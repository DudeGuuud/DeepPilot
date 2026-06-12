import { bcs } from "@mysten/sui/bcs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";

import { clientGrpcUrls } from "./client-config";
import { predictDeployment } from "./predict-config";
import { runGuardian } from "./guardian";
import { z } from "zod";
import type {
  MarketDiscoveryResult,
  MarketListItem,
  OracleState,
  ParsedIntent,
  PredictChartPoint,
  PredictOracleHistory,
  PredictMarketSnapshot,
  PredictOracleSummary,
  PredictQuotePreview,
  PredictSviEvent,
  PredictStatus,
  VaultSummary
} from "./types";

const PRICE_SCALE = 1_000_000_000;
const DUSDC_SCALE = 1_000_000;
const PREDICT_TIMEOUT_MS = 5_000;
const QUOTE_EXPIRY_MS = 15_000;
const QUOTE_PREVIEW_SENDER = "0x0000000000000000000000000000000000000000000000000000000000000a11";
const DEFAULT_MARKET_PAGE_SIZE = 4;
const MAX_MARKET_PAGE_SIZE = 12;
const HISTORY_POINT_CAP = 240;
const SVI_EVENT_CAP = 120;

const oracleSummarySchema: z.ZodType<PredictOracleSummary> = z.object({
  predict_id: z.string(),
  oracle_id: z.string().regex(/^0x[a-fA-F0-9]{1,64}$/),
  underlying_asset: z.literal("BTC"),
  expiry: z.number().finite(),
  min_strike: z.number().finite(),
  tick_size: z.number().finite(),
  status: z.string(),
  activated_at: z.number().finite().nullable(),
  settlement_price: z.number().finite().nullable(),
  settled_at: z.number().finite().nullable()
});

const predictStatusSchema: z.ZodType<PredictStatus> = z.object({
  status: z.string(),
  latest_onchain_checkpoint: z.number().finite(),
  current_time_ms: z.number().finite(),
  max_lag_pipeline: z.string(),
  max_checkpoint_lag: z.number().finite(),
  max_time_lag_seconds: z.number().finite()
});

const vaultSummarySchema: z.ZodType<VaultSummary> = z.object({
  predict_id: z.string(),
  vault_balance: z.number().finite(),
  vault_value: z.number().finite(),
  total_mtm: z.number().finite(),
  total_max_payout: z.number().finite(),
  available_liquidity: z.number().finite(),
  available_withdrawal: z.number().finite(),
  plp_total_supply: z.number().finite(),
  plp_share_price: z.number().finite(),
  utilization: z.number().finite(),
  max_payout_utilization: z.number().finite()
});

const oracleStateSchema: z.ZodType<OracleState> = z.object({
  oracle: oracleSummarySchema,
  latest_price: z
    .object({
      spot: z.number().finite(),
      forward: z.number().finite(),
      onchain_timestamp: z.number().finite(),
      checkpoint: z.number().finite().optional(),
      event_digest: z.string().optional()
    })
    .nullable(),
  latest_svi: z
    .object({
      a: z.number().finite(),
      b: z.number().finite(),
      rho: z.number().finite(),
      m: z.number().finite().optional(),
      sigma: z.number().finite().optional(),
      onchain_timestamp: z.number().finite().optional(),
      checkpoint: z.number().finite().optional(),
      event_digest: z.string().optional()
    })
    .nullable(),
  ask_bounds: z.unknown().nullable()
});

const oraclePriceHistorySchema = z.array(
  z.object({
    spot: z.number().finite(),
    forward: z.number().finite(),
    onchain_timestamp: z.number().finite()
  })
);

const oracleSviHistorySchema = z.array(
  z.object({
    a: z.number().finite(),
    b: z.number().finite(),
    rho: z.number().finite(),
    rho_negative: z.boolean().optional(),
    m: z.number().finite().optional(),
    m_negative: z.boolean().optional(),
    sigma: z.number().finite().optional(),
    onchain_timestamp: z.number().finite()
  })
);

const marketFilterSchema = z.object({
  status: z.enum(["active", "settled", "all"]).default("active"),
  asset: z.literal("BTC").default("BTC"),
  expiry: z.enum(["next", "today", "this_week", "all"]).default("all"),
  risk: z.enum(["low", "medium", "high", "blocked", "unknown", "all"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_MARKET_PAGE_SIZE).default(DEFAULT_MARKET_PAGE_SIZE),
  selectedOracleId: z.string().regex(/^0x[a-fA-F0-9]{1,64}$/).optional()
});

export type MarketFilters = z.input<typeof marketFilterSchema>;

export { predictDeployment };

export function createPredictClientPreview() {
  return {
    network: predictDeployment.network,
    transport: "DeepBook Predict public server",
    endpoint: predictDeployment.serverUrl,
    predictId: predictDeployment.predictId,
    quoteAsset: "DUSDC"
  } as const;
}

export async function getPredictMarkets(input: MarketFilters = {}): Promise<MarketDiscoveryResult> {
  const filters = marketFilterSchema.parse(input);
  const [rawStatus, rawOracles, rawVault] = await Promise.all([
    fetchPredict("/status", predictStatusSchema),
    fetchPredict(`/predicts/${predictDeployment.predictId}/oracles`, z.array(oracleSummarySchema)),
    fetchPredict(`/predicts/${predictDeployment.predictId}/vault/summary`, vaultSummarySchema)
  ]);
  const status = normalizeStatus(rawStatus);
  const vault = normalizeVault(rawVault);

  if (vault.predict_id !== predictDeployment.predictId) {
    throw new Error("Predict vault summary does not match the configured Predict object.");
  }

  const oracles = rawOracles
    .map(normalizeOracle)
    .filter((oracle) => oracle.predict_id === predictDeployment.predictId)
    .filter((oracle) => oracle.underlying_asset === filters.asset);

  const pageableOracles = filterOracles(oracles, filters.status, filters.expiry, status.current_time_ms);
  const pagination = marketPagination(pageableOracles.length, filters.page, filters.pageSize);
  const pageOracles = pageableOracles.slice((pagination.page - 1) * pagination.pageSize, pagination.page * pagination.pageSize);
  const selectedOracle = filters.selectedOracleId
    ? pageableOracles.find((oracle) => oracle.oracle_id === filters.selectedOracleId) ?? null
    : null;
  const stateIds = selectedStateIds(pageOracles, selectedOracle);
  const stateEntries = await Promise.allSettled(
    stateIds.map(async (oracleId) => {
      const state = normalizeOracleState(await fetchPredict(`/oracles/${oracleId}/state`, oracleStateSchema));
      assertPredictConsistency(vault, state);
      return [oracleId, state] as const;
    })
  );
  const states = new Map<string, OracleState>();

  for (const entry of stateEntries) {
    if (entry.status === "fulfilled") {
      states.set(entry.value[0], entry.value[1]);
    }
  }

  const markets = pageOracles
    .map((oracle) => buildMarketListItem(oracle, status, vault, states.get(oracle.oracle_id) ?? null))
    .filter((market) => filters.risk === "all" || market.riskLevel === filters.risk);
  const selectedMarketFromPage = markets.find((market) => market.oracleId === filters.selectedOracleId);
  const selectedMarketFromLookup = selectedOracle
    ? buildMarketListItem(selectedOracle, status, vault, states.get(selectedOracle.oracle_id) ?? null)
    : null;
  const selectedMarket =
    selectedMarketFromPage ?? selectedMarketFromLookup ?? markets[0] ?? null;

  return {
    predict: createPredictClientPreview(),
    fetchedAt: new Date().toISOString(),
    status,
    vault,
    pagination,
    markets,
    selectedMarket
  };
}

export async function getPredictOracleHistory(oracleId: string): Promise<PredictOracleHistory> {
  const [rawState, rawPrices, rawSvi] = await Promise.all([
    fetchPredict(`/oracles/${oracleId}/state`, oracleStateSchema),
    fetchPredict(`/oracles/${oracleId}/prices`, oraclePriceHistorySchema),
    fetchPredict(`/oracles/${oracleId}/svi`, oracleSviHistorySchema)
  ]);
  const state = normalizeOracleState(rawState);

  if (state.oracle.predict_id !== predictDeployment.predictId) {
    throw new Error("Oracle history does not belong to the configured Predict object.");
  }

  const points = rawPrices
    .map((price): PredictChartPoint => ({
      time: price.onchain_timestamp,
      spot: normalizePrice(price.spot),
      forward: normalizePrice(price.forward)
    }))
    .sort((left, right) => left.time - right.time);
  const svi = rawSvi
    .map((event): PredictSviEvent => ({
      time: event.onchain_timestamp,
      checkpoint: null,
      a: event.a,
      b: event.b,
      rho: (event.rho_negative ? -event.rho : event.rho) / PRICE_SCALE,
      m: typeof event.m === "number" ? (event.m_negative ? -event.m : event.m) : null,
      sigma: event.sigma ?? null
    }))
    .sort((left, right) => left.time - right.time);

  // The history endpoints can return large arrays; the UI only needs a bounded preview.
  return {
    oracleId: state.oracle.oracle_id,
    points: points.slice(-HISTORY_POINT_CAP),
    sviEvents: svi.slice(-SVI_EVENT_CAP),
    capped: points.length > HISTORY_POINT_CAP || svi.length > SVI_EVENT_CAP,
    fetchedAt: new Date().toISOString()
  };
}

export async function getPredictMarketSnapshot(intent: ParsedIntent): Promise<PredictMarketSnapshot | null> {
  if (intent.status !== "ready" || intent.action === "stablecoin_transfer") {
    return null;
  }

  if (intent.oracleId) {
    return getSnapshotForOracle(intent, intent.oracleId);
  }

  return getSnapshotForNextActiveOracle(intent);
}

export async function getPredictQuotePreview(
  intent: ParsedIntent,
  market: PredictMarketSnapshot | null
): Promise<PredictQuotePreview | null> {
  if (intent.status !== "ready" || intent.action !== "predict_binary_mint") {
    return null;
  }

  if (!market || !intent.direction) {
    return unavailableQuote(intent, market, "A live binary Predict market is required before quoting payout.");
  }

  try {
    const quote = await quoteBinaryMint(intent, market);

    return buildAvailableQuote(intent, market, quote);
  } catch (error) {
    return unavailableQuote(
      intent,
      market,
      error instanceof Error ? error.message : "DeepBook Predict quote simulation failed."
    );
  }
}

async function getSnapshotForNextActiveOracle(intent: Extract<ParsedIntent, { status: "ready" }>) {
  const [rawStatus, rawOracles, rawVault] = await Promise.all([
    fetchPredict("/status", predictStatusSchema),
    fetchPredict(`/predicts/${predictDeployment.predictId}/oracles`, z.array(oracleSummarySchema)),
    fetchPredict(`/predicts/${predictDeployment.predictId}/vault/summary`, vaultSummarySchema)
  ]);
  const status = normalizeStatus(rawStatus);
  const oracles = rawOracles.map(normalizeOracle);
  const vault = normalizeVault(rawVault);

  const oracle = selectOracle(oracles, status.current_time_ms, intent);
  const oracleState = normalizeOracleState(await fetchPredict(`/oracles/${oracle.oracle_id}/state`, oracleStateSchema));

  return buildSnapshot(intent, status, vault, oracleState);
}

async function getSnapshotForOracle(intent: Extract<ParsedIntent, { status: "ready" }>, oracleId: string) {
  // Direct oracle lookup avoids fetching the full oracle list when the user already provided an id.
  const [rawStatus, rawVault, rawOracleState] = await Promise.all([
    fetchPredict("/status", predictStatusSchema),
    fetchPredict(`/predicts/${predictDeployment.predictId}/vault/summary`, vaultSummarySchema),
    fetchPredict(`/oracles/${oracleId}/state`, oracleStateSchema)
  ]);

  return buildSnapshot(
    intent,
    normalizeStatus(rawStatus),
    normalizeVault(rawVault),
    normalizeOracleState(rawOracleState)
  );
}

async function quoteBinaryMint(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot
) {
  const quoteBudgetRaw = intent.amountType === "quote" ? BigInt(toDusdcBaseUnits(Number(intent.amount))) : null;
  const quantityRaw = intent.quantity
    ? parseQuantityRaw(intent.quantity)
    : await quantityFromBudget(intent, market, quoteBudgetRaw);

  if (quantityRaw <= 0n) {
    throw new Error("Predict quote resolved to zero quantity.");
  }

  let amounts = await simulateTradeAmounts(intent, market, quantityRaw);

  if (quoteBudgetRaw !== null && amounts.mintCostRaw > quoteBudgetRaw) {
    const adjustedQuantity = quantityRaw * quoteBudgetRaw / amounts.mintCostRaw;

    if (adjustedQuantity <= 0n) {
      throw new Error("DUSDC budget is too small for the current Predict ask.");
    }

    amounts = await simulateTradeAmounts(intent, market, adjustedQuantity);
  }

  if (quoteBudgetRaw !== null && amounts.mintCostRaw > quoteBudgetRaw) {
    throw new Error("DeepBook quote exceeds the requested DUSDC budget after sizing.");
  }

  return amounts;
}

async function quantityFromBudget(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot,
  quoteBudgetRaw: bigint | null
) {
  if (quoteBudgetRaw === null || quoteBudgetRaw <= 0n) {
    throw new Error("A positive DUSDC budget is required for quote-based Predict sizing.");
  }

  const probe = await simulateTradeAmounts(intent, market, quoteBudgetRaw);

  if (probe.mintCostRaw <= 0n) {
    throw new Error("DeepBook Predict returned a zero-cost quote.");
  }

  return quoteBudgetRaw * quoteBudgetRaw / probe.mintCostRaw;
}

async function simulateTradeAmounts(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot,
  quantityRaw: bigint
) {
  try {
    return await simulateTradeAmountsOnce(intent, market, quantityRaw);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return simulateTradeAmountsOnce(intent, market, quantityRaw);
  }
}

async function simulateTradeAmountsOnce(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot,
  quantityRaw: bigint
) {
  const tx = new Transaction();
  tx.setSender(QUOTE_PREVIEW_SENDER);
  const oracleId = market.oracle.oracle_id;
  const strike = market.metrics.selectedStrike ?? intent.strike;

  if (!strike) {
    throw new Error("Predict strike is required before quoting payout.");
  }

  const key = tx.moveCall({
    target: `${predictDeployment.packageId}::market_key::${intent.direction === "down" ? "down" : "up"}`,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(market.oracle.expiry),
      tx.pure.u64(BigInt(toPredictPrice(strike)))
    ]
  });

  tx.moveCall({
    target: `${predictDeployment.packageId}::predict::get_trade_amounts`,
    arguments: [
      tx.object(predictDeployment.predictId),
      tx.object(oracleId),
      key,
      tx.pure.u64(quantityRaw),
      tx.object("0x6")
    ]
  });

  const result = await createQuoteClient().simulateTransaction({
    transaction: tx,
    checksEnabled: false,
    include: {
      commandResults: true,
      effects: true
    }
  });

  const status = (result.Transaction ?? result.FailedTransaction).status;

  if (!status.success) {
    throw new Error(formatExecutionError(status.error));
  }

  const returnValues = result.commandResults?.[1]?.returnValues;
  const mintCost = returnValues?.[0]?.bcs;
  const redeemPayout = returnValues?.[1]?.bcs;

  if (!mintCost || !redeemPayout) {
    throw new Error("DeepBook quote simulation did not return mint and redeem amounts.");
  }

  return {
    quantityRaw,
    mintCostRaw: parseU64(mintCost),
    redeemPayoutRaw: parseU64(redeemPayout)
  };
}

function buildAvailableQuote(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  market: PredictMarketSnapshot,
  quote: {
    quantityRaw: bigint;
    mintCostRaw: bigint;
    redeemPayoutRaw: bigint;
  }
): PredictQuotePreview {
  const quantityDusdc = rawDusdcToNumber(quote.quantityRaw);
  const estimatedCostDusdc = rawDusdcToNumber(quote.mintCostRaw);
  const redeemPayoutDusdc = rawDusdcToNumber(quote.redeemPayoutRaw);
  const potentialProfitDusdc = quantityDusdc - estimatedCostDusdc;
  const fetchedAt = new Date();

  return {
    status: "available",
    source: "sui_simulate_predict_get_trade_amounts",
    oracleId: market.oracle.oracle_id,
    expiry: market.oracle.expiry,
    direction: intent.direction ?? null,
    strike: market.metrics.selectedStrike ?? intent.strike ?? null,
    quoteBudgetDusdc: intent.amountType === "quote" ? Number(intent.amount) : null,
    quantityRaw: quote.quantityRaw.toString(),
    quantityDusdc,
    estimatedCostDusdc,
    askPrice: quantityDusdc > 0 ? estimatedCostDusdc / quantityDusdc : null,
    bidPrice: quantityDusdc > 0 ? redeemPayoutDusdc / quantityDusdc : null,
    maxPayoutDusdc: quantityDusdc,
    potentialProfitDusdc,
    returnPct: estimatedCostDusdc > 0 ? potentialProfitDusdc / estimatedCostDusdc * 100 : null,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: new Date(fetchedAt.getTime() + QUOTE_EXPIRY_MS).toISOString(),
    warning: "DeepBook Predict quote is a current-state estimate. Final execution can change if oracle or vault state changes before signing."
  };
}

function unavailableQuote(
  intent: ParsedIntent,
  market: PredictMarketSnapshot | null,
  warning: string
): PredictQuotePreview {
  const fetchedAt = new Date();
  const readyIntent = intent.status === "ready" ? intent : null;

  return {
    status: readyIntent?.action === "predict_binary_mint" ? "unavailable" : "unsupported",
    source: "not_available",
    oracleId: market?.oracle.oracle_id ?? readyIntent?.oracleId ?? null,
    expiry: market?.oracle.expiry ?? null,
    direction: readyIntent?.direction ?? null,
    strike: market?.metrics.selectedStrike ?? readyIntent?.strike ?? null,
    quoteBudgetDusdc: readyIntent?.amountType === "quote" ? Number(readyIntent.amount) : null,
    quantityRaw: null,
    quantityDusdc: null,
    estimatedCostDusdc: null,
    askPrice: null,
    bidPrice: null,
    maxPayoutDusdc: null,
    potentialProfitDusdc: null,
    returnPct: null,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: fetchedAt.toISOString(),
    warning
  };
}

function createQuoteClient() {
  if (predictDeployment.network === "mainnet") {
    throw new Error("DeepBook Predict quote preview is configured for testnet/devnet only.");
  }

  return new SuiGrpcClient({
    network: predictDeployment.network,
    baseUrl: clientGrpcUrls[predictDeployment.network]
  });
}

function parseQuantityRaw(value: string) {
  const trimmed = value.trim();

  if (!trimmed || Number(trimmed) <= 0) {
    throw new Error("Predict quantity must be positive.");
  }

  if (/^\d+$/.test(trimmed) && BigInt(trimmed) >= BigInt(DUSDC_SCALE)) {
    return BigInt(trimmed);
  }

  return BigInt(toDusdcBaseUnits(Number(trimmed)));
}

function parseU64(bytes: Uint8Array) {
  return BigInt(bcs.U64.parse(bytes));
}

function formatExecutionError(error: unknown) {
  if (!error) {
    return "DeepBook quote simulation did not succeed.";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "DeepBook quote simulation did not succeed.";
}

function rawDusdcToNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Predict quote amount is too large to display safely.");
  }

  return Number(value) / DUSDC_SCALE;
}

function buildSnapshot(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  status: PredictStatus,
  vault: VaultSummary,
  oracleState: OracleState
): PredictMarketSnapshot {
  assertPredictConsistency(vault, oracleState);

  return {
    source: "deepbook_predict",
    deployment: predictDeployment,
    status,
    oracle: oracleState.oracle,
    oracleState,
    vault,
    metrics: buildMetrics(intent, status, oracleState, vault),
    fetchedAt: new Date().toISOString()
  };
}

function assertPredictConsistency(vault: VaultSummary, oracleState: OracleState) {
  if (vault.predict_id !== predictDeployment.predictId) {
    throw new Error("Predict vault summary does not match the configured Predict object.");
  }

  if (oracleState.oracle.predict_id !== predictDeployment.predictId) {
    throw new Error("Oracle state does not belong to the configured Predict object.");
  }

  if (oracleState.oracle.underlying_asset !== "BTC") {
    throw new Error(`Unsupported Predict underlying asset: ${oracleState.oracle.underlying_asset}.`);
  }
}

function normalizeStatus(status: PredictStatus): PredictStatus {
  return {
    status: status.status,
    latest_onchain_checkpoint: status.latest_onchain_checkpoint,
    current_time_ms: status.current_time_ms,
    max_lag_pipeline: status.max_lag_pipeline,
    max_checkpoint_lag: status.max_checkpoint_lag,
    max_time_lag_seconds: status.max_time_lag_seconds
  };
}

function normalizeOracle(oracle: PredictOracleSummary): PredictOracleSummary {
  return {
    predict_id: oracle.predict_id,
    oracle_id: oracle.oracle_id,
    underlying_asset: oracle.underlying_asset,
    expiry: oracle.expiry,
    min_strike: oracle.min_strike,
    tick_size: oracle.tick_size,
    status: oracle.status,
    activated_at: oracle.activated_at,
    settlement_price: oracle.settlement_price,
    settled_at: oracle.settled_at
  };
}

function normalizeOracleState(state: OracleState): OracleState {
  return {
    oracle: normalizeOracle(state.oracle),
    latest_price: state.latest_price
      ? {
          spot: state.latest_price.spot,
          forward: state.latest_price.forward,
          onchain_timestamp: state.latest_price.onchain_timestamp,
          checkpoint: state.latest_price.checkpoint,
          event_digest: state.latest_price.event_digest
        }
      : null,
    latest_svi: state.latest_svi
      ? {
          a: state.latest_svi.a,
          b: state.latest_svi.b,
          rho: state.latest_svi.rho,
          m: state.latest_svi.m,
          sigma: state.latest_svi.sigma,
          onchain_timestamp: state.latest_svi.onchain_timestamp,
          checkpoint: state.latest_svi.checkpoint,
          event_digest: state.latest_svi.event_digest
        }
      : null,
    ask_bounds: state.ask_bounds
  };
}

function normalizeVault(vault: VaultSummary): VaultSummary {
  return {
    predict_id: vault.predict_id,
    vault_balance: vault.vault_balance,
    vault_value: vault.vault_value,
    total_mtm: vault.total_mtm,
    total_max_payout: vault.total_max_payout,
    available_liquidity: vault.available_liquidity,
    available_withdrawal: vault.available_withdrawal,
    plp_total_supply: vault.plp_total_supply,
    plp_share_price: vault.plp_share_price,
    utilization: vault.utilization,
    max_payout_utilization: vault.max_payout_utilization
  };
}

function filterOracles(
  oracles: PredictOracleSummary[],
  status: "active" | "settled" | "all",
  expiry: "next" | "today" | "this_week" | "all",
  nowMs: number
) {
  let filtered = oracles;

  if (status !== "all") {
    filtered = filtered.filter((oracle) => oracle.status === status);
  }

  if (expiry === "today") {
    filtered = filtered.filter((oracle) => oracle.expiry >= nowMs && oracle.expiry <= nowMs + 24 * 60 * 60 * 1_000);
  } else if (expiry === "this_week") {
    filtered = filtered.filter((oracle) => oracle.expiry >= nowMs && oracle.expiry <= nowMs + 7 * 24 * 60 * 60 * 1_000);
  } else if (expiry === "next") {
    filtered = filtered
      .filter((oracle) => oracle.expiry >= nowMs)
      .sort((left, right) => left.expiry - right.expiry)
      .slice(0, 1);
  }

  return filtered.sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "active" ? -1 : right.status === "active" ? 1 : left.status.localeCompare(right.status);
    }

    return left.status === "settled" ? right.expiry - left.expiry : left.expiry - right.expiry;
  });
}

function selectedStateIds(pageOracles: PredictOracleSummary[], selectedOracle: PredictOracleSummary | null) {
  const ids = new Set<string>();

  if (selectedOracle) {
    ids.add(selectedOracle.oracle_id);
  }

  // Current-page state prefetch keeps pagination useful without scanning every oracle.
  for (const oracle of pageOracles) {
    ids.add(oracle.oracle_id);
  }

  return [...ids];
}

function marketPagination(totalItems: number, requestedPage: number, pageSize: number) {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);

  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: totalPages > 0 && page < totalPages,
    hasPreviousPage: totalPages > 0 && page > 1
  };
}

function buildMarketListItem(
  oracle: PredictOracleSummary,
  status: PredictStatus,
  vault: VaultSummary,
  oracleState: OracleState | null
): MarketListItem {
  if (!oracleState) {
    return {
      oracleId: oracle.oracle_id,
      underlying: oracle.underlying_asset,
      status: oracle.status,
      expiry: oracle.expiry,
      minStrike: normalizePrice(oracle.min_strike),
      tickSize: normalizePrice(oracle.tick_size),
      spot: null,
      forward: null,
      selectedStrike: null,
      oracleAgeMs: null,
      timeToExpiryMs: Math.max(0, oracle.expiry - status.current_time_ms),
      vaultUtilization: vault.utilization,
      maxPayoutUtilization: vault.max_payout_utilization,
      availableLiquidityDusdc: normalizeDusdc(vault.available_liquidity),
      askBoundsAvailable: false,
      riskLevel: "unknown",
      guardianDecision: "unknown",
      guardianSummary: "Oracle state was not prefetched for this list row.",
      hasState: false
    };
  }

  const intent = marketQuoteIntent(oracleState.oracle);
  const snapshot = buildSnapshot(intent, status, vault, oracleState);
  const guardian = runGuardian(intent, snapshot);

  return {
    oracleId: oracle.oracle_id,
    underlying: oracle.underlying_asset,
    status: oracle.status,
    expiry: oracle.expiry,
    minStrike: normalizePrice(oracle.min_strike),
    tickSize: normalizePrice(oracle.tick_size),
    spot: snapshot.metrics.spot,
    forward: snapshot.metrics.forward,
    selectedStrike: snapshot.metrics.selectedStrike,
    oracleAgeMs: snapshot.metrics.oracleAgeMs,
    timeToExpiryMs: snapshot.metrics.timeToExpiryMs,
    vaultUtilization: snapshot.metrics.vaultUtilization,
    maxPayoutUtilization: snapshot.metrics.maxPayoutUtilization,
    availableLiquidityDusdc: snapshot.metrics.availableLiquidityDusdc,
    askBoundsAvailable: snapshot.metrics.askBoundsAvailable,
    riskLevel: guardian.level,
    guardianDecision: guardian.decision,
    guardianSummary: guardian.summary,
    hasState: true
  };
}

function marketQuoteIntent(oracle: PredictOracleSummary): Extract<ParsedIntent, { status: "ready" }> {
  return {
    status: "ready",
    action: "predict_quote_only",
    direction: "up",
    underlying: "BTC",
    quoteAsset: "DUSDC",
    amount: "10",
    amountType: "quote",
    maxOracleAgeMs: 20_000,
    maxPipelineLagSeconds: 5,
    oracleId: oracle.oracle_id,
    raw: `Quote 10 DUSDC BTC UP using oracle ${oracle.oracle_id}`
  };
}

async function fetchPredict<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREDICT_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`${predictDeployment.serverUrl}${path}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });
  } catch {
    throw new Error("Predict server request failed.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Predict server ${path} returned ${response.status}`);
  }

  const parsed = schema.safeParse(await response.json());

  if (!parsed.success) {
    throw new Error("Predict server returned an invalid payload.");
  }

  return parsed.data;
}

function selectOracle(
  oracles: PredictOracleSummary[],
  nowMs: number,
  intent: Extract<ParsedIntent, { status: "ready" }>
) {
  const active = oracles
    .filter((oracle) => oracle.underlying_asset === "BTC")
    .filter((oracle) => oracle.status === "active")
    .filter((oracle) => oracle.expiry > nowMs)
    .sort((left, right) => left.expiry - right.expiry);

  if (active.length === 0) {
    throw new Error("No active BTC Predict oracle is available.");
  }

  if (intent.expiryPreference === "specific_time" && intent.requestedExpiryMs) {
    const requested = normalizeRequestedExpiry(intent.requestedExpiryMs, nowMs);

    return [...active].sort((left, right) => {
      const leftDistance = Math.abs(left.expiry - requested);
      const rightDistance = Math.abs(right.expiry - requested);

      return leftDistance === rightDistance ? left.expiry - right.expiry : leftDistance - rightDistance;
    })[0];
  }

  return active[0];
}

function normalizeRequestedExpiry(requestedExpiryMs: number, nowMs: number) {
  if (requestedExpiryMs > nowMs) {
    return requestedExpiryMs;
  }

  return requestedExpiryMs + 24 * 60 * 60 * 1_000;
}

function buildMetrics(
  intent: Extract<ParsedIntent, { status: "ready" }>,
  status: PredictStatus,
  oracleState: OracleState,
  vault: VaultSummary
) {
  const latestPrice = oracleState.latest_price;
  const spot = latestPrice ? normalizePrice(latestPrice.spot) : null;
  const forward = latestPrice ? normalizePrice(latestPrice.forward) : null;
  const selectedStrike = chooseStrike(intent, oracleState.oracle, forward ?? spot);
  const oracleAgeMs = latestPrice ? Math.max(0, status.current_time_ms - latestPrice.onchain_timestamp) : null;
  const referencePrice = forward ?? spot;
  const strikeDistanceBps =
    referencePrice && selectedStrike ? Math.round((selectedStrike - referencePrice) / referencePrice * 10_000) : null;

  return {
    spot,
    forward,
    selectedStrike,
    strikeDistanceBps,
    oracleAgeMs,
    timeToExpiryMs: Math.max(0, oracleState.oracle.expiry - status.current_time_ms),
    pipelineLagSeconds: status.max_time_lag_seconds,
    notionalDusdc: intent.amountType === "quote" ? Number(intent.amount) : 0,
    availableLiquidityDusdc: normalizeDusdc(vault.available_liquidity),
    vaultUtilization: vault.utilization,
    maxPayoutUtilization: vault.max_payout_utilization,
    askBoundsAvailable: oracleState.ask_bounds !== null
  };
}

function chooseStrike(intent: Extract<ParsedIntent, { status: "ready" }>, oracle: PredictOracleSummary, referencePrice: number | null) {
  if (intent.strike) {
    return intent.strike;
  }

  if (intent.lowerStrike && intent.upperStrike) {
    return Math.round((intent.lowerStrike + intent.upperStrike) / 2);
  }

  const minStrike = normalizePrice(oracle.min_strike);
  const tickSize = normalizePrice(oracle.tick_size);

  if (!referencePrice || tickSize <= 0) {
    return minStrike;
  }

  return Math.max(minStrike, Math.round(referencePrice / tickSize) * tickSize);
}

export function normalizePrice(value: number) {
  return value / PRICE_SCALE;
}

export function normalizeDusdc(value: number) {
  return value / DUSDC_SCALE;
}

export function toPredictPrice(value: number) {
  return Math.round(value * PRICE_SCALE);
}

export function toDusdcBaseUnits(value: number) {
  const baseUnits = Math.round(value * DUSDC_SCALE);

  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(baseUnits)) {
    throw new Error("Invalid DUSDC amount.");
  }

  return baseUnits;
}
