import { z } from "zod";

import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { createPredictClientPreview } from "@/src/lib/predict";
import { compileStrategy } from "@/src/lib/strategy";
import type { CompileStreamEvent, ConversationContext, PilotStreamEvent } from "@/src/lib/types";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(700),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  refreshed: z.boolean().optional(),
  lastMarketThesis: z.string().trim().max(1500).optional(),
  conversation: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(900),
    mode: z.enum(["chat", "trade", "strategy"]).optional(),
    sourceTitles: z.array(z.string().trim().min(1).max(160)).max(4).optional()
  })).max(8).optional()
});

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "strategy-stream",
    maxRequests: 20,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return new Response("Too many strategy requests", {
      status: 429,
      headers: rateLimitHeaders(rateLimit.retryAfterSeconds)
    });
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return new Response("Invalid strategy payload", { status: 400 });
  }

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: PilotStreamEvent) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const review = await compileStrategy(body.data.message, {
            walletAddress: body.data.walletAddress,
            managerId: body.data.managerId,
            refreshed: Boolean(body.data.refreshed),
            conversationContext: conversationContextFromBody(body.data),
            onEvent: (event) => forwardCompileEvent(event, send)
          });

          send({
            type: "strategy_compiled",
            review: {
              ...review,
              predict: createPredictClientPreview()
            } as typeof review
          });
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Strategy compile failed"
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

function conversationContextFromBody(body: z.infer<typeof bodySchema>): ConversationContext | null {
  const messages = body.conversation ?? [];
  const lastMarketThesis = body.lastMarketThesis?.trim() || null;

  if (!messages.length && !lastMarketThesis) {
    return null;
  }

  return {
    messages,
    lastMarketThesis
  };
}

function forwardCompileEvent(event: CompileStreamEvent, send: (event: PilotStreamEvent) => void) {
  if (event.type === "stage") {
    send({
      type: "stage",
      label: event.label,
      state: event.state,
      detail: event.detail
    });
  }
}
