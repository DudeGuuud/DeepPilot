import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitHeaders } from "@/src/lib/http";
import { getPredictOracleHistory } from "@/src/lib/predict";

type RouteContext = {
  params: Promise<{
    oracleId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
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
    const { oracleId } = await context.params;

    return NextResponse.json(await getPredictOracleHistory(oracleId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Oracle history failed" },
      { status: 502 }
    );
  }
}
