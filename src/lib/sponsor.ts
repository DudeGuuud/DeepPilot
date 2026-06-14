import { auditLogPackageId, sponsorLimits } from "./execution-config";
import { predictDeployment } from "./predict";
import type {
  GasMode,
  GuardianResult,
  ParsedIntent,
  PredictMarketSnapshot,
  PredictQuotePreview,
  PtbPlan,
  SponsorDecision,
  SponsorPolicy
} from "./types";

export const sponsorPolicy: SponsorPolicy = {
  allowedPackages: [predictDeployment.packageId, auditLogPackageId, "0x2"],
  allowedMoveCalls: [
    "market_key::up",
    "market_key::down",
    "range_key::new",
    "predict::create_manager",
    "predict::mint",
    "predict::mint_range",
    "predict::redeem_permissionless",
    "log::record_intent",
    "coin::transfer"
  ],
  maxGasBudget: sponsorLimits.maxGasBudget,
  maxTradeSizeDusdc: sponsorLimits.maxTradeSizeDusdc
};

const sponsorPlanCheckLabels = new Set([
  "PTB preview exists",
  "programmable transaction kind",
  "gas budget within sponsor cap",
  "all sponsored amounts within cap",
  "all Move targets allowlisted"
]);

export function decideGasMode(
  intent: ParsedIntent,
  guardian: GuardianResult,
  market: PredictMarketSnapshot | null,
  quote: PredictQuotePreview | null = null
): SponsorDecision {
  if (intent.status !== "ready") {
    return decision("user_pays_gas", false, "Awaiting complete Predict intent", [
      ["complete intent", false],
      ["guardian not blocked", !guardian.blocked]
    ]);
  }

  if (intent.action === "stablecoin_transfer") {
    const transferSize = Number(intent.amount);
    const withinCap = amountWithinSponsorCap(transferSize);

    return decision("gasless_stablecoin_transfer", !guardian.blocked && withinCap, "Gasless DUSDC transfer preview", [
      ["DUSDC transfer", true],
      ["transfer size within sponsor cap", withinCap],
      ["guardian not blocked", !guardian.blocked]
    ]);
  }

  if (intent.action === "predict_quote_only") {
    return decision("user_pays_gas", false, "Quote-only preview; no sponsor required", [
      ["quote-only intent", true],
      ["guardian not blocked", !guardian.blocked]
    ]);
  }

  const tradeSize = quote?.status === "available" && quote.estimatedCostDusdc !== null
    ? quote.estimatedCostDusdc
    : market?.metrics.notionalDusdc ?? Number(intent.amount);
  const walletExecutionReady = !guardian.blocked && amountWithinSponsorCap(tradeSize);

  return decision("user_pays_gas", walletExecutionReady, "Wallet pays Sui gas", [
    ["Predict package allowlisted", sponsorPolicy.allowedPackages.includes(predictDeployment.packageId)],
    ["Predict Move call allowlisted", true],
    ["trade size within policy cap", amountWithinSponsorCap(tradeSize)],
    ["guardian not blocked", !guardian.blocked]
  ]);
}

export function validateSponsorPlan(gas: SponsorDecision, ptb: PtbPlan | null): SponsorDecision {
  // The sponsor boundary must validate the compiled PTB, not just the user's intent.
  const checks: Array<[string, boolean]> = [
    ["PTB preview exists", Boolean(ptb)],
    ["programmable transaction kind", ptb?.transactionKind === "ProgrammableTransaction"],
    ["gas budget within sponsor cap", Boolean(ptb && ptb.gasBudget <= sponsorPolicy.maxGasBudget)],
    ["all sponsored amounts within cap", Boolean(ptb && ptb.commands.every(commandAmountWithinSponsorCap))],
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

function amountWithinSponsorCap(value: number) {
  return Number.isFinite(value) && value > 0 && value <= sponsorPolicy.maxTradeSizeDusdc;
}

function commandAmountWithinSponsorCap(command: PtbPlan["commands"][number]) {
  const amountBaseUnits = command.inputs?.amountBaseUnits;

  if (typeof amountBaseUnits !== "number") {
    const estimatedCostDusdc = command.inputs?.estimatedCostDusdc;

    if (typeof estimatedCostDusdc === "number") {
      return amountWithinSponsorCap(estimatedCostDusdc);
    }

    const quoteBudgetDusdc = command.inputs?.quoteBudgetDusdc;

    return typeof quoteBudgetDusdc !== "number" || amountWithinSponsorCap(quoteBudgetDusdc);
  }

  return Number.isSafeInteger(amountBaseUnits) && amountBaseUnits >= 0 && amountBaseUnits <= sponsorPolicy.maxTradeSizeDusdc * 1_000_000;
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
