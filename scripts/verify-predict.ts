import { compileIntent } from "../src/lib/compile";
import { predictDeployment } from "../src/lib/predict";

const intent = "Buy 10 DUSDC BTC UP near 62500 on the next active DeepBook Predict oracle";
const result = await compileIntent(intent);

assert(result.intent.status === "ready", "intent should parse");
assert(result.market?.source === "deepbook_predict", "market snapshot should come from DeepBook Predict");
assert(result.market.deployment.network === "testnet", "default Predict network should be testnet");
assert(result.market.oracle.status === "active", "selected oracle should be active");
assert(result.market.metrics.spot !== null, "spot should be available");
assert(result.guardian.decision !== "block", "Guardian should not block the smoke intent");
assert(Boolean(result.ptb), "PTB preview should be built");
assert(result.gas.approved, "sponsor policy should approve the smoke PTB preview");
assert(result.gas.checks.every((check) => check.passed), "all sponsor policy checks should pass");
assert(
  result.ptb?.commands.some((command) => command.target === `${predictDeployment.packageId}::predict::mint`),
  "PTB preview should target predict::mint"
);
assert(
  !result.ptb?.commands.some((command) => command.target.endsWith("::log::record_intent")),
  "default gas-optimized PTB should not add the audit Move call"
);

const transfer = await compileIntent(
  "Transfer 1 DUSDC to 0x0000000000000000000000000000000000000000000000000000000000000b0b"
);
const quoteOnly = await compileIntent(`Quote 10 DUSDC BTC UP near 62500 using oracle ${result.market.oracle.oracle_id}`);
const incompleteRedeem = await compileIntent("Redeem my BTC Predict position");

assert(transfer.intent.status === "ready", "transfer intent should parse");
assert(Boolean(transfer.ptb), "transfer PTB should be built");
assert(transfer.ptb?.commands[0]?.target === "0x2::coin::transfer", "transfer PTB should use coin::transfer");
assert(transfer.gas.approved, "transfer sponsor policy should approve allowlisted coin transfer");
assert(transfer.ptb.gasOwner === transfer.ptb.sponsor, "gasless transfer should use sponsor as gas owner");
assert(quoteOnly.intent.status === "ready", "quote-only intent should parse");
assert(quoteOnly.intent.action === "predict_quote_only", "quote-only intent should stay quote-only");
assert(quoteOnly.market?.oracle.oracle_id === result.market.oracle.oracle_id, "explicit oracle lookup should preserve oracle id");
assert(quoteOnly.market?.oracle.predict_id === predictDeployment.predictId, "explicit oracle lookup should stay within configured Predict object");
assert(!quoteOnly.ptb, "quote-only intent should not build a PTB");
assert(!quoteOnly.gas.approved, "quote-only intent should not be sponsor approved");
assert(incompleteRedeem.intent.status === "needs_clarification", "redeem without oracle id should ask for clarification");

console.log(
  JSON.stringify(
    {
      ok: true,
      oracle: result.market.oracle.oracle_id,
      spot: result.market.metrics.spot,
      oracleAgeMs: result.market.metrics.oracleAgeMs,
      guardian: result.guardian.decision,
      sponsor: result.gas.approved,
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
