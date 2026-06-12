import { NextResponse } from "next/server";
import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { createPredictClientPreview } from "@/src/lib/predict";

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional()
});

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "compile",
    maxRequests: 30,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many compile requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return NextResponse.json(
      {
        error: "Invalid intent payload"
      },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json({
      ...(await compileIntent(body.data.intent, {
        walletAddress: body.data.walletAddress,
        managerId: body.data.managerId
      })),
      predict: createPredictClientPreview()
    });
  } catch {
    return NextResponse.json({ error: "Intent compile failed" }, { status: 502 });
  }
}
