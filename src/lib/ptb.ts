import { createHash } from "node:crypto";

import { auditLogPackageId, auditLogPackageIsPublished, previewAccounts } from "./execution-config";
import { predictDeployment, toDusdcBaseUnits, toPredictPrice } from "./predict";
import { onchainAuditEnabled } from "./predict-config";
import type {
  ExecutionReadiness,
  GuardianResult,
  ParsedIntent,
  PredictMarketSnapshot,
  ProfileSummary,
  PtbCommandPreview,
  PtbPlan,
  PtbTransactionData,
  SponsorDecision,
  TradeSizingPreview
} from "./types";

export function buildPtbPlan(
  intent: ParsedIntent,
  market: PredictMarketSnapshot | null,
  guardian: GuardianResult,
  gas: SponsorDecision,
  profile: ProfileSummary | null = null
): PtbPlan | null {
  if (intent.status !== "ready" || guardian.blocked) {
    return null;
  }

  if (intent.action === "predict_quote_only") {
    return null;
  }

  const commands = buildCommands(intent, market);
  const sizing = buildSizing(intent);
  const execution = buildExecutionReadiness(intent, market, profile, sizing);
  const requirements = buildRequirements(intent, market, execution, sizing);
  const keyTarget = intent.action === "predict_range_mint"
    ? `${predictDeployment.packageId}::range_key::new`
    : `${predictDeployment.packageId}::market_key::${(intent.direction ?? "up") === "up" ? "up" : "down"}`;
  const transactionData: PtbTransactionData = {
    kind: "ProgrammableTransaction",
    network: predictDeployment.network,
    packageId: predictDeployment.packageId,
    predictObject: predictDeployment.predictId,
    quoteAssetType: predictDeployment.quoteAssetType,
    onchainAuditEnabled,
    manager: execution.managerId,
    oracleId: market?.oracle.oracle_id ?? intent.oracleId ?? null,
    key: {
      target: intent.action === "stablecoin_transfer" ? null : keyTarget,
      oracleId: market?.oracle.oracle_id ?? intent.oracleId ?? null,
      expiry: market?.oracle.expiry ?? null,
      strikeScaled: scaledStrike(market, intent),
      direction: intent.direction ?? null
    },
    mint: {
      target: intent.action === "predict_binary_mint" ? `${predictDeployment.packageId}::predict::mint` : null,
      quantityRaw: sizing.quantityRaw
    },
    intent: {
      action: intent.action,
      direction: intent.direction,
      amount: intent.amount,
      amountType: intent.amountType,
      quoteBudgetDusdc: sizing.quoteBudgetDusdc,
      quantityRaw: sizing.quantityRaw,
      strike: market?.metrics.selectedStrike ?? intent.strike ?? null,
      strikeScaled: scaledStrike(market, intent),
      lowerStrike: intent.lowerStrike ?? null,
      lowerStrikeScaled: intent.lowerStrike ? toPredictPrice(intent.lowerStrike) : null,
      upperStrike: intent.upperStrike ?? null
    },
    requirements,
    commands
  };

  return {
    sender: previewAccounts.sender,
    sponsor: previewAccounts.sponsor,
    gasBudget: 12_000_000,
    // Sponsored Predict and gasless transfer previews use the sponsor as gas owner.
    gasOwner: gas.mode === "user_pays_gas" ? previewAccounts.sender : previewAccounts.sponsor,
    transactionKind: "ProgrammableTransaction",
    commands,
    requirements,
    sizing,
    execution,
    transactionData,
    digestPreview: digestPreview(JSON.stringify(transactionData)),
    simulated: {
      status: "not_submitted",
      reason: execution.reason,
      explorerReady: execution.canSign
    }
  };
}

function buildCommands(intent: Extract<ParsedIntent, { status: "ready" }>, market: PredictMarketSnapshot | null) {
  const commands: PtbCommandPreview[] = [];
  const oracle = market?.oracle;

  if (intent.action === "stablecoin_transfer") {
    commands.push({
      index: 1,
      command: "Transfer DUSDC",
      target: "0x2::coin::transfer",
      riskGate: "atomic",
      inputs: {
        quoteAssetType: predictDeployment.quoteAssetType,
        amountBaseUnits: toDusdcBaseUnits(Number(intent.amount)),
        recipient: intent.recipient ?? null
      }
    });

    return commands;
  }

  if (intent.action === "predict_redeem") {
    commands.push(binaryKeyCommand(intent, market, 1));
    commands.push({
      index: 2,
      command: `Redeem settled position for ${shortId(market?.oracle.oracle_id ?? intent.oracleId)}`,
      target: `${predictDeployment.packageId}::predict::redeem_permissionless`,
      riskGate: "atomic",
      inputs: predictInputs(intent, market, null)
    });
  } else if (intent.action === "predict_range_mint") {
    commands.push({
      index: 1,
      command: `Build range key ${intent.lowerStrike}-${intent.upperStrike}`,
      target: `${predictDeployment.packageId}::range_key::new`,
      riskGate: "pre-sign",
      inputs: {
        oracleId: oracle?.oracle_id ?? intent.oracleId ?? null,
        expiry: oracle?.expiry ?? null,
        lowerStrikeScaled: intent.lowerStrike ? toPredictPrice(intent.lowerStrike) : null,
        upperStrikeScaled: intent.upperStrike ? toPredictPrice(intent.upperStrike) : null
      }
    });
    commands.push({
      index: 2,
      command: `Mint BTC range ${intent.lowerStrike}-${intent.upperStrike}`,
      target: `${predictDeployment.packageId}::predict::mint_range`,
      riskGate: "atomic",
      inputs: predictInputs(intent, market, intent.quantity ?? null)
    });
  } else {
    commands.push(binaryKeyCommand(intent, market, 1));
    commands.push({
      index: 2,
      command: `Mint BTC ${intent.direction ?? "up"} binary at ${market?.metrics.selectedStrike ?? intent.strike ?? "ATM"}`,
      target: `${predictDeployment.packageId}::predict::mint`,
      riskGate: "atomic",
      inputs: predictInputs(intent, market, intent.quantity ?? null)
    });
  }

  if (onchainAuditEnabled) {
    if (!auditLogPackageIsPublished) {
      throw new Error("DEEP_PILOT_LOG_PACKAGE_ID must be a published 0x package id when on-chain audit logging is enabled.");
    }

    commands.push({
      index: commands.length + 1,
      command: "Record market snapshot hash and Guardian decision",
      target: `${auditLogPackageId}::log::record_intent`,
      riskGate: "receipt",
      inputs: {
        adminCapRequired: true
      }
    });
  }

  return commands;
}

function binaryKeyCommand(intent: Extract<ParsedIntent, { status: "ready" }>, market: PredictMarketSnapshot | null, index: number) {
  const isUp = (intent.direction ?? "up") === "up";

  return {
    index,
    command: `Build ${isUp ? "UP" : "DOWN"} market key`,
    target: `${predictDeployment.packageId}::market_key::${isUp ? "up" : "down"}`,
    riskGate: "pre-sign",
    inputs: {
      oracleId: market?.oracle.oracle_id ?? intent.oracleId ?? null,
      expiry: market?.oracle.expiry ?? null,
      strikeScaled: scaledStrike(market, intent)
    }
  } satisfies PtbCommandPreview;
}

function predictInputs(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot | null,
  quantityRaw: string | null
) {
  return {
    predictObject: predictDeployment.predictId,
    managerObject: previewAccounts.manager,
    oracleObject: market?.oracle.oracle_id ?? intent.oracleId ?? null,
    quoteType: predictDeployment.quoteAssetType,
    quantityRaw,
    quoteBudgetDusdc: intent.amountType === "quote" ? Number(intent.amount) : null,
    clockObject: "0x6"
  };
}

function buildRequirements(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot | null,
  execution: ExecutionReadiness,
  sizing: TradeSizingPreview
) {
  if (intent.action === "stablecoin_transfer") {
    return [
      {
        label: "DUSDC coin input",
        satisfied: false,
        detail: "Wallet must select a DUSDC coin with enough balance for transfer."
      }
    ];
  }

  return [
    {
      label: "PredictManager object",
      satisfied: Boolean(execution.managerId),
      detail: execution.managerId ?? "Create or load the user's shared PredictManager before submitting mint/redeem."
    },
    {
      label: "DUSDC manager balance",
      satisfied: execution.managerBalanceDusdc !== null,
      detail: execution.managerBalanceDusdc === null
        ? "Mint requires DUSDC already deposited into the PredictManager."
        : `${execution.managerBalanceDusdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC trading balance detected.`
    },
    {
      label: "Predict quantity",
      satisfied: sizing.executable,
      detail: sizing.reason
    },
    {
      label: "Oracle object",
      satisfied: Boolean(market?.oracle.oracle_id ?? intent.oracleId),
      detail: market?.oracle.oracle_id ?? intent.oracleId ?? "No oracle selected."
    },
    {
      label: "Clock object",
      satisfied: true,
      detail: "Sui system clock object 0x6."
    },
    {
      label: "Gas audit mode",
      satisfied: true,
      detail: onchainAuditEnabled
        ? "Enabled by PREDICT_ENABLE_ONCHAIN_LOG=true; adds one extra Move call."
        : "Disabled by default to save one extra Move call; audit can stay off-chain."
    }
  ];
}

function buildSizing(intent: Extract<ParsedIntent, { status: "ready" }>): TradeSizingPreview {
  if (intent.action === "stablecoin_transfer" || intent.action === "predict_redeem") {
    return {
      mode: "not_required",
      quoteBudgetDusdc: intent.amountType === "quote" ? Number(intent.amount) : null,
      quantityRaw: intent.quantity ?? null,
      executable: true,
      label: "No mint sizing required",
      reason: "This action does not need a new Predict mint quantity."
    };
  }

  if (intent.quantity) {
    return {
      mode: "explicit_quantity",
      quoteBudgetDusdc: intent.amountType === "quote" ? Number(intent.amount) : null,
      quantityRaw: intent.quantity,
      executable: false,
      label: `${intent.quantity} Predict quantity`,
      reason: "Explicit quantity is parsed, but signing remains locked until DeepPilot can verify the exact mint cost before wallet signing."
    };
  }

  return {
    mode: "quote_budget",
    quoteBudgetDusdc: intent.amountType === "quote" ? Number(intent.amount) : null,
    quantityRaw: null,
    executable: false,
    label: `${intent.amount} DUSDC budget`,
    reason: "Predict mint takes position quantity, not DUSDC budget. DeepPilot will not convert budget to quantity without a verified quote."
  };
}

function buildExecutionReadiness(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot | null,
  profile: ProfileSummary | null,
  sizing: TradeSizingPreview
): ExecutionReadiness {
  const walletAddress = profile?.wallet ?? null;
  const managerId = profile?.managerId ?? null;
  const checks = [
    {
      label: "Wallet connected",
      passed: Boolean(walletAddress),
      detail: walletAddress ?? "Connect wallet before Review & Sign."
    },
    {
      label: "PredictManager linked",
      passed: Boolean(managerId),
      detail: managerId ?? "No PredictManager found for this wallet."
    },
    {
      label: "Oracle selected",
      passed: Boolean(market?.oracle.oracle_id ?? intent.oracleId),
      detail: market?.oracle.oracle_id ?? intent.oracleId ?? "No Predict oracle selected."
    },
    {
      label: "Executable sizing",
      passed: sizing.executable,
      detail: sizing.reason
    }
  ];
  const canSign = checks.every((check) => check.passed);

  return {
    canSign,
    mode: canSign ? "wallet_transaction" : "preview_only",
    reason: canSign
      ? "Ready for wallet signing."
      : "Review is available, but wallet signing is locked until every readiness check passes.",
    walletAddress,
    managerId,
    managerBalanceDusdc: profile?.tradingBalanceDusdc ?? null,
    requiredQuoteDusdc: sizing.quoteBudgetDusdc,
    checks
  };
}

function scaledStrike(market: PredictMarketSnapshot | null, intent: Extract<ParsedIntent, { status: "ready" }>) {
  const strike = market?.metrics.selectedStrike ?? intent.strike;

  return strike ? toPredictPrice(strike) : null;
}

function shortId(value?: string | null) {
  if (!value) {
    return "selected oracle";
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function digestPreview(input: string) {
  return `0x${createHash("sha256").update(input).digest("hex")}`;
}
