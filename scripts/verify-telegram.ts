import { randomUUID } from "node:crypto";

import { consumeQuota, getQuotaStatus } from "../src/lib/quota";
import { authorizeRequestQuota, consumeRequestQuota, isQuotaIdentityRequiredError } from "../src/lib/request-quota";
import { createReviewSeed, decodeReviewSeed, encodeReviewSeed } from "../src/lib/review-seed";
import { createTelegramLoginToken, decodeTelegramLoginToken, telegramHashForUserId } from "../src/lib/telegram-auth";
import { telegramClarificationTestHooks } from "../src/lib/telegram-bot";
import {
  clearPendingTelegramIntent,
  getPendingTelegramIntent,
  getTelegramSessionByWallet,
  setPendingTelegramIntent,
  upsertTelegramSession
} from "../src/lib/telegram-session";

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

const vaultLpReviewToken = encodeReviewSeed(createReviewSeed({
  source: "telegram",
  message: "Deposit 1 DUSDC to Vault LP",
  modeHint: "vault_lp",
  telegramHash
}));
const vaultLpReviewSeed = decodeReviewSeed(vaultLpReviewToken);

if (vaultLpReviewSeed.modeHint !== "vault_lp") {
  throw new Error("Telegram Vault LP review seed did not preserve modeHint.");
}

const buyBtcMissing = telegramClarificationTestHooks.telegramMissingFields("trade", "buy BTC", []);

if (!buyBtcMissing.includes("amount") || !buyBtcMissing.includes("direction") || !buyBtcMissing.includes("expiry")) {
  throw new Error("Incomplete Telegram trade intent should ask for amount, direction, and expiry.");
}

const partialTradeMissing = telegramClarificationTestHooks.telegramMissingFields("trade", "Bet 1 DUSDC BTC", []);

if (!partialTradeMissing.includes("direction") || !partialTradeMissing.includes("expiry") || partialTradeMissing.includes("amount")) {
  throw new Error("Partial Telegram trade intent should ask only for missing direction/expiry.");
}

const strategyMissing = telegramClarificationTestHooks.telegramMissingFields("strategy", "hedge BTC", []);

if (!strategyMissing.includes("amount") || !strategyMissing.includes("expiry")) {
  throw new Error("Incomplete Telegram strategy intent should ask for budget and expiry plan.");
}

const lpMissing = telegramClarificationTestHooks.telegramMissingFields("vault_lp", "deposit", []);

if (!lpMissing.includes("amount")) {
  throw new Error("Incomplete Telegram Vault LP intent should ask for amount.");
}

const lpReady = telegramClarificationTestHooks.telegramMissingFields("vault_lp", "deposit 1 DUSDC", []);

if (lpReady.length !== 0) {
  throw new Error("Complete Telegram Vault LP intent should not ask clarification.");
}

const clarification = telegramClarificationTestHooks.formatClarificationQuestion("trade", buyBtcMissing);

if (clarification.includes("Review & Sign") || !clarification.includes("How much DUSDC")) {
  throw new Error("Clarification response should ask a question without review link language.");
}

const formattedHtml = telegramClarificationTestHooks.formatTelegramHtml("**BTC** <risk> & data");

if (formattedHtml !== "<b>BTC</b> &lt;risk&gt; &amp; data") {
  throw new Error("Telegram HTML formatter should render safe bold and escape unsafe HTML.");
}

if (!telegramClarificationTestHooks.isStoredVaultLpReplay("do the same trade again with 1 dUSDC", "last trade shape: vault_lp deposit 1 DUSDC")) {
  throw new Error("Telegram should recognize same-trade replay when memory stores Vault LP.");
}

if (telegramClarificationTestHooks.isStoredVaultLpReplay("do the same trade again with 1 dUSDC", "last trade shape: BTC DOWN 1 DUSDC")) {
  throw new Error("Telegram should not treat non-LP memory as Vault LP replay.");
}

const mergedIntent = telegramClarificationTestHooks.mergePendingIntentText({
  mode: "trade",
  originalText: "Bet 1 DUSDC BTC",
  missing: ["direction", "expiry"],
  createdAt: new Date().toISOString()
}, "DOWN nearest settlement");

if (!mergedIntent.includes("Clarification: DOWN nearest settlement")) {
  throw new Error("Pending Telegram intent should merge user clarification.");
}

await setPendingTelegramIntent(telegramHash, {
  mode: "trade",
  originalText: "Bet 1 DUSDC BTC",
  missing: ["direction", "expiry"],
  createdAt: new Date().toISOString()
});

const pendingIntent = await getPendingTelegramIntent(telegramHash);

if (pendingIntent?.mode !== "trade" || pendingIntent.originalText !== "Bet 1 DUSDC BTC") {
  throw new Error("Pending Telegram intent was not stored.");
}

await clearPendingTelegramIntent(telegramHash);

if (await getPendingTelegramIntent(telegramHash)) {
  throw new Error("Pending Telegram intent was not cleared.");
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

try {
  await consumeRequestQuota({ profileId });
  throw new Error("Quota identity check trusted a bare profile id.");
} catch (error) {
  if (!isQuotaIdentityRequiredError(error)) {
    throw error;
  }
}

const authorized = await authorizeRequestQuota({
  profileId,
  walletAddress: walletB
}, {
  consume: false
});

if (authorized.identity?.profileId !== profileId || authorized.quota) {
  throw new Error("Quota authorization did not resolve the wallet session without consuming quota.");
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
  vaultLpMode: vaultLpReviewSeed.modeHint,
  quotaUsed: status.used,
  quotaLimit: status.limit,
  source: status.source
});
