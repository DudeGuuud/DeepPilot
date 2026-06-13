import { z } from "zod";

import { compileIntent } from "../src/lib/compile";
import { parseJsonBody } from "../src/lib/http";
import { buildBinaryMintTransaction, buildCreatePredictManagerTransaction } from "../src/lib/predict-execution";
import { getPredictMarkets, getPredictOracleHistory, predictDeployment } from "../src/lib/predict";
import { getProfileSummary } from "../src/lib/profile";

const intent = "Buy 10 DUSDC BTC UP on the next active DeepBook Predict oracle";
const result = await compileIntent(intent);

assert(result.intent.status === "ready", "intent should parse");
assert(result.market, "market snapshot should exist");
const market = result.market;

assert(market.source === "deepbook_predict", "market snapshot should come from DeepBook Predict");
assert(market.deployment.network === "testnet", "default Predict network should be testnet");
assert(market.oracle.status === "active", "selected oracle should be active");
assert(market.metrics.spot !== null, "spot should be available");
assert(result.guardian.decision !== "block", "Guardian should not block the smoke intent");
assert(result.quote?.status === "available", "binary mint should include a DeepBook Predict quote");
assert(result.quote.quantityRaw, "binary quote should include quantityRaw");
assert(
  typeof result.quote.estimatedCostDusdc === "number" && result.quote.estimatedCostDusdc <= 10,
  "binary quote should fit inside the requested DUSDC budget"
);
assert(result.quote.estimatedCostRaw, "binary quote should include raw estimated cost");
assert(Boolean(result.ptb), "PTB preview should be built");
assert(result.gas.mode === "user_pays_gas", "Predict trade should use user-paid wallet gas");
assert(result.gas.approved, "wallet gas policy should approve the smoke PTB preview");
assert(result.gas.checks.every((check) => check.passed), "all wallet policy checks should pass");
assert(result.ptb?.gasOwner === result.ptb?.sender, "Predict trade preview should not use a sponsor gas owner");
assert(
  result.ptb?.commands.some((command) => command.target === `${predictDeployment.packageId}::predict::mint`),
  "PTB preview should target predict::mint"
);
assert(
  result.ptb?.commands.some((command) => command.target === `${predictDeployment.packageId}::predict_manager::deposit`),
  "PTB preview should include PredictManager DUSDC top-up"
);
assert(
  result.ptb?.commands.some((command) => command.inputs?.quantityRaw === result.quote?.quantityRaw),
  "PTB preview should use the verified quote quantity"
);
const fakeManagerId = "0x00000000000000000000000000000000000000000000000000000000feed0001";
const createManagerTx = buildCreatePredictManagerTransaction({
  packageId: predictDeployment.packageId,
  gasBudget: result.ptb?.gasBudget
});
const mintTx = buildBinaryMintTransaction({
  transactionData: result.ptb!.transactionData,
  managerId: fakeManagerId,
  managerBalanceRaw: "0",
  gasBudget: result.ptb?.gasBudget
});
assert(createManagerTx, "create manager transaction should be buildable");
assert(mintTx.topUpRaw === result.quote.estimatedCostRaw, "mint builder should top up the estimated raw DUSDC cost");
assert(
  !result.ptb?.commands.some((command) => command.target.endsWith("::log::record_intent")),
  "default gas-optimized PTB should not add the audit Move call"
);

const transfer = await compileIntent(
  "Transfer 1 DUSDC to 0x0000000000000000000000000000000000000000000000000000000000000b0b"
);
const quoteOnly = await compileIntent(`Quote 10 DUSDC BTC UP near 62500 using oracle ${market.oracle.oracle_id}`);
const sellPreview = await compileIntent(`Sell or redeem my BTC Predict position using oracle ${market.oracle.oracle_id}`);
const incompleteRedeem = await compileIntent("Redeem my BTC Predict position");
const markets = await getPredictMarkets({ status: "active", asset: "BTC", selectedOracleId: market.oracle.oracle_id });
const secondPageMarkets = await getPredictMarkets({ status: "active", asset: "BTC", page: 2, pageSize: 4 });
const history = await getPredictOracleHistory(market.oracle.oracle_id);
const emptyProfile = await getProfileSummary({ wallet: null, managerId: null });
const invalidJson = await parseJsonBody(
  new Request("http://deeppilot.local", { method: "POST", body: "not-json" }),
  z.object({ intent: z.string() })
);

assert(transfer.intent.status === "ready", "transfer intent should parse");
assert(Boolean(transfer.ptb), "transfer PTB should be built");
assert(transfer.ptb?.commands[0]?.target === "0x2::coin::transfer", "transfer PTB should use coin::transfer");
assert(transfer.gas.approved, "transfer sponsor policy should approve allowlisted coin transfer");
assert(transfer.ptb.gasOwner === transfer.ptb.sponsor, "gasless transfer should use sponsor as gas owner");
assert(quoteOnly.intent.status === "ready", "quote-only intent should parse");
assert(quoteOnly.intent.action === "predict_quote_only", "quote-only intent should stay quote-only");
assert(quoteOnly.market?.oracle.oracle_id === market.oracle.oracle_id, "explicit oracle lookup should preserve oracle id");
assert(quoteOnly.market?.oracle.predict_id === predictDeployment.predictId, "explicit oracle lookup should stay within configured Predict object");
assert(!quoteOnly.quote, "quote-only intent should not produce executable trade quote");
assert(!quoteOnly.ptb, "quote-only intent should not build a PTB");
assert(!quoteOnly.gas.approved, "quote-only intent should not be wallet execution approved");
assert(sellPreview.intent.status === "ready", "sell/redeem intent should parse");
assert(sellPreview.intent.action === "predict_redeem", "sell should map to redeem preview");
assert(
  sellPreview.ptb?.commands.some((command) => command.target === `${predictDeployment.packageId}::predict::redeem_permissionless`),
  "sell/redeem preview should target predict::redeem_permissionless"
);
assert(incompleteRedeem.intent.status === "needs_clarification", "redeem without oracle id should ask for clarification");
assert(markets.markets.some((market) => market.status === "active"), "markets API should return active BTC markets");
assert(markets.markets.length <= markets.pagination.pageSize, "markets API should return only one page");
assert(markets.markets.every((market) => market.hasState), "visible market page should be state-prefetched");
assert(markets.pagination.totalItems >= markets.markets.length, "markets pagination should include total item count");
assert(secondPageMarkets.markets.length <= 4, "second market page should respect requested page size");
assert(secondPageMarkets.pagination.page >= 1, "second market page should return a normalized page number");
assert(
  markets.markets.some((item) => item.oracleId === market.oracle.oracle_id && item.riskLevel !== "unknown"),
  "selected oracle path should include a Guardian quick badge"
);
assert(history.points.length > 0, "oracle history should include price points");
assert(history.points.length <= 240, "oracle history should be server capped");
assert(history.points.every((point) => point.spot > 1_000 && point.spot < 1_000_000), "oracle history should normalize price scale");
assert(!emptyProfile.managerLinked, "profile without manager id should stay in honest not-linked mode");
assert(!invalidJson.success, "invalid JSON body should be rejected without throwing");

console.log(
  JSON.stringify(
    {
      ok: true,
      oracle: market.oracle.oracle_id,
      spot: market.metrics.spot,
      oracleAgeMs: market.metrics.oracleAgeMs,
      guardian: result.guardian.decision,
      gasMode: result.gas.mode,
      digestPreview: result.ptb?.digestPreview
    },
    null,
    2
  )
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
