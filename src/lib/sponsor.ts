import { predictDeployment } from "./predict";
import type {
  GasMode,
  GuardianResult,
  ParsedIntent,
  PredictMarketSnapshot,
  PtbPlan,
  SponsorDecision,
  SponsorPolicy
} from "./types";

export const sponsorPolicy: SponsorPolicy = {
  allowedPackages: [predictDeployment.packageId, "deep_pilot_log", "0x2"],
  allowedMoveCalls: [
    "market_key::up",
    "market_key::down",
    "range_key::new",
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

const sponsorPlanCheckLabels = new Set([
  "PTB preview exists",
  "programmable transaction kind",
  "gas budget within sponsor cap",
  "all Move targets allowlisted"
]);

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

  if (intent.action === "predict_quote_only") {
    return decision("user_pays_gas", false, "Quote-only preview; no sponsor required", [
      ["quote-only intent", true],
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

export function validateSponsorPlan(gas: SponsorDecision, ptb: PtbPlan | null): SponsorDecision {
  // The sponsor boundary must validate the compiled PTB, not just the user's intent.
  const checks: Array<[string, boolean]> = [
    ["PTB preview exists", Boolean(ptb)],
    ["programmable transaction kind", ptb?.transactionKind === "ProgrammableTransaction"],
    ["gas budget within sponsor cap", Boolean(ptb && ptb.gasBudget <= sponsorPolicy.maxGasBudget)],
    ["all Move targets allowlisted", Boolean(ptb && ptb.commands.every((command) => isAllowedTarget(command.target)))]
  ];
  const passed = checks.every(([, checkPassed]) => checkPassed);

  return {
    ...gas,
    approved: gas.approved && passed,
    checks: [
      ...gas.checks.filter((check) => !sponsorPlanCheckLabels.has(check.label)),
      ...checks.map(([label, checkPassed]) => ({
        label,
        passed: checkPassed
      }))
    ]
  };
}

function isAllowedTarget(target: string) {
  const [packageId, moduleName, functionName, extra] = target.split("::");

  if (!packageId || !moduleName || !functionName || extra) {
    return false;
  }

  const moveCall = `${moduleName}::${functionName}`;
  const deepPilotMoveCall = `${packageId}::${moduleName}::${functionName}`;

  return (
    sponsorPolicy.allowedPackages.includes(packageId) &&
    (sponsorPolicy.allowedMoveCalls.includes(moveCall) || sponsorPolicy.allowedMoveCalls.includes(deepPilotMoveCall))
  );
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
