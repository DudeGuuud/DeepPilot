import { NextResponse } from "next/server";
import { z } from "zod";

import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { compileVaultLpIntent } from "@/src/lib/vault-lp";

export const runtime = "nodejs";

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional()
});

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "vault-lp-compile",
    maxRequests: 40,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many Vault LP compile requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return NextResponse.json({ error: "Invalid Vault LP compile payload." }, { status: 400 });
  }

  try {
    return NextResponse.json(await compileVaultLpIntent(body.data.intent, {
      wallet: body.data.walletAddress ?? null
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Vault LP compile failed." },
      { status: 502 }
    );
  }
}
