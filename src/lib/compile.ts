import type { CompileResult, GuardianResult } from "./types";
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

  const guardian = marketError ? unavailableGuardian(marketError) : runGuardian(intent, market);
  const gasPreview = decideGasMode(intent, guardian, market);
  const ptb = buildPtbPlan(intent, market, guardian, gasPreview);
  const gas = validateSponsorPlan(gasPreview, ptb);

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
        label: "Compiling Predict PTB preview",
        state: ptb ? "complete" : guardian.blocked ? "blocked" : "pending"
      },
      {
        label: "Awaiting wallet confirmation",
        state: ptb ? "complete" : "pending"
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
