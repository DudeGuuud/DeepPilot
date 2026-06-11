import type { GuardianFinding, GuardianResult, ParsedIntent, PredictMarketSnapshot } from "./types";

const HIGH_VAULT_UTILIZATION = 0.65;
const HIGH_MAX_PAYOUT_UTILIZATION = 0.8;
const LIQUIDITY_BUFFER_MULTIPLE = 5;

export function runGuardian(intent: ParsedIntent, market: PredictMarketSnapshot | null): GuardianResult {
  if (intent.status !== "ready") {
    return blockedResult("INCOMPLETE_INTENT", "Clarification required", intent.reason);
  }

  if (intent.action === "stablecoin_transfer") {
    return {
      score: 12,
      level: "low",
      blocked: false,
      decision: "allow",
      findings: [],
      summary: "DUSDC transfer is outside Predict trading risk and can use the transfer policy."
    };
  }

  if (!market) {
    return blockedResult("API_UNAVAILABLE", "Predict market unavailable", "DeepBook Predict state is required before signing.");
  }

  const findings: GuardianFinding[] = [];
  const { metrics, oracle } = market;

  if (oracle.status !== "active" && intent.action !== "predict_redeem") {
    findings.push({
      type: "ORACLE_NOT_ACTIVE",
      title: "Oracle is not active",
      explanation: `Current oracle status is ${oracle.status}; new mint actions require an active oracle.`
    });
  }

  if (metrics.timeToExpiryMs <= 0 && intent.action !== "predict_redeem") {
    findings.push({
      type: "EXPIRED_ORACLE",
      title: "Oracle has expired",
      explanation: "This market has reached expiry. Switch to redeem flow or choose a live oracle."
    });
  }

  if (metrics.oracleAgeMs === null || metrics.oracleAgeMs > intent.maxOracleAgeMs) {
    findings.push({
      type: "ORACLE_STALE",
      title: "Oracle price is stale",
      explanation: `Latest oracle price age is ${formatAge(metrics.oracleAgeMs)}, above the ${formatAge(intent.maxOracleAgeMs)} policy.`
    });
  }

  if (metrics.pipelineLagSeconds > intent.maxPipelineLagSeconds) {
    findings.push({
      type: "INDEXER_LAG",
      title: "Predict server is lagging",
      explanation: `Indexer lag is ${metrics.pipelineLagSeconds}s, above the ${intent.maxPipelineLagSeconds}s policy.`
    });
  }

  if (metrics.vaultUtilization > HIGH_VAULT_UTILIZATION || metrics.maxPayoutUtilization > HIGH_MAX_PAYOUT_UTILIZATION) {
    findings.push({
      type: "HIGH_VAULT_UTILIZATION",
      title: "Vault risk is elevated",
      explanation: `Vault utilization is ${(metrics.vaultUtilization * 100).toFixed(2)}%; max-payout utilization is ${(metrics.maxPayoutUtilization * 100).toFixed(2)}%.`
    });
  }

  if (metrics.notionalDusdc > metrics.availableLiquidityDusdc / LIQUIDITY_BUFFER_MULTIPLE) {
    findings.push({
      type: "SIZE_OVER_LIQUIDITY",
      title: "Trade size is too large",
      explanation: `${metrics.notionalDusdc.toLocaleString()} DUSDC is high relative to ${metrics.availableLiquidityDusdc.toLocaleString()} DUSDC available liquidity.`
    });
  }

  if (!metrics.askBoundsAvailable) {
    findings.push({
      type: "MISSING_ASK_BOUNDS",
      title: "Ask bounds unavailable",
      explanation: "Predict server returned null ask-bounds, so Guardian falls back to oracle freshness and vault utilization checks."
    });
  }

  const score = Math.min(
    100,
    findings.reduce((total, finding) => total + findingWeight(finding.type), 6)
  );
  const hardBlock = findings.some((finding) =>
    ["ORACLE_NOT_ACTIVE", "EXPIRED_ORACLE", "ORACLE_STALE", "INDEXER_LAG", "SIZE_OVER_LIQUIDITY"].includes(finding.type)
  );
  const blocked = hardBlock || score >= 80;
  const level = blocked ? "blocked" : score >= 55 ? "high" : score >= 24 ? "medium" : "low";

  return {
    score,
    level,
    blocked,
    decision: blocked ? "block" : level === "low" ? "allow" : "reduce",
    findings,
    summary: blocked
      ? "Guardian blocks signing until market state or intent changes."
      : findings.length > 0
        ? "Guardian allows preview with reduced-confidence warnings."
        : "Predict market checks passed."
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
    case "INCOMPLETE_INTENT":
    case "API_UNAVAILABLE":
    case "UNSUPPORTED_INTENT":
      return 100;
    case "ORACLE_STALE":
    case "INDEXER_LAG":
      return 72;
    case "ORACLE_NOT_ACTIVE":
    case "EXPIRED_ORACLE":
      return 80;
    case "SIZE_OVER_LIQUIDITY":
      return 64;
    case "HIGH_VAULT_UTILIZATION":
      return 34;
    case "MISSING_ASK_BOUNDS":
      return 10;
    case "DUSDC_REQUIRED":
      return 48;
  }
}

function formatAge(valueMs: number | null) {
  if (valueMs === null) {
    return "unknown";
  }

  if (valueMs < 1_000) {
    return `${valueMs}ms`;
  }

  return `${(valueMs / 1_000).toFixed(1)}s`;
}
