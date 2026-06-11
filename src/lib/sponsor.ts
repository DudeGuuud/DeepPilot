import { predictDeployment } from "./predict";
import type { GasMode, GuardianResult, ParsedIntent, PredictMarketSnapshot, SponsorDecision, SponsorPolicy } from "./types";

export const sponsorPolicy: SponsorPolicy = {
  allowedPackages: [predictDeployment.packageId, "deep_pilot_log"],
  allowedMoveCalls: [
    "predict::mint",
    "predict::mint_range",
    "predict::redeem_permissionless",
    "deep_pilot_log::log::record_intent",
    "coin::transfer"
  ],
  maxGasBudget: 20_000_000,
  maxTradeSizeDusdc: 1_000,
  maxDailySponsoredTxPerWallet: 20
};

export function decideGasMode(
  intent: ParsedIntent,
  guardian: GuardianResult,
  market: PredictMarketSnapshot | null
): SponsorDecision {
  if (intent.status !== "ready") {
    return decision("user_pays_gas", false, "Awaiting complete Predict intent", [
      ["complete intent", false],
      ["guardian not blocked", !guardian.blocked]
    ]);
  }

  if (intent.action === "stablecoin_transfer") {
    return decision("gasless_stablecoin_transfer", !guardian.blocked, "Gasless DUSDC transfer preview", [
      ["DUSDC transfer", true],
      ["guardian not blocked", !guardian.blocked]
    ]);
  }

  const tradeSize = market?.metrics.notionalDusdc ?? Number(intent.amount);
  const sponsorApproved = !guardian.blocked && tradeSize <= sponsorPolicy.maxTradeSizeDusdc;

  return decision("sponsored", sponsorApproved, "Sponsored by DeepPilot", [
    ["Predict package allowlisted", sponsorPolicy.allowedPackages.includes(predictDeployment.packageId)],
    ["Predict Move call allowlisted", true],
    ["trade size within demo cap", tradeSize <= sponsorPolicy.maxTradeSizeDusdc],
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
