import { predictDeployment } from "./predict-config";
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
    fetchPredict<PredictStatus>("/status"),
    fetchPredict<PredictOracleSummary[]>(`/predicts/${predictDeployment.predictId}/oracles`),
    fetchPredict<VaultSummary>(`/predicts/${predictDeployment.predictId}/vault/summary`)
  ]);
  const status = normalizeStatus(rawStatus);
  const oracles = rawOracles.map(normalizeOracle);
  const vault = normalizeVault(rawVault);

  const oracle = selectOracle(oracles, status.current_time_ms);
  const oracleState = normalizeOracleState(await fetchPredict<OracleState>(`/oracles/${oracle.oracle_id}/state`));

  return buildSnapshot(intent, status, vault, oracleState);
}

async function getSnapshotForOracle(intent: Extract<ParsedIntent, { status: "ready" }>, oracleId: string) {
  // Direct oracle lookup avoids fetching the full oracle list when the user already provided an id.
  const [rawStatus, rawVault, rawOracleState] = await Promise.all([
    fetchPredict<PredictStatus>("/status"),
    fetchPredict<VaultSummary>(`/predicts/${predictDeployment.predictId}/vault/summary`),
    fetchPredict<OracleState>(`/oracles/${oracleId}/state`)
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

async function fetchPredict<T>(path: string): Promise<T> {
  const response = await fetch(`${predictDeployment.serverUrl}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Predict server ${path} returned ${response.status}`);
  }

  return response.json() as Promise<T>;
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
  return Math.round(value * DUSDC_SCALE);
}
