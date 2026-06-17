import { NextResponse } from "next/server";
import { z } from "zod";

import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { memoryContextText, readAgentMemory } from "@/src/lib/memory";
import { createPredictClientPreview } from "@/src/lib/predict";
import { consumeRequestQuota, isQuotaIdentityRequiredError } from "@/src/lib/request-quota";
import { compileStrategy } from "@/src/lib/strategy";
import { getTelegramSession } from "@/src/lib/telegram-session";
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
    const quota = body.data.refreshed
      ? null
      : await consumeRequestQuota({
          profileId: body.data.profileId,
          telegramHash: body.data.telegramHash,
          walletAddress: body.data.walletAddress
        });

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
        conversationContext: conversationContextFromBody(
          body.data,
          await resolveMemoryContext(body.data)
        )
      })),
      predict: createPredictClientPreview()
    });
  } catch (error) {
    if (isQuotaIdentityRequiredError(error)) {
      return NextResponse.json({ error: error.message }, { status: 401 });
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

async function resolveMemoryContext(body: z.infer<typeof bodySchema>) {
  const profileId = body.profileId
    ?? (body.telegramHash ? (await getTelegramSession(body.telegramHash))?.profileId ?? null : null);

  if (!profileId) {
    return null;
  }

  return memoryContextText(await readAgentMemory(profileId));
}
