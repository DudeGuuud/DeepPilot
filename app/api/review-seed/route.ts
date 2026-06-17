import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitHeaders } from "@/src/lib/http";
import { decodeReviewSeed } from "@/src/lib/review-seed";

export async function GET(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "review-seed",
    maxRequests: 60,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many review seed requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const token = new URL(request.url).searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Missing review seed token" }, { status: 400 });
  }

  try {
    return NextResponse.json({ seed: decodeReviewSeed(token) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid review seed token" },
      { status: 400 }
    );
  }
}
