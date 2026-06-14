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

const followUpTrade = await classifyPilotInput("那就买跌 10u 最快结算", {
  conversationContext: {
    lastMarketThesis: "BTC downside risk increased after the latest market and news review.",
    messages: [
      {
        role: "user",
        content: "Summarize BTC news",
        mode: "chat",
        sourceTitles: ["Nearest BTC Predict oracle"]
      },
      {
        role: "assistant",
        content: "BTC market context shows near-term downside risk factors.",
        mode: "chat",
        sourceTitles: ["BTC Predict oracle history"]
      }
    ]
  }
});
assert.equal(followUpTrade.mode, "trade", "explicit Chinese follow-up trade should route to trade mode");
assert.equal(followUpTrade.asset, "BTC", "follow-up trade should inherit BTC context");
assert(!followUpTrade.missing.includes("expiry"), "fastest settlement should satisfy expiry");

const compiled = await compileIntent("Bet 10 DUSDC on BTC DOWN tonight");
assert.equal(compiled.intent.status, "ready", "trade fallback compiler should produce a typed intent");
assert(compiled.guardian.decision, "trade compile should include Guardian review");
assert(compiled.reviewFreshness?.active, "trade compile should include active review freshness");
const quote = compiled.quote;
assert(quote?.status === "available", "trade compile should include an available Predict quote");
assert(quote.quantityRaw, "trade quote should include executable quantity");
assert(quote.estimatedCostRaw, "trade quote should include raw DUSDC cost for wallet execution");
assert(
  typeof quote.estimatedCostDusdc === "number" && quote.estimatedCostDusdc <= 10,
  "quote-based sizing should stay within the requested DUSDC budget"
);
assert(compiled.ptb, "trade compile should include PTB preview when live state allows it");
assert(
  compiled.ptb.commands.some((command) => command.inputs?.quantityRaw === quote.quantityRaw),
  "PTB preview should use the verified quote quantity"
);

const fastestCompiled = await compileIntent("那就买跌 10u 最快结算", {
  refreshed: true,
  conversationContext: {
    lastMarketThesis: "BTC downside risk increased after the latest market and news review.",
    messages: [
      {
        role: "assistant",
        content: "BTC market context shows near-term downside risk factors.",
        mode: "chat",
        sourceTitles: ["BTC Predict oracle history"]
      }
    ]
  }
});
assert.equal(fastestCompiled.intent.status, "ready", "fastest settlement follow-up should compile");
assert(fastestCompiled.intent.status === "ready");
assert.equal(fastestCompiled.intent.direction, "down", "买跌 should compile as DOWN");
assert.equal(fastestCompiled.intent.expiryPreference, "next_active", "最快结算 should map to next active expiry");
assert(fastestCompiled.market?.oracle.status === "active", "fastest settlement should resolve an active oracle");
assert(fastestCompiled.reviewFreshness?.refreshed, "refreshed compile should mark review freshness");

if (originalDeepSeekKey) {
  process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
} else {
  delete process.env.DEEPSEEK_API_KEY;
}

console.log("pilot smoke ok", {
  chatMode: chat.mode,
  chatSources: context.sources.length,
  tradeMode: trade.mode,
  followUpMode: followUpTrade.mode,
  quote: quote.status,
  guardian: compiled.guardian.decision,
  ptbDigest: compiled.ptb.digestPreview
});
