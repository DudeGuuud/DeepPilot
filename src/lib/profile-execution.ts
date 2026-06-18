import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { clientGrpcUrls, clientNetwork, type ClientNetwork } from "./client-config";
import type { DeepPilotPlanName } from "./types";

const SUI_OBJECT_ID = /^0x[a-fA-F0-9]{1,64}$/;
export const DEEP_PILOT_PLAN_STANDARD = 0;
export const DEEP_PILOT_PLAN_PRO = 1;
export const DEEP_PILOT_PLAN_MAX = 2;
export const DEFAULT_PLAN_PRICE_MIST = "100000000";

export type DeepPilotPlan = 0 | 1 | 2;

export type BuildCreateProfileInput = {
  packageId: string;
  registryId: string;
  telegramHash: string | Uint8Array | number[];
  memoryNamespace?: string | null;
};

export type BuildSubscribePlanInput = {
  packageId: string;
  profileId: string;
  treasuryId: string;
  plan: DeepPilotPlan;
  priceMist?: string | number | bigint | null;
};

export type BuildSetMemoryPointerInput = {
  packageId: string;
  profileId: string;
  memoryAccountId?: string | null;
  memoryNamespace?: string | null;
  memoryRootBlobId?: string | null;
};

export type BuildAdminSetPlanInput = {
  packageId: string;
  adminCapId: string;
  profileId: string;
  plan: DeepPilotPlan;
  expiresAtMs: string | number | bigint;
};

export type BuildAdminWithdrawInput = {
  packageId: string;
  adminCapId: string;
  treasuryId: string;
  amountMist: string | number | bigint;
  recipient: string;
};

type ExecutedTransactionLike = {
  digest: string;
  events?: unknown;
  effects?: unknown;
  objectTypes?: unknown;
};

type VerifyProfileCreatedInput = {
  packageId: string;
  digest: string;
  profileId: string;
  owner: string;
  telegramHash: string;
  network?: ClientNetwork;
};

type VerifyPlanChangedInput = {
  packageId: string;
  digest: string;
  profileId: string;
  owner: string;
  plan: DeepPilotPlanName;
  network?: ClientNetwork;
};

type FindProfileInRegistryInput = {
  registryId: string;
  telegramHash: string | Uint8Array | number[];
  walletAddress?: string | null;
  network?: ClientNetwork;
};

export function buildCreateDeepPilotProfileTransaction({
  packageId,
  registryId,
  telegramHash,
  memoryNamespace
}: BuildCreateProfileInput) {
  assertObjectId(packageId, "Profile package id");
  assertObjectId(registryId, "Profile registry object");

  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::profile::create_profile`,
    arguments: [
      tx.object(registryId),
      tx.pure.vector("u8", normalizeTelegramHashBytes(telegramHash)),
      tx.pure.string(memoryNamespace?.trim() || ""),
      tx.object("0x6")
    ]
  });

  return tx;
}

export function buildSubscribePlanTransaction({
  packageId,
  profileId,
  treasuryId,
  plan,
  priceMist
}: BuildSubscribePlanInput) {
  assertObjectId(packageId, "Profile package id");
  assertObjectId(profileId, "Profile object");
  assertObjectId(treasuryId, "Profile treasury object");
  assertPaidPlan(plan);

  const payment = normalizeU64String(priceMist ?? DEFAULT_PLAN_PRICE_MIST, "Plan price");
  const tx = new Transaction();
  const coin = tx.coin({
    type: "0x2::sui::SUI",
    balance: BigInt(payment)
  });

  tx.moveCall({
    target: `${packageId}::profile::subscribe`,
    arguments: [
      tx.object(profileId),
      tx.object(treasuryId),
      tx.pure.u8(plan),
      coin,
      tx.object("0x6")
    ]
  });

  return tx;
}

export function buildSetProfileMemoryPointerTransaction({
  packageId,
  profileId,
  memoryAccountId,
  memoryNamespace,
  memoryRootBlobId
}: BuildSetMemoryPointerInput) {
  assertObjectId(packageId, "Profile package id");
  assertObjectId(profileId, "Profile object");

  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::profile::set_memory_pointer`,
    arguments: [
      tx.object(profileId),
      tx.pure.string(memoryAccountId?.trim() || ""),
      tx.pure.string(memoryNamespace?.trim() || ""),
      tx.pure.string(memoryRootBlobId?.trim() || ""),
      tx.object("0x6")
    ]
  });

  return tx;
}

export function buildAdminSetPlanTransaction({
  packageId,
  adminCapId,
  profileId,
  plan,
  expiresAtMs
}: BuildAdminSetPlanInput) {
  assertObjectId(packageId, "Profile package id");
  assertObjectId(adminCapId, "Profile admin cap");
  assertObjectId(profileId, "Profile object");
  assertPlan(plan);

  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::profile::admin_set_plan`,
    arguments: [
      tx.object(adminCapId),
      tx.object(profileId),
      tx.pure.u8(plan),
      tx.pure.u64(normalizeU64String(expiresAtMs, "Plan expiry")),
      tx.object("0x6")
    ]
  });

  return tx;
}

export function buildAdminWithdrawProfileTreasuryTransaction({
  packageId,
  adminCapId,
  treasuryId,
  amountMist,
  recipient
}: BuildAdminWithdrawInput) {
  assertObjectId(packageId, "Profile package id");
  assertObjectId(adminCapId, "Profile admin cap");
  assertObjectId(treasuryId, "Profile treasury object");
  assertObjectId(recipient, "Treasury recipient");

  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::profile::admin_withdraw`,
    arguments: [
      tx.object(adminCapId),
      tx.object(treasuryId),
      tx.pure.u64(normalizeU64String(amountMist, "Treasury withdraw amount")),
      tx.pure.address(recipient)
    ]
  });

  return tx;
}

export function extractDeepPilotProfileId(result: unknown, packageId: string) {
  assertObjectId(packageId, "Profile package id");

  const transaction = unwrapTransaction(result);
  const eventProfileId = extractProfileFromEvents(transaction.events);

  if (eventProfileId) {
    return eventProfileId;
  }

  const expectedType = `${packageId}::profile::Profile`;
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

export async function verifyDeepPilotProfileCreated({
  packageId,
  digest,
  profileId,
  owner,
  telegramHash,
  network = clientNetwork
}: VerifyProfileCreatedInput) {
  assertObjectId(packageId, "Profile package id");
  assertObjectId(profileId, "Profile object");
  assertObjectId(owner, "Profile owner");
  assertTransactionDigest(digest);

  const transaction = await fetchTransaction(digest, network);
  const event = findProfileEvent(transaction.events, `${packageId}::profile::ProfileCreated`);
  const eventProfileId = objectIdFromJson(event?.profile_id);
  const eventOwner = stringFromJson(event?.owner);
  const eventTelegramHash = bytesFromJson(event?.telegram_hash);

  if (
    !eventProfileId ||
    eventProfileId.toLowerCase() !== profileId.toLowerCase() ||
    eventOwner?.toLowerCase() !== owner.toLowerCase() ||
    !sameBytes(eventTelegramHash, normalizeTelegramHashBytes(telegramHash))
  ) {
    throw new Error("Profile create transaction does not match the linked Telegram wallet.");
  }

  return {
    profileId: eventProfileId,
    owner: eventOwner
  };
}

export async function verifyDeepPilotPlanChanged({
  packageId,
  digest,
  profileId,
  owner,
  plan,
  network = clientNetwork
}: VerifyPlanChangedInput) {
  assertObjectId(packageId, "Profile package id");
  assertObjectId(profileId, "Profile object");
  assertObjectId(owner, "Profile owner");
  assertTransactionDigest(digest);

  const transaction = await fetchTransaction(digest, network);
  const event = findProfileEvent(transaction.events, `${packageId}::profile::PlanChanged`);
  const eventProfileId = objectIdFromJson(event?.profile_id);
  const eventOwner = stringFromJson(event?.owner);
  const eventPlan = numberFromJson(event?.plan);

  if (
    !eventProfileId ||
    eventProfileId.toLowerCase() !== profileId.toLowerCase() ||
    eventOwner?.toLowerCase() !== owner.toLowerCase() ||
    eventPlan !== planNameToCode(plan)
  ) {
    throw new Error("Plan subscription transaction does not match the linked Profile.");
  }

  return {
    profileId: eventProfileId,
    owner: eventOwner,
    plan
  };
}

export async function findDeepPilotProfileInRegistry({
  registryId,
  telegramHash,
  walletAddress,
  network = clientNetwork
}: FindProfileInRegistryInput) {
  assertObjectId(registryId, "Profile registry object");

  if (walletAddress) {
    assertObjectId(walletAddress, "Profile owner");
  }

  const client = new SuiGrpcClient({
    network,
    baseUrl: clientGrpcUrls[network]
  });
  const registry = await client.getObject({
    objectId: registryId,
    include: {
      json: true
    }
  });
  const json = isRecord(registry.object.json) ? registry.object.json : null;
  const byTelegram = findVecMapValue(
    json?.telegram_profiles,
    bytesToBase64(normalizeTelegramHashBytes(telegramHash))
  );
  const byWallet = walletAddress
    ? findVecMapValue(json?.wallet_profiles, walletAddress.toLowerCase())
    : null;

  if (byTelegram && byWallet && byTelegram.toLowerCase() !== byWallet.toLowerCase()) {
    throw new Error("Profile registry has inconsistent Telegram and wallet mappings.");
  }

  return byTelegram ?? byWallet;
}

function extractProfileFromEvents(events: unknown) {
  if (!Array.isArray(events)) {
    return null;
  }

  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }

    const eventType = typeof event.eventType === "string"
      ? event.eventType
      : typeof event.type === "string"
        ? event.type
        : "";

    if (!eventType.endsWith("::profile::ProfileCreated")) {
      continue;
    }

    const json = isRecord(event.json)
      ? event.json
      : isRecord(event.parsedJson)
        ? event.parsedJson
        : null;
    const profileId = objectIdFromJson(json?.profile_id);

    if (profileId) {
      return profileId;
    }
  }

  return null;
}

async function fetchTransaction(digest: string, network: ClientNetwork): Promise<ExecutedTransactionLike> {
  const client = new SuiGrpcClient({
    network,
    baseUrl: clientGrpcUrls[network]
  });
  const transaction = await client.waitForTransaction({
    digest,
    include: {
      effects: true,
      events: true,
      objectTypes: true
    }
  });

  return unwrapTransaction(transaction);
}

function findProfileEvent(events: unknown, expectedType: string) {
  if (!Array.isArray(events)) {
    return null;
  }

  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }

    const eventType = typeof event.eventType === "string"
      ? event.eventType
      : typeof event.type === "string"
        ? event.type
        : "";

    if (eventType !== expectedType && !eventType.endsWith(expectedType)) {
      continue;
    }

    const json = isRecord(event.json)
      ? event.json
      : isRecord(event.parsedJson)
        ? event.parsedJson
        : null;

    if (json) {
      return json;
    }
  }

  return null;
}

function objectIdFromJson(value: unknown) {
  if (typeof value === "string" && SUI_OBJECT_ID.test(value)) {
    return value;
  }

  if (isRecord(value) && typeof value.id === "string" && SUI_OBJECT_ID.test(value.id)) {
    return value.id;
  }

  return null;
}

function stringFromJson(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberFromJson(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

function bytesFromJson(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const bytes = value.map((item) => Number(item));

  return bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) ? bytes : null;
}

function sameBytes(left: number[] | null, right: number[]) {
  return Boolean(left && left.length === right.length && left.every((item, index) => item === right[index]));
}

function findVecMapValue(value: unknown, expectedKey: string) {
  if (!isRecord(value) || !Array.isArray(value.contents)) {
    return null;
  }

  const normalizedKey = expectedKey.toLowerCase();

  for (const entry of value.contents) {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
      continue;
    }

    if (entry.key.toLowerCase() === normalizedKey && SUI_OBJECT_ID.test(entry.value)) {
      return entry.value;
    }
  }

  return null;
}

function bytesToBase64(bytes: number[]) {
  return Buffer.from(bytes).toString("base64");
}

function planNameToCode(plan: DeepPilotPlanName): DeepPilotPlan {
  if (plan === "pro") {
    return DEEP_PILOT_PLAN_PRO;
  }

  if (plan === "max") {
    return DEEP_PILOT_PLAN_MAX;
  }

  return DEEP_PILOT_PLAN_STANDARD;
}

function normalizeTelegramHashBytes(value: string | Uint8Array | number[]) {
  if (value instanceof Uint8Array) {
    return [...value];
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!Number.isInteger(item) || item < 0 || item > 255) {
        throw new Error("Telegram hash bytes must be u8 values.");
      }

      return item;
    });
  }

  const hex = value.startsWith("0x") ? value.slice(2) : value;

  if (!/^[a-fA-F0-9]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Telegram hash must be hex bytes.");
  }

  const bytes: number[] = [];

  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }

  return bytes;
}

function normalizeU64String(value: string | number | bigint, label: string) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error(`${label} must be a positive integer.`);
    }

    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a positive safe integer.`);
    }

    return String(value);
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer string.`);
  }

  return value;
}

function assertPlan(plan: unknown): asserts plan is DeepPilotPlan {
  if (plan !== DEEP_PILOT_PLAN_STANDARD && plan !== DEEP_PILOT_PLAN_PRO && plan !== DEEP_PILOT_PLAN_MAX) {
    throw new Error("Plan must be Standard, Pro, or Max.");
  }
}

function assertPaidPlan(plan: unknown): asserts plan is 1 | 2 {
  if (plan !== DEEP_PILOT_PLAN_PRO && plan !== DEEP_PILOT_PLAN_MAX) {
    throw new Error("Only Pro and Max are paid subscription plans.");
  }
}

function assertObjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SUI_OBJECT_ID.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
}

function assertTransactionDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9]{32,128}$/.test(value)) {
    throw new Error("Transaction digest is missing or invalid.");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
