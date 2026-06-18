import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { memoryContextText, readAgentMemory } from "@/src/lib/memory";
import { classifyPilotInput } from "@/src/lib/pilot";
import { createPredictClientPreview } from "@/src/lib/predict";
import { buildRagContext, streamRagAnswer } from "@/src/lib/rag";
import { authorizeRequestQuota } from "@/src/lib/request-quota";
import { compileStrategy } from "@/src/lib/strategy";
import type { CompileStreamEvent, ConversationContext, PilotStreamEvent } from "@/src/lib/types";

export const runtime = "nodejs";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(500).optional(),
  intent: z.string().trim().min(1).max(500).optional(),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  profileId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  telegramHash: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  lastMarketThesis: z.string().trim().max(1500).optional(),
  conversation: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(900),
    mode: z.enum(["chat", "trade", "strategy"]).optional(),
    sourceTitles: z.array(z.string().trim().min(1).max(160)).max(4).optional()
  })).max(8).optional()
}).refine((body) => Boolean(body.message || body.intent));

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "pilot-stream",
    maxRequests: 30,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return new Response("Too many pilot requests", {
      status: 429,
      headers: rateLimitHeaders(rateLimit.retryAfterSeconds)
    });
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return new Response("Invalid pilot payload", { status: 400 });
  }

  const message = body.data.message ?? body.data.intent ?? "";
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: PilotStreamEvent) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const authorization = await authorizeRequestQuota({
            profileId: body.data.profileId,
            telegramHash: body.data.telegramHash,
            walletAddress: body.data.walletAddress
          });
          const quota = authorization.quota;

          if (quota && !quota.allowed) {
            send({
              type: "error",
              error: `Daily AI quota exhausted. Open Plans to upgrade or wait until ${quota.resetAt}.`
            });
            return;
          }

          send({
            type: "stage",
            label: "Classifying request",
            state: "pending"
          });
          const conversationContext = conversationContextFromBody(
            body.data,
            await resolveMemoryContext(authorization.identity?.profileId ?? null)
          );
          const classification = await classifyPilotInput(message, {
            conversationContext
          });

          send({
            type: "stage",
            label: "Classifying request",
            state: "complete",
            detail: classification.mode
          });
          send({
            type: "mode",
            mode: classification.mode,
            classification
          });

          if (classification.mode === "trade") {
            await streamTradeReview(message, body.data, conversationContext, send);
            return;
          }

          if (classification.mode === "strategy") {
            await streamStrategyReview(message, body.data, conversationContext, send);
            return;
          }

          await streamChatAnswer(message, classification, send);
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Pilot request failed"
          });
        } finally {
          controller.close();
        }
      }
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive"
      }
    }
  );
}

async function streamStrategyReview(
  message: string,
  body: z.infer<typeof bodySchema>,
  conversationContext: ConversationContext | null,
  send: (event: PilotStreamEvent) => void
) {
  const review = await compileStrategy(message, {
    walletAddress: body.walletAddress,
    managerId: body.managerId,
    conversationContext,
    onEvent: (event) => forwardCompileEvent(event, send)
  });

  send({
    type: "strategy_compiled",
    review: {
      ...review,
      predict: createPredictClientPreview()
    } as typeof review
  });
}

async function streamTradeReview(
  message: string,
  body: z.infer<typeof bodySchema>,
  conversationContext: ConversationContext | null,
  send: (event: PilotStreamEvent) => void
) {
  const result = await compileIntent(message, {
    walletAddress: body.walletAddress,
    managerId: body.managerId,
    conversationContext,
    onEvent: (event) => forwardCompileEvent(event, send)
  });

  send({
    type: "compiled",
    result: {
      ...result,
      predict: createPredictClientPreview()
    } as typeof result
  });
}

function conversationContextFromBody(
  body: z.infer<typeof bodySchema>,
  memoryContext?: string | null
): ConversationContext | null {
  const messages = body.conversation ?? [];
  const lastMarketThesis = body.lastMarketThesis?.trim() || null;

  if (!messages.length && !lastMarketThesis && !memoryContext) {
    return null;
  }

  return {
    messages,
    lastMarketThesis,
    memoryContext: memoryContext ?? null
  };
}

async function resolveMemoryContext(profileId: string | null) {
  if (!profileId) {
    return null;
  }

  return memoryContextText(await readAgentMemory(profileId));
}

async function streamChatAnswer(
  message: string,
  classification: Awaited<ReturnType<typeof classifyPilotInput>>,
  send: (event: PilotStreamEvent) => void
) {
  send({
    type: "stage",
    label: "Retrieving Predict oracle, news, and repo context",
    state: "pending"
  });
  const context = await buildRagContext(message, classification);

  send({
    type: "sources",
    sources: context.sources
  });
  send({
    type: "stage",
    label: "Retrieving Predict oracle, news, and repo context",
    state: context.partial ? "blocked" : "complete",
    detail: context.partial ? "partial sources" : `${context.sources.length} sources`
  });
  send({
    type: "stage",
    label: "Generating risk explanation",
    state: "pending"
  });
  await streamRagAnswer({
    input: message,
    classification,
    sources: context.sources,
    onDelta: (delta) => send({ type: "answer_delta", delta })
  });
  send({
    type: "stage",
    label: "Generating risk explanation",
    state: "complete"
  });
}

function forwardCompileEvent(event: CompileStreamEvent, send: (event: PilotStreamEvent) => void) {
  if (event.type === "stage") {
    send({
      type: "stage",
      label: event.label,
      state: event.state,
      detail: event.detail
    });
    return;
  }

  if (event.type === "fallback") {
    send({
      type: "stage",
      label: "Using deterministic intent fallback",
      state: "complete",
      detail: event.reason
    });
  }
}
