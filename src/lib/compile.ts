import type { CompileResult, CompileStreamEvent, GuardianResult, ProfileSummary, PtbPlan } from "./types";
import { runGuardian } from "./guardian";
import { parseIntent } from "./intent";
import { getPredictMarketSnapshot } from "./predict";
import { getProfileSummary } from "./profile";
import { buildPtbPlan } from "./ptb";
import { decideGasMode, validateSponsorPlan } from "./sponsor";

export type CompileOptions = {
  walletAddress?: string | null;
  managerId?: string | null;
  onEvent?: (event: CompileStreamEvent) => void;
};

export async function compileIntent(input: string, options: CompileOptions = {}): Promise<CompileResult> {
  options.onEvent?.({
    type: "stage",
    label: "Parsing intent with DeepSeek",
    state: "pending"
  });
  const intent = await parseIntent(input, {
    onEvent: options.onEvent
  });
  let market = null;
  let marketError: Error | null = null;
  let profile: ProfileSummary | null = null;

  options.onEvent?.({
    type: "stage",
    label: "Parsing intent with DeepSeek",
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
  let gasPreview = decideGasMode(intent, guardian, market);
  let ptb: PtbPlan | null = null;
  let ptbError: Error | null = null;

  options.onEvent?.({
    type: "stage",
    label: "Building PTB preview",
    state: "pending"
  });
  try {
    ptb = buildPtbPlan(intent, market, guardian, gasPreview, profile);
    options.onEvent?.({
      type: "stage",
      label: "Building PTB preview",
      state: ptb ? "complete" : "blocked",
      detail: ptb?.digestPreview ?? "No PTB for this intent"
    });
  } catch (error) {
    ptbError = error instanceof Error ? error : new Error("PTB compilation failed.");
    guardian = configGuardian(ptbError);
    gasPreview = decideGasMode(intent, guardian, market);
    options.onEvent?.({
      type: "stage",
      label: "Building PTB preview",
      state: "blocked",
      detail: ptbError.message
    });
  }

  const gas = validateSponsorPlan(gasPreview, ptb);
  // Quote-only still reads Predict state and runs Guardian, but must never advance to signing.
  const quoteOnly = intent.status === "ready" && intent.action === "predict_quote_only";

  return {
    intent,
    market,
    profile,
    guardian,
    gas,
    ptb,
    timeline: [
      {
        label: "Parsing intent",
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
        label: quoteOnly ? "Skipping PTB for quote-only intent" : "Building PTB preview",
        state: quoteOnly || ptb ? "complete" : guardian.blocked || ptbError ? "blocked" : "pending"
      }
    ]
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
