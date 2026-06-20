import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { memoryContextText, readAgentMemory } from "@/src/lib/memory";
import { classifyPilotInput } from "@/src/lib/pilot";
import { createPredictClientPreview } from "@/src/lib/predict";
import { buildRagContext, streamRagAnswer } from "@/src/lib/rag";
import { authorizeRequestQuota } from "@/src/lib/request-quota";
import { compileStrategy } from "@/src/lib/strategy";
import { compileVaultLpIntent } from "@/src/lib/vault-lp";
import type { CompileStreamEvent, ConversationContext, PilotMode, PilotStreamEvent } from "@/src/lib/types";

export const runtime = "nodejs";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(500).optional(),
  intent: z.string().trim().min(1).max(500).optional(),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  managerId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  profileId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  telegramHash: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  lastMarketThesis: z.string().trim().max(1500).optional(),
  conversation: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(900),
    mode: z.enum(["chat", "trade", "strategy", "vault_lp"]).optional(),
    sourceTitles: z.array(z.string().trim().min(1).max(160)).max(4).optional()
  })).max(8).optional()
}).refine((body) => Boolean(body.message || body.intent));

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "pilot-stream",
    maxRequests: 30,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return new Response("Too many pilot requests", {
      status: 429,
      headers: rateLimitHeaders(rateLimit.retryAfterSeconds)
    });
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return new Response("Invalid pilot payload", { status: 400 });
  }

  const message = body.data.message ?? body.data.intent ?? "";
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: PilotStreamEvent) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const authorization = await authorizeRequestQuota({
            profileId: body.data.profileId,
            telegramHash: body.data.telegramHash,
            walletAddress: body.data.walletAddress
          });
          const quota = authorization.quota;

          if (quota && !quota.allowed) {
            send({
              type: "error",
              error: `Daily AI quota exhausted. Open Plans to upgrade or wait until ${quota.resetAt}.`
            });
            return;
          }

          send({
            type: "stage",
            label: "Classifying request",
            state: "pending"
          });
          const conversationContext = conversationContextFromBody(
            body.data,
            await resolveMemoryContext(authorization.identity?.profileId ?? null)
          );
          const classification = await classifyPilotInput(message, {
            conversationContext
          });

          send({
            type: "stage",
            label: "Classifying request",
            state: "complete",
            detail: classification.mode
          });
          if (classification.mode === "trade") {
            if (sendClarificationIfMissing("trade", message, classification.missing, send)) {
              return;
            }

            await streamTradeReview(message, body.data, conversationContext, send);
            return;
          }

          if (classification.mode === "strategy") {
            if (sendClarificationIfMissing("strategy", message, classification.missing, send)) {
              return;
            }

            await streamStrategyReview(message, body.data, conversationContext, send);
            return;
          }

          if (classification.mode === "vault_lp") {
            if (sendClarificationIfMissing("vault_lp", message, classification.missing, send)) {
              return;
            }

            await streamVaultLpReview(message, body.data, send);
            return;
          }

          send({
            type: "mode",
            mode: classification.mode,
            classification
          });
          await streamChatAnswer(message, classification, send);
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Pilot request failed"
          });
        } finally {
          controller.close();
        }
      }
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive"
      }
    }
  );
}

async function streamVaultLpReview(
  message: string,
  body: z.infer<typeof bodySchema>,
  send: (event: PilotStreamEvent) => void
) {
  send({
    type: "stage",
    label: "Reading Vault LP state",
    state: "pending"
  });
  const review = await compileVaultLpIntent(message, {
    wallet: body.walletAddress ?? null
  });

  if (review.intent.status === "needs_clarification") {
    sendClarification("vault_lp", message, review.intent.missing, send);
    return;
  }

  send({
    type: "stage",
    label: "Reading Vault LP state",
    state: "complete",
    detail: `Share price ${review.summary.vault.plp_share_price.toFixed(6)}`
  });
  send({
    type: "mode",
    mode: "vault_lp",
    classification: {
      mode: "vault_lp",
      asset: null,
      question: message,
      draftIntent: null,
      missing: []
    }
  });
  send({
    type: "vault_lp_compiled",
    review
  });
}

function sendClarificationIfMissing(
  mode: Exclude<PilotMode, "chat">,
  originalText: string,
  upstreamMissing: string[],
  send: (event: PilotStreamEvent) => void
) {
  const missing = webMissingFields(mode, originalText, upstreamMissing);

  if (!missing.length) {
    return false;
  }

  sendClarification(mode, originalText, missing, send);
  return true;
}

function sendClarification(
  mode: Exclude<PilotMode, "chat">,
  originalText: string,
  missing: string[],
  send: (event: PilotStreamEvent) => void
) {
  const normalizedMissing = normalizeMissingFields(mode, missing);

  send({
    type: "clarification",
    mode,
    missing: normalizedMissing,
    question: formatClarificationQuestion(mode, normalizedMissing),
    originalText
  });
}

function webMissingFields(
  mode: Exclude<PilotMode, "chat">,
  rawIntent: string,
  upstreamMissing: string[]
) {
  const missing = new Set(normalizeMissingFields(mode, upstreamMissing));

  if (referencesStoredShape(rawIntent)) {
    return [...missing];
  }

  if (mode === "trade") {
    if (!hasCurrencyAmount(rawIntent)) {
      missing.add("amount");
    }

    if (!hasTradeDirection(rawIntent)) {
      missing.add("direction");
    }

    if (!hasExpiryPlan(rawIntent) && !hasObjectId(rawIntent)) {
      missing.add("expiry");
    }
  }

  if (mode === "strategy") {
    if (!hasCurrencyAmount(rawIntent)) {
      missing.add("amount");
    }

    if (!hasStrategyShape(rawIntent)) {
      missing.add("strategy_shape");
    }

    if (!hasStrategyDirection(rawIntent)) {
      missing.add("direction");
    }

    if (!hasExpiryPlan(rawIntent)) {
      missing.add("expiry");
    }
  }

  if (mode === "vault_lp") {
    const lowerIntent = rawIntent.toLowerCase();
    const infoOnly = /\b(show|check|info|status|performance)\b|查看|看看|表现|信息|状态/.test(lowerIntent);
    const hasAction = /\b(deposit|supply|mint|add|provide|withdraw|remove|exit|redeem)\b|存入|充值|放进|提供|加入|做|取出|赎回|退出/i.test(rawIntent);

    if (!infoOnly && !hasAction) {
      missing.add("action");
    }

    if (!infoOnly && !hasCurrencyAmount(rawIntent)) {
      missing.add("amount");
    }
  }

  return [...missing];
}

function normalizeMissingFields(mode: Exclude<PilotMode, "chat">, missing: string[]) {
  const aliases: Record<string, string> = {
    budget: "amount",
    quote: "amount",
    payment: "amount",
    side: "direction",
    expiryPreference: "expiry",
    oracle: "expiry",
    oracleId: "expiry",
    settlement: "expiry",
    method: mode === "vault_lp" ? "action" : "strategy_shape",
    shape: "strategy_shape"
  };

  return [...new Set(missing
    .map((item) => aliases[item] ?? item)
    .filter((item) => item === "amount" || item === "direction" || item === "expiry" || item === "strategy_shape" || item === "action"))];
}

function formatClarificationQuestion(mode: Exclude<PilotMode, "chat">, missing: string[]) {
  const questions = missing.map((field) => {
    if (mode === "vault_lp" && field === "action") {
      return "Do you want to deposit to Vault LP or withdraw from Vault LP?";
    }

    if (field === "amount") {
      return mode === "strategy"
        ? "What total budget should DeepPilot allocate? Example: 1 DUSDC."
        : "How much DUSDC do you want to use? Example: 1 DUSDC.";
    }

    if (field === "direction") {
      return mode === "strategy"
        ? "Should the strategy lean UP, DOWN, or market-neutral hedge?"
        : "Which side do you want: BTC UP or BTC DOWN?";
    }

    if (field === "strategy_shape") {
      return "Do you want a hedge, split ladder, or single directional plan?";
    }

    if (field === "expiry") {
      return mode === "strategy"
        ? "Use nearest settlement, 1h/2h/3h ladder, or a specific expiry?"
        : "Which settlement do you want: nearest active, 1h, 2h, or a specific time?";
    }

    return "Please clarify the missing field.";
  });

  return [
    "I need one more detail before creating a Review & Sign flow.",
    ...questions,
    "",
    "Reply with the missing detail and DeepPilot will continue this request."
  ].join("\n");
}

function hasCurrencyAmount(raw: string) {
  return (
    /(\d+(?:\.\d+)?)\s*(?:d?usdc|usdc|u|\$)/i.test(normalizeCurrencyText(raw)) ||
    /\b(a|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:d?usdc|usdc|u)\b/i.test(raw)
  );
}

function hasTradeDirection(raw: string) {
  return /\b(up|down|call|put|long|short)\b|涨|跌|做多|做空|看涨|看跌/i.test(raw);
}

function hasStrategyDirection(raw: string) {
  return hasTradeDirection(raw) || /\b(market-neutral|neutral|balanced|mostly|overweight)\b|中性|双向|对冲|大头/i.test(raw);
}

function hasStrategyShape(raw: string) {
  return /\b(strategy|hedge|split|ladder|multi-leg|multi leg|single directional|directional)\b|策略|对冲|分批|阶梯|多笔|多腿|一小时|两小时|二小时|三小时|1h|2h|3h|1小时|2小时|3小时/i.test(raw);
}

function hasExpiryPlan(raw: string) {
  return /\b(next|nearest|fastest|earliest|settlement|expiry|today|tonight|tomorrow|1h|2h|3h|one hour|two hour|three hour|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2})\b|最近|最快|结算|到期|今天|今晚|明天|一小时|两小时|二小时|三小时|[0-2]?\d点/i.test(raw);
}

function hasObjectId(raw: string) {
  return /0x[a-fA-F0-9]{16,64}/.test(raw);
}

function referencesStoredShape(raw: string) {
  return /\b(same|repeat|again|last time|previous|as before)\b|跟上一次|和上次一样|照旧|同样/i.test(raw);
}

function normalizeCurrencyText(raw: string) {
  return raw.replace(/([a-z])\s+(?=[a-z])/gi, "$1");
}

async function streamStrategyReview(
  message: string,
  body: z.infer<typeof bodySchema>,
  conversationContext: ConversationContext | null,
  send: (event: PilotStreamEvent) => void
) {
  const review = await compileStrategy(message, {
    walletAddress: body.walletAddress,
    managerId: body.managerId,
    conversationContext,
    onEvent: (event) => forwardCompileEvent(event, send)
  });

  if (review.plan.missing.length > 0) {
    sendClarification("strategy", message, review.plan.missing, send);
    return;
  }

  send({
    type: "mode",
    mode: "strategy",
    classification: {
      mode: "strategy",
      asset: review.plan.asset,
      question: message,
      draftIntent: null,
      missing: []
    }
  });
  send({
    type: "strategy_compiled",
    review: {
      ...review,
      predict: createPredictClientPreview()
    } as typeof review
  });
}

async function streamTradeReview(
  message: string,
  body: z.infer<typeof bodySchema>,
  conversationContext: ConversationContext | null,
  send: (event: PilotStreamEvent) => void
) {
  const result = await compileIntent(message, {
    walletAddress: body.walletAddress,
    managerId: body.managerId,
    conversationContext,
    onEvent: (event) => forwardCompileEvent(event, send)
  });

  if (result.intent.status === "needs_clarification") {
    sendClarification("trade", message, result.intent.missing, send);
    return;
  }

  send({
    type: "mode",
    mode: "trade",
    classification: {
      mode: "trade",
      asset: result.intent.status === "ready" ? result.intent.underlying : null,
      question: message,
      draftIntent: null,
      missing: []
    }
  });
  send({
    type: "compiled",
    result: {
      ...result,
      predict: createPredictClientPreview()
    } as typeof result
  });
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

async function streamChatAnswer(
  message: string,
  classification: Awaited<ReturnType<typeof classifyPilotInput>>,
  send: (event: PilotStreamEvent) => void
) {
  send({
    type: "stage",
    label: "Retrieving Predict oracle, news, and repo context",
    state: "pending"
  });
  const context = await buildRagContext(message, classification);

  send({
    type: "sources",
    sources: context.sources
  });
  send({
    type: "stage",
    label: "Retrieving Predict oracle, news, and repo context",
    state: context.partial ? "blocked" : "complete",
    detail: context.partial ? "partial sources" : `${context.sources.length} sources`
  });
  send({
    type: "stage",
    label: "Generating risk explanation",
    state: "pending"
  });
  await streamRagAnswer({
    input: message,
    classification,
    sources: context.sources,
    onDelta: (delta) => send({ type: "answer_delta", delta })
  });
  send({
    type: "stage",
    label: "Generating risk explanation",
    state: "complete"
  });
}

function forwardCompileEvent(event: CompileStreamEvent, send: (event: PilotStreamEvent) => void) {
  if (event.type === "stage") {
    send({
      type: "stage",
      label: event.label,
      state: event.state,
      detail: event.detail
    });
    return;
  }

  if (event.type === "fallback") {
    send({
      type: "stage",
      label: "Using deterministic intent fallback",
      state: "complete",
      detail: event.reason
    });
  }
}
