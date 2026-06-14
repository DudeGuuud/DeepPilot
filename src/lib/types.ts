export type PredictIntentAction =
  | "predict_binary_mint"
  | "predict_range_mint"
  | "predict_redeem"
  | "predict_quote_only"
  | "stablecoin_transfer";

export type PredictDirection = "up" | "down";
export type AmountType = "quote" | "base";
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type GasMode = "sponsored" | "gasless_stablecoin_transfer" | "user_pays_gas";
export type MarketRiskLevel = RiskLevel | "unknown";
export type ExpiryPreference = "next_active" | "specific_time";
export type TradeSizingMode = "quote_budget" | "explicit_quantity" | "not_required";
export type PilotMode = "chat" | "trade";

export type ParsedIntent =
  | {
      status: "ready";
      action: PredictIntentAction;
      direction?: PredictDirection;
      underlying: "BTC";
      quoteAsset: "DUSDC";
      amount: string;
      amountType: AmountType;
      maxOracleAgeMs: number;
      maxPipelineLagSeconds: number;
      strike?: number;
      lowerStrike?: number;
      upperStrike?: number;
      expiryPreference?: ExpiryPreference;
      requestedExpiryMs?: number;
      expiryLabel?: string;
      quantity?: string;
      oracleId?: string;
      recipient?: string;
      raw: string;
    }
  | {
      status: "needs_clarification";
      missing: string[];
      reason: string;
      raw: string;
    };

export interface PilotClassification {
  mode: PilotMode;
  asset: "BTC" | "ETH" | "SOL" | "TRX" | null;
  question: string;
  draftIntent: ParsedIntent | null;
  missing: string[];
}

export interface PilotMessageSummary {
  role: "user" | "assistant";
  content: string;
  mode?: PilotMode;
  sourceTitles?: string[];
}

export interface ConversationContext {
  messages: PilotMessageSummary[];
  lastMarketThesis?: string | null;
}

export interface ActiveMarketContextItem {
  oracleId: string;
  expiry: number;
  expiryIso: string;
  status: string;
  isEarliestActive: boolean;
}

export interface ActiveMarketContext {
  asset: "BTC";
  nowIso: string;
  earliestActiveOracleId: string | null;
  markets: ActiveMarketContextItem[];
}

export interface RagSource {
  id: string;
  title: string;
  url?: string;
  sourceType: "predict" | "news" | "repo" | "docs";
  publishedAt?: string;
  snippet: string;
  partial?: boolean;
}

export interface PredictDeployment {
  network: "devnet" | "testnet" | "mainnet";
  serverUrl: string;
  packageId: string;
  predictId: string;
  quoteAssetType: string;
  plpCoinType: string;
  sourceBranch: string;
}

export interface PredictStatus {
  status: string;
  latest_onchain_checkpoint: number;
  current_time_ms: number;
  max_lag_pipeline: string;
  max_checkpoint_lag: number;
  max_time_lag_seconds: number;
}

export interface PredictOracleSummary {
  predict_id: string;
  oracle_id: string;
  underlying_asset: "BTC";
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: "active" | "pending" | "settled" | string;
  activated_at: number | null;
  settlement_price: number | null;
  settled_at: number | null;
}

export interface OraclePrice {
  spot: number;
  forward: number;
  onchain_timestamp: number;
  checkpoint?: number;
  event_digest?: string;
}

export interface OracleSvi {
  a: number;
  b: number;
  rho: number;
  m?: number;
  sigma?: number;
  onchain_timestamp?: number;
  checkpoint?: number;
  event_digest?: string;
}

export interface OracleState {
  oracle: PredictOracleSummary;
  latest_price: OraclePrice | null;
  latest_svi: OracleSvi | null;
  ask_bounds: unknown | null;
}

export interface VaultSummary {
  predict_id: string;
  vault_balance: number;
  vault_value: number;
  total_mtm: number;
  total_max_payout: number;
  available_liquidity: number;
  available_withdrawal: number;
  plp_total_supply: number;
  plp_share_price: number;
  utilization: number;
  max_payout_utilization: number;
}

export interface PredictRiskMetrics {
  spot: number | null;
  forward: number | null;
  selectedStrike: number | null;
  strikeDistanceBps: number | null;
  oracleAgeMs: number | null;
  timeToExpiryMs: number;
  pipelineLagSeconds: number;
  notionalDusdc: number;
  availableLiquidityDusdc: number;
  vaultUtilization: number;
  maxPayoutUtilization: number;
  askBoundsAvailable: boolean;
}

export interface PredictMarketSnapshot {
  source: "deepbook_predict";
  deployment: PredictDeployment;
  status: PredictStatus;
  oracle: PredictOracleSummary;
  oracleState: OracleState;
  vault: VaultSummary;
  metrics: PredictRiskMetrics;
  fetchedAt: string;
}

export interface PredictQuotePreview {
  status: "available" | "unavailable" | "unsupported";
  source: "sui_simulate_predict_get_trade_amounts" | "not_available";
  oracleId: string | null;
  expiry: number | null;
  direction: PredictDirection | null;
  strike: number | null;
  quoteBudgetDusdc: number | null;
  quoteBudgetRaw: string | null;
  quantityRaw: string | null;
  quantityDusdc: number | null;
  estimatedCostDusdc: number | null;
  estimatedCostRaw: string | null;
  askPrice: number | null;
  bidPrice: number | null;
  maxPayoutDusdc: number | null;
  maxPayoutRaw: string | null;
  potentialProfitDusdc: number | null;
  returnPct: number | null;
  fetchedAt: string;
  expiresAt: string;
  warning: string | null;
}

export interface GuardianFinding {
  type:
    | "INCOMPLETE_INTENT"
    | "API_UNAVAILABLE"
    | "ORACLE_STALE"
    | "INDEXER_LAG"
    | "ORACLE_NOT_ACTIVE"
    | "EXPIRED_ORACLE"
    | "HIGH_VAULT_UTILIZATION"
    | "MISSING_ASK_BOUNDS"
    | "SIZE_OVER_LIQUIDITY"
    | "DUSDC_REQUIRED"
    | "UNSUPPORTED_INTENT"
    | "QUOTE_UNAVAILABLE"
    | "CONFIG_ERROR";
  title: string;
  explanation: string;
}

export interface GuardianResult {
  score: number;
  level: RiskLevel;
  blocked: boolean;
  decision: "allow" | "reduce" | "block";
  findings: GuardianFinding[];
  summary: string;
}

export interface PtbCommandPreview {
  index: number;
  command: string;
  target: string;
  riskGate: "pre-sign" | "atomic" | "receipt";
  inputs?: Record<string, string | number | boolean | null>;
}

export interface TradeSizingPreview {
  mode: TradeSizingMode;
  quoteBudgetDusdc: number | null;
  quantityRaw: string | null;
  executable: boolean;
  label: string;
  reason: string;
}

export interface ExecutionReadinessCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ExecutionReadiness {
  canSign: boolean;
  mode: "wallet_transaction" | "preview_only";
  reason: string;
  walletAddress: string | null;
  managerId: string | null;
  managerBalanceDusdc: number | null;
  managerBalanceRaw: string | null;
  requiredQuoteDusdc: number | null;
  requiredQuoteRaw: string | null;
  requiredTopUpRaw: string | null;
  checks: ExecutionReadinessCheck[];
}

export interface PtbTransactionData {
  kind: "ProgrammableTransaction";
  network: PredictDeployment["network"];
  packageId: string;
  predictObject: string;
  quoteAssetType: string;
  onchainAuditEnabled: boolean;
  manager: string | null;
  oracleId: string | null;
  key: {
    target: string | null;
    oracleId: string | null;
    expiry: number | null;
    strikeScaled: number | null;
    direction: PredictDirection | null;
  };
  mint: {
    target: string | null;
    quantityRaw: string | null;
  };
  quote: {
    source: PredictQuotePreview["source"];
    estimatedCostDusdc: number | null;
    estimatedCostRaw: string | null;
    maxPayoutDusdc: number | null;
    maxPayoutRaw: string | null;
    askPrice: number | null;
    returnPct: number | null;
    expiresAt: string;
  } | null;
  intent: {
    action: PredictIntentAction;
    direction?: PredictDirection;
    amount: string;
    amountType: AmountType;
    quoteBudgetDusdc: number | null;
    quantityRaw: string | null;
    strike: number | null;
    strikeScaled: number | null;
    lowerStrike: number | null;
    lowerStrikeScaled: number | null;
    upperStrike: number | null;
  };
  requirements: PtbPlan["requirements"];
  commands: PtbCommandPreview[];
}

export interface PtbPlan {
  sender: string;
  sponsor: string;
  gasBudget: number;
  gasOwner: string;
  transactionKind: "ProgrammableTransaction";
  commands: PtbCommandPreview[];
  requirements: Array<{
    label: string;
    satisfied: boolean;
    detail: string;
  }>;
  sizing: TradeSizingPreview;
  execution: ExecutionReadiness;
  transactionData: PtbTransactionData;
  digestPreview: string;
  simulated: {
    status: "not_submitted";
    reason: string;
    explorerReady: boolean;
  };
}

export interface SponsorPolicy {
  allowedPackages: string[];
  allowedMoveCalls: string[];
  maxGasBudget: number;
  maxTradeSizeDusdc: number;
}

export interface SponsorDecision {
  mode: GasMode;
  approved: boolean;
  label: string;
  checks: Array<{
    label: string;
    passed: boolean;
  }>;
}

export interface CompileResult {
  intent: ParsedIntent;
  market: PredictMarketSnapshot | null;
  profile: ProfileSummary | null;
  guardian: GuardianResult;
  gas: SponsorDecision;
  quote: PredictQuotePreview | null;
  ptb: PtbPlan | null;
  reviewFreshness?: {
    checkedAt: string;
    active: boolean;
    refreshed: boolean;
    reason: string;
  };
  timeline: Array<{
    label: string;
    state: "complete" | "blocked" | "pending";
  }>;
}

export type CompileStreamEvent =
  | {
      type: "stage";
      label: string;
      state: "complete" | "blocked" | "pending";
      detail?: string;
    }
  | {
      type: "llm_delta";
      delta: string;
    }
  | {
      type: "llm_output";
      content: string;
    }
  | {
      type: "fallback";
      reason: string;
    }
  | {
      type: "compiled";
      result: CompileResult;
    }
  | {
      type: "error";
      error: string;
    };

export type PilotStreamEvent =
  | {
      type: "mode";
      mode: PilotMode;
      classification: PilotClassification;
    }
  | {
      type: "answer_delta";
      delta: string;
    }
  | {
      type: "sources";
      sources: RagSource[];
    }
  | {
      type: "stage";
      label: string;
      state: "complete" | "blocked" | "pending";
      detail?: string;
    }
  | {
      type: "compiled";
      result: CompileResult;
    }
  | {
      type: "error";
      error: string;
    };

export interface MarketListItem {
  oracleId: string;
  underlying: "BTC";
  status: string;
  expiry: number;
  minStrike: number;
  tickSize: number;
  spot: number | null;
  forward: number | null;
  selectedStrike: number | null;
  oracleAgeMs: number | null;
  timeToExpiryMs: number;
  vaultUtilization: number;
  maxPayoutUtilization: number;
  availableLiquidityDusdc: number;
  askBoundsAvailable: boolean;
  riskLevel: MarketRiskLevel;
  guardianDecision: GuardianResult["decision"] | "unknown";
  guardianSummary: string;
  hasState: boolean;
}

export interface MarketDiscoveryResult {
  predict: {
    network: PredictDeployment["network"];
    transport: string;
    endpoint: string;
    predictId: string;
    quoteAsset: "DUSDC";
  };
  fetchedAt: string;
  status: PredictStatus;
  vault: VaultSummary;
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  markets: MarketListItem[];
  selectedMarket: MarketListItem | null;
}

export interface PredictChartPoint {
  time: number;
  spot: number;
  forward: number | null;
}

export interface PredictSviEvent {
  time: number;
  checkpoint: number | null;
  a: number;
  b: number;
  rho: number;
  m: number | null;
  sigma: number | null;
}

export interface PredictOracleHistory {
  oracleId: string;
  fetchedAt: string;
  capped: boolean;
  points: PredictChartPoint[];
  sviEvents: PredictSviEvent[];
}

export interface ProfileActivityItem {
  id: string;
  time: string;
  type: "compile" | "sponsor_preview" | "manager_create" | "predict_mint" | "mint" | "redeem" | "keeper";
  oracleId?: string;
  digest?: string;
  guardianDecision?: GuardianResult["decision"];
  summary: string;
}

export interface KeeperSnapshotItem {
  oracleId: string;
  status: string;
  openQuantity: number;
  action: "monitor_settlement" | "redeemable" | "none";
  detail: string;
}

export interface KeeperSnapshot {
  source: "predict_server_replay";
  checkedAt: string;
  monitoringEnabled: boolean;
  items: KeeperSnapshotItem[];
}

export interface ProfilePosition {
  id: string;
  kind: "binary" | "range" | "unknown";
  market: string | null;
  oracleId: string | null;
  status: string;
  expiry: number | null;
  direction: PredictDirection | null;
  strike: number | null;
  lowerStrike: number | null;
  upperStrike: number | null;
  openQuantityRaw: string | null;
  openQuantityDusdc: number | null;
  costBasisDusdc: number | null;
  currentValueDusdc: number | null;
  unrealizedPnlDusdc: number | null;
  realizedPnlDusdc: number | null;
  liveExitValueDusdc: number | null;
  livePnlDusdc: number | null;
  quoteStatus: "live" | "indexed" | "unavailable" | "settled";
  canRedeem: boolean;
  action: "monitor_settlement" | "redeemable" | "none";
}

export interface ProfilePnlSummary {
  realizedPnlDusdc: number | null;
  unrealizedPnlDusdc: number | null;
  totalPnlDusdc: number | null;
  range: string;
  source: "predict_server";
}

export interface ProfileIndexPolicy {
  registry: "deep_pilot_profile_registry";
  status: "planned";
  publicValues: string[];
  consentRequiredValues: string[];
  privateValues: string[];
}

export interface ProfileMemoryStatus {
  sealedReceipts: {
    provider: "Walrus + Seal";
    status: "not_configured" | "ready";
    policy: string;
  };
  preview: {
    provider: "Walrus + Seal";
    status: "preview_only";
    policy: string;
    keys: Array<{
      key: string;
      label: string;
      value: string;
    }>;
  };
  longTermMemory: {
    provider: "Walrus Memory / MemWal";
    status: "not_configured" | "ready";
    namespace: string | null;
    stores: string[];
  };
}

export interface ProfileSummary {
  wallet: string | null;
  network: PredictDeployment["network"];
  predictPackageId: string;
  managerId: string | null;
  managerLinked: boolean;
  managerNeedsCreation: boolean;
  message: string;
  openExposureDusdc: number | null;
  redeemableValueDusdc: number | null;
  realizedPnlDusdc: number | null;
  tradingBalanceDusdc: number | null;
  tradingBalanceRaw: string | null;
  awaitingSettlement: number | null;
  positions: ProfilePosition[];
  pnl: ProfilePnlSummary | null;
  guardianBlockedCount: number;
  activity: ProfileActivityItem[];
  keeper: KeeperSnapshot;
  indexPolicy: ProfileIndexPolicy;
  memory: ProfileMemoryStatus;
  rawManager?: unknown;
  rawPositions?: unknown;
  rawPnl?: unknown;
}
