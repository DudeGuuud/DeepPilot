import { z } from "zod";

import { isVaultLpRequest } from "./vault-lp";
import type { ActiveMarketContext, ConversationContext, PilotClassification } from "./types";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const CLASSIFIER_TIMEOUT_MS = 8_000;

const classifierSchema = z.object({
  mode: z.enum(["chat", "trade", "strategy", "vault_lp"]),
  asset: z.enum(["BTC", "ETH", "SOL", "TRX"]).nullable(),
  question: z.string().trim().min(1).max(500),
  missing: z.array(z.string()).default([])
});

type ClassifierOutput = z.infer<typeof classifierSchema>;

export type PilotClassifierOptions = {
  activeMarketContext?: ActiveMarketContext | null;
  conversationContext?: ConversationContext | null;
};

export async function classifyPilotInput(
  input: string,
  options: PilotClassifierOptions = {}
): Promise<PilotClassification> {
  const raw = input.trim();

  if (!raw) {
    return {
      mode: "chat",
      asset: null,
      question: "What do you want to do on DeepBook Predict?",
      draftIntent: null,
      missing: ["message"]
    };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey || typeof window !== "undefined") {
    return fallbackClassification(raw, options);
  }

  try {
    const classified = await callDeepSeekClassifier(raw, apiKey, options);

    return {
      ...classified,
      question: classified.question || raw,
      draftIntent: null
    };
  } catch {
    return fallbackClassification(raw, options);
  }
}

async function callDeepSeekClassifier(
  raw: string,
  apiKey: string,
  options: PilotClassifierOptions
): Promise<ClassifierOutput> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
        messages: [
          {
            role: "system",
            content: classifierPrompt()
          },
          {
            role: "user",
            content: JSON.stringify({
              nowIso: new Date().toISOString(),
              defaultTimezone: "Asia/Shanghai",
              text: raw,
              activeMarketContext: options.activeMarketContext ?? null,
              conversationContext: summarizeConversationContext(options.conversationContext)
            })
          }
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 350,
        stream: false
      }),
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`DeepSeek pilot classifier returned ${response.status}`);
    }

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("DeepSeek pilot classifier returned empty content.");
    }

    const parsed = classifierSchema.safeParse(JSON.parse(content));

    if (!parsed.success) {
      throw new Error("DeepSeek pilot classifier returned invalid JSON.");
    }

    return normalizeClassification(raw, parsed.data);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeClassification(raw: string, classified: ClassifierOutput): ClassifierOutput {
  if (isVaultLpRequest(raw)) {
    return {
      ...classified,
      mode: "vault_lp",
      missing: vaultLpMissingFields(raw)
    };
  }

  if (!isAdviceQuestion(raw) && isExplicitStrategyRequest(raw)) {
    return {
      ...classified,
      mode: "strategy",
      missing: strategyMissingFields(raw)
    };
  }

  if (!isAdviceQuestion(raw) && isExplicitTradeRequest(raw) && classified.mode === "chat") {
    return {
      ...classified,
      mode: "trade",
      missing: tradeMissingFields(raw)
    };
  }

  if (classified.mode === "chat") {
    return {
      ...classified,
      missing: []
    };
  }

  if (classified.mode === "strategy") {
    return {
      ...classified,
      missing: strategyMissingFields(raw)
    };
  }

  // The LLM sometimes treats "tonight" as too vague even though the intent compiler
  // can route it to a concrete or next-active Predict expiry. Keep the public event
  // aligned with the deterministic compiler fallback.
  return {
    ...classified,
    missing: tradeMissingFields(raw)
  };
}

function fallbackClassification(raw: string, options: PilotClassifierOptions): PilotClassification {
  const adviceQuestion = isAdviceQuestion(raw);
  const vaultLp = isVaultLpRequest(raw);
  const explicitTrade = isExplicitTradeRequest(raw);
  const explicitStrategy = isExplicitStrategyRequest(raw);
  const mode = vaultLp
    ? "vault_lp"
    : explicitStrategy && !adviceQuestion
    ? "strategy"
    : explicitTrade && !adviceQuestion ? "trade" : "chat";
  const asset = detectAsset(raw) ?? inferContextAsset(options.conversationContext) ?? (mode === "strategy" ? "BTC" : null);
  const missing = mode === "vault_lp"
    ? vaultLpMissingFields(raw)
    : mode === "strategy" ? strategyMissingFields(raw) : mode === "trade" ? tradeMissingFields(raw) : [];

  return {
    mode,
    asset,
    question: raw,
    draftIntent: null,
    missing
  };
}

function detectAsset(raw: string): PilotClassification["asset"] {
  const normalized = raw.toUpperCase();

  if (/\bBTC\b|BITCOIN|比特币/.test(normalized)) {
    return "BTC";
  }

  if (/\bETH\b|ETHEREUM|以太/.test(normalized)) {
    return "ETH";
  }

  if (/\bSOL\b|SOLANA/.test(normalized)) {
    return "SOL";
  }

  if (/\bTRX\b|TRON|波场/.test(normalized)) {
    return "TRX";
  }

  return null;
}

function tradeMissingFields(raw: string) {
  const normalized = raw.toLowerCase();
  const missing: string[] = [];
  const hasAmount = hasCurrencyAmount(raw) || /amount|金额/i.test(raw);
  const hasDirection = /\b(up|down|call|put)\b|涨|跌|做多|做空/i.test(raw);
  const hasExpiry =
    /\b(next|tonight|today|tomorrow|nearest|fastest|earliest|settlement|expiry|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2})\b|今天|今晚|明天|到期|结算|最快|最近|六点|[0-2]?\d点/i.test(raw);
  const isRedeem = /\b(redeem|claim)\b|赎回|领取/.test(normalized);

  if (!isRedeem && !hasAmount) {
    missing.push("amount");
  }

  if (!isRedeem && !hasDirection) {
    missing.push("direction");
  }

  if (!isRedeem && !hasExpiry) {
    missing.push("expiry");
  }

  return missing;
}

function strategyMissingFields(raw: string) {
  const missing: string[] = [];
  const hasAmount = hasCurrencyAmount(raw) || /amount|金额|预算/i.test(raw);
  const hasDirection = /\b(up|down|call|put|long|short)\b|涨|跌|做多|做空|看涨|看跌/i.test(raw);

  if (!hasAmount) {
    missing.push("amount");
  }

  if (!hasDirection && !/hedge|对冲/i.test(raw)) {
    missing.push("direction");
  }

  return missing;
}

function vaultLpMissingFields(raw: string) {
  const normalized = raw.toLowerCase();
  const infoOnly = /\b(show|check|info|status|performance)\b|查看|看看|表现|信息|状态/.test(normalized);

  return infoOnly || hasCurrencyAmount(raw) ? [] : ["amount"];
}

function isAdviceQuestion(raw: string) {
  const normalized = raw.toLowerCase();

  return (
    /\bshould\s+i\s+(buy|sell|bet|short|long)\b/.test(normalized) ||
    /\b(recommend|advice|advise|suggestion)\b/.test(normalized) ||
    /\bshould\s+i\s+(hedge|split|ladder|allocate|use|open|enter)\b/.test(normalized) ||
    /\b(is|would)\s+it\s+(a\s+)?good\s+idea\s+to\b/.test(normalized) ||
    /(要不要|该不该|建议|能不能).*?(买|卖|做多|做空|下注)/.test(raw) ||
    /(什么是|怎么理解|解释一下|是什么意思).*?(对冲|策略|分批)/.test(raw)
  );
}

function isExplicitTradeRequest(raw: string) {
  const normalized = raw.toLowerCase();

  return (
    /\b(bet|mint|redeem|claim|execute|order)\b/.test(normalized) ||
    /\b(buy|sell)\b.*\b(dusdc|usdc|down|up|position|contract|predict)\b/.test(normalized) ||
    /(帮我|我要|给我|执行|下单|下注|买|买入|卖出|赎回|领取|做多|做空).*?(btc|eth|sol|trx|跌|涨|down|up|dusdc|usdc|\d+\s*u)/i.test(raw) ||
    /(买跌|买涨|做空|做多).*?(\d+(?:\.\d+)?\s*(u|dusdc|usdc|\$))/i.test(normalizeCurrencyText(raw))
  );
}

function isExplicitStrategyRequest(raw: string) {
  const hasStrategyWord =
    /\b(strategy|hedge|split|ladder|multi-leg|multi leg|portfolio plan)\b/i.test(raw) ||
    /(策略|对冲|分批|阶梯|多笔|多腿|一小时|两小时|二小时|三小时|1小时|2小时|3小时)/i.test(raw);
  const hasExecutionCue =
    /\b(build|draft|open|execute|bet|buy|allocate|plan|play)\b/i.test(raw) ||
    /(帮我|我要|给我|执行|下单|下注|开|开仓|买|买入|做|玩|生成|安排|分配)/i.test(raw);

  return hasStrategyWord && (hasExecutionCue || hasCurrencyAmount(raw));
}

function hasCurrencyAmount(raw: string) {
  return /(\d+(?:\.\d+)?)\s*(?:d?usdc|u|\$)/i.test(normalizeCurrencyText(raw));
}

function normalizeCurrencyText(raw: string) {
  return raw.replace(/([a-z])\s+(?=[a-z])/gi, "$1");
}

function inferContextAsset(context?: ConversationContext | null): PilotClassification["asset"] {
  const text = [
    context?.lastMarketThesis ?? "",
    context?.memoryContext ?? "",
    ...(context?.messages ?? []).map((message) => message.content)
  ].join(" ");

  return detectAsset(text);
}

function summarizeConversationContext(context?: ConversationContext | null) {
  if (!context) {
    return null;
  }

  return {
    lastMarketThesis: context.lastMarketThesis ?? null,
    memoryContext: context.memoryContext ?? null,
    messages: context.messages.slice(-6).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 700),
      mode: message.mode,
      sourceTitles: message.sourceTitles?.slice(0, 4) ?? []
    }))
  };
}

function classifierPrompt() {
  return `You are DeepPilot's pilot router. Return JSON only.

Task:
Classify one user message as either:
- "vault_lp": the user explicitly asks to deposit/supply DUSDC into the DeepBook Predict Vault LP, withdraw from Vault LP, or check Vault LP/PLP performance.
- "trade": the user explicitly asks DeepPilot to execute, place, mint, buy/sell a Predict position, redeem, claim, or build a transaction review.
- "strategy": the user explicitly asks DeepPilot to build a multi-leg trading plan, hedge, split, ladder, or allocate positions across several expiries.
- "chat": the user asks about market movement, price performance, news, protocol risk, vault/oracle state, explanations, or asks for financial advice.

Important safety rule:
If the user asks "should I buy/sell/bet" or asks for a recommendation, classify as "chat", not "trade" or "strategy". Chat can explain data and risk, but must not recommend a trade.
Use conversationContext and memoryContext only as context. If the current user message explicitly says buy, bet, mint, order, execute, 买, 买跌, 买涨, 下单, 下注, or 执行, recent BTC market discussion or stored last trade shape may fill the asset context. Never classify a pure follow-up advice question as trade.
For trade wording, fastest settlement / nearest expiry / 最近结算 / 最快结算 means the next active Predict expiry.
Strategy trigger examples: hedge, split, ladder, multi-leg, 分批, 对冲, 一小时两小时三小时. Only use strategy when the user asks to draft or execute a plan with multiple legs.
Vault LP examples: deposit 1 DUSDC to Vault LP, supply liquidity, withdraw 1 DUSDC from PLP, 把 1 DUSDC 存进 LP vault, 从 LP 取出 1 DUSDC. Do not confuse Vault LP with PredictManager or Trading Balance funding.

Supported assets: BTC, ETH, SOL, TRX.

Return this JSON object:
{
  "mode": "chat" | "trade" | "strategy" | "vault_lp",
  "asset": "BTC" | "ETH" | "SOL" | "TRX" | null,
  "question": "cleaned user question",
  "missing": ["amount", "direction", "expiry"]
}`;
}
