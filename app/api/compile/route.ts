import { NextResponse } from "next/server";
import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { memoryContextText, readAgentMemory } from "@/src/lib/memory";
import { createPredictClientPreview } from "@/src/lib/predict";
import { authorizeRequestQuota, isQuotaIdentityRequiredError, quotaIdentityErrorStatus } from "@/src/lib/request-quota";
import type { ConversationContext, ParsedIntent } from "@/src/lib/types";

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  profileId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  telegramHash: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  parsedIntent: z.custom<ParsedIntent>((value) =>
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "ready" || value.status === "needs_clarification")
  ).optional(),
  refreshed: z.boolean().optional(),
  lastMarketThesis: z.string().trim().max(1500).optional(),
  conversation: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(900),
    mode: z.enum(["chat", "trade", "strategy"]).optional(),
    sourceTitles: z.array(z.string().trim().min(1).max(160)).max(4).optional()
  })).max(8).optional()
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
    const authorization = await authorizeRequestQuota({
      profileId: body.data.profileId,
      telegramHash: body.data.telegramHash,
      walletAddress: body.data.walletAddress
    }, {
      consume: !body.data.refreshed
    });
    const quota = authorization.quota;

    if (quota && !quota.allowed) {
      return NextResponse.json({
        error: "Daily AI quota exhausted.",
        quota
      }, { status: 402 });
    }

    return NextResponse.json({
      ...(await compileIntent(body.data.intent, {
        walletAddress: body.data.walletAddress,
        managerId: body.data.managerId,
        parsedIntent: body.data.parsedIntent,
        refreshed: Boolean(body.data.refreshed),
        conversationContext: conversationContextFromBody(
          body.data,
          await resolveMemoryContext(authorization.identity?.profileId ?? null)
        )
      })),
      predict: createPredictClientPreview()
    });
  } catch (error) {
    if (isQuotaIdentityRequiredError(error)) {
      return NextResponse.json({ error: error.message }, { status: quotaIdentityErrorStatus(error) });
    }

    return NextResponse.json({ error: "Intent compile failed" }, { status: 502 });
  }
}

function conversationContextFromBody(
  body: z.infer<typeof bodySchema>,
  memoryContext?: string | null
): ConversationContext | null {
  const messages = body.conversation ?? [];
  const lastMarketThesis = body.lastMarketThesis?.trim() || null;

  if (!messages.length && !lastMarketThesis && !memoryContext) {
    return null;
  }

  return {
    messages,
    lastMarketThesis,
    memoryContext: memoryContext ?? null
  };
}

async function resolveMemoryContext(profileId: string | null) {
  if (!profileId) {
    return null;
  }

  return memoryContextText(await readAgentMemory(profileId));
}
