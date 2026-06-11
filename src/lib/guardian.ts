import type { DeepBookQuote, GuardianFinding, GuardianResult, ParsedIntent } from "./types";

export function runGuardian(intent: ParsedIntent, quote: DeepBookQuote | null): GuardianResult {
  if (intent.status !== "ready") {
    return {
      score: 100,
      level: "blocked",
      blocked: true,
      decision: "block",
      findings: [
        {
          type: "UNSUPPORTED_INTENT",
          title: "Clarification required",
          explanation: intent.reason
        }
      ],
      summary: "Guardian is waiting for a complete, safe intent."
    };
  }

  if (intent.action === "stablecoin_transfer") {
    return {
      score: 12,
      level: "low",
      blocked: false,
      decision: "allow",
      findings: [],
      summary: "Stablecoin transfer path is eligible for gasless preview."
    };
  }

  if (!quote) {
    return blockedResult("UNSUPPORTED_INTENT", "No quote available", "DeepBook data is required before signing.");
  }

  const findings: GuardianFinding[] = [];

  if (quote.estimatedSlippageBps > intent.maxSlippageBps) {
    findings.push({
      type: "HIGH_SLIPPAGE",
      title: "Slippage above limit",
      explanation: `Estimated slippage is ${quote.estimatedSlippageBps / 100}%, above your ${intent.maxSlippageBps / 100}% limit.`
    });
  }

  if (quote.visibleDepthUsd < quote.orderSizeUsd * 8) {
    findings.push({
      type: "LOW_LIQUIDITY",
      title: "Thin visible depth",
      explanation: "The current order book cannot fill this size cleanly."
    });
  }

  if (quote.quoteAgeMs > 20_000) {
    findings.push({
      type: "STALE_QUOTE",
      title: "Quote is stale",
      explanation: "Refresh the quote before signing."
    });
  }

  if (quote.spreadBps > 15) {
    findings.push({
      type: "WIDE_SPREAD",
      title: "Wide spread",
      explanation: "The bid/ask spread is wider than the default Guardian threshold."
    });
  }

  if (quote.orderSizeUsd > 5_000) {
    findings.push({
      type: "LARGE_ORDER_SIZE",
      title: "Large order size",
      explanation: "Order size is high for the visible book depth in this demo market."
    });
  }

  const score = Math.min(
    100,
    findings.reduce((total, finding) => total + findingWeight(finding.type), 8)
  );
  const blockedBySlippage = findings.some((finding) => finding.type === "HIGH_SLIPPAGE");
  const blocked = blockedBySlippage || score >= 80;
  const level = blocked ? "blocked" : score >= 60 ? "high" : score >= 32 ? "medium" : "low";

  return {
    score,
    level,
    blocked,
    decision: blocked ? "block" : level === "low" ? "allow" : "warn",
    findings,
    summary: blocked
      ? "Guardian blocks signing until the intent or quote changes."
      : findings.length > 0
        ? "Guardian allows confirmation with visible warnings."
        : "Guardian checks passed."
  };
}

function blockedResult(type: GuardianFinding["type"], title: string, explanation: string): GuardianResult {
  return {
    score: 100,
    level: "blocked",
    blocked: true,
    decision: "block",
    findings: [{ type, title, explanation }],
    summary: "Guardian blocks signing."
  };
}

function findingWeight(type: GuardianFinding["type"]) {
  switch (type) {
    case "HIGH_SLIPPAGE":
      return 72;
    case "LOW_LIQUIDITY":
      return 34;
    case "STALE_QUOTE":
      return 26;
    case "WIDE_SPREAD":
      return 18;
    case "LARGE_ORDER_SIZE":
      return 20;
    case "UNSUPPORTED_INTENT":
      return 100;
  }
}
