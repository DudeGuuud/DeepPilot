export type IntentAction =
  | "deepbook_market_order"
  | "deepbook_limit_order"
  | "stablecoin_transfer"
  | "quote_only";

export type TradeSide = "buy" | "sell";
export type AmountType = "base" | "quote";
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type GasMode = "sponsored" | "gasless_stablecoin_transfer" | "user_pays_gas";

export type ParsedIntent =
  | {
      status: "ready";
      action: IntentAction;
      side: TradeSide;
      baseToken: string;
      quoteToken: string;
      amount: string;
      amountType: AmountType;
      maxSlippageBps: number;
      venue: "deepbook";
      confirmationRequired: true;
      limitPrice?: string;
      recipient?: string;
      raw: string;
    }
  | {
      status: "needs_clarification";
      missing: string[];
      reason: string;
      raw: string;
    };

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
}

export interface DeepBookQuote {
  pair: string;
  poolKey: string;
  source: "mock_deepbook_v3_ready";
  baseToken: string;
  quoteToken: string;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  estimatedSlippageBps: number;
  visibleDepthUsd: number;
  orderSizeUsd: number;
  quoteAgeMs: number;
  baseQuantityOut: number;
  quoteQuantityIn: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  deepbookExtension: string;
}

export interface GuardianFinding {
  type:
    | "HIGH_SLIPPAGE"
    | "LOW_LIQUIDITY"
    | "STALE_QUOTE"
    | "WIDE_SPREAD"
    | "LARGE_ORDER_SIZE"
    | "UNSUPPORTED_INTENT";
  title: string;
  explanation: string;
}

export interface GuardianResult {
  score: number;
  level: RiskLevel;
  blocked: boolean;
  decision: "allow" | "warn" | "block";
  findings: GuardianFinding[];
  summary: string;
}

export interface PtbCommandPreview {
  index: number;
  command: string;
  target: string;
  riskGate: "pre-sign" | "atomic" | "receipt";
}

export interface PtbPlan {
  sender: string;
  sponsor: string;
  gasBudget: number;
  gasOwner: string;
  transactionKind: "ProgrammableTransaction";
  commands: PtbCommandPreview[];
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
  maxTradeSizeUsd: number;
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
  quote: DeepBookQuote | null;
  guardian: GuardianResult;
  gas: SponsorDecision;
  ptb: PtbPlan | null;
  timeline: Array<{
    label: string;
    state: "complete" | "blocked" | "pending";
  }>;
}

