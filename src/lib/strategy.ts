import { createHash } from "node:crypto";

import type { CompileOptions } from "./compile";
import { getActivePredictMarketContext } from "./predict";
import { tradeMethodAdapters, strategyLegToIntent } from "./trade-methods";
import type {
  ActiveMarketContext,
  AggregateExecutionReadiness,
  BatchPredictMintTransactionData,
  CompileResult,
  CompiledTradeLeg,
  ConversationContext,
  ExecutionReadinessCheck,
  PtbCommandPreview,
  StrategyLeg,
  StrategyLegStatus,
  StrategyPlan,
  StrategyReview
} from "./types";

const DUSDC_SCALE = 1_000_000;
const MARKET_MATCH_TOLERANCE_MS = 45 * 60_000;

export type CompileStrategyOptions = Pick<CompileOptions, "walletAddress" | "managerId" | "refreshed" | "onEvent"> & {
  conversationContext?: ConversationContext | null;
  activeMarketContext?: ActiveMarketContext | null;
};

export async function compileStrategy(input: string, options: CompileStrategyOptions = {}): Promise<StrategyReview> {
  options.onEvent?.({
    type: "stage",
    label: "Loading active Predict context",
    state: "pending"
  });
  const activeMarketContext = options.activeMarketContext ?? await getActivePredictMarketContext(12);
  options.onEvent?.({
    type: "stage",
    label: "Loading active Predict context",
    state: activeMarketContext.markets.length ? "complete" : "blocked",
    detail: `${activeMarketContext.markets.length} active BTC markets`
  });

  options.onEvent?.({
    type: "stage",
    label: "Planning strategy legs",
    state: "pending"
  });
  const plan = buildStrategyPlan(input, activeMarketContext, options.conversationContext ?? null);
  options.onEvent?.({
    type: "stage",
    label: "Planning strategy legs",
    state: plan.missing.length ? "blocked" : "complete",
    detail: plan.missing.length ? `Missing ${plan.missing.join(", ")}` : `${plan.legs.length} legs`
  });

  const compiledLegs: CompiledTradeLeg[] = [];

  for (const leg of plan.legs) {
    const adapter = tradeMethodAdapters[leg.method];
    const intentText = strategyLegToIntent(leg);

    if (!adapter) {
      compiledLegs.push(blockedLeg(leg, intentText, "This trade method is preview-only in v1."));
      continue;
    }

    if (leg.amountDusdc === null || leg.amountDusdc <= 0) {
      compiledLegs.push(blockedLeg(leg, intentText, "Add a total strategy budget or per-leg amount before signing."));
      continue;
    }

    if (!leg.oracleId) {
      compiledLegs.push(blockedLeg(leg, intentText, "No active Predict oracle matched this leg's target expiry."));
      continue;
    }

    options.onEvent?.({
      type: "stage",
      label: `Compiling ${leg.id}`,
      state: "pending",
      detail: leg.note
    });

    try {
      const result = await adapter.quote(leg, {
        walletAddress: options.walletAddress,
        managerId: options.managerId,
        activeMarketContext,
        conversationContext: options.conversationContext ?? null,
        refreshed: options.refreshed
      });
      const status = legStatus(result);
      compiledLegs.push({
        id: leg.id,
        leg,
        intentText,
        result: adapter.buildPreview(result),
        status,
        selected: leg.selected && status !== "blocked",
        blockReason: status === "blocked" ? legBlockReason(result) : null
      });
      options.onEvent?.({
        type: "stage",
        label: `Compiling ${leg.id}`,
        state: status === "blocked" ? "blocked" : "complete",
        detail: legBlockReason(result) ?? status
      });
    } catch (error) {
      compiledLegs.push(blockedLeg(leg, intentText, error instanceof Error ? error.message : "Leg compile failed."));
      options.onEvent?.({
        type: "stage",
        label: `Compiling ${leg.id}`,
        state: "blocked",
        detail: error instanceof Error ? error.message : "Leg compile failed"
      });
    }
  }

  const aggregateReadiness = buildAggregateReadiness(compiledLegs);
  const batchTransactionData = aggregateReadiness.canSign ? buildBatchTransactionData(compiledLegs) : null;
  const reviewFreshness = buildStrategyFreshness(compiledLegs, Boolean(options.refreshed));

  return {
    plan,
    compiledLegs,
    aggregateReadiness,
    batchTransactionData,
    reviewFreshness,
    timeline: [
      {
        label: "Loading active Predict context",
        state: activeMarketContext.markets.length ? "complete" : "blocked"
      },
      {
        label: "Planning strategy legs",
        state: plan.missing.length ? "blocked" : "complete"
      },
      {
        label: "Compiling selected legs",
        state: compiledLegs.some((leg) => leg.status === "blocked") ? "blocked" : "complete"
      },
      {
        label: "Checking aggregate Trading Balance",
        state: aggregateReadiness.fundingStatus === "sufficient" ? "complete" : "blocked"
      },
      {
        label: "Building batch PTB preview",
        state: batchTransactionData ? "complete" : "blocked"
      }
    ]
  };
}

export function buildStrategyPlan(
  input: string,
  activeMarketContext: ActiveMarketContext,
  conversationContext: ConversationContext | null = null
): StrategyPlan {
  const raw = input.trim();
  const direction = detectDirection(raw, conversationContext);
  const amount = detectAmount(raw);
  const durations = detectDurations(raw);
  const isHedge = /hedge|对冲/i.test(raw);
  const targetDurations = targetStrategyDurations(durations, isHedge);
  const legDirections = targetLegDirections(targetDurations.length, direction, isHedge);
  const legAmounts = allocateStrategyBudget(amount, strategyLegWeights(raw, isHedge, legDirections));
  const nowMs = Date.parse(activeMarketContext.nowIso);
  const legs: StrategyLeg[] = targetDurations.map((minutes, index) => {
    const legDirection = legDirections[index] ?? direction;
    const market = minutes > 0
      ? nearestMarketByDuration(activeMarketContext, nowMs, minutes)
      : activeMarketContext.markets[0] ?? null;
    const expiryPreference = minutes === 60
      ? "one_hour"
      : minutes === 120
        ? "two_hour"
        : minutes === 180
          ? "three_hour"
          : minutes > 0 ? "custom" : "next_active";

    return {
      id: `leg-${index + 1}`,
      method: "predict_binary_mint",
      action: legDirection === "down" ? "buy_down" : "buy_up",
      asset: "BTC",
      direction: legDirection,
      amountDusdc: legAmounts[index] ?? null,
      expiryPreference,
      targetDurationMinutes: minutes || null,
      requestedExpiryMs: minutes > 0 ? nowMs + minutes * 60_000 : null,
      oracleId: market?.oracleId ?? null,
      selected: true,
      note: market
        ? `${legDirection.toUpperCase()} near ${expiryPreferenceLabel(expiryPreference)}`
        : `No active oracle near ${minutes} minutes`
    };
  });

  return {
    mode: "strategy",
    asset: "BTC",
    thesis: strategyThesis(raw, conversationContext, isHedge),
    totalBudgetDusdc: amount,
    legs,
    riskNotes: [
      "Strategy output is a candidate plan, not investment advice.",
      "Each leg must pass live quote, Guardian, freshness, and Trading Balance checks before signing.",
      "Batch signing can fail if any selected market changes before wallet confirmation."
    ],
    missing: amount === null ? ["amount"] : [],
    source: "deterministic",
    raw
  };
}

function buildAggregateReadiness(compiledLegs: CompiledTradeLeg[]): AggregateExecutionReadiness {
  const selected = compiledLegs.filter((leg) => leg.selected);
  const ready = selected.filter((leg) => leg.status === "ready" && leg.result?.ptb?.execution.canSign);
  const firstResult = selected.find((leg) => leg.result)?.result ?? null;
  const profile = firstResult?.profile ?? null;
  const managerId = firstResult?.ptb?.execution.managerId ?? profile?.managerId ?? null;
  const walletAddress = profile?.wallet ?? firstResult?.ptb?.execution.walletAddress ?? null;
  const managerBalanceRaw = profile?.tradingBalanceRaw ?? firstResult?.ptb?.execution.managerBalanceRaw ?? null;
  const estimatedPaymentRaw = sumRaw(selected.map((leg) => leg.result?.quote?.estimatedCostRaw ?? null));
  const funding = fundingStatus(managerBalanceRaw, estimatedPaymentRaw);
  const checks: ExecutionReadinessCheck[] = [
    {
      label: "Selected legs",
      passed: selected.length > 0,
      detail: selected.length ? `${selected.length} selected legs` : "Select at least one ready leg."
    },
    {
      label: "Every selected leg ready",
      passed: selected.length > 0 && selected.length === ready.length,
      detail: `${ready.length}/${selected.length} selected legs ready.`
    },
    {
      label: "Wallet connected",
      passed: Boolean(walletAddress),
      detail: walletAddress ?? "Connect wallet before batch signing."
    },
    {
      label: "PredictManager linked",
      passed: Boolean(managerId),
      detail: managerId ?? "Create or load PredictManager before batch signing."
    },
    {
      label: "Aggregate Trading Balance",
      passed: funding.status === "sufficient",
      detail: funding.detail
    }
  ];

  return {
    canSign: checks.every((check) => check.passed),
    mode: checks.every((check) => check.passed) ? "wallet_transaction" : "preview_only",
    reason: checks.every((check) => check.passed)
      ? "All selected legs are ready for one batch wallet signature."
      : "Batch signing is locked until every selected leg and aggregate funding check passes.",
    walletAddress,
    managerId,
    selectedLegCount: selected.length,
    readyLegCount: ready.length,
    blockedLegCount: selected.length - ready.length,
    estimatedPaymentRaw,
    estimatedPaymentDusdc: rawDusdcToNumber(estimatedPaymentRaw),
    managerBalanceRaw,
    managerBalanceDusdc: rawDusdcToNumber(managerBalanceRaw),
    fundingShortfallRaw: funding.shortfallRaw,
    fundingStatus: funding.status,
    checks
  };
}

function buildBatchTransactionData(compiledLegs: CompiledTradeLeg[]): BatchPredictMintTransactionData | null {
  const selected = compiledLegs.filter((leg) => leg.selected && leg.result?.ptb?.transactionData);
  const first = selected[0]?.result?.ptb?.transactionData;

  if (!first) {
    return null;
  }

  const commands: PtbCommandPreview[] = [];
  const legs = selected.map((leg) => {
    const transaction = leg.result!.ptb!.transactionData;
    const keyCommand = transaction.commands.find((command) => command.target.includes("::market_key::"));
    const mintCommand = transaction.commands.find((command) => command.target.endsWith("::predict::mint"));

    if (keyCommand) {
      commands.push({ ...keyCommand, index: commands.length + 1, command: `${leg.id}: ${keyCommand.command}` });
    }

    if (mintCommand) {
      commands.push({ ...mintCommand, index: commands.length + 1, command: `${leg.id}: ${mintCommand.command}` });
    }

    return {
      legId: leg.id,
      oracleId: transaction.key.oracleId,
      expiry: transaction.key.expiry,
      strikeScaled: transaction.key.strikeScaled,
      direction: transaction.key.direction,
      keyTarget: transaction.key.target,
      mintTarget: transaction.mint.target,
      quantityRaw: transaction.mint.quantityRaw,
      estimatedCostRaw: transaction.quote?.estimatedCostRaw ?? null
    };
  });

  return {
    kind: "BatchProgrammableTransaction",
    network: first.network,
    packageId: first.packageId,
    predictObject: first.predictObject,
    quoteAssetType: first.quoteAssetType,
    manager: first.manager,
    legs,
    commands
  };
}

function buildStrategyFreshness(compiledLegs: CompiledTradeLeg[], refreshed: boolean) {
  const checkedAt = new Date().toISOString();
  const selected = compiledLegs.filter((leg) => leg.selected);
  const stale = selected.find((leg) => !leg.result?.reviewFreshness?.active);
  const inactive = selected.find((leg) => {
    const market = leg.result?.market;

    return market ? market.oracle.status !== "active" || market.oracle.expiry <= market.status.current_time_ms : true;
  });

  if (stale || inactive) {
    return {
      checkedAt,
      active: false,
      refreshed,
      reason: stale?.result?.reviewFreshness?.reason ?? "One selected strategy leg is no longer active."
    };
  }

  return {
    checkedAt,
    active: selected.length > 0,
    refreshed,
    reason: selected.length ? "All selected strategy legs were checked against current Predict state." : "No selected legs."
  };
}

function legStatus(result: CompileResult): StrategyLegStatus {
  if (result.guardian.blocked || !result.ptb || result.quote?.status === "unavailable") {
    return "blocked";
  }

  if (result.ptb.execution.canSign) {
    return "ready";
  }

  return result.quote?.status === "available" ? "quoted" : "draft";
}

function legBlockReason(result: CompileResult) {
  if (result.guardian.blocked) {
    return result.guardian.summary;
  }

  if (!result.ptb) {
    return "No executable PTB preview for this leg.";
  }

  if (!result.ptb.execution.canSign) {
    return result.ptb.execution.reason;
  }

  return null;
}

function blockedLeg(leg: StrategyLeg, intentText: string, reason: string): CompiledTradeLeg {
  return {
    id: leg.id,
    leg,
    intentText,
    result: null,
    status: "blocked",
    selected: false,
    blockReason: reason
  };
}

function detectDirection(raw: string, conversationContext?: ConversationContext | null): "up" | "down" {
  const text = `${raw}\n${conversationContext?.memoryContext ?? ""}`;

  if (/\b(down|put|short|lower)\b|跌|做空|看跌/i.test(text)) {
    return "down";
  }

  return "up";
}

function oppositeDirection(direction: "up" | "down") {
  return direction === "up" ? "down" : "up";
}

function detectAmount(raw: string) {
  const match = normalizeCurrencyText(raw).match(/(\d+(?:\.\d+)?)\s*(?:d?usdc|usdc|u|\$)/i);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);

  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeCurrencyText(raw: string) {
  return raw.replace(/([a-z])\s+(?=[a-z])/gi, "$1");
}

function targetStrategyDurations(durations: number[], isHedge: boolean) {
  if (durations.length) {
    return durations;
  }

  // A hedge without explicit ladder durations belongs on the same earliest active
  // expiry. Splitting it across later expiries makes "nearest settlement" hard
  // to review and can produce a misleading hedge.
  return isHedge ? [0, 0] : [0];
}

function targetLegDirections(count: number, primaryDirection: "up" | "down", isHedge: boolean) {
  return Array.from({ length: count }, (_, index) => {
    if (!isHedge) {
      return primaryDirection;
    }

    return index % 2 === 0 ? primaryDirection : oppositeDirection(primaryDirection);
  });
}

function strategyLegWeights(raw: string, isHedge: boolean, directions: Array<"up" | "down">) {
  if (!isHedge || directions.length < 2) {
    return equalWeights(directions.length);
  }

  const majorDirection = detectMajorDirection(raw);

  if (!majorDirection) {
    return equalWeights(directions.length);
  }

  const majorCount = directions.filter((direction) => direction === majorDirection).length;
  const hedgeCount = directions.length - majorCount;

  if (majorCount === 0 || hedgeCount === 0) {
    return equalWeights(directions.length);
  }

  return directions.map((direction) => direction === majorDirection ? 0.7 / majorCount : 0.3 / hedgeCount);
}

function detectMajorDirection(raw: string): "up" | "down" | null {
  const match = raw.match(/(?:大头|主仓|主要|偏向|mostly|majority|larger|heavy|bigger|overweight|favor|favour|tilt|bias|main).*?(涨|看涨|做多|up|upside|long|call|跌|看跌|做空|down|downside|short|put)/i);

  if (!match) {
    return null;
  }

  return /跌|看跌|做空|down|downside|short|put/i.test(match[1]) ? "down" : "up";
}

function equalWeights(count: number) {
  return Array.from({ length: count }, () => count > 0 ? 1 / count : 0);
}

function allocateStrategyBudget(amount: number | null, weights: number[]) {
  if (amount === null || weights.length === 0) {
    return weights.map(() => null);
  }

  const totalRaw = Math.max(1, Math.round(amount * DUSDC_SCALE));
  let allocatedRaw = 0;

  return weights.map((weight, index) => {
    const raw = index === weights.length - 1
      ? totalRaw - allocatedRaw
      : Math.floor(totalRaw * weight);
    allocatedRaw += raw;

    return raw / DUSDC_SCALE;
  });
}

function detectDurations(raw: string) {
  const durations = new Set<number>();
  const normalized = raw.toLowerCase();

  if (/\b1\s*(h|hour|hours)\b|one\s+hour|一小时|1小时/.test(normalized)) {
    durations.add(60);
  }

  if (/\b2\s*(h|hour|hours)\b|two\s+hours?|两小时|二小时|2小时/.test(normalized)) {
    durations.add(120);
  }

  if (/\b3\s*(h|hour|hours)\b|three\s+hours?|三小时|3小时/.test(normalized)) {
    durations.add(180);
  }

  return [...durations].sort((left, right) => left - right);
}

function nearestMarketByDuration(context: ActiveMarketContext, nowMs: number, minutes: number) {
  const target = nowMs + minutes * 60_000;
  let best: ActiveMarketContext["markets"][number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const market of context.markets) {
    const distance = Math.abs(market.expiry - target);

    if (distance < bestDistance) {
      best = market;
      bestDistance = distance;
    }
  }

  return best && bestDistance <= MARKET_MATCH_TOLERANCE_MS ? best : null;
}

function strategyThesis(raw: string, conversationContext: ConversationContext | null, isHedge: boolean) {
  const context = conversationContext?.lastMarketThesis?.trim() || conversationContext?.memoryContext?.trim();

  if (context) {
    return `Candidate ${isHedge ? "hedge" : "ladder"} plan based on the latest market discussion: ${context}`;
  }

  return `Candidate ${isHedge ? "hedge" : "ladder"} plan from: ${raw}`;
}

function expiryPreferenceLabel(value: StrategyLeg["expiryPreference"]) {
  switch (value) {
    case "one_hour":
      return "1h expiry";
    case "two_hour":
      return "2h expiry";
    case "three_hour":
      return "3h expiry";
    case "next_active":
      return "next active expiry";
    default:
      return "target expiry";
  }
}

function sumRaw(values: Array<string | null | undefined>) {
  let total = 0n;

  for (const value of values) {
    if (!value || !/^\d+$/.test(value)) {
      return null;
    }

    total += BigInt(value);
  }

  return total.toString();
}

function fundingStatus(managerBalanceRaw: string | null, estimatedPaymentRaw: string | null) {
  if (!estimatedPaymentRaw || !/^\d+$/.test(estimatedPaymentRaw)) {
    return {
      status: "unknown" as const,
      shortfallRaw: null,
      detail: "Aggregate payment is unavailable until every selected leg has a quote."
    };
  }

  if (!managerBalanceRaw || !/^\d+$/.test(managerBalanceRaw)) {
    return {
      status: "unknown" as const,
      shortfallRaw: estimatedPaymentRaw,
      detail: "Trading Balance is unavailable or not indexed yet."
    };
  }

  const required = BigInt(estimatedPaymentRaw);
  const balance = BigInt(managerBalanceRaw);
  const shortfall = balance >= required ? 0n : required - balance;

  if (shortfall > 0n) {
    return {
      status: "insufficient" as const,
      shortfallRaw: shortfall.toString(),
      detail: `Trading Balance is short by ${rawDusdcToNumber(shortfall.toString())?.toFixed(4) ?? "--"} DUSDC.`
    };
  }

  return {
    status: "sufficient" as const,
    shortfallRaw: "0",
    detail: `${rawDusdcToNumber(managerBalanceRaw)?.toFixed(4) ?? "--"} DUSDC Trading Balance available.`
  };
}

function rawDusdcToNumber(value: string | null) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const raw = BigInt(value);

  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  return Number(raw) / DUSDC_SCALE;
}

export function strategyReviewFingerprint(review: StrategyReview) {
  return JSON.stringify({
    selected: review.compiledLegs
      .filter((leg) => leg.selected)
      .map((leg) => ({
        id: leg.id,
        oracleId: leg.result?.ptb?.transactionData.oracleId ?? null,
        key: leg.result?.ptb?.transactionData.key ?? null,
        mint: leg.result?.ptb?.transactionData.mint ?? null,
        estimatedCostRaw: leg.result?.quote?.estimatedCostRaw ?? null
      })),
    aggregatePaymentRaw: review.aggregateReadiness.estimatedPaymentRaw,
    managerId: review.aggregateReadiness.managerId
  });
}

export function strategyDigestPreview(review: StrategyReview) {
  return `0x${createHash("sha256").update(strategyReviewFingerprint(review)).digest("hex")}`;
}
