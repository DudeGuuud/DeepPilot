import { z } from "zod";

import type { PilotClassification } from "./types";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const CLASSIFIER_TIMEOUT_MS = 8_000;

const classifierSchema = z.object({
  mode: z.enum(["chat", "trade"]),
  asset: z.enum(["BTC", "ETH", "SOL", "TRX"]).nullable(),
  question: z.string().trim().min(1).max(500),
  missing: z.array(z.string()).default([])
});

type ClassifierOutput = z.infer<typeof classifierSchema>;

export async function classifyPilotInput(input: string): Promise<PilotClassification> {
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
    return fallbackClassification(raw);
  }

  try {
    const classified = await callDeepSeekClassifier(raw, apiKey);

    return {
      ...classified,
      question: classified.question || raw,
      draftIntent: null
    };
  } catch {
    return fallbackClassification(raw);
  }
}

async function callDeepSeekClassifier(raw: string, apiKey: string): Promise<ClassifierOutput> {
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
              text: raw
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
  if (classified.mode === "chat") {
    return {
      ...classified,
      missing: []
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

function fallbackClassification(raw: string): PilotClassification {
  const normalized = raw.toLowerCase();
  const asset = detectAsset(raw);
  const adviceQuestion =
    /\bshould\s+i\s+(buy|sell|bet|short|long)\b/.test(normalized) ||
    /\b(recommend|advice|advise|suggestion)\b/.test(normalized) ||
    /(要不要|该不该|建议|能不能).*?(买|卖|做多|做空|下注)/.test(raw);
  const explicitTrade =
    /\b(bet|mint|redeem|claim|execute|order)\b/.test(normalized) ||
    /\b(buy|sell)\b.*\b(dusdc|usdc|down|up|position|contract|predict)\b/.test(normalized) ||
    /(帮我|我要|给我|执行|下单|下注|买入|卖出|赎回|领取|做多|做空).*?(btc|eth|sol|trx|跌|涨|down|up|dusdc|usdc|\d+\s*u)/i.test(raw);
  const mode = explicitTrade && !adviceQuestion ? "trade" : "chat";
  const missing = mode === "trade" ? tradeMissingFields(raw) : [];

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
  const hasAmount = /(\d+(?:\.\d+)?\s*(u|dusdc|usdc|\$)|amount|金额)/i.test(raw);
  const hasDirection = /\b(up|down|call|put)\b|涨|跌|做多|做空/i.test(raw);
  const hasExpiry = /\b(next|tonight|today|tomorrow|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2})\b|今天|今晚|明天|到期|六点|[0-2]?\d点/i.test(raw);
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

function classifierPrompt() {
  return `You are DeepPilot's pilot router. Return JSON only.

Task:
Classify one user message as either:
- "trade": the user explicitly asks DeepPilot to execute, place, mint, buy/sell a Predict position, redeem, claim, or build a transaction review.
- "chat": the user asks about market movement, price performance, news, protocol risk, vault/oracle state, explanations, or asks for financial advice.

Important safety rule:
If the user asks "should I buy/sell/bet" or asks for a recommendation, classify as "chat", not "trade". Chat can explain data and risk, but must not recommend a trade.

Supported assets: BTC, ETH, SOL, TRX.

Return this JSON object:
{
  "mode": "chat" | "trade",
  "asset": "BTC" | "ETH" | "SOL" | "TRX" | null,
  "question": "cleaned user question",
  "missing": ["amount", "direction", "expiry"]
}`;
}
