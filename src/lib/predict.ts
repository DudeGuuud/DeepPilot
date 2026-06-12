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
  PredictSviEvent,
  PredictStatus,
  VaultSummary
} from "./types";

const PRICE_SCALE = 1_000_000_000;
const DUSDC_SCALE = 1_000_000;
const PREDICT_TIMEOUT_MS = 5_000;
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
