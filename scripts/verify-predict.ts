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
assert(
  result.ptb?.commands.some((command) => command.target === `${predictDeployment.packageId}::predict::mint`),
  "PTB preview should target predict::mint"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      oracle: result.market.oracle.oracle_id,
      spot: result.market.metrics.spot,
      oracleAgeMs: result.market.metrics.oracleAgeMs,
      guardian: result.guardian.decision,
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
