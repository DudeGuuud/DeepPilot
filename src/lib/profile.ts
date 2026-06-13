import { predictDeployment } from "./predict-config";
import { normalizeDusdc } from "./predict";
import type { KeeperSnapshot, ProfileIndexPolicy, ProfileMemoryStatus, ProfileSummary } from "./types";

const objectIdPattern = /^0x[a-fA-F0-9]{1,64}$/;

type ProfileInput = {
  wallet?: string | null;
  managerId?: string | null;
};

export async function getProfileSummary({ wallet, managerId }: ProfileInput): Promise<ProfileSummary> {
  const normalizedWallet = normalizeObjectId(wallet);
  const discoveredManager = await discoverManager(normalizedWallet, managerId);
  const normalizedManager = discoveredManager.managerId;

  if (!normalizedManager) {
    return emptyProfile(
      normalizedWallet,
      null,
      "No PredictManager is linked yet. DeepPilot will not invent PnL or positions without a manager object."
    );
  }

  const [manager, positions, pnl] = await Promise.all([
    fetchManagerJson(`/managers/${normalizedManager}/summary`),
    fetchManagerJson(`/managers/${normalizedManager}/positions/summary`),
    fetchManagerJson(`/managers/${normalizedManager}/pnl?range=ALL`)
  ]);

  if (!manager && !positions && !pnl) {
    return emptyProfile(
      normalizedWallet,
      normalizedManager,
      "Predict server did not find this manager. Check the manager id before trusting portfolio data."
    );
  }

  const managerSummary = normalizeManagerSummary(manager);
  const keeper = buildKeeperSnapshot(positions);

  return {
    wallet: managerSummary.owner ?? normalizedWallet ?? discoveredManager.owner,
    managerId: normalizedManager,
    managerLinked: true,
    network: predictDeployment.network,
    openExposureDusdc: managerSummary.openExposureDusdc,
    redeemableValueDusdc: managerSummary.redeemableValueDusdc,
    realizedPnlDusdc: managerSummary.realizedPnlDusdc,
    tradingBalanceDusdc: managerSummary.tradingBalanceDusdc,
    tradingBalanceRaw: managerSummary.tradingBalanceRaw,
    awaitingSettlement: managerSummary.awaitingSettlement,
    guardianBlockedCount: 0,
    activity: [],
    keeper,
    indexPolicy: defaultIndexPolicy(),
    memory: defaultMemoryStatus(normalizedWallet, normalizedManager),
    message: managerSummary.tradingBalanceDusdc === null
      ? "Manager endpoints responded. DeepPilot keeps unknown values empty instead of fabricating PnL."
      : `Manager linked with ${managerSummary.tradingBalanceDusdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC trading balance.`,
    rawManager: manager,
    rawPositions: positions,
    rawPnl: pnl
  };
}

function emptyProfile(wallet: string | null, managerId: string | null, message: string): ProfileSummary {
  return {
    wallet,
    managerId,
    managerLinked: false,
    network: predictDeployment.network,
    openExposureDusdc: null,
    redeemableValueDusdc: null,
    realizedPnlDusdc: null,
    tradingBalanceDusdc: null,
    tradingBalanceRaw: null,
    awaitingSettlement: null,
    guardianBlockedCount: 0,
    activity: [],
    keeper: emptyKeeperSnapshot(),
    indexPolicy: defaultIndexPolicy(),
    memory: defaultMemoryStatus(wallet, managerId),
    message
  };
}

async function discoverManager(wallet: string | null, explicitManager?: string | null) {
  const normalizedManager = normalizeObjectId(explicitManager);

  if (normalizedManager) {
    return {
      managerId: normalizedManager,
      owner: wallet
    };
  }

  if (!wallet) {
    return {
      managerId: null,
      owner: null
    };
  }

  const events = await fetchManagerJson(`/managers?owner=${wallet}`) as unknown;
  const managers = Array.isArray(events)
    ? events
        .map((event) => ({
          managerId: normalizeObjectId(readString(event, "manager_id")),
          owner: normalizeObjectId(readString(event, "owner")),
          checkpointTimestampMs: readNumber(event, "checkpoint_timestamp_ms") ?? 0
        }))
        .filter((event): event is { managerId: string; owner: string | null; checkpointTimestampMs: number } => Boolean(event.managerId))
        .sort((left, right) => right.checkpointTimestampMs - left.checkpointTimestampMs)
    : [];

  return {
    managerId: managers[0]?.managerId ?? null,
    owner: managers[0]?.owner ?? wallet
  };
}

async function fetchManagerJson(path: string) {
  const response = await fetch(`${predictDeployment.serverUrl}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Predict manager endpoint ${path} returned ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

function normalizeObjectId(value?: string | null) {
  const trimmed = value?.trim();

  return trimmed && objectIdPattern.test(trimmed) ? trimmed : null;
}

function normalizeManagerSummary(value: unknown) {
  const tradingBalance = readNumber(value, "trading_balance");
  const openExposure = readNumber(value, "open_exposure");
  const redeemableValue = readNumber(value, "redeemable_value");
  const realizedPnl = readNumber(value, "realized_pnl");
  const awaitingSettlement = readNumber(value, "awaiting_settlement_positions");

  return {
    owner: normalizeObjectId(readString(value, "owner")),
    tradingBalanceDusdc: tradingBalance === null ? null : normalizeDusdc(tradingBalance),
    tradingBalanceRaw: readRawU64(value, "trading_balance"),
    openExposureDusdc: openExposure === null ? null : normalizeDusdc(openExposure),
    redeemableValueDusdc: redeemableValue === null ? null : normalizeDusdc(redeemableValue),
    realizedPnlDusdc: realizedPnl === null ? null : normalizeDusdc(realizedPnl),
    awaitingSettlement
  };
}

function buildKeeperSnapshot(value: unknown): KeeperSnapshot {
  const checkedAt = new Date().toISOString();
  const positions = Array.isArray(value) ? value : [];

  return {
    source: "predict_server_replay",
    checkedAt,
    monitoringEnabled: positions.length > 0,
    items: positions
      .map((position) => {
        const oracleId = normalizeObjectId(readString(position, "oracle_id"));
        const status = readString(position, "status") ?? "unknown";
        const openQuantity = readNumber(position, "open_quantity") ?? 0;

        if (!oracleId) {
          return null;
        }

        return {
          oracleId,
          status,
          openQuantity,
          action: status === "settled" && openQuantity > 0 ? "redeemable" : openQuantity > 0 ? "monitor_settlement" : "none",
          detail: status === "settled" && openQuantity > 0
            ? "Position appears settled and redeemable from Predict server replay."
            : openQuantity > 0
              ? "Keeper should monitor this position until settlement."
              : "No keeper action required."
        } satisfies KeeperSnapshot["items"][number];
      })
      .filter((item): item is KeeperSnapshot["items"][number] => item !== null)
  };
}

function emptyKeeperSnapshot(): KeeperSnapshot {
  return {
    source: "predict_server_replay",
    checkedAt: new Date().toISOString(),
    monitoringEnabled: false,
    items: []
  };
}

function defaultIndexPolicy(): ProfileIndexPolicy {
  return {
    registry: "deep_pilot_profile_registry",
    status: "planned",
    publicValues: ["profile_id", "manager_id", "oracle_id", "tx_digest", "receipt_hash", "keeper_action_type", "timestamp"],
    consentRequiredValues: ["realized_pnl", "win_loss_count", "open_exposure", "redeemable_value", "average_trade_size"],
    privateValues: ["full_reasoning_trace", "raw_risk_profile", "private_strategy_preferences", "sealed_memory_plaintext"]
  };
}

function defaultMemoryStatus(wallet: string | null, managerId: string | null): ProfileMemoryStatus {
  return {
    sealedReceipts: {
      provider: "Walrus + Seal",
      status: "not_configured",
      policy: "Owner-only encrypted receipt pointers; browser-local receipts stay local until the user opts in."
    },
    longTermMemory: {
      provider: "Walrus Memory / MemWal",
      status: "not_configured",
      namespace: wallet ?? managerId,
      stores: ["portable risk profile", "keeper history", "audit summaries", "user-approved preferences"]
    }
  };
}

function readString(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function readNumber(value: unknown, key: string) {
  return isRecord(value) && typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : null;
}

function readRawU64(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const field = value[key];

  if (typeof field === "string" && /^\d+$/.test(field)) {
    return field;
  }

  if (typeof field === "number" && Number.isSafeInteger(field) && field >= 0) {
    return String(field);
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
