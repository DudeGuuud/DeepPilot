import { createHmac, timingSafeEqual } from "node:crypto";

import { reviewSeedSecret } from "./deep-pilot-config";
import type { ReviewSeed } from "./types";

const REVIEW_SEED_TTL_MS = 10 * 60_000;

type EncodedSeedPayload = {
  version: 1;
  seed: ReviewSeed;
};

export function createReviewSeed(input: {
  source: ReviewSeed["source"];
  message: string;
  conversationSummary?: string | null;
  modeHint?: ReviewSeed["modeHint"];
  telegramHash?: string;
  ttlMs?: number;
}): ReviewSeed {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + (input.ttlMs ?? REVIEW_SEED_TTL_MS));

  return {
    source: input.source,
    message: input.message,
    conversationSummary: input.conversationSummary ?? null,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    modeHint: input.modeHint,
    telegramHash: input.telegramHash
  };
}

export function encodeReviewSeed(seed: ReviewSeed) {
  const payload = base64UrlEncode(JSON.stringify({ version: 1, seed } satisfies EncodedSeedPayload));
  const signature = sign(payload);

  return `${payload}.${signature}`;
}

export function decodeReviewSeed(token: string): ReviewSeed {
  const [payload, signature, extra] = token.split(".");

  if (!payload || !signature || extra) {
    throw new Error("Invalid review seed token.");
  }

  const expected = sign(payload);

  if (!safeEqual(signature, expected)) {
    throw new Error("Review seed token signature is invalid.");
  }

  const parsed = JSON.parse(base64UrlDecode(payload)) as EncodedSeedPayload;

  if (parsed.version !== 1 || !parsed.seed?.message) {
    throw new Error("Review seed token payload is invalid.");
  }

  if (Date.parse(parsed.seed.expiresAt) <= Date.now()) {
    throw new Error("Review seed token has expired.");
  }

  return parsed.seed;
}

function sign(payload: string) {
  return createHmac("sha256", reviewSeedSecret()).update(payload).digest("base64url");
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
