import { compileIntent } from "./compile";
import { appBaseUrl } from "./deep-pilot-config";
import { createReviewSeed, encodeReviewSeed } from "./review-seed";
import { consumeQuota, getQuotaStatus } from "./quota";
import { buildRagContext, streamRagAnswer } from "./rag";
import { classifyPilotInput } from "./pilot";
import { getActivePredictMarketContext } from "./predict";
import { compileStrategy } from "./strategy";
import { createTelegramLoginToken, telegramHashForUserId, telegramLoginUrl } from "./telegram-auth";
import { clearTelegramMemoryFallback, getTelegramSession, upsertTelegramSession } from "./telegram-session";
import { memoryContextText, readAgentMemory, writeAgentMemory } from "./memory";
import type { CompileResult, StrategyReview, TelegramSession } from "./types";

type TelegramInlineButton = {
  text: string;
  url?: string;
};

type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat?: {
    id?: number | string;
  };
  from?: {
    id?: number | string;
  };
};

type TelegramUpdate = {
  message?: TelegramMessage;
};

export async function handleTelegramUpdate(update: TelegramUpdate) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  const text = message?.text?.trim();

  if (!chatId || !userId || !text) {
    return;
  }

  const telegramHash = telegramHashForUserId(userId);
  await upsertTelegramSession({
    telegramHash,
    chatId: String(chatId)
  });

  if (text === "/start" || text === "/login") {
    await sendLogin(chatId, userId);
    return;
  }

  if (text === "/help") {
    await sendMessage(chatId, helpText());
    return;
  }

  const session = await getTelegramSession(telegramHash);

  if (text === "/plans") {
    await sendPlans(chatId, userId);
    return;
  }

  if (!session?.walletAddress) {
    await sendLogin(chatId, userId, "Connect your wallet before using DeepPilot in Telegram.");
    return;
  }

  if (!session.profileId) {
    await sendCreateProfile(chatId, userId);
    return;
  }

  if (text === "/profile") {
    await sendProfile(chatId, session);
    return;
  }

  if (text === "/quota") {
    await sendQuota(chatId, session);
    return;
  }

  if (text === "/memory") {
    await sendMemory(chatId, session);
    return;
  }

  if (text === "/forget") {
    await clearTelegramMemoryFallback(session.profileId);
    await sendMessage(chatId, "Local fallback memory cleared. Walrus Memory deletion requires Web authorization.");
    return;
  }

  if (text === "/markets") {
    await sendMarkets(chatId);
    return;
  }

  if (text.startsWith("/news")) {
    await runNews(chatId, session, text.replace(/^\/news\s*/i, "").trim() || "BTC");
    return;
  }

  if (text.startsWith("/trade")) {
    await runTrade(chatId, session, text.replace(/^\/trade\s*/i, "").trim());
    return;
  }

  if (text.startsWith("/strategy")) {
    await runStrategy(chatId, session, text.replace(/^\/strategy\s*/i, "").trim());
    return;
  }

  await runNaturalLanguage(chatId, session, text);
}

async function runNaturalLanguage(chatId: number | string, session: TelegramSession, text: string) {
  const quota = await consumeQuotaOrReply(chatId, session);

  if (!quota) {
    return;
  }

  const memory = memoryContextText(await readAgentMemory(session.profileId!));
  const classification = await classifyPilotInput(text, {
    conversationContext: memory ? { messages: [], memoryContext: memory } : null
  });

  if (classification.mode === "trade") {
    await runTrade(chatId, session, text, false);
    return;
  }

  if (classification.mode === "strategy") {
    await runStrategy(chatId, session, text, false);
    return;
  }

  await runNews(chatId, session, text, false);
}

async function runNews(
  chatId: number | string,
  session: TelegramSession,
  query: string,
  shouldConsumeQuota = true
) {
  if (shouldConsumeQuota && !(await consumeQuotaOrReply(chatId, session))) {
    return;
  }

  const classification = await classifyPilotInput(query);
  const context = await buildRagContext(query, classification);
  let answer = "";
  await streamRagAnswer({
    input: query,
    classification,
    sources: context.sources,
    onDelta: (delta) => {
      answer += delta;
    }
  });

  await writeAgentMemory(session.profileId!, {
    lastMarketThesis: answer.slice(0, 600)
  });

  await sendMessage(chatId, [
    truncate(answer, 2600),
    "",
    sourceLine(context.sources.map((source) => source.title).slice(0, 4))
  ].join("\n"));
}

async function runTrade(
  chatId: number | string,
  session: TelegramSession,
  intent: string,
  shouldConsumeQuota = true
) {
  if (!intent) {
    await sendMessage(chatId, "Usage: /trade Bet 1 DUSDC BTC DOWN nearest expiry");
    return;
  }

  if (shouldConsumeQuota && !(await consumeQuotaOrReply(chatId, session))) {
    return;
  }

  const result = await compileIntent(intent, {
    walletAddress: session.walletAddress,
    managerId: session.managerId,
    conversationContext: await sessionConversationContext(session)
  });
  const token = encodeReviewSeed(createReviewSeed({
    source: "telegram",
    message: intent,
    modeHint: "trade",
    telegramHash: session.telegramHash
  }));

  await writeAgentMemory(session.profileId!, {
    lastTradeShape: summarizeTradeShape(result)
  });

  await sendMessage(chatId, formatTradeReview(result), [
    { text: "Review & Sign", url: reviewUrl(token) }
  ]);
}

async function runStrategy(
  chatId: number | string,
  session: TelegramSession,
  intent: string,
  shouldConsumeQuota = true
) {
  if (!intent) {
    await sendMessage(chatId, "Usage: /strategy hedge BTC nearest settlement 1 DUSDC mostly UP");
    return;
  }

  if (shouldConsumeQuota && !(await consumeQuotaOrReply(chatId, session))) {
    return;
  }

  const review = await compileStrategy(intent, {
    walletAddress: session.walletAddress,
    managerId: session.managerId,
    conversationContext: await sessionConversationContext(session)
  });
  const token = encodeReviewSeed(createReviewSeed({
    source: "telegram",
    message: intent,
    modeHint: "strategy",
    telegramHash: session.telegramHash
  }));

  await writeAgentMemory(session.profileId!, {
    lastTradeShape: summarizeStrategyShape(review)
  });

  await sendMessage(chatId, formatStrategyReview(review), [
    { text: "Review Strategy", url: reviewUrl(token) }
  ]);
}

async function sendLogin(chatId: number | string, userId: number | string, prefix?: string) {
  const token = createTelegramLoginToken({ telegramUserId: userId, chatId });

  await sendMessage(chatId, [
    prefix,
    "Open DeepPilot and sign the wallet link challenge. Telegram never receives your private key."
  ].filter(Boolean).join("\n"), [
    { text: "Connect wallet", url: telegramLoginUrl(token) }
  ]);
}

async function sendCreateProfile(chatId: number | string, userId: number | string) {
  const token = createTelegramLoginToken({ telegramUserId: userId, chatId });

  await sendMessage(chatId, "Wallet linked. Create your DeepPilot Profile NFT before using AI quota or Telegram trade review.", [
    { text: "Create Profile", url: telegramLoginUrl(token) }
  ]);
}

async function sendPlans(chatId: number | string, userId: number | string) {
  const token = createTelegramLoginToken({ telegramUserId: userId, chatId });

  await sendMessage(chatId, [
    "Plans",
    "Standard: 10/day",
    "Pro: 50/day · 0.1 SUI/month",
    "Max: 100/day · 0.1 SUI/month",
    "",
    "Demo quota: 50 messages/day for all plans in v1."
  ].join("\n"), [
    { text: "Open Plans", url: `${telegramLoginUrl(token)}&plans=1` }
  ]);
}

async function sendProfile(chatId: number | string, session: TelegramSession) {
  const quota = await getQuotaStatus(session.profileId!);

  await sendMessage(chatId, [
    "DeepPilot Profile",
    `Wallet: ${shortAddress(session.walletAddress)}`,
    `Profile NFT: ${shortAddress(session.profileId)}`,
    `PredictManager: ${shortAddress(session.managerId)}`,
    `Plan: ${session.plan}`,
    `Quota: ${quota.remaining}/${quota.limit} left today`
  ].join("\n"));
}

async function sendQuota(chatId: number | string, session: TelegramSession) {
  const quota = await getQuotaStatus(session.profileId!);

  await sendMessage(chatId, `Quota: ${quota.remaining}/${quota.limit} left today. Reset: ${quota.resetAt}.`);
}

async function sendMemory(chatId: number | string, session: TelegramSession) {
  const memory = await readAgentMemory(session.profileId!);

  await sendMessage(chatId, memory
    ? `Memory fallback:\n${memoryContextText(memory)}`
    : "No local fallback memory yet. Walrus Memory is used only when configured and authorized.");
}

async function sendMarkets(chatId: number | string) {
  const context = await getActivePredictMarketContext();
  const lines = context.markets.slice(0, 5).map((market, index) =>
    `${index + 1}. ${market.isEarliestActive ? "earliest " : ""}${market.oracleId.slice(0, 10)}... · ${market.expiryIso}`
  );

  await sendMessage(chatId, lines.length ? `Active BTC Predict markets:\n${lines.join("\n")}` : "No active BTC Predict market right now.");
}

async function consumeQuotaOrReply(chatId: number | string, session: TelegramSession) {
  const quota = await consumeQuota(session.profileId!);

  if (!quota.allowed) {
    await sendMessage(chatId, `Daily AI quota exhausted. Reset: ${quota.resetAt}.`, [
      { text: "Open Plans", url: `${appBaseUrl().replace(/\/$/, "")}/profile?plans=1` }
    ]);
    return null;
  }

  return quota;
}

async function sessionConversationContext(session: TelegramSession) {
  const memory = memoryContextText(await readAgentMemory(session.profileId!));

  return memory ? { messages: [], memoryContext: memory } : null;
}

function formatTradeReview(result: CompileResult) {
  const quote = result.quote;
  const execution = result.ptb?.execution;
  const outcome = quote?.direction ? `BTC ${quote.direction.toUpperCase()}` : "Predict position";

  return [
    "Trade review",
    `Outcome: ${outcome}`,
    `Estimated payment: ${formatDusdc(quote?.estimatedCostDusdc)}`,
    `Max payout: ${formatDusdc(quote?.maxPayoutDusdc)}`,
    `Expiry: ${quote?.expiry ? new Date(quote.expiry).toLocaleString("en-US", { timeZone: "Asia/Shanghai" }) : "--"}`,
    `Guardian: ${result.guardian.decision.toUpperCase()}`,
    `Funding: ${execution?.fundingStatus ?? "unknown"}`,
    "",
    "Open Web Review to refresh quote, checks, and sign with your wallet."
  ].join("\n");
}

function formatStrategyReview(review: StrategyReview) {
  const legs = review.compiledLegs.map((leg, index) => {
    const quote = leg.result?.quote;
    return `${index + 1}. ${leg.leg.direction?.toUpperCase() ?? "--"} · ${formatDusdc(quote?.estimatedCostDusdc)} pay · ${leg.status}`;
  });

  return [
    "Strategy candidate",
    review.plan.thesis,
    "",
    legs.join("\n") || "No legs generated.",
    "",
    `Payment: ${formatDusdc(review.aggregateReadiness.estimatedPaymentDusdc)}`,
    `Funding: ${review.aggregateReadiness.fundingStatus}`,
    "Candidate plan, not investment advice. Open Web Review before signing."
  ].join("\n");
}

function summarizeTradeShape(result: CompileResult) {
  const quote = result.quote;

  return [
    "predict_binary_mint",
    quote?.direction ? `BTC ${quote.direction.toUpperCase()}` : null,
    quote?.expiry ? `expiry ${quote.expiry}` : null,
    quote?.estimatedCostDusdc ? `payment ${quote.estimatedCostDusdc} DUSDC` : null
  ].filter(Boolean).join(" · ");
}

function summarizeStrategyShape(review: StrategyReview) {
  return review.compiledLegs.map((leg) =>
    `${leg.leg.direction?.toUpperCase() ?? "UP"} ${leg.leg.amountDusdc ?? "?"} DUSDC ${leg.leg.expiryPreference}`
  ).join(" | ");
}

function reviewUrl(token: string) {
  return `${appBaseUrl().replace(/\/$/, "")}/trade?review=${encodeURIComponent(token)}`;
}

function sourceLine(titles: string[]) {
  return titles.length ? `Sources: ${titles.join(" · ")}` : "Sources: Predict data and local docs.";
}

function helpText() {
  return [
    "DeepPilot commands",
    "/login - connect wallet",
    "/profile - profile and quota",
    "/plans - Standard / Pro / Max",
    "/quota - remaining daily AI quota",
    "/markets - active BTC Predict markets",
    "/news BTC - market news and risk context",
    "/trade <intent> - create Web Review link",
    "/strategy <intent> - create multi-leg Web Review link",
    "/memory - show fallback memory",
    "/forget - clear fallback memory"
  ].join("\n");
}

async function sendMessage(chatId: number | string, text: string, buttons: TelegramInlineButton[] = []) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: truncate(text, 3900),
    disable_web_page_preview: true,
    reply_markup: buttons.length
      ? { inline_keyboard: [buttons] }
      : undefined
  });
}

async function telegramApi(method: string, payload: Record<string, unknown>) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with ${response.status}.`);
  }
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function formatDusdc(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(4)} DUSDC` : "--";
}

function shortAddress(value: string | null | undefined) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "--";
}
