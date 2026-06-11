import { auditLogPackageId, previewAccounts } from "./execution-config";
import { predictDeployment, toDusdcBaseUnits, toPredictPrice } from "./predict";
import { onchainAuditEnabled } from "./predict-config";
import type { GuardianResult, ParsedIntent, PredictMarketSnapshot, PtbCommandPreview, PtbPlan, SponsorDecision } from "./types";

export function buildPtbPlan(
  intent: ParsedIntent,
  market: PredictMarketSnapshot | null,
  guardian: GuardianResult,
  gas: SponsorDecision
): PtbPlan | null {
  if (intent.status !== "ready" || guardian.blocked) {
    return null;
  }

  if (intent.action === "predict_quote_only") {
    return null;
  }

  const commands = buildCommands(intent, market);
  const requirements = buildRequirements(intent, market);
  const transactionData = {
    kind: "ProgrammableTransaction",
    network: predictDeployment.network,
    packageId: predictDeployment.packageId,
    predictObject: predictDeployment.predictId,
    quoteAssetType: predictDeployment.quoteAssetType,
    onchainAuditEnabled,
    manager: previewAccounts.manager,
    oracleId: market?.oracle.oracle_id ?? intent.oracleId ?? null,
    intent: {
      action: intent.action,
      direction: intent.direction,
      amount: intent.amount,
      quantityBaseUnits: quantityBaseUnits(intent),
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
    transactionData,
    digestPreview: hashish(JSON.stringify(transactionData)).slice(0, 44),
    simulated: {
      status: "not_submitted",
      reason:
        "Preview uses live Predict state and exact Predict targets. Real submission requires a funded DUSDC manager object and wallet-selected coin inputs.",
      explorerReady: false
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
      inputs: predictInputs(intent, market)
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
      command: `Mint BTC range ${intent.lowerStrike}-${intent.upperStrike} with ${intent.amount} DUSDC`,
      target: `${predictDeployment.packageId}::predict::mint_range`,
      riskGate: "atomic",
      inputs: predictInputs(intent, market)
    });
  } else {
    commands.push(binaryKeyCommand(intent, market, 1));
    commands.push({
      index: 2,
      command: `Mint BTC ${intent.direction ?? "up"} binary at ${market?.metrics.selectedStrike ?? intent.strike ?? "ATM"} with ${intent.amount} DUSDC`,
      target: `${predictDeployment.packageId}::predict::mint`,
      riskGate: "atomic",
      inputs: predictInputs(intent, market)
    });
  }

  if (onchainAuditEnabled) {
    commands.push({
      index: commands.length + 1,
      command: "Record market snapshot hash and Guardian decision",
      target: `${auditLogPackageId}::log::record_intent`,
      riskGate: "receipt"
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

function predictInputs(intent: Extract<ParsedIntent, { status: "ready" }>, market: PredictMarketSnapshot | null) {
  return {
    predictObject: predictDeployment.predictId,
    managerObject: previewAccounts.manager,
    oracleObject: market?.oracle.oracle_id ?? intent.oracleId ?? null,
    quoteType: predictDeployment.quoteAssetType,
    quantityBaseUnits: quantityBaseUnits(intent),
    clockObject: "0x6"
  };
}

function buildRequirements(intent: Extract<ParsedIntent, { status: "ready" }>, market: PredictMarketSnapshot | null) {
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
      satisfied: false,
      detail: "Create or load the user's shared PredictManager before submitting mint/redeem."
    },
    {
      label: "DUSDC manager balance",
      satisfied: false,
      detail: "Mint requires DUSDC already deposited into the PredictManager."
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

function scaledStrike(market: PredictMarketSnapshot | null, intent: Extract<ParsedIntent, { status: "ready" }>) {
  const strike = market?.metrics.selectedStrike ?? intent.strike;

  return strike ? toPredictPrice(strike) : null;
}

function quantityBaseUnits(intent: Extract<ParsedIntent, { status: "ready" }>) {
  return toDusdcBaseUnits(Number(intent.amount));
}

function shortId(value?: string | null) {
  if (!value) {
    return "selected oracle";
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function hashish(input: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `0x${(hash >>> 0).toString(16).padStart(8, "0")}${input.length.toString(16).padStart(8, "0")}`;
}
