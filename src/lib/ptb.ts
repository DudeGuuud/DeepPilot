import { Transaction } from "@mysten/sui/transactions";

import type { DeepBookQuote, GuardianResult, ParsedIntent, PtbCommandPreview, PtbPlan, SponsorDecision } from "./types";

const DEMO_SENDER = "0x0000000000000000000000000000000000000000000000000000000000000a11";
const DEMO_SPONSOR = "0x00000000000000000000000000000000000000000000000000000000000005aa";
const DEMO_DEEPBOOK_PACKAGE = "0x00000000000000000000000000000000000000000000000000000000dee90001";
const DEMO_LOG_PACKAGE = "0x00000000000000000000000000000000000000000000000000000000d9000001";
const DEMO_POOL_ID = "0x00000000000000000000000000000000000000000000000000000000b0000001";

export function buildPtbPlan(
  intent: ParsedIntent,
  quote: DeepBookQuote | null,
  guardian: GuardianResult,
  gas: SponsorDecision
): PtbPlan | null {
  if (intent.status !== "ready" || guardian.blocked) {
    return null;
  }

  const tx = new Transaction();
  tx.setSender(DEMO_SENDER);
  tx.setGasBudget(12_000_000);
  tx.setGasOwner(gas.mode === "sponsored" ? DEMO_SPONSOR : DEMO_SENDER);
  tx.setExpiration({ None: true });

  const commands: PtbCommandPreview[] = [];

  if (intent.action === "stablecoin_transfer") {
    tx.moveCall({
      target: "0x2::coin::transfer",
      typeArguments: [`0x2::${intent.baseToken.toLowerCase()}::${intent.baseToken}`],
      arguments: [
        tx.object("0x00000000000000000000000000000000000000000000000000000000c01a0001"),
        tx.pure.address(intent.recipient ?? DEMO_SENDER)
      ]
    });

    commands.push({
      index: 1,
      command: `Gasless ${intent.baseToken} transfer`,
      target: "0x2::coin::transfer",
      riskGate: "atomic"
    });
  } else {
    tx.moveCall({
      target: `${DEMO_DEEPBOOK_PACKAGE}::deepbook::${intent.action === "deepbook_limit_order" ? "place_limit_order" : "place_market_order"}`,
      arguments: [
        tx.object(DEMO_POOL_ID),
        tx.pure.string(intent.side),
        tx.pure.u64(Math.round(Number(intent.amount) * 1_000_000)),
        tx.pure.u64(intent.maxSlippageBps),
        tx.pure.u64(Math.round((quote?.bestAsk ?? 0) * 1_000_000))
      ],
      typeArguments: [`0x2::sui::SUI`, `0x2::usdc::USDC`]
    });

    commands.push({
      index: 1,
      command: `${intent.action === "deepbook_limit_order" ? "Place limit" : "Place market"} ${intent.side} on ${quote?.pair ?? "SUI/USDC"}`,
      target: "deepbook::place_order",
      riskGate: "atomic"
    });
  }

  tx.moveCall({
    target: `${DEMO_LOG_PACKAGE}::deep_pilot_log::record_intent`,
    arguments: [
      tx.pure.string(hashish(intent.raw)),
      tx.pure.string(intent.action),
      tx.pure.string(guardian.level),
      tx.pure.u64(guardian.score),
      tx.pure.bool(gas.mode === "sponsored")
    ]
  });

  commands.push({
    index: commands.length + 1,
    command: "Record IntentRecord and RiskRecord",
    target: "deep_pilot_log::record_intent",
    riskGate: "receipt"
  });

  return {
    sender: DEMO_SENDER,
    sponsor: DEMO_SPONSOR,
    gasBudget: 12_000_000,
    gasOwner: gas.mode === "sponsored" ? DEMO_SPONSOR : DEMO_SENDER,
    transactionKind: "ProgrammableTransaction",
    commands,
    transactionData: tx.getData(),
    digestPreview: hashish(JSON.stringify(tx.getData())).slice(0, 44),
    simulated: {
      status: "not_submitted",
      reason: "Real deployment is disabled for this milestone; PTB is compiled for local signing preview.",
      explorerReady: false
    }
  };
}

function hashish(input: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `0x${(hash >>> 0).toString(16).padStart(8, "0")}${input.length.toString(16).padStart(8, "0")}`;
}

