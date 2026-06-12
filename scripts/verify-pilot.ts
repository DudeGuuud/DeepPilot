import { strict as assert } from "node:assert";

import { compileIntent } from "../src/lib/compile";
import { classifyPilotInput } from "../src/lib/pilot";
import { buildRagContext, streamRagAnswer } from "../src/lib/rag";

const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;

process.env.DEEPSEEK_API_KEY = "";

const chat = await classifyPilotInput("Why is BTC moving?");
assert.equal(chat.mode, "chat", "market explanation request should route to chat mode");
assert.equal(chat.asset, "BTC", "chat classifier should detect BTC");

const context = await buildRagContext("Why is BTC moving?", chat);
assert(context.sources.length > 0, "chat mode should return source chips");

let answer = "";
await streamRagAnswer({
  input: "Why is BTC moving?",
  classification: chat,
  sources: context.sources,
  onDelta: (delta) => {
    answer += delta;
  }
});
assert(answer.length > 0, "chat mode should stream an answer or fallback answer");

const trade = await classifyPilotInput("Bet 10 DUSDC on BTC DOWN tonight");
assert.equal(trade.mode, "trade", "explicit Predict order should route to trade mode");

const compiled = await compileIntent("Bet 10 DUSDC on BTC DOWN tonight");
assert.equal(compiled.intent.status, "ready", "trade fallback compiler should produce a typed intent");
assert(compiled.guardian.decision, "trade compile should include Guardian review");
const quote = compiled.quote;
assert(quote?.status === "available", "trade compile should include an available Predict quote");
assert(quote.quantityRaw, "trade quote should include executable quantity");
assert(
  typeof quote.estimatedCostDusdc === "number" && quote.estimatedCostDusdc <= 10,
  "quote-based sizing should stay within the requested DUSDC budget"
);
assert(compiled.ptb, "trade compile should include PTB preview when live state allows it");
assert(
  compiled.ptb.commands.some((command) => command.inputs?.quantityRaw === quote.quantityRaw),
  "PTB preview should use the verified quote quantity"
);

if (originalDeepSeekKey) {
  process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
} else {
  delete process.env.DEEPSEEK_API_KEY;
}

console.log("pilot smoke ok", {
  chatMode: chat.mode,
  chatSources: context.sources.length,
  tradeMode: trade.mode,
  quote: quote.status,
  guardian: compiled.guardian.decision,
  ptbDigest: compiled.ptb.digestPreview
});
