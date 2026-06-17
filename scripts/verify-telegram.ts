import { randomUUID } from "node:crypto";

import { consumeQuota, getQuotaStatus } from "../src/lib/quota";
import { consumeRequestQuota, isQuotaIdentityRequiredError } from "../src/lib/request-quota";
import { createReviewSeed, decodeReviewSeed, encodeReviewSeed } from "../src/lib/review-seed";
import { createTelegramLoginToken, decodeTelegramLoginToken, telegramHashForUserId } from "../src/lib/telegram-auth";
import { getTelegramSessionByWallet, upsertTelegramSession } from "../src/lib/telegram-session";

process.env.UPSTASH_REDIS_REST_URL = "";
process.env.UPSTASH_REDIS_REST_TOKEN = "";
process.env.QUOTA_V1_DAILY_LIMIT = "50";
process.env.DEEP_PILOT_ALLOW_ANON_AI = "";

const telegramHash = telegramHashForUserId("123456");
const loginToken = createTelegramLoginToken({ telegramUserId: "123456", chatId: "654321" });
const decodedLogin = decodeTelegramLoginToken(loginToken);

if (decodedLogin.telegramHash !== telegramHash) {
  throw new Error("Telegram login token hash mismatch.");
}

const reviewToken = encodeReviewSeed(createReviewSeed({
  source: "telegram",
  message: "Bet 1 DUSDC BTC DOWN nearest expiry",
  modeHint: "trade",
  telegramHash
}));
const reviewSeed = decodeReviewSeed(reviewToken);

if (reviewSeed.source !== "telegram" || reviewSeed.telegramHash !== telegramHash) {
  throw new Error("Telegram review seed did not round-trip.");
}

const profileId = `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`;

try {
  await consumeRequestQuota({});
  throw new Error("Quota identity check allowed an anonymous request.");
} catch (error) {
  if (!isQuotaIdentityRequiredError(error)) {
    throw error;
  }
}

const walletA = `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`;
const walletB = `0x${randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`;
await upsertTelegramSession({
  telegramHash,
  chatId: "654321",
  walletAddress: walletA,
  profileId
});
await upsertTelegramSession({
  telegramHash,
  chatId: "654321",
  walletAddress: walletB,
  profileId
});

if (await getTelegramSessionByWallet(walletA)) {
  throw new Error("Old wallet reverse session index was not cleared.");
}

const walletSession = await getTelegramSessionByWallet(walletB);

if (walletSession?.profileId !== profileId) {
  throw new Error("New wallet reverse session index was not written.");
}

for (let index = 0; index < 50; index += 1) {
  const quota = await consumeQuota(profileId);

  if (!quota.allowed) {
    throw new Error(`Quota blocked too early at ${index + 1}.`);
  }
}

const blocked = await consumeQuota(profileId);

if (blocked.allowed) {
  throw new Error("Quota did not block the 51st request.");
}

const status = await getQuotaStatus(profileId);

if (status.remaining !== 0 || status.limit !== 50) {
  throw new Error("Quota status did not report exhausted state.");
}

console.log("telegram smoke ok", {
  telegramHash: telegramHash.slice(0, 12),
  reviewMode: reviewSeed.modeHint,
  quotaUsed: status.used,
  quotaLimit: status.limit,
  source: status.source
});
