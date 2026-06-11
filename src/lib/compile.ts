import type { CompileResult } from "./types";
import { getDeepBookQuote } from "./deepbook";
import { runGuardian } from "./guardian";
import { parseIntent } from "./intent";
import { buildPtbPlan } from "./ptb";
import { decideGasMode } from "./sponsor";

export function compileIntent(input: string): CompileResult {
  const intent = parseIntent(input);
  const quote = getDeepBookQuote(intent);
  const guardian = runGuardian(intent, quote);
  const gas = decideGasMode(intent, guardian, quote);
  const ptb = buildPtbPlan(intent, quote, guardian, gas);

  return {
    intent,
    quote,
    guardian,
    gas,
    ptb,
    timeline: [
      {
        label: "Parsing intent",
        state: intent.status === "ready" ? "complete" : "blocked"
      },
      {
        label: "Reading DeepBook liquidity",
        state: quote || intent.status === "ready" && intent.action === "stablecoin_transfer" ? "complete" : "pending"
      },
      {
        label: "Compiling PTB",
        state: ptb ? "complete" : guardian.blocked ? "blocked" : "pending"
      },
      {
        label: "Running Guardian checks",
        state: guardian.blocked ? "blocked" : "complete"
      },
      {
        label: "Awaiting confirmation",
        state: ptb ? "complete" : "pending"
      }
    ]
  };
}

