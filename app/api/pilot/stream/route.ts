import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { classifyPilotInput } from "@/src/lib/pilot";
import { createPredictClientPreview } from "@/src/lib/predict";
import { buildRagContext, streamRagAnswer } from "@/src/lib/rag";
import type { CompileStreamEvent, PilotStreamEvent } from "@/src/lib/types";

export const runtime = "nodejs";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(500).optional(),
  intent: z.string().trim().min(1).max(500).optional(),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional()
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
          send({
            type: "stage",
            label: "Classifying request",
            state: "pending"
          });
          const classification = await classifyPilotInput(message);

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
            await streamTradeReview(message, body.data, send);
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

async function streamTradeReview(
  message: string,
  body: z.infer<typeof bodySchema>,
  send: (event: PilotStreamEvent) => void
) {
  const result = await compileIntent(message, {
    walletAddress: body.walletAddress,
    managerId: body.managerId,
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
