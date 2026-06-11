import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitHeaders } from "@/src/lib/http";
import { getProfileSummary } from "@/src/lib/profile";

export async function GET(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "profile",
    maxRequests: 40,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many profile requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const query = new URL(request.url).searchParams;

  try {
    return NextResponse.json(
      await getProfileSummary({
        wallet: query.get("wallet"),
        managerId: query.get("managerId")
      })
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Profile lookup failed" },
      { status: 502 }
    );
  }
}
