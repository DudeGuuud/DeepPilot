import { z } from "zod";

import type { ParsedIntent, TradeSide } from "./types";

const unsafeInstructionPattern =
  /(ignore|bypass|skip|disable|绕过|忽略|关闭).*(guardian|guard|risk|risk check|风控|守护)|private key|seed phrase|mnemonic/i;

const addressPattern = /0x[a-fA-F0-9]{16,64}/;

const intentSchema = z.object({
  text: z.string().trim().min(1).max(500)
});

export function parseIntent(input: string): ParsedIntent {
  const parsed = intentSchema.safeParse({ text: input });

  if (!parsed.success) {
    return {
      status: "needs_clarification",
      missing: ["intent"],
      reason: "Tell DeepPilot what to trade, transfer, or preview.",
      raw: input
    };
  }

  const raw = parsed.data.text;
  const normalized = raw.replace(/\s+/g, " ").trim();

  if (unsafeInstructionPattern.test(normalized)) {
    return {
      status: "needs_clarification",
      missing: ["safe_intent"],
      reason: "DeepPilot only parses trading intent. It will not bypass Guardian or handle secrets.",
      raw
    };
  }

  const lower = normalized.toLowerCase();
  const isQuoteOnly = /\b(quote|preview|simulate|check)\b/i.test(normalized) || /报价|预览|模拟/.test(normalized);
  const isTransfer = /\b(send|transfer)\b/i.test(normalized) || /转账|发送/.test(normalized);
  const side = detectSide(normalized);
  const amountMatch = normalized.match(/(\d+(?:\.\d+)?)/);
  const amount = amountMatch?.[1];
  const maxSlippageBps = parseSlippageBps(normalized);
  const recipient = normalized.match(addressPattern)?.[0];
  const baseToken = detectToken(normalized, ["SUI", "DEEP", "WAL", "BTC", "ETH"]) ?? "SUI";
  const quoteToken = detectToken(normalized, ["USDC", "USDT", "USD", "SUI"]) ?? "USDC";

  if (isTransfer) {
    const transferToken = detectToken(normalized, ["USDC", "USDT", "SUI"]) ?? quoteToken;

    if (!amount || !transferToken || !recipient) {
      return {
        status: "needs_clarification",
        missing: [
          !amount ? "amount" : null,
          !transferToken ? "asset" : null,
          !recipient ? "recipient" : null
        ].filter(Boolean) as string[],
        reason: "Stablecoin transfers need an amount, asset, and recipient address.",
        raw
      };
    }

    return {
      status: "ready",
      action: "stablecoin_transfer",
      side: "sell",
      baseToken: transferToken,
      quoteToken: transferToken,
      amount,
      amountType: "base",
      maxSlippageBps: 0,
      venue: "deepbook",
      confirmationRequired: true,
      recipient,
      raw
    };
  }

  if (!side && !isQuoteOnly) {
    return {
      status: "needs_clarification",
      missing: ["direction"],
      reason: "Specify buy, sell, or quote-only preview.",
      raw
    };
  }

  if (!amount) {
    return {
      status: "needs_clarification",
      missing: ["amount"],
      reason: "Specify the order size.",
      raw
    };
  }

  const action = /\blimit\b|限价/i.test(normalized) ? "deepbook_limit_order" : isQuoteOnly ? "quote_only" : "deepbook_market_order";
  const limitPrice = normalized.match(/(?:limit|price|at|价格|限价)\D*(\d+(?:\.\d+)?)/i)?.[1];
  const amountType = lower.includes("worth") || lower.includes("usdc") || /价值|用/.test(normalized) ? "quote" : "base";

  return {
    status: "ready",
    action,
    side: side ?? "buy",
    baseToken: baseToken === quoteToken ? "SUI" : baseToken,
    quoteToken: quoteToken === "USD" ? "USDC" : quoteToken,
    amount,
    amountType,
    maxSlippageBps,
    venue: "deepbook",
    confirmationRequired: true,
    limitPrice,
    raw
  };
}

function detectSide(text: string): TradeSide | null {
  if (/\b(buy|long)\b/i.test(text) || /买|买入/.test(text)) {
    return "buy";
  }

  if (/\b(sell|short)\b/i.test(text) || /卖|卖出/.test(text)) {
    return "sell";
  }

  return null;
}

function detectToken(text: string, tokens: string[]) {
  return tokens.find((token) => new RegExp(`\\b${token}\\b`, "i").test(text));
}

function parseSlippageBps(text: string) {
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/);

  if (!percent) {
    return 50;
  }

  return Math.round(Number(percent[1]) * 100);
}

