import { NextResponse } from "next/server";
import { z } from "zod";

import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { memoryContextText, readAgentMemory } from "@/src/lib/memory";
import { createPredictClientPreview } from "@/src/lib/predict";
import { authorizeRequestQuota, isQuotaIdentityRequiredError, quotaIdentityErrorStatus } from "@/src/lib/request-quota";
import { compileStrategy } from "@/src/lib/strategy";
import type { ConversationContext } from "@/src/lib/types";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(700),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  profileId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  telegramHash: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  refreshed: z.boolean().optional(),
  lastMarketThesis: z.string().trim().max(1500).optional(),
  conversation: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(900),
    mode: z.enum(["chat", "trade", "strategy"]).optional(),
    sourceTitles: z.array(z.string().trim().min(1).max(160)).max(4).optional()
  })).max(8).optional(),
  lockedLegs: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    oracleId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).nullable().optional(),
    direction: z.enum(["up", "down"]).nullable().optional(),
    strike: z.number().finite().positive().nullable().optional()
  })).max(8).optional()
});

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "strategy-compile",
    maxRequests: 20,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many strategy requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return NextResponse.json({ error: "Invalid strategy payload" }, { status: 400 });
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
      ...(await compileStrategy(body.data.message, {
        walletAddress: body.data.walletAddress,
        managerId: body.data.managerId,
        refreshed: Boolean(body.data.refreshed),
        lockedLegs: body.data.lockedLegs ?? [],
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

    return NextResponse.json({ error: "Strategy compile failed" }, { status: 502 });
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
