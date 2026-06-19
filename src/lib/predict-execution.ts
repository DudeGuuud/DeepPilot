import { Transaction } from "@mysten/sui/transactions";

import type { BatchPredictMintTransactionData, PtbTransactionData } from "./types";

const SUI_OBJECT_ID = /^0x[a-fA-F0-9]{1,64}$/;

export type BuildCreateManagerInput = {
  packageId: string;
};

export type BuildBinaryMintInput = {
  transactionData: PtbTransactionData;
  managerId?: string | null;
};

export type BuildBatchPredictMintInput = {
  transactionData: BatchPredictMintTransactionData;
  managerId?: string | null;
};

export type BuiltPredictMintTransaction = {
  transaction: Transaction;
  managerId: string;
  estimatedCostRaw: string;
};

export type BuiltBatchPredictMintTransaction = {
  transaction: Transaction;
  managerId: string;
  estimatedCostRaw: string;
  legCount: number;
};

export type BuildManagerFundingInput = {
  packageId: string;
  managerId: string;
  quoteAssetType: string;
  amountRaw: string;
};

export type BuildManagerWithdrawInput = BuildManagerFundingInput & {
  recipient: string;
};

export type BuildRedeemPermissionlessInput = {
  packageId: string;
  predictObject: string;
  managerId: string;
  oracleId: string;
  quoteAssetType: string;
  expiry: number;
  strikeScaled: number;
  direction: "up" | "down";
  quantityRaw: string;
};

export type BuildVaultLpSupplyInput = {
  packageId: string;
  predictObject: string;
  quoteAssetType: string;
  amountRaw: string;
  recipient: string;
};

export type BuildVaultLpWithdrawInput = {
  packageId: string;
  predictObject: string;
  quoteAssetType: string;
  plpCoinType: string;
  plpSharesRaw: string;
  recipient: string;
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

export function buildCreatePredictManagerTransaction({ packageId }: BuildCreateManagerInput) {
  assertObjectId(packageId, "Predict package id");

  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::predict::create_manager`
  });

  return tx;
}

export function buildBinaryMintTransaction({
  transactionData,
  managerId
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

  const key = tx.moveCall({
    target: keyTarget,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(expiry),
      tx.pure.u64(BigInt(strikeScaled))
    ]
  });
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
    estimatedCostRaw
  };
}

export function buildBatchPredictMintTransaction({
  transactionData,
  managerId
}: BuildBatchPredictMintInput): BuiltBatchPredictMintTransaction {
  const resolvedManager = managerId ?? transactionData.manager;
  assertObjectId(transactionData.packageId, "Predict package id");
  assertObjectId(transactionData.predictObject, "Predict object");
  assertObjectId(resolvedManager, "PredictManager object");

  if (!transactionData.legs.length) {
    throw new Error("Batch Predict mint requires at least one leg.");
  }

  const tx = new Transaction();
  let estimatedCostRaw = 0n;

  for (const leg of transactionData.legs) {
    assertObjectId(leg.oracleId, "Predict oracle object");
    assertU64(leg.expiry, "Predict expiry");
    assertU64(leg.strikeScaled, "Predict strike");
    assertU64String(leg.quantityRaw, "Predict quantity");
    assertU64String(leg.estimatedCostRaw, "Estimated mint cost");

    if (!leg.keyTarget || !leg.keyTarget.startsWith(`${transactionData.packageId}::market_key::`)) {
      throw new Error(`Batch leg ${leg.legId} has an invalid market key target.`);
    }

    if (leg.mintTarget !== `${transactionData.packageId}::predict::mint`) {
      throw new Error(`Batch leg ${leg.legId} has an invalid mint target.`);
    }

    const key = tx.moveCall({
      target: leg.keyTarget,
      arguments: [
        tx.pure.id(leg.oracleId),
        tx.pure.u64(leg.expiry),
        tx.pure.u64(BigInt(leg.strikeScaled))
      ]
    });

    tx.moveCall({
      target: leg.mintTarget,
      typeArguments: [transactionData.quoteAssetType],
      arguments: [
        tx.object(transactionData.predictObject),
        tx.object(resolvedManager),
        tx.object(leg.oracleId),
        key,
        tx.pure.u64(BigInt(leg.quantityRaw)),
        tx.object("0x6")
      ]
    });

    estimatedCostRaw += BigInt(leg.estimatedCostRaw);
  }

  return {
    transaction: tx,
    managerId: resolvedManager,
    estimatedCostRaw: estimatedCostRaw.toString(),
    legCount: transactionData.legs.length
  };
}

export function buildDepositToManagerTransaction({
  packageId,
  managerId,
  quoteAssetType,
  amountRaw
}: BuildManagerFundingInput) {
  assertObjectId(packageId, "Predict package id");
  assertObjectId(managerId, "PredictManager object");
  assertU64String(amountRaw, "Deposit amount");

  const tx = new Transaction();
  const coin = tx.coin({
    type: quoteAssetType,
    balance: BigInt(amountRaw)
  });

  tx.moveCall({
    target: `${packageId}::predict_manager::deposit`,
    typeArguments: [quoteAssetType],
    arguments: [
      tx.object(managerId),
      coin
    ]
  });

  return tx;
}

export function buildWithdrawFromManagerTransaction({
  packageId,
  managerId,
  quoteAssetType,
  amountRaw,
  recipient
}: BuildManagerWithdrawInput) {
  assertObjectId(packageId, "Predict package id");
  assertObjectId(managerId, "PredictManager object");
  assertObjectId(recipient, "Recipient address");
  assertU64String(amountRaw, "Withdraw amount");

  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${packageId}::predict_manager::withdraw`,
    typeArguments: [quoteAssetType],
    arguments: [
      tx.object(managerId),
      tx.pure.u64(BigInt(amountRaw))
    ]
  });

  tx.transferObjects([coin], tx.pure.address(recipient));

  return tx;
}

export function buildRedeemPermissionlessTransaction({
  packageId,
  predictObject,
  managerId,
  oracleId,
  quoteAssetType,
  expiry,
  strikeScaled,
  direction,
  quantityRaw
}: BuildRedeemPermissionlessInput) {
  assertObjectId(packageId, "Predict package id");
  assertObjectId(predictObject, "Predict object");
  assertObjectId(managerId, "PredictManager object");
  assertObjectId(oracleId, "Predict oracle object");
  assertU64(expiry, "Predict expiry");
  assertU64(strikeScaled, "Predict strike");
  assertU64String(quantityRaw, "Predict quantity");

  const tx = new Transaction();
  const key = tx.moveCall({
    target: `${packageId}::market_key::${direction === "up" ? "up" : "down"}`,
    arguments: [
      tx.pure.id(oracleId),
      tx.pure.u64(expiry),
      tx.pure.u64(BigInt(strikeScaled))
    ]
  });

  tx.moveCall({
    target: `${packageId}::predict::redeem_permissionless`,
    typeArguments: [quoteAssetType],
    arguments: [
      tx.object(predictObject),
      tx.object(managerId),
      tx.object(oracleId),
      key,
      tx.pure.u64(BigInt(quantityRaw)),
      tx.object("0x6")
    ]
  });

  return tx;
}

export function buildVaultLpSupplyTransaction({
  packageId,
  predictObject,
  quoteAssetType,
  amountRaw,
  recipient
}: BuildVaultLpSupplyInput) {
  assertObjectId(packageId, "Predict package id");
  assertObjectId(predictObject, "Predict object");
  assertObjectId(recipient, "Recipient address");
  assertU64String(amountRaw, "Vault LP supply amount");

  const tx = new Transaction();
  const payment = tx.coin({
    type: quoteAssetType,
    balance: BigInt(amountRaw)
  });
  const plpCoin = tx.moveCall({
    target: `${packageId}::predict::supply`,
    typeArguments: [quoteAssetType],
    arguments: [
      tx.object(predictObject),
      payment,
      tx.object("0x6")
    ]
  });

  tx.transferObjects([plpCoin], tx.pure.address(recipient));

  return tx;
}

export function buildVaultLpWithdrawTransaction({
  packageId,
  predictObject,
  quoteAssetType,
  plpCoinType,
  plpSharesRaw,
  recipient
}: BuildVaultLpWithdrawInput) {
  assertObjectId(packageId, "Predict package id");
  assertObjectId(predictObject, "Predict object");
  assertObjectId(recipient, "Recipient address");
  assertU64String(plpSharesRaw, "Vault LP withdraw shares");

  const tx = new Transaction();
  const lpCoin = tx.coin({
    type: plpCoinType,
    balance: BigInt(plpSharesRaw)
  });
  const dusdcCoin = tx.moveCall({
    target: `${packageId}::predict::withdraw`,
    typeArguments: [quoteAssetType],
    arguments: [
      tx.object(predictObject),
      lpCoin,
      tx.object("0x6")
    ]
  });

  tx.transferObjects([dusdcCoin], tx.pure.address(recipient));

  return tx;
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
