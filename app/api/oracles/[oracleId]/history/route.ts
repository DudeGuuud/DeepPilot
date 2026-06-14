import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitHeaders } from "@/src/lib/http";
import { getPredictOracleHistory } from "@/src/lib/predict";

const HISTORY_CACHE_TTL_MS = 2_500;
type HistoryPayload = Awaited<ReturnType<typeof getPredictOracleHistory>>;
const historyCache = new Map<string, { expiresAt: number; payload: HistoryPayload }>();

type RouteContext = {
  params: Promise<{
    oracleId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { oracleId } = await context.params;
  const cached = historyCache.get(oracleId);

  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, { headers: { "x-deeppilot-cache": "hit" } });
  }

  const rateLimit = checkRateLimit(request, {
    scope: "oracle-history",
    maxRequests: 40,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many history requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  try {
    const payload = await getPredictOracleHistory(oracleId);

    historyCache.set(oracleId, {
      expiresAt: Date.now() + HISTORY_CACHE_TTL_MS,
      payload
    });

    return NextResponse.json(payload, { headers: { "x-deeppilot-cache": "miss" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Oracle history failed" },
      { status: 502 }
    );
  }
}
