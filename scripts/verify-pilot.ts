import { strict as assert } from "node:assert";

import { compileIntent } from "../src/lib/compile";
import { classifyPilotInput } from "../src/lib/pilot";
import { buildRagContext, streamRagAnswer } from "../src/lib/rag";
import { buildStrategyPlan, compileStrategy } from "../src/lib/strategy";
import { compileVaultLpIntent } from "../src/lib/vault-lp";

const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
const TRADE_SMOKE_INTENT = "Bet 10 DUSDC on BTC DOWN at the fastest settlement";

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

const trade = await classifyPilotInput(TRADE_SMOKE_INTENT);
assert.equal(trade.mode, "trade", "explicit Predict order should route to trade mode");

const strategy = await classifyPilotInput("BTC split 9 DUSDC long across 1h 2h 3h expiries");
assert.equal(strategy.mode, "strategy", "multi-leg strategy request should route to strategy mode");

const vaultLpDeposit = await classifyPilotInput("Deposit 1 DUSDC to Vault LP");
assert.equal(vaultLpDeposit.mode, "vault_lp", "Vault LP deposit should route to vault_lp mode");

const vaultLpChinese = await classifyPilotInput("把 1 DUSDC 存进 LP vault");
assert.equal(vaultLpChinese.mode, "vault_lp", "Chinese Vault LP wording should route to vault_lp mode");

const vaultLpWithdraw = await classifyPilotInput("Withdraw 1 DUSDC from Vault LP");
assert.equal(vaultLpWithdraw.mode, "vault_lp", "Vault LP withdraw should route to vault_lp mode");

const vaultLpCasualDeposit = await classifyPilotInput("i wanna deposit one dusdc in lp vault");
assert.equal(vaultLpCasualDeposit.mode, "vault_lp", "casual Telegram Vault LP deposit should route to vault_lp mode");
assert(!vaultLpCasualDeposit.missing.includes("amount"), "word amount should satisfy Vault LP amount");

const tradingBalanceDeposit = await classifyPilotInput("Deposit 1 DUSDC to Trading Balance");
assert.notEqual(tradingBalanceDeposit.mode, "vault_lp", "Trading Balance deposit must not be misrouted to Vault LP");

const nowMs = Date.now();
const lockedPlan = buildStrategyPlan(
  "Build a 1 DUSDC hedge strategy, mostly BTC UP, nearest settlement",
  {
    asset: "BTC",
    nowIso: new Date(nowMs).toISOString(),
    earliestActiveOracleId: "0x1",
    markets: [
      {
        oracleId: "0x1",
        expiry: nowMs + 10 * 60_000,
        expiryIso: new Date(nowMs + 10 * 60_000).toISOString(),
        status: "active",
        isEarliestActive: true
      }
    ]
  },
  { messages: [], memoryContext: "last trade shape: DOWN 1 DUSDC next_active" },
  [
    {
      id: "leg-1",
      oracleId: "0x1",
      direction: "up",
      strike: 64_321
    }
  ]
);
assert.equal(lockedPlan.legs[0]?.direction, "up", "current strategy direction should override memory direction");
assert.equal(lockedPlan.legs[0]?.strike, 64_321, "strategy refresh should preserve locked leg strike");

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

const compiled = await compileIntent(TRADE_SMOKE_INTENT);
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

const missingBudgetStrategy = await compileStrategy("BTC 分别在一小时两小时三小时做多");
assert.equal(missingBudgetStrategy.plan.mode, "strategy", "strategy compiler should return a strategy plan");
assert(missingBudgetStrategy.plan.missing.includes("amount"), "strategy without budget should require amount before signing");
assert.equal(missingBudgetStrategy.aggregateReadiness.canSign, false, "strategy without amount must not be signable");

const budgetedStrategy = await compileStrategy("BTC split 0.03 DUSDC long across 1h 2h 3h expiries");
assert(budgetedStrategy.compiledLegs.length >= 1, "budgeted strategy should create at least one leg");
assert(
  budgetedStrategy.compiledLegs.some((leg) => leg.status === "ready" || leg.status === "blocked" || leg.status === "quoted"),
  "strategy legs should be independently compiled"
);

const vaultLpReview = await compileVaultLpIntent("Deposit 1 DUSDC to Vault LP");
assert.equal(vaultLpReview.intent.action, "deposit", "Vault LP compiler should parse deposit action");
assert.equal(vaultLpReview.transactionData?.action, "deposit", "Vault LP review should include deposit transaction data");
const vaultLpCasualReview = await compileVaultLpIntent("i wanna deposit one dusdc in lp vault");
assert.equal(vaultLpCasualReview.intent.action, "deposit", "casual Vault LP wording should parse deposit action");
assert.equal(vaultLpCasualReview.intent.amountDusdc, 1, "word amount should parse as 1 DUSDC");
assert.equal(vaultLpCasualReview.transactionData?.action, "deposit", "casual Vault LP wording should produce signable deposit transaction data");

const naturalHedge = await classifyPilotInput("帮我在最近可以结算的地方开一个对冲 大头是涨 玩 1du sd c");
assert.equal(naturalHedge.mode, "strategy", "Chinese hedge request should route to strategy");
assert(!naturalHedge.missing.includes("amount"), "spaced DUSDC text should still count as an amount");
const naturalHedgeReview = await compileStrategy("帮我在最近可以结算的地方开一个对冲 大头是涨 玩 1du sd c");
assert.equal(naturalHedgeReview.plan.missing.length, 0, "natural hedge should not miss amount");
assert.equal(naturalHedgeReview.plan.legs.length, 2, "nearest hedge should create two opposite legs");
assert.equal(naturalHedgeReview.plan.legs[0]?.direction, "up", "major hedge direction should be UP");
assert.equal(naturalHedgeReview.plan.legs[1]?.direction, "down", "hedge leg should be DOWN");
assert.equal(naturalHedgeReview.plan.legs[0]?.expiryPreference, "next_active", "nearest hedge should use next active expiry");
assert.equal(naturalHedgeReview.plan.legs[0]?.oracleId, naturalHedgeReview.plan.legs[1]?.oracleId, "hedge legs should share the same nearest oracle");
assert.equal(naturalHedgeReview.plan.legs[0]?.amountDusdc, 0.7, "major hedge leg should receive 70% of budget");
assert.equal(naturalHedgeReview.plan.legs[1]?.amountDusdc, 0.3, "hedge leg should receive 30% of budget");

const englishHedge = await classifyPilotInput("Use 1 DUSDC to hedge BTC on the fastest expiry, overweight upside");
assert.equal(englishHedge.mode, "strategy", "English hedge wording should route to strategy");
assert(!englishHedge.missing.includes("amount"), "English hedge wording should keep the DUSDC budget");
const englishHedgeReview = await compileStrategy("Use 1 DUSDC to hedge BTC on the fastest expiry, overweight upside");
assert.equal(englishHedgeReview.plan.legs[0]?.direction, "up", "overweight upside should make UP the major leg");
assert.equal(englishHedgeReview.plan.legs[1]?.direction, "down", "hedge should keep the opposite DOWN leg");
assert.equal(englishHedgeReview.plan.legs[0]?.amountDusdc, 0.7, "overweight upside should allocate 70% to UP");
assert.equal(englishHedgeReview.plan.legs[1]?.amountDusdc, 0.3, "overweight upside should allocate 30% to DOWN");

const adviceHedge = await classifyPilotInput("Should I hedge BTC with 1 DUSDC?");
assert.equal(adviceHedge.mode, "chat", "advice phrasing should stay in chat mode");

if (originalDeepSeekKey) {
  process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
} else {
  delete process.env.DEEPSEEK_API_KEY;
}

console.log("pilot smoke ok", {
  chatMode: chat.mode,
  chatSources: context.sources.length,
  tradeMode: trade.mode,
  strategyMode: strategy.mode,
  vaultLpMode: vaultLpDeposit.mode,
  followUpMode: followUpTrade.mode,
  quote: quote.status,
  guardian: compiled.guardian.decision,
  ptbDigest: compiled.ptb.digestPreview
});
