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

export interface PredictDeployment {
  network: "devnet" | "testnet" | "mainnet";
  serverUrl: string;
  packageId: string;
  predictId: string;
  quoteAssetType: string;
  plpCoinType: string;
  sourceBranch: string;
}

export interface PredictStatusPipeline {
  pipeline: string;
  checkpoint_lag: number;
  time_lag_ms: number;
  time_lag_seconds: number;
}

export interface PredictStatus {
  status: string;
  latest_onchain_checkpoint: number;
  current_time_ms: number;
  max_lag_pipeline: string;
  max_checkpoint_lag: number;
  max_time_lag_seconds: number;
  pipelines: PredictStatusPipeline[];
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
  source: "deepbook_predict_testnet";
  deployment: PredictDeployment;
  status: PredictStatus;
  oracle: PredictOracleSummary;
  oracleState: OracleState;
  vault: VaultSummary;
  metrics: PredictRiskMetrics;
  fetchedAt: string;
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
    | "UNSUPPORTED_INTENT";
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
  transactionData: unknown;
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
  maxDailySponsoredTxPerWallet: number;
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
  guardian: GuardianResult;
  gas: SponsorDecision;
  ptb: PtbPlan | null;
  timeline: Array<{
    label: string;
    state: "complete" | "blocked" | "pending";
  }>;
}
