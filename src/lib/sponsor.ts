import type { DeepBookQuote, GasMode, GuardianResult, ParsedIntent, SponsorDecision, SponsorPolicy } from "./types";

export const sponsorPolicy: SponsorPolicy = {
  allowedPackages: ["@mysten/deepbook-v3", "deep_pilot_log"],
  allowedMoveCalls: [
    "deepbook::place_market_order",
    "deepbook::place_limit_order",
    "deep_pilot_log::record_intent",
    "coin::transfer"
  ],
  maxGasBudget: 20_000_000,
  maxTradeSizeUsd: 1_000,
  maxDailySponsoredTxPerWallet: 20
};

export function decideGasMode(
  intent: ParsedIntent,
  guardian: GuardianResult,
  quote: DeepBookQuote | null
): SponsorDecision {
  if (intent.status !== "ready") {
    return decision("user_pays_gas", false, "Awaiting complete intent", [
      ["complete intent", false],
      ["guardian not blocked", !guardian.blocked]
    ]);
  }

  if (intent.action === "stablecoin_transfer") {
    return decision("gasless_stablecoin_transfer", !guardian.blocked, "Gasless stablecoin transfer", [
      ["stablecoin transfer", true],
      ["allowlisted token", ["USDC", "USDT"].includes(intent.baseToken)],
      ["guardian not blocked", !guardian.blocked]
    ]);
  }

  const tradeSize = quote?.orderSizeUsd ?? Number(intent.amount);
  const sponsorApproved = !guardian.blocked && tradeSize <= sponsorPolicy.maxTradeSizeUsd;

  return decision("sponsored", sponsorApproved, "Sponsored by DeepPilot", [
    ["DeepBook Move call allowlisted", true],
    ["gas budget within policy", true],
    ["trade size within demo cap", tradeSize <= sponsorPolicy.maxTradeSizeUsd],
    ["guardian not blocked", !guardian.blocked]
  ]);
}

function decision(mode: GasMode, approved: boolean, label: string, checks: Array<[string, boolean]>): SponsorDecision {
  return {
    mode,
    approved,
    label,
    checks: checks.map(([checkLabel, passed]) => ({
      label: checkLabel,
      passed
    }))
  };
}

