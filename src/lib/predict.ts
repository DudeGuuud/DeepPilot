import { predictDeployment } from "./predict-config";
import { z } from "zod";
import type {
  OracleState,
  ParsedIntent,
  PredictMarketSnapshot,
  PredictOracleSummary,
  PredictStatus,
  VaultSummary
} from "./types";

const PRICE_SCALE = 1_000_000_000;
const DUSDC_SCALE = 1_000_000;
const PREDICT_TIMEOUT_MS = 5_000;

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

export { predictDeployment };

export function createPredictClientPreview() {
  return {
    network: predictDeployment.network,
    transport: "DeepBook Predict public server",
    endpoint: predictDeployment.serverUrl,
    predictId: predictDeployment.predictId,
    quoteAsset: "DUSDC"
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

  const oracle = selectOracle(oracles, status.current_time_ms);
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

function selectOracle(oracles: PredictOracleSummary[], nowMs: number) {
  const active = oracles
    .filter((oracle) => oracle.underlying_asset === "BTC")
    .filter((oracle) => oracle.status === "active")
    .filter((oracle) => oracle.expiry > nowMs)
    .sort((left, right) => left.expiry - right.expiry);

  if (active.length === 0) {
    throw new Error("No active BTC Predict oracle is available.");
  }

  return active[0];
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
    notionalDusdc: Number(intent.amount),
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
