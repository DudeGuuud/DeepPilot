import { compileIntent, type CompileOptions } from "./compile";
import type { CompileResult, StrategyLeg, TradeMethod } from "./types";

export interface TradeMethodAdapter {
  method: TradeMethod;
  executableInBatch: boolean;
  resolve(leg: StrategyLeg): Promise<StrategyLeg>;
  quote(leg: StrategyLeg, options: CompileOptions): Promise<CompileResult>;
  checkSafety(result: CompileResult): boolean;
  buildPreview(result: CompileResult): CompileResult;
}

export const predictBinaryMintAdapter: TradeMethodAdapter = {
  method: "predict_binary_mint",
  executableInBatch: true,
  async resolve(leg) {
    return leg;
  },
  async quote(leg, options) {
    return compileIntent(strategyLegToIntent(leg), options);
  },
  checkSafety(result) {
    return Boolean(result.ptb && !result.guardian.blocked);
  },
  buildPreview(result) {
    return result;
  }
};

export const tradeMethodAdapters: Record<TradeMethod, TradeMethodAdapter | null> = {
  predict_binary_mint: predictBinaryMintAdapter,
  predict_range_mint: null,
  predict_redeem: null,
  manager_funding: null
};

export function strategyLegToIntent(leg: StrategyLeg) {
  const direction = leg.direction === "down" ? "DOWN" : "UP";
  const amount = leg.amountDusdc === null ? "0" : formatStrategyAmount(leg.amountDusdc);
  const oracle = leg.oracleId ? ` using oracle ${leg.oracleId}` : " on the next active DeepBook Predict oracle";
  const strike = typeof leg.strike === "number" ? ` at strike ${leg.strike}` : "";

  return `Buy ${amount} DUSDC BTC ${direction}${strike}${oracle}`;
}

function formatStrategyAmount(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
