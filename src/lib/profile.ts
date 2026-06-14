import { predictDeployment } from "./predict-config";
import { getPredictBinaryTradeAmounts, normalizeDusdc, normalizePrice } from "./predict";
import type {
  KeeperSnapshot,
  ProfileIndexPolicy,
  ProfileMemoryStatus,
  ProfilePnlSummary,
  ProfilePosition,
  ProfileSummary
} from "./types";

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
      "No PredictManager is linked yet. DeepPilot will not invent PnL or positions without a manager object.",
      Boolean(normalizedWallet)
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
      "Manager created, waiting for Predict indexer. Refresh after the public Predict server indexes the manager."
    );
  }

  const managerSummary = normalizeManagerSummary(manager);
  const normalizedPositions = await enrichProfilePositionsWithLiveQuotes(normalizeProfilePositions(positions));
  const normalizedPnl = normalizeProfilePnl(pnl, managerSummary);
  const keeper = buildKeeperSnapshot(normalizedPositions);

  return {
    wallet: managerSummary.owner ?? normalizedWallet ?? discoveredManager.owner,
    managerId: normalizedManager,
    managerLinked: true,
    managerNeedsCreation: false,
    network: predictDeployment.network,
    predictPackageId: predictDeployment.packageId,
    quoteAssetType: predictDeployment.quoteAssetType,
    openExposureDusdc: managerSummary.openExposureDusdc,
    redeemableValueDusdc: managerSummary.redeemableValueDusdc,
    realizedPnlDusdc: managerSummary.realizedPnlDusdc,
    tradingBalanceDusdc: managerSummary.tradingBalanceDusdc,
    tradingBalanceRaw: managerSummary.tradingBalanceRaw,
    awaitingSettlement: managerSummary.awaitingSettlement,
    positions: normalizedPositions,
    pnl: normalizedPnl,
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

function emptyProfile(
  wallet: string | null,
  managerId: string | null,
  message: string,
  managerNeedsCreation = false
): ProfileSummary {
  return {
    wallet,
    managerId,
    managerLinked: false,
    managerNeedsCreation,
    network: predictDeployment.network,
    predictPackageId: predictDeployment.packageId,
    quoteAssetType: predictDeployment.quoteAssetType,
    openExposureDusdc: null,
    redeemableValueDusdc: null,
    realizedPnlDusdc: null,
    tradingBalanceDusdc: null,
    tradingBalanceRaw: null,
    awaitingSettlement: null,
    positions: [],
    pnl: null,
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

export function normalizeProfilePositions(value: unknown): ProfilePosition[] {
  const rows = Array.isArray(value) ? value : [];

  return rows.map((position, index) => {
    const oracleId = normalizeObjectId(readStringFromKeys(position, ["oracle_id", "oracleId"]));
    const direction = readDirection(position);
    const strike = normalizePriceFromKeys(position, ["strike"]);
    const lowerStrike = normalizePriceFromKeys(position, ["lower_strike", "lowerStrike", "min_strike", "minStrike"]);
    const upperStrike = normalizePriceFromKeys(position, ["upper_strike", "upperStrike", "higher_strike", "higherStrike", "max_strike", "maxStrike"]);
    const openQuantity = readNumberFromKeys(position, ["open_quantity", "openQuantity", "quantity"]);
    const openQuantityRaw = readRawIntegerFromKeys(position, ["open_quantity", "openQuantity", "quantity"]);
    const status = readStringFromKeys(position, ["status"]) ?? "unknown";
    const kind = inferPositionKind(position, direction, strike, lowerStrike, upperStrike);
    const indexedCurrentValueDusdc = normalizeDusdcFromKeys(position, ["mark_value", "markValue", "current_value", "currentValue", "server_value", "serverValue"]);
    const redeemableValueDusdc = normalizeDusdcFromKeys(position, [
      "redeemable_value",
      "redeemableValue",
      "redeem_value",
      "redeemValue",
      "redeem_payout",
      "redeemPayout",
      "settlement_value",
      "settlementValue",
      "settled_value",
      "settledValue"
    ]);
    const indexedUnrealizedPnlDusdc = normalizeDusdcFromKeys(position, ["unrealized_pnl", "unrealizedPnl", "floating_pnl", "floatingPnl"]);
    const action = keeperAction(status, openQuantity ?? 0);
    const canRedeem = action === "redeemable";
    const costBasisDusdc = normalizeDusdcFromKeys(position, ["open_cost_basis", "openCostBasis", "cost_basis", "costBasis"]);
    const currentValueDusdc = canRedeem ? redeemableValueDusdc ?? indexedCurrentValueDusdc : indexedCurrentValueDusdc;
    const unrealizedPnlDusdc = canRedeem && redeemableValueDusdc !== null && costBasisDusdc !== null
      ? redeemableValueDusdc - costBasisDusdc
      : indexedUnrealizedPnlDusdc;
    const quoteStatus = defaultQuoteStatus(canRedeem, currentValueDusdc, unrealizedPnlDusdc);

    return {
      id: buildPositionId(position, oracleId, kind, index),
      kind,
      market: readStringFromKeys(position, ["underlying_asset", "underlyingAsset", "market", "asset"]),
      oracleId,
      status,
      expiry: readNumberFromKeys(position, ["expiry"]),
      direction,
      strike,
      lowerStrike,
      upperStrike,
      openQuantityRaw,
      openQuantityDusdc: openQuantity === null ? null : normalizeDusdc(openQuantity),
      costBasisDusdc,
      currentValueDusdc,
      unrealizedPnlDusdc,
      realizedPnlDusdc: normalizeDusdcFromKeys(position, ["realized_pnl", "realizedPnl"]),
      liveExitValueDusdc: null,
      livePnlDusdc: null,
      quoteStatus,
      canRedeem,
      action
    };
  });
}

export async function enrichProfilePositionsWithLiveQuotes(positions: ProfilePosition[]): Promise<ProfilePosition[]> {
  return Promise.all(
    positions.map(async (position) => {
      if (!isLiveQuoteableBinaryPosition(position)) {
        return position;
      }

      try {
        const quote = await getPredictBinaryTradeAmounts({
          oracleId: position.oracleId,
          expiry: position.expiry,
          strike: position.strike,
          direction: position.direction,
          quantityRaw: position.openQuantityRaw
        });

        return {
          ...position,
          liveExitValueDusdc: quote.redeemPayoutDusdc,
          livePnlDusdc: position.costBasisDusdc === null ? null : quote.redeemPayoutDusdc - position.costBasisDusdc,
          quoteStatus: "live"
        };
      } catch {
        return position;
      }
    })
  );
}

export function normalizeProfilePnl(value: unknown, managerSummary?: { realizedPnlDusdc: number | null }): ProfilePnlSummary | null {
  if (!isRecord(value) && managerSummary?.realizedPnlDusdc === null) {
    return null;
  }

  const realized = normalizeDusdcFromKeys(value, ["realized_pnl", "realizedPnl"]) ?? managerSummary?.realizedPnlDusdc ?? null;
  const unrealized = normalizeDusdcFromKeys(value, [
    "current_unrealized_pnl",
    "currentUnrealizedPnl",
    "unrealized_pnl",
    "unrealizedPnl"
  ]);
  const explicitTotal = normalizeDusdcFromKeys(value, ["current_total_pnl", "currentTotalPnl", "total_pnl", "totalPnl"]);
  const total = explicitTotal ?? (realized !== null && unrealized !== null ? realized + unrealized : null);

  if (realized === null && unrealized === null && total === null) {
    return null;
  }

  return {
    realizedPnlDusdc: realized,
    unrealizedPnlDusdc: unrealized,
    totalPnlDusdc: total,
    range: readStringFromKeys(value, ["range"]) ?? "ALL",
    source: "predict_server"
  };
}

function buildKeeperSnapshot(positions: ProfilePosition[]): KeeperSnapshot {
  const checkedAt = new Date().toISOString();

  return {
    source: "predict_server_replay",
    checkedAt,
    monitoringEnabled: positions.some((position) => position.action !== "none"),
    items: positions.flatMap((position) => {
      if (!position.oracleId) {
        return [];
      }

      return [{
        oracleId: position.oracleId,
        status: position.status,
        openQuantity: position.openQuantityDusdc ?? 0,
        action: position.action,
        detail: position.action === "redeemable"
          ? "Position appears settled and redeemable from Predict server replay."
          : position.action === "monitor_settlement"
            ? "Keeper should monitor this position until settlement."
            : "No keeper action required."
      }];
    })
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
    preview: {
      provider: "Walrus + Seal",
      status: "preview_only",
      policy: "Seal-encrypted memory preview; not uploaded until user opts in.",
      keys: [
        {
          key: "risk_preference",
          label: "risk preference",
          value: "Local risk limits and preferred confirmation style"
        },
        {
          key: "last_market_thesis",
          label: "last market thesis",
          value: "Recent AI market summary approved by the user"
        },
        {
          key: "keeper_history",
          label: "keeper history",
          value: "Settlement and redeem reminder history"
        },
        {
          key: "sealed_receipt_pointer",
          label: "sealed receipt pointer",
          value: "Encrypted receipt pointer for future Walrus storage"
        }
      ]
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

function readStringFromKeys(value: unknown, keys: string[]) {
  for (const key of keys) {
    const result = readString(value, key);

    if (result !== null) {
      return result;
    }
  }

  return null;
}

function readNumberFromKeys(value: unknown, keys: string[]) {
  for (const key of keys) {
    const result = readNumeric(value, key);

    if (result !== null) {
      return result;
    }
  }

  return null;
}

function readRawIntegerFromKeys(value: unknown, keys: string[]) {
  for (const key of keys) {
    const result = readRawInteger(value, key);

    if (result !== null) {
      return result;
    }
  }

  return null;
}

function readNumeric(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const field = value[key];

  if (typeof field === "number" && Number.isFinite(field)) {
    return field;
  }

  if (typeof field === "string" && /^-?\d+(\.\d+)?$/.test(field)) {
    const numeric = Number(field);

    return Number.isFinite(numeric) ? numeric : null;
  }

  return null;
}

function readRawInteger(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const field = value[key];

  if (typeof field === "string" && /^-?\d+$/.test(field)) {
    return field;
  }

  if (typeof field === "number" && Number.isSafeInteger(field)) {
    return String(field);
  }

  return null;
}

function normalizeDusdcFromKeys(value: unknown, keys: string[]) {
  const raw = readNumberFromKeys(value, keys);

  return raw === null ? null : normalizeDusdc(raw);
}

function normalizePriceFromKeys(value: unknown, keys: string[]) {
  const raw = readNumberFromKeys(value, keys);

  return raw === null ? null : normalizePrice(raw);
}

function readDirection(value: unknown) {
  const direction = readStringFromKeys(value, ["direction"]);

  if (direction?.toLowerCase() === "up" || direction?.toLowerCase() === "down") {
    return direction.toLowerCase() as ProfilePosition["direction"];
  }

  if (isRecord(value) && typeof value.is_up === "boolean") {
    return value.is_up ? "up" : "down";
  }

  if (isRecord(value) && typeof value.isUp === "boolean") {
    return value.isUp ? "up" : "down";
  }

  return null;
}

function inferPositionKind(
  value: unknown,
  direction: ProfilePosition["direction"],
  strike: number | null,
  lowerStrike: number | null,
  upperStrike: number | null
): ProfilePosition["kind"] {
  const explicitKind = readStringFromKeys(value, ["kind", "position_type", "positionType", "type"])?.toLowerCase();

  if (explicitKind === "binary" || explicitKind === "range") {
    return explicitKind;
  }

  if (lowerStrike !== null || upperStrike !== null) {
    return "range";
  }

  if (direction !== null || strike !== null) {
    return "binary";
  }

  return "unknown";
}

function buildPositionId(value: unknown, oracleId: string | null, kind: ProfilePosition["kind"], index: number) {
  const explicitId = readStringFromKeys(value, ["position_id", "positionId", "id"]);

  if (explicitId) {
    return explicitId;
  }

  const expiry = readNumberFromKeys(value, ["expiry"]) ?? "no-expiry";
  const strike = readRawIntegerFromKeys(value, ["strike", "lower_strike", "lowerStrike", "upper_strike", "upperStrike"]) ?? "no-strike";

  return `${oracleId ?? "unknown"}-${kind}-${expiry}-${strike}-${index}`;
}

function defaultQuoteStatus(
  canRedeem: boolean,
  currentValueDusdc: number | null,
  unrealizedPnlDusdc: number | null
): ProfilePosition["quoteStatus"] {
  if (canRedeem) {
    return "settled";
  }

  if (currentValueDusdc !== null || unrealizedPnlDusdc !== null) {
    return "indexed";
  }

  return "unavailable";
}

function isLiveQuoteableBinaryPosition(position: ProfilePosition): position is ProfilePosition & {
  oracleId: string;
  expiry: number;
  strike: number;
  direction: NonNullable<ProfilePosition["direction"]>;
  openQuantityRaw: string;
} {
  return position.kind === "binary" &&
    position.action === "monitor_settlement" &&
    Boolean(position.oracleId) &&
    typeof position.expiry === "number" &&
    typeof position.strike === "number" &&
    Boolean(position.direction) &&
    Boolean(position.openQuantityRaw && /^\d+$/.test(position.openQuantityRaw));
}

function keeperAction(status: string, openQuantity: number): ProfilePosition["action"] {
  const normalizedStatus = status.toLowerCase();

  if (openQuantity <= 0) {
    return "none";
  }

  if (normalizedStatus === "settled" || normalizedStatus === "redeemable") {
    return "redeemable";
  }

  return "monitor_settlement";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
