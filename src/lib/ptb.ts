import { createHash } from "node:crypto";

import { auditLogPackageId, auditLogPackageIsPublished, previewAccounts } from "./execution-config";
import { predictDeployment, toDusdcBaseUnits, toPredictPrice } from "./predict";
import { onchainAuditEnabled } from "./predict-config";
import type {
  ExecutionReadiness,
  GuardianResult,
  ParsedIntent,
  PredictMarketSnapshot,
  PredictQuotePreview,
  ProfileSummary,
  PtbCommandPreview,
  PtbPlan,
  PtbTransactionData,
  SponsorDecision,
  TradeSizingPreview
} from "./types";

const DUSDC_SCALE = 1_000_000;

export function buildPtbPlan(
  intent: ParsedIntent,
  market: PredictMarketSnapshot | null,
  guardian: GuardianResult,
  gas: SponsorDecision,
  profile: ProfileSummary | null = null,
  quote: PredictQuotePreview | null = null
): PtbPlan | null {
  if (intent.status !== "ready" || guardian.blocked) {
    return null;
  }

  if (intent.action === "predict_quote_only") {
    return null;
  }

  const commands = buildCommands(intent, market, profile, quote);
  const sizing = buildSizing(intent, quote);
  const execution = buildExecutionReadiness(intent, market, profile, sizing, quote);
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
    quote: quote && quote.status === "available"
      ? {
          source: quote.source,
          estimatedCostDusdc: quote.estimatedCostDusdc,
          estimatedCostRaw: quote.estimatedCostRaw,
          maxPayoutDusdc: quote.maxPayoutDusdc,
          maxPayoutRaw: quote.maxPayoutRaw,
          askPrice: quote.askPrice,
          returnPct: quote.returnPct,
          expiresAt: quote.expiresAt
        }
      : null,
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
    // This is still a deterministic preview; the actual wallet transaction pays its own gas.
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

function buildCommands(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot | null,
  profile: ProfileSummary | null,
  quote: PredictQuotePreview | null
) {
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
      inputs: predictInputs(intent, market, profile?.managerId ?? null, null, quote)
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
      inputs: predictInputs(intent, market, profile?.managerId ?? null, intent.quantity ?? null, quote)
    });
  } else {
    commands.push(binaryKeyCommand(intent, market, 1));

    commands.push({
      index: commands.length + 1,
      command: `Mint BTC ${intent.direction ?? "up"} binary at ${market?.metrics.selectedStrike ?? intent.strike ?? "ATM"}`,
      target: `${predictDeployment.packageId}::predict::mint`,
      riskGate: "atomic",
      inputs: predictInputs(intent, market, profile?.managerId ?? null, quote?.status === "available" ? quote.quantityRaw : intent.quantity ?? null, quote)
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
  managerId: string | null,
  quantityRaw: string | null,
  quote: PredictQuotePreview | null
) {
  return {
    predictObject: predictDeployment.predictId,
    managerObject: managerId,
    oracleObject: market?.oracle.oracle_id ?? intent.oracleId ?? null,
    quoteType: predictDeployment.quoteAssetType,
    quantityRaw,
    quoteBudgetDusdc: intent.amountType === "quote" ? Number(intent.amount) : null,
    estimatedCostDusdc: quote?.status === "available" ? quote.estimatedCostDusdc : null,
    maxPayoutDusdc: quote?.status === "available" ? quote.maxPayoutDusdc : null,
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
      label: "Trading Balance",
      satisfied: execution.fundingStatus === "sufficient" || execution.fundingStatus === "not_required",
      detail: fundingRequirementDetail(execution)
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

function buildSizing(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  quote: PredictQuotePreview | null
): TradeSizingPreview {
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

  if (intent.action === "predict_binary_mint" && quote?.status === "available") {
    return {
      mode: intent.quantity ? "explicit_quantity" : "quote_budget",
      quoteBudgetDusdc: quote.quoteBudgetDusdc,
      quantityRaw: quote.quantityRaw,
      executable: true,
      label: `${formatDusdc(quote.quantityDusdc)} max payout units`,
      reason: `DeepBook quote estimates ${formatDusdc(quote.estimatedCostDusdc)} DUSDC cost for ${formatDusdc(quote.maxPayoutDusdc)} DUSDC max payout.`
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
  sizing: TradeSizingPreview,
  quote: PredictQuotePreview | null
): ExecutionReadiness {
  const walletAddress = profile?.wallet ?? null;
  const managerId = profile?.managerId ?? null;
  const requiredQuoteRaw = quote?.status === "available" ? quote.estimatedCostRaw : null;
  const funding = fundingReadiness(profile, quote, intent.action);
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
    },
    {
      label: "Trading Balance",
      passed: funding.status === "sufficient" || funding.status === "not_required",
      detail: funding.detail
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
    managerBalanceRaw: profile?.tradingBalanceRaw ?? null,
    requiredQuoteDusdc: sizing.quoteBudgetDusdc,
    requiredQuoteRaw,
    estimatedPaymentRaw: requiredQuoteRaw,
    fundingShortfallRaw: funding.shortfallRaw,
    fundingStatus: funding.status,
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

function formatDusdc(value: number | null) {
  return value === null ? "--" : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fundingReadiness(
  profile: ProfileSummary | null,
  quote: PredictQuotePreview | null,
  action: Extract<ParsedIntent, { status: "ready" }>["action"]
) {
  if (action === "stablecoin_transfer" || action === "predict_redeem" || action === "predict_quote_only") {
    return {
      status: "not_required" as const,
      shortfallRaw: null,
      detail: "No new Predict mint payment required."
    };
  }

  if (quote?.status !== "available" || !quote.estimatedCostRaw) {
    return {
      status: "unknown" as const,
      shortfallRaw: null,
      detail: "Trading Balance cannot be checked until the Predict payment quote is available."
    };
  }

  if (!profile?.managerId) {
    return {
      status: "unknown" as const,
      shortfallRaw: quote.estimatedCostRaw,
      detail: "Create a PredictManager before funding and opening this position."
    };
  }

  if (!profile.tradingBalanceRaw || !/^\d+$/.test(profile.tradingBalanceRaw)) {
    return {
      status: "unknown" as const,
      shortfallRaw: quote.estimatedCostRaw,
      detail: "Trading Balance is not indexed yet. Refresh Profile after funding."
    };
  }

  const required = BigInt(quote.estimatedCostRaw);
  const balance = parseRawU64(profile.tradingBalanceRaw);
  const shortfall = balance >= required ? 0n : required - balance;

  if (shortfall > 0n) {
    return {
      status: "insufficient" as const,
      shortfallRaw: shortfall.toString(),
      detail: `Trading Balance is short by ${formatDusdc(rawDusdcToDisplay(shortfall.toString()))} DUSDC. Add funds in Profile before opening this trade.`
    };
  }

  return {
    status: "sufficient" as const,
    shortfallRaw: "0",
    detail: `${formatDusdc(profile.tradingBalanceDusdc ?? rawDusdcToDisplay(profile.tradingBalanceRaw))} DUSDC Trading Balance available.`
  };
}

function fundingRequirementDetail(execution: ExecutionReadiness) {
  switch (execution.fundingStatus) {
    case "sufficient":
      return execution.managerBalanceDusdc === null
        ? "Trading Balance is sufficient."
        : `${execution.managerBalanceDusdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC Trading Balance available.`;
    case "insufficient":
      return `Add ${formatDusdc(rawDusdcToDisplay(execution.fundingShortfallRaw))} DUSDC in Profile before opening this position.`;
    case "not_required":
      return "No new Predict mint payment required.";
    default:
      return "Trading Balance is unavailable or not indexed yet.";
  }
}

function parseRawU64(value?: string | null) {
  return value && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function rawDusdcToDisplay(value?: string | null) {
  const raw = value && /^\d+$/.test(value) ? BigInt(value) : 0n;

  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  return Number(raw) / DUSDC_SCALE;
}
