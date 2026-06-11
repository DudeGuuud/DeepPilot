import { z } from "zod";

import type { ParsedIntent, PredictDirection } from "./types";

const unsafeInstructionPattern =
  /(ignore|bypass|skip|disable|绕过|忽略|关闭).*(guardian|guard|risk|risk check|风控|守护)|private key|seed phrase|mnemonic/i;

const objectIdPattern = /0x[a-fA-F0-9]{16,64}/;

const intentSchema = z.object({
  text: z.string().trim().min(1).max(500)
});

export function parseIntent(input: string): ParsedIntent {
  const parsed = intentSchema.safeParse({ text: input });

  if (!parsed.success) {
    return needsClarification(input, ["intent"], "Tell DeepPilot what Predict action to preview or execute.");
  }

  const raw = parsed.data.text;
  const normalized = raw.replace(/\s+/g, " ").trim();

  if (unsafeInstructionPattern.test(normalized)) {
    return needsClarification(
      raw,
      ["safe_intent"],
      "DeepPilot parses Predict intent only. It will not bypass Guardian or handle secrets."
    );
  }

  const action = detectAction(normalized);
  const amount = parseAmount(normalized);
  const direction = detectDirection(normalized);
  const oracleId = normalized.match(objectIdPattern)?.[0];
  const range = parseRange(normalized);
  const strike = parseStrike(normalized, range);

  if (action === "stablecoin_transfer") {
    const recipient = oracleId;

    if (!amount || !recipient) {
      return needsClarification(raw, [!amount ? "amount" : null, !recipient ? "recipient" : null], "DUSDC transfers need an amount and recipient address.");
    }

    return {
      status: "ready",
      action,
      underlying: "BTC",
      quoteAsset: "DUSDC",
      amount,
      amountType: "quote",
      maxOracleAgeMs: 20_000,
      maxPipelineLagSeconds: 5,
      recipient,
      raw
    };
  }

  if (action !== "predict_redeem" && !amount) {
    return needsClarification(raw, ["amount"], "Specify the DUSDC notional for the Predict action.");
  }

  if (action === "predict_binary_mint" && !direction) {
    return needsClarification(raw, ["direction"], "Specify UP/CALL or DOWN/PUT for the binary Predict position.");
  }

  if (action === "predict_range_mint" && (!range.lowerStrike || !range.upperStrike)) {
    return needsClarification(raw, ["range"], "Range positions need lower and upper BTC strikes.");
  }

  // Redeem is tied to a settled oracle/position; guessing the next active oracle would be unsafe.
  if (action === "predict_redeem" && !oracleId) {
    return needsClarification(raw, ["oracle"], "Redeem needs the settled oracle id or a manager-specific position lookup.");
  }

  return {
    status: "ready",
    action,
    direction,
    underlying: "BTC",
    quoteAsset: "DUSDC",
    amount: amount ?? "0",
    amountType: "quote",
    maxOracleAgeMs: parseOracleAgeMs(normalized),
    maxPipelineLagSeconds: parseLagSeconds(normalized),
    strike,
    lowerStrike: range.lowerStrike,
    upperStrike: range.upperStrike,
    oracleId,
    raw
  };
}

function detectAction(text: string): Extract<ParsedIntent, { status: "ready" }>["action"] {
  if (/\b(redeem|claim|settle)\b/i.test(text) || /赎回|领取|结算/.test(text)) {
    return "predict_redeem";
  }

  if (/\b(send|transfer)\b/i.test(text) || /转账|发送/.test(text)) {
    return "stablecoin_transfer";
  }

  if (/\b(range|between)\b/i.test(text) || /区间|范围|之间/.test(text)) {
    return "predict_range_mint";
  }

  if (/\b(quote|preview|simulate|check)\b/i.test(text) || /报价|预览|模拟|检查/.test(text)) {
    return "predict_quote_only";
  }

  return "predict_binary_mint";
}

function detectDirection(text: string): PredictDirection | undefined {
  if (/\b(up|call|above|higher|long)\b/i.test(text) || /涨|看涨|向上/.test(text)) {
    return "up";
  }

  if (/\b(down|put|below|lower|short)\b/i.test(text) || /跌|看跌|向下/.test(text)) {
    return "down";
  }

  return undefined;
}

function parseAmount(text: string) {
  const explicit = text.match(/(\d+(?:\.\d+)?)\s*(?:d?usdc|\$)/i);

  if (explicit) {
    return explicit[1];
  }

  const fallback = text.match(/(?:buy|mint|spend|用|买入|购买)\D{0,12}(\d+(?:\.\d+)?)/i);

  return fallback?.[1];
}

function parseRange(text: string) {
  const between = text.match(/(?:between|range|区间|范围|从)\D*(\d{4,8}(?:\.\d+)?)\D+(?:and|to|-|到|至)\D*(\d{4,8}(?:\.\d+)?)/i);

  if (!between) {
    return {};
  }

  const left = Number(between[1]);
  const right = Number(between[2]);

  return {
    lowerStrike: Math.min(left, right),
    upperStrike: Math.max(left, right)
  };
}

function parseStrike(text: string, range: { lowerStrike?: number; upperStrike?: number }) {
  if (range.lowerStrike && range.upperStrike) {
    return undefined;
  }

  const strike = text.match(/(?:strike|near|at|above|below|行权价|接近|高于|低于)\D*(\d{4,8}(?:\.\d+)?)/i);

  return strike ? Number(strike[1]) : undefined;
}

function parseOracleAgeMs(text: string) {
  const seconds = text.match(/(?:oracle|price|data|预言机|价格|数据)\D{0,20}(\d+(?:\.\d+)?)\s*(?:s|sec|second|seconds|秒)/i);

  return seconds ? Math.round(Number(seconds[1]) * 1_000) : 20_000;
}

function parseLagSeconds(text: string) {
  const seconds = text.match(/(?:lag|delay|延迟|滞后)\D{0,20}(\d+(?:\.\d+)?)\s*(?:s|sec|second|seconds|秒)/i);

  return seconds ? Number(seconds[1]) : 5;
}

function needsClarification(raw: string, missing: Array<string | null>, reason: string): ParsedIntent {
  return {
    status: "needs_clarification",
    missing: missing.filter(Boolean) as string[],
    reason,
    raw
  };
}
