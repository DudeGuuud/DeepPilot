import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { createPredictClientPreview } from "@/src/lib/predict";
import type { CompileStreamEvent } from "@/src/lib/types";

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional()
});

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "compile-stream",
    maxRequests: 30,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return new Response("Too many compile requests", {
      status: 429,
      headers: rateLimitHeaders(rateLimit.retryAfterSeconds)
    });
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return new Response("Invalid intent payload", { status: 400 });
  }

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: CompileStreamEvent) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const result = await compileIntent(body.data.intent, {
            walletAddress: body.data.walletAddress,
            managerId: body.data.managerId,
            onEvent: send
          });

          send({
            type: "compiled",
            result: {
              ...result,
              predict: createPredictClientPreview()
            } as typeof result
          });
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Intent compile failed"
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
