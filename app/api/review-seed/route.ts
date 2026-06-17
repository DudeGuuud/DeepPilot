import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitHeaders } from "@/src/lib/http";
import { decodeReviewSeed } from "@/src/lib/review-seed";
import { getTelegramSession } from "@/src/lib/telegram-session";

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
  const wallet = new URL(request.url).searchParams.get("wallet")?.trim().toLowerCase() ?? null;

  if (!token) {
    return NextResponse.json({ error: "Missing review seed token" }, { status: 400 });
  }

  try {
    const seed = decodeReviewSeed(token);

    if (seed.telegramHash && !wallet) {
      return NextResponse.json({ error: "Connect the wallet linked to this Telegram review." }, { status: 401 });
    }

    if (seed.telegramHash && wallet) {
      const session = await getTelegramSession(seed.telegramHash);

      if (!session?.walletAddress || session.walletAddress.toLowerCase() !== wallet) {
        return NextResponse.json({ error: "Connect the wallet linked to this Telegram review." }, { status: 403 });
      }
    }

    return NextResponse.json({ seed });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid review seed token" },
      { status: 400 }
    );
  }
}
