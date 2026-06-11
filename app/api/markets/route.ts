import { NextResponse } from "next/server";

import { checkRateLimit, rateLimitHeaders } from "@/src/lib/http";
import { getPredictMarkets } from "@/src/lib/predict";

export async function GET(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "markets",
    maxRequests: 60,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many market requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const query = new URL(request.url).searchParams;

  try {
    return NextResponse.json(
      await getPredictMarkets({
        status: normalizeStatusFilter(query.get("status")),
        asset: "BTC",
        expiry: normalizeExpiryFilter(query.get("expiry")),
        risk: normalizeRiskFilter(query.get("risk")),
        page: normalizePositiveInteger(query.get("page")),
        pageSize: normalizePageSize(query.get("pageSize")),
        selectedOracleId: query.get("selectedOracleId") ?? undefined
      })
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Market discovery failed" },
      { status: 502 }
    );
  }
}

function normalizeStatusFilter(value: string | null) {
  if (value === "active" || value === "settled" || value === "all") {
    return value;
  }

  return undefined;
}

function normalizeExpiryFilter(value: string | null) {
  if (value === "week") {
    return "this_week";
  }

  if (value === "next" || value === "today" || value === "this_week" || value === "all") {
    return value;
  }

  return undefined;
}

function normalizeRiskFilter(value: string | null) {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "blocked" ||
    value === "unknown" ||
    value === "all"
  ) {
    return value;
  }

  return undefined;
}

function normalizePositiveInteger(value: string | null) {
  const parsed = value ? Number(value) : NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizePageSize(value: string | null) {
  const parsed = normalizePositiveInteger(value);

  return parsed ? Math.min(parsed, 12) : undefined;
}
