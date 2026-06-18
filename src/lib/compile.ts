import type {
  ActiveMarketContext,
  CompileResult,
  CompileStreamEvent,
  ConversationContext,
  GuardianResult,
  ParsedIntent,
  PredictQuotePreview,
  ProfileSummary,
  PtbPlan
} from "./types";
import { runGuardian } from "./guardian";
import { parseIntent } from "./intent";
import {
  MIN_SIGNABLE_TIME_TO_EXPIRY_MS,
  getActivePredictMarketContext,
  getPredictMarketSnapshot,
  getPredictQuotePreview,
  toDusdcBaseUnits
} from "./predict";
import { getProfileSummary } from "./profile";
import { buildPtbPlan } from "./ptb";
import { decideGasMode, validateSponsorPlan } from "./sponsor";

export type CompileOptions = {
  walletAddress?: string | null;
  managerId?: string | null;
  activeMarketContext?: ActiveMarketContext | null;
  conversationContext?: ConversationContext | null;
  parsedIntent?: ParsedIntent | null;
  refreshed?: boolean;
  onEvent?: (event: CompileStreamEvent) => void;
};

export async function compileIntent(input: string, options: CompileOptions = {}): Promise<CompileResult> {
  let activeMarketContext = options.activeMarketContext ?? null;

  if (!activeMarketContext) {
    options.onEvent?.({
      type: "stage",
      label: "Loading active Predict context",
      state: "pending"
    });
    try {
      activeMarketContext = await getActivePredictMarketContext();
      options.onEvent?.({
        type: "stage",
        label: "Loading active Predict context",
        state: activeMarketContext.markets.length ? "complete" : "blocked",
        detail: activeMarketContext.earliestActiveOracleId ?? "No active BTC oracle"
      });
    } catch (error) {
      options.onEvent?.({
        type: "stage",
        label: "Loading active Predict context",
        state: "blocked",
        detail: error instanceof Error ? error.message : "Predict market context unavailable"
      });
    }
  }

  const isStructuredRefresh = Boolean(options.parsedIntent);
  options.onEvent?.({
    type: "stage",
    label: isStructuredRefresh ? "Using typed intent" : "Parsing intent with DeepSeek",
    state: "pending"
  });
  const parsedIntent = options.parsedIntent ?? await parseIntent(input, {
    onEvent: options.onEvent,
    activeMarketContext,
    conversationContext: options.conversationContext ?? null
  });
  const intent = normalizeRefreshIntent(parsedIntent);
  let market = null;
  let marketError: Error | null = null;
  let profile: ProfileSummary | null = null;

  options.onEvent?.({
    type: "stage",
    label: isStructuredRefresh ? "Using typed intent" : "Parsing intent with DeepSeek",
    state: intent.status === "ready" ? "complete" : "blocked",
    detail: intent.status === "ready" ? intent.action : intent.reason
  });

  if (options.walletAddress || options.managerId) {
    options.onEvent?.({
      type: "stage",
      label: "Loading wallet profile",
      state: "pending"
    });
    try {
      profile = await getProfileSummary({
        wallet: options.walletAddress,
        managerId: options.managerId
      });
      options.onEvent?.({
        type: "stage",
        label: "Loading wallet profile",
        state: "complete",
        detail: profile.managerId ?? "No PredictManager linked"
      });
    } catch {
      profile = null;
      options.onEvent?.({
        type: "stage",
        label: "Loading wallet profile",
        state: "blocked",
        detail: "Profile lookup failed"
      });
    }
  }

  if (intent.status === "ready" && intent.action !== "stablecoin_transfer") {
    options.onEvent?.({
      type: "stage",
      label: "Resolving BTC Predict market",
      state: "pending"
    });
    try {
      market = await getPredictMarketSnapshot(intent);
      options.onEvent?.({
        type: "stage",
        label: "Resolving BTC Predict market",
        state: "complete",
        detail: market?.oracle.oracle_id
      });
    } catch (error) {
      marketError = error instanceof Error ? error : new Error("Predict market request failed.");
      options.onEvent?.({
        type: "stage",
        label: "Resolving BTC Predict market",
        state: "blocked",
        detail: marketError.message
      });
    }
  }

  options.onEvent?.({
    type: "stage",
    label: "Running Guardian checks",
    state: "pending"
  });
  let guardian = marketError ? unavailableGuardian(marketError) : runGuardian(intent, market);
  options.onEvent?.({
    type: "stage",
    label: "Running Guardian checks",
    state: guardian.blocked ? "blocked" : "complete",
    detail: guardian.decision
  });
  const quoteOnly = intent.status === "ready" && intent.action === "predict_quote_only";
  const shouldQuote = needsQuote(intent) && !guardian.blocked;
  let quote: PredictQuotePreview | null = null;
  let quoteError: Error | null = null;

  options.onEvent?.({
    type: "stage",
    label: "Quoting Predict payout",
    state: shouldQuote ? "pending" : quoteOnly || !needsQuote(intent) ? "complete" : "blocked",
    detail: shouldQuote ? undefined : quoteOnly ? "No mint quote required" : guardian.summary
  });
  if (shouldQuote) {
    try {
      quote = await getPredictQuotePreview(intent, market);

      if (quote?.status === "unavailable") {
        quoteError = new Error(quote.warning ?? "Predict quote unavailable.");
        guardian = quoteUnavailableGuardian(guardian, quote);
      }

      options.onEvent?.({
        type: "stage",
        label: "Quoting Predict payout",
        state: quoteError ? "blocked" : "complete",
        detail: quote?.status === "available"
          ? `${quote.estimatedCostDusdc?.toFixed(4)} DUSDC est. pay`
          : quote?.status ?? "No quote required"
      });
    } catch (error) {
      quoteError = error instanceof Error ? error : new Error("Predict quote request failed.");
      guardian = quoteUnavailableGuardian(guardian, {
        status: "unavailable",
        source: "not_available",
        oracleId: market?.oracle.oracle_id ?? null,
        expiry: market?.oracle.expiry ?? null,
        direction: intent.status === "ready" ? intent.direction ?? null : null,
        strike: market?.metrics.selectedStrike ?? null,
        quoteBudgetDusdc: intent.status === "ready" && intent.amountType === "quote" ? Number(intent.amount) : null,
        quoteBudgetRaw: intent.status === "ready" && intent.amountType === "quote" ? toDusdcBaseUnits(Number(intent.amount)).toString() : null,
        quantityRaw: null,
        quantityDusdc: null,
        estimatedCostDusdc: null,
        estimatedCostRaw: null,
        askPrice: null,
        bidPrice: null,
        maxPayoutDusdc: null,
        maxPayoutRaw: null,
        potentialProfitDusdc: null,
        returnPct: null,
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        warning: quoteError.message
      });
      options.onEvent?.({
        type: "stage",
        label: "Quoting Predict payout",
        state: "blocked",
        detail: quoteError.message
      });
    }
  }

  let gasPreview = decideGasMode(intent, guardian, market, quote);
  let ptb: PtbPlan | null = null;
  let ptbError: Error | null = null;

  options.onEvent?.({
    type: "stage",
    label: "Building PTB preview",
    state: "pending"
  });
    try {
      ptb = buildPtbPlan(intent, market, guardian, gasPreview, profile, quote);
      options.onEvent?.({
        type: "stage",
        label: "Checking Trading Balance",
        state: fundingStageState(ptb),
        detail: fundingStageDetail(ptb)
      });
      options.onEvent?.({
        type: "stage",
        label: "Building PTB preview",
      state: ptb ? "complete" : "blocked",
      detail: ptb?.digestPreview ?? "No PTB for this intent"
    });
  } catch (error) {
    ptbError = error instanceof Error ? error : new Error("PTB compilation failed.");
    guardian = configGuardian(ptbError);
    gasPreview = decideGasMode(intent, guardian, market, quote);
    options.onEvent?.({
      type: "stage",
      label: "Building PTB preview",
      state: "blocked",
      detail: ptbError.message
    });
  }

  const gas = validateSponsorPlan(gasPreview, ptb);
  const reviewFreshness = buildReviewFreshness(intent, market, quote, {
    refreshed: Boolean(options.refreshed)
  });

  return {
    intent,
    market,
    profile,
    guardian,
    gas,
    quote,
    ptb,
    reviewFreshness,
    timeline: [
      {
        label: "Loading active Predict context",
        state: activeMarketContext?.markets.length ? "complete" : "blocked"
      },
      {
        label: isStructuredRefresh ? "Using typed intent" : "Parsing intent",
        state: intent.status === "ready" ? "complete" : "blocked"
      },
      {
        label: "Resolving BTC Predict market",
        state: market ? "complete" : intent.status === "ready" && intent.action === "stablecoin_transfer" ? "complete" : marketError ? "blocked" : "pending"
      },
      {
        label: "Matching nearest expiry",
        state: market ? "complete" : intent.status === "ready" && intent.action === "stablecoin_transfer" ? "complete" : marketError ? "blocked" : "pending"
      },
      {
        label: "Reading oracle and vault state",
        state: market ? "complete" : intent.status === "ready" && intent.action === "stablecoin_transfer" ? "complete" : marketError ? "blocked" : "pending"
      },
      {
        label: "Running Guardian checks",
        state: guardian.blocked ? "blocked" : "complete"
      },
      {
        label: "Quoting Predict payout",
        state: quoteOnly || quote?.status === "available" || !needsQuote(intent)
          ? "complete"
          : guardian.blocked || quoteError
            ? "blocked"
            : "pending"
      },
      {
        label: "Checking Trading Balance",
        state: fundingStageState(ptb)
      },
      {
        label: quoteOnly ? "Skipping PTB for quote-only intent" : "Building PTB preview",
        state: quoteOnly || ptb ? "complete" : guardian.blocked || ptbError ? "blocked" : "pending"
      }
    ]
  };
}

function fundingStageState(ptb: PtbPlan | null): "complete" | "blocked" | "pending" {
  const status = ptb?.execution.fundingStatus;

  if (!status) {
    return "pending";
  }

  return status === "sufficient" || status === "not_required" ? "complete" : "blocked";
}

function fundingStageDetail(ptb: PtbPlan | null) {
  const execution = ptb?.execution;

  if (!execution) {
    return "Trading Balance unavailable.";
  }

  if (execution.fundingStatus === "insufficient") {
    return `Funding shortfall: ${execution.fundingShortfallRaw ?? "unknown"} raw DUSDC.`;
  }

  return execution.fundingStatus;
}

function buildReviewFreshness(
  intent: CompileResult["intent"],
  market: CompileResult["market"],
  quote: PredictQuotePreview | null,
  options: { refreshed: boolean }
): NonNullable<CompileResult["reviewFreshness"]> {
  const checkedAt = new Date().toISOString();

  if (intent.status !== "ready") {
    return {
      checkedAt,
      active: false,
      refreshed: options.refreshed,
      reason: "Intent needs clarification before a signable review can be fresh."
    };
  }

  if (intent.action === "stablecoin_transfer") {
    return {
      checkedAt,
      active: true,
      refreshed: options.refreshed,
      reason: "Stablecoin transfer review does not depend on a Predict oracle."
    };
  }

  if (!market) {
    return {
      checkedAt,
      active: false,
      refreshed: options.refreshed,
      reason: "No active Predict market was resolved for this review."
    };
  }

  const marketNow = market.status.current_time_ms;
  const marketActive = market.oracle.status === "active" && market.oracle.expiry > marketNow;
  const timeToExpiryMs = market.oracle.expiry - marketNow;

  if (!marketActive) {
    return {
      checkedAt,
      active: false,
      refreshed: options.refreshed,
      reason: "Market expired, refresh review"
    };
  }

  if (timeToExpiryMs < MIN_SIGNABLE_TIME_TO_EXPIRY_MS) {
    return {
      checkedAt,
      active: false,
      refreshed: options.refreshed,
      reason: "Market is too close to expiry for safe wallet signing. Refresh review to choose the next active market."
    };
  }

  if (intent.action === "predict_binary_mint") {
    const quoteActive = quote?.status === "available" && new Date(quote.expiresAt).getTime() > Date.now();

    return {
      checkedAt,
      active: Boolean(quoteActive),
      refreshed: options.refreshed,
      reason: quoteActive ? "Market and quote were checked against current Predict state." : "Quote is stale or unavailable."
    };
  }

  return {
    checkedAt,
    active: true,
    refreshed: options.refreshed,
    reason: "Market was checked against current Predict state."
  };
}

function needsQuote(intent: CompileResult["intent"]) {
  return intent.status === "ready" && intent.action === "predict_binary_mint";
}

function normalizeRefreshIntent(intent: ParsedIntent): ParsedIntent {
  if (intent.status !== "ready" || intent.expiryPreference !== "next_active" || !intent.oracleId) {
    return intent;
  }

  // "next active" is a moving target. Do not pin a stale oracle id returned by
  // the first AI parse; every compile/refresh should choose the earliest market
  // that still has enough wallet-signing time.
  return {
    ...intent,
    oracleId: undefined
  };
}

function quoteUnavailableGuardian(previous: GuardianResult, quote: PredictQuotePreview): GuardianResult {
  return {
    ...previous,
    score: 100,
    level: "blocked",
    blocked: true,
    decision: "block",
    findings: [
      ...previous.findings,
      {
        type: "QUOTE_UNAVAILABLE",
        title: "Predict quote unavailable",
        explanation: quote.warning ?? "DeepPilot could not verify the mint cost and payout before signing."
      }
    ],
    summary: "Guardian blocks signing because DeepBook Predict quote could not be verified."
  };
}

function unavailableGuardian(error: Error): GuardianResult {
  return {
    score: 100,
    level: "blocked",
    blocked: true,
    decision: "block",
    findings: [
      {
        type: "API_UNAVAILABLE",
        title: "Predict API unavailable",
        explanation: error.message
      }
    ],
    summary: "Guardian blocks signing because live Predict state could not be verified."
  };
}

function configGuardian(error: Error): GuardianResult {
  return {
    score: 100,
    level: "blocked",
    blocked: true,
    decision: "block",
    findings: [
      {
        type: "CONFIG_ERROR",
        title: "PTB configuration error",
        explanation: error.message
      }
    ],
    summary: "Guardian blocks signing because PTB configuration is invalid."
  };
}
