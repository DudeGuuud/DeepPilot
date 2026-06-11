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

  const [status, oracles, vault] = await Promise.all([
    fetchPredict<PredictStatus>("/status"),
    fetchPredict<PredictOracleSummary[]>(`/predicts/${predictDeployment.predictId}/oracles`),
    fetchPredict<VaultSummary>(`/predicts/${predictDeployment.predictId}/vault/summary`)
  ]);

  const oracle = selectOracle(oracles, intent, status.current_time_ms);
  const oracleState = await fetchPredict<OracleState>(`/oracles/${oracle.oracle_id}/state`);

  return {
    source: "deepbook_predict_testnet",
    deployment: predictDeployment,
    status,
    oracle,
    oracleState,
    vault,
    metrics: buildMetrics(intent, status, oracleState, vault),
    fetchedAt: new Date().toISOString()
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

function selectOracle(oracles: PredictOracleSummary[], intent: Extract<ParsedIntent, { status: "ready" }>, nowMs: number) {
  const active = oracles
    .filter((oracle) => oracle.underlying_asset === "BTC")
    .filter((oracle) => oracle.status === "active")
    .filter((oracle) => oracle.expiry > nowMs)
    .sort((left, right) => left.expiry - right.expiry);

  if (intent.oracleId) {
    const requested = oracles.find((oracle) => oracle.oracle_id === intent.oracleId);

    if (requested) {
      return requested;
    }
  }

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
