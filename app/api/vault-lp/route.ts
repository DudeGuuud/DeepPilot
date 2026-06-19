import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitHeaders } from "@/src/lib/http";
import { getVaultLpSummary } from "@/src/lib/vault-lp";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "vault-lp",
    maxRequests: 60,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many Vault LP requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const url = new URL(request.url);
  const wallet = url.searchParams.get("wallet")?.trim() ?? null;

  if (wallet && !/^0x[a-fA-F0-9]{1,64}$/.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address." }, { status: 400 });
  }

  try {
    return NextResponse.json(await getVaultLpSummary({ wallet }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Vault LP lookup failed." },
      { status: 502 }
    );
  }
}
