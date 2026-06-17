import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

import { appBaseUrl, telegramLinkSalt, telegramLinkSecret } from "./deep-pilot-config";
import { redisGet, redisSet } from "./redis-store";

const LOGIN_TOKEN_TTL_MS = 10 * 60_000;

export type TelegramLoginTokenPayload = {
  version: 1;
  telegramHash: string;
  chatId: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
};

export function telegramHashForUserId(userId: string | number) {
  return createHash("sha256")
    .update(`${telegramLinkSalt()}:${String(userId)}`)
    .digest("hex");
}

export function createTelegramLoginToken(input: { telegramUserId: string | number; chatId: string | number }) {
  const createdAt = new Date();
  const payload: TelegramLoginTokenPayload = {
    version: 1,
    telegramHash: telegramHashForUserId(input.telegramUserId),
    chatId: String(input.chatId),
    nonce: randomUUID(),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + LOGIN_TOKEN_TTL_MS).toISOString()
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));

  return `${encoded}.${sign(encoded)}`;
}

export function decodeTelegramLoginToken(token: string) {
  const [payload, signature, extra] = token.split(".");

  if (!payload || !signature || extra) {
    throw new Error("Invalid Telegram login token.");
  }

  if (!safeEqual(signature, sign(payload))) {
    throw new Error("Telegram login token signature is invalid.");
  }

  const parsed = JSON.parse(base64UrlDecode(payload)) as TelegramLoginTokenPayload;

  if (parsed.version !== 1 || !parsed.telegramHash || !parsed.chatId || !parsed.nonce) {
    throw new Error("Telegram login token payload is invalid.");
  }

  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    throw new Error("Telegram login token has expired.");
  }

  return parsed;
}

export function telegramLoginUrl(token: string) {
  return `${appBaseUrl().replace(/\/$/, "")}/telegram/login?token=${encodeURIComponent(token)}`;
}

export function buildTelegramWalletLinkMessage(input: {
  telegramHash: string;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
}) {
  return [
    "DeepPilot Telegram wallet link v1",
    `domain=${new URL(appBaseUrl()).host}`,
    `telegramHash=${input.telegramHash}`,
    `wallet=${input.walletAddress}`,
    `nonce=${input.nonce}`,
    `expiresAt=${input.expiresAt}`
  ].join("\n");
}

export async function verifyTelegramWalletLink(input: {
  token: string;
  walletAddress: string;
  signature: string;
}) {
  const token = decodeTelegramLoginToken(input.token);
  const nonceKey = `telegram:nonce:${token.nonce}`;
  const replay = await redisGet<string>(nonceKey);

  if (replay) {
    throw new Error("Telegram login token was already used.");
  }

  const message = buildTelegramWalletLinkMessage({
    telegramHash: token.telegramHash,
    walletAddress: input.walletAddress,
    nonce: token.nonce,
    expiresAt: token.expiresAt
  });

  await verifyPersonalMessageSignature(new TextEncoder().encode(message), input.signature, {
    address: input.walletAddress
  });

  await redisSet(nonceKey, "used", Math.max(60, Math.ceil((Date.parse(token.expiresAt) - Date.now()) / 1_000)));

  return {
    ...token,
    walletAddress: input.walletAddress,
    message
  };
}

function sign(payload: string) {
  return createHmac("sha256", telegramLinkSecret()).update(payload).digest("base64url");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
