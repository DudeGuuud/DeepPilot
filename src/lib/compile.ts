import type { CompileResult, GuardianResult, PtbPlan } from "./types";
import { runGuardian } from "./guardian";
import { parseIntent } from "./intent";
import { getPredictMarketSnapshot } from "./predict";
import { buildPtbPlan } from "./ptb";
import { decideGasMode, validateSponsorPlan } from "./sponsor";

export async function compileIntent(input: string): Promise<CompileResult> {
  const intent = parseIntent(input);
  let market = null;
  let marketError: Error | null = null;

  if (intent.status === "ready" && intent.action !== "stablecoin_transfer") {
    try {
      market = await getPredictMarketSnapshot(intent);
    } catch (error) {
      marketError = error instanceof Error ? error : new Error("Predict market request failed.");
    }
  }

  let guardian = marketError ? unavailableGuardian(marketError) : runGuardian(intent, market);
  let gasPreview = decideGasMode(intent, guardian, market);
  let ptb: PtbPlan | null = null;
  let ptbError: Error | null = null;

  try {
    ptb = buildPtbPlan(intent, market, guardian, gasPreview);
  } catch (error) {
    ptbError = error instanceof Error ? error : new Error("PTB compilation failed.");
    guardian = configGuardian(ptbError);
    gasPreview = decideGasMode(intent, guardian, market);
  }

  const gas = validateSponsorPlan(gasPreview, ptb);
  // Quote-only still reads Predict state and runs Guardian, but must never advance to signing.
  const quoteOnly = intent.status === "ready" && intent.action === "predict_quote_only";

  return {
    intent,
    market,
    guardian,
    gas,
    ptb,
    timeline: [
      {
        label: "Parsing Predict intent",
        state: intent.status === "ready" ? "complete" : "blocked"
      },
      {
        label: "Reading DeepBook Predict state",
        state: market ? "complete" : intent.status === "ready" && intent.action === "stablecoin_transfer" ? "complete" : marketError ? "blocked" : "pending"
      },
      {
        label: "Running Guardian checks",
        state: guardian.blocked ? "blocked" : "complete"
      },
      {
        label: quoteOnly ? "Skipping PTB for quote-only intent" : "Compiling Predict PTB preview",
        state: quoteOnly || ptb ? "complete" : guardian.blocked || ptbError ? "blocked" : "pending"
      },
      {
        label: quoteOnly ? "Quote-only result" : "Awaiting wallet confirmation",
        state: quoteOnly || ptb ? "complete" : "pending"
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
