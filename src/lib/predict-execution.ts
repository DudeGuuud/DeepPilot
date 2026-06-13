import { Transaction } from "@mysten/sui/transactions";

import type { PtbTransactionData } from "./types";

const SUI_OBJECT_ID = /^0x[a-fA-F0-9]{1,64}$/;

export type BuildCreateManagerInput = {
  packageId: string;
  gasBudget?: number;
};

export type BuildBinaryMintInput = {
  transactionData: PtbTransactionData;
  managerId?: string | null;
  managerBalanceRaw?: string | null;
  gasBudget?: number;
};

export type BuiltPredictMintTransaction = {
  transaction: Transaction;
  managerId: string;
  estimatedCostRaw: string;
  topUpRaw: string;
};

type ExecutedTransactionLike = {
  digest: string;
  status?: {
    success: boolean;
    error?: unknown;
  };
  events?: unknown;
  effects?: unknown;
  objectTypes?: unknown;
};

export function buildCreatePredictManagerTransaction({ packageId, gasBudget }: BuildCreateManagerInput) {
  assertObjectId(packageId, "Predict package id");

  const tx = new Transaction();

  if (gasBudget) {
    tx.setGasBudget(gasBudget);
  }

  tx.moveCall({
    target: `${packageId}::predict::create_manager`
  });

  return tx;
}

export function buildBinaryMintTransaction({
  transactionData,
  managerId,
  managerBalanceRaw,
  gasBudget
}: BuildBinaryMintInput): BuiltPredictMintTransaction {
  if (transactionData.intent.action !== "predict_binary_mint") {
    throw new Error("Only binary Predict mint is executable in this version.");
  }

  if (transactionData.onchainAuditEnabled) {
    throw new Error("On-chain audit logging is not supported in the wallet execution path yet.");
  }

  const resolvedManager = managerId ?? transactionData.manager;
  assertObjectId(transactionData.packageId, "Predict package id");
  assertObjectId(transactionData.predictObject, "Predict object");
  assertObjectId(resolvedManager, "PredictManager object");

  const oracleId = transactionData.key.oracleId ?? transactionData.oracleId;
  const expiry = transactionData.key.expiry;
  const strikeScaled = transactionData.key.strikeScaled;
  const keyTarget = transactionData.key.target;
  const mintTarget = transactionData.mint.target;
  const quantityRaw = transactionData.mint.quantityRaw;
  const estimatedCostRaw = transactionData.quote?.estimatedCostRaw;

  assertObjectId(oracleId, "Predict oracle object");
  assertU64(expiry, "Predict expiry");
  assertU64(strikeScaled, "Predict strike");
  assertU64String(quantityRaw, "Predict quantity");
  assertU64String(estimatedCostRaw, "Estimated mint cost");

  if (!keyTarget || !keyTarget.startsWith(`${transactionData.packageId}::market_key::`)) {
    throw new Error("Compiled market key target is missing or does not match the Predict package.");
  }

  if (mintTarget !== `${transactionData.packageId}::predict::mint`) {
    throw new Error("Compiled mint target does not match predict::mint.");
  }

  const tx = new Transaction();

  if (gasBudget) {
    tx.setGasBudget(gasBudget);
  }

  const key = tx.moveCall({
    target: keyTarget,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(expiry),
      tx.pure.u64(BigInt(strikeScaled))
    ]
  });
  const topUpRaw = calculateTopUpRaw(estimatedCostRaw, managerBalanceRaw);

  if (topUpRaw > 0n) {
    const coin = tx.coin({
      type: transactionData.quoteAssetType,
      balance: topUpRaw
    });

    tx.moveCall({
      target: `${transactionData.packageId}::predict_manager::deposit`,
      typeArguments: [transactionData.quoteAssetType],
      arguments: [
        tx.object(resolvedManager),
        coin
      ]
    });
  }

  tx.moveCall({
    target: mintTarget,
    typeArguments: [transactionData.quoteAssetType],
    arguments: [
      tx.object(transactionData.predictObject),
      tx.object(resolvedManager),
      tx.object(oracleId),
      key,
      tx.pure.u64(BigInt(quantityRaw)),
      tx.object("0x6")
    ]
  });

  return {
    transaction: tx,
    managerId: resolvedManager,
    estimatedCostRaw,
    topUpRaw: topUpRaw.toString()
  };
}

export function getExecutedDigest(result: unknown) {
  const transaction = unwrapTransaction(result);

  return transaction.digest;
}

export function assertExecuted(result: unknown) {
  const transaction = unwrapTransaction(result);

  if (!transaction.status?.success) {
    throw new Error(formatExecutionStatus(transaction.status?.error));
  }

  return transaction;
}

export function extractPredictManagerId(result: unknown, packageId: string) {
  const transaction = unwrapTransaction(result);
  const eventManager = extractManagerFromEvents(transaction.events);

  if (eventManager) {
    return eventManager;
  }

  const expectedType = `${packageId}::predict_manager::PredictManager`;
  const objectTypes = isRecord(transaction.objectTypes) ? transaction.objectTypes : {};
  const effects = isRecord(transaction.effects) ? transaction.effects : null;
  const changedObjects = Array.isArray(effects?.changedObjects)
    ? effects.changedObjects
    : [];

  for (const change of changedObjects) {
    if (!isRecord(change) || change.idOperation !== "Created" || typeof change.objectId !== "string") {
      continue;
    }

    if (objectTypes[change.objectId] === expectedType) {
      return change.objectId;
    }
  }

  return null;
}

export function calculateTopUpRaw(estimatedCostRaw: string, managerBalanceRaw?: string | null) {
  const required = BigInt(estimatedCostRaw);
  const balance = managerBalanceRaw && /^\d+$/.test(managerBalanceRaw) ? BigInt(managerBalanceRaw) : 0n;

  return balance >= required ? 0n : required - balance;
}

function unwrapTransaction(result: unknown): ExecutedTransactionLike {
  if (!isRecord(result)) {
    throw new Error("Wallet did not return a transaction result.");
  }

  const value = result.Transaction ?? result.FailedTransaction;

  if (!isRecord(value) || typeof value.digest !== "string") {
    throw new Error("Wallet transaction result is missing a digest.");
  }

  return value as ExecutedTransactionLike;
}

function extractManagerFromEvents(events: unknown) {
  if (!Array.isArray(events)) {
    return null;
  }

  for (const event of events) {
    if (!isRecord(event) || typeof event.eventType !== "string") {
      continue;
    }

    if (!event.eventType.endsWith("::predict_manager::PredictManagerCreated")) {
      continue;
    }

    const json = isRecord(event.json) ? event.json : null;
    const managerId = json?.manager_id;

    if (typeof managerId === "string" && SUI_OBJECT_ID.test(managerId)) {
      return managerId;
    }
  }

  return null;
}

function assertObjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SUI_OBJECT_ID.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
}

function assertU64(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is missing or invalid.`);
  }
}

function assertU64String(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
}

function formatExecutionStatus(error: unknown) {
  if (!error) {
    return "Transaction failed.";
  }

  if (typeof error === "string") {
    return error;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return "Transaction failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
