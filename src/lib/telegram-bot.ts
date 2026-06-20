import { compileIntent } from "./compile";
import { appBaseUrl } from "./deep-pilot-config";
import { createReviewSeed, encodeReviewSeed } from "./review-seed";
import { consumeQuota, getQuotaStatus } from "./quota";
import { buildRagContext, streamRagAnswer } from "./rag";
import { classifyPilotInput } from "./pilot";
import { getActivePredictMarketContext } from "./predict";
import { compileStrategy } from "./strategy";
import { createTelegramLoginToken, telegramHashForUserId, telegramLoginUrl } from "./telegram-auth";
import {
  clearPendingTelegramIntent,
  clearTelegramMemoryFallback,
  getPendingTelegramIntent,
  getTelegramSession,
  setPendingTelegramIntent,
  upsertTelegramSession
} from "./telegram-session";
import { memoryContextText, readAgentMemory, writeAgentMemory } from "./memory";
import { compileVaultLpIntent, getVaultLpSummary } from "./vault-lp";
import type { CompileResult, PendingTelegramIntent, StrategyReview, TelegramSession, VaultLpReview } from "./types";

type TelegramInlineButton = {
  text: string;
  url?: string;
  callback_data?: string;
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
  callback_query?: {
    id?: string;
    data?: string;
    message?: TelegramMessage;
    from?: {
      id?: number | string;
    };
  };
};

type TelegramButtonRows = TelegramInlineButton[] | TelegramInlineButton[][];
type ClarifiableMode = PendingTelegramIntent["mode"];

const TELEGRAM_SUGGESTIONS = [
  {
    id: "news_btc",
    label: "News BTC",
    command: "/news BTC market news and risk context"
  },
  {
    id: "markets",
    label: "Active markets",
    command: "/markets"
  },
  {
    id: "trade_up",
    label: "Trade UP 1 DUSDC",
    command: "/trade Bet 1 DUSDC on BTC UP at the nearest settlement"
  },
  {
    id: "trade_down",
    label: "Trade DOWN 1 DUSDC",
    command: "/trade Bet 1 DUSDC on BTC DOWN at the nearest settlement"
  },
  {
    id: "hedge_up",
    label: "Hedge mostly UP",
    command: "/strategy Build a 1 DUSDC hedge strategy, mostly BTC UP, nearest settlement"
  },
  {
    id: "hedge_down",
    label: "Hedge mostly DOWN",
    command: "/strategy Build a 1 DUSDC hedge strategy, mostly BTC DOWN, nearest settlement"
  },
  {
    id: "split_up",
    label: "Split UP ladder",
    command: "/strategy Split 1 DUSDC BTC UP across nearest, 1h, and 2h expiries"
  },
  {
    id: "split_down",
    label: "Split DOWN ladder",
    command: "/strategy Split 1 DUSDC BTC DOWN across nearest, 1h, and 2h expiries"
  },
  {
    id: "lp_deposit",
    label: "Deposit Vault LP",
    command: "/lp deposit 1 DUSDC"
  },
  {
    id: "lp_withdraw",
    label: "Withdraw Vault LP",
    command: "/lp withdraw 1 DUSDC"
  },
  {
    id: "lp_status",
    label: "Vault LP status",
    command: "/lp"
  }
] as const;

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query);
    return;
  }

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

  if (text === "/login") {
    await sendLogin(chatId, userId);
    return;
  }

  const session = await getTelegramSession(telegramHash);

  if (text === "/start") {
    if (session?.walletAddress && session.profileId) {
      await sendWelcome(chatId, session);
    } else if (session?.walletAddress) {
      await sendCreateProfile(chatId, userId);
    } else {
      await sendLogin(chatId, userId, "Welcome to DeepPilot Telegram.");
    }
    return;
  }

  if (text === "/help") {
    await sendHelp(chatId);
    return;
  }

  if (text === "/ideas" || text === "/examples") {
    await sendIdeas(chatId);
    return;
  }

  if (text === "/plans") {
    await sendPlans(chatId, userId);
    return;
  }

  if (text === "/cancel") {
    await clearPendingTelegramIntent(telegramHash);
    await sendMessage(chatId, "Pending DeepPilot request cancelled.");
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
    await clearPendingTelegramIntent(session.telegramHash);
    await clearTelegramMemoryFallback(session.profileId);
    await sendMessage(chatId, "Redis fallback memory cleared. Walrus Memory uses the Profile-authorized namespace; disable or revoke it from the Web authorization flow when available.");
    return;
  }

  if (!text.startsWith("/")) {
    const pendingIntent = await getPendingTelegramIntent(session.telegramHash);

    if (pendingIntent) {
      await runPendingIntent(chatId, session, pendingIntent, text);
      return;
    }
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

  if (text.startsWith("/lp")) {
    await runVaultLp(chatId, session, text.replace(/^\/lp\s*/i, "").trim());
    return;
  }

  await runNaturalLanguage(chatId, session, text);
}

async function handleTelegramCallback(query: NonNullable<TelegramUpdate["callback_query"]>) {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const data = query.data ?? "";

  if (query.id) {
    await answerCallbackQuery(query.id).catch(() => {});
  }

  if (!chatId || !userId || !data.startsWith("suggest:")) {
    return;
  }

  const command = TELEGRAM_SUGGESTIONS.find((suggestion) => suggestion.id === data.slice("suggest:".length))?.command;

  if (!command) {
    return;
  }

  await handleTelegramUpdate({
    message: {
      chat: { id: chatId },
      from: { id: userId },
      text: command
    }
  });
}

async function runPendingIntent(
  chatId: number | string,
  session: TelegramSession,
  pendingIntent: PendingTelegramIntent,
  clarification: string
) {
  const mergedIntent = mergePendingIntentText(pendingIntent, clarification);

  switch (pendingIntent.mode) {
    case "trade":
      await runTrade(chatId, session, mergedIntent, false);
      return;
    case "strategy":
      await runStrategy(chatId, session, mergedIntent, false);
      return;
    case "vault_lp":
      await runVaultLp(chatId, session, mergedIntent, false);
      return;
  }
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
    if (await askClarificationIfMissing(chatId, session, "trade", text, classification.missing)) {
      return;
    }

    await runTrade(chatId, session, text, false);
    return;
  }

  if (classification.mode === "strategy") {
    if (await askClarificationIfMissing(chatId, session, "strategy", text, classification.missing)) {
      return;
    }

    await runStrategy(chatId, session, text, false);
    return;
  }

  if (classification.mode === "vault_lp") {
    if (await askClarificationIfMissing(chatId, session, "vault_lp", text, classification.missing)) {
      return;
    }

    await runVaultLp(chatId, session, text, false);
    return;
  }

  await runNews(chatId, session, text, false);
}

async function askClarificationIfMissing(
  chatId: number | string,
  session: TelegramSession,
  mode: ClarifiableMode,
  intent: string,
  upstreamMissing: string[]
) {
  const missing = telegramMissingFields(mode, intent, upstreamMissing);

  if (!missing.length) {
    return false;
  }

  await askClarification(chatId, session, mode, intent, missing);
  return true;
}

async function askClarification(
  chatId: number | string,
  session: TelegramSession,
  mode: ClarifiableMode,
  intent: string,
  missing: string[]
) {
  const normalizedMissing = normalizeMissingFields(mode, missing);

  await setPendingTelegramIntent(session.telegramHash, {
    mode,
    originalText: intent,
    missing: normalizedMissing,
    createdAt: new Date().toISOString()
  });
  await sendMessage(chatId, formatClarificationQuestion(mode, normalizedMissing));
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
    lastMarketThesis: summarizeMarketThesis(answer)
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

  const classification = await classifyPilotInput(intent, {
    conversationContext: await sessionConversationContext(session)
  });

  if (await askClarificationIfMissing(chatId, session, "trade", intent, classification.missing)) {
    return;
  }

  const result = await compileIntent(intent, {
    walletAddress: session.walletAddress,
    managerId: session.managerId,
    conversationContext: await sessionConversationContext(session)
  });

  if (result.intent.status === "needs_clarification") {
    await askClarification(chatId, session, "trade", intent, result.intent.missing);
    return;
  }

  const token = encodeReviewSeed(createReviewSeed({
    source: "telegram",
    message: intent,
    modeHint: "trade",
    telegramHash: session.telegramHash
  }));

  await writeAgentMemory(session.profileId!, {
    lastTradeShape: summarizeTradeShape(result)
  });
  await clearPendingTelegramIntent(session.telegramHash);

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
    await sendStrategyGuide(chatId);
    return;
  }

  if (shouldConsumeQuota && !(await consumeQuotaOrReply(chatId, session))) {
    return;
  }

  const classification = await classifyPilotInput(intent, {
    conversationContext: await sessionConversationContext(session)
  });

  if (await askClarificationIfMissing(chatId, session, "strategy", intent, classification.missing)) {
    return;
  }

  const review = await compileStrategy(intent, {
    walletAddress: session.walletAddress,
    managerId: session.managerId,
    conversationContext: await sessionConversationContext(session)
  });

  if (review.plan.missing.length > 0) {
    await askClarification(chatId, session, "strategy", intent, review.plan.missing);
    return;
  }

  const token = encodeReviewSeed(createReviewSeed({
    source: "telegram",
    message: intent,
    modeHint: "strategy",
    telegramHash: session.telegramHash
  }));

  await writeAgentMemory(session.profileId!, {
    lastTradeShape: summarizeStrategyShape(review)
  });
  await clearPendingTelegramIntent(session.telegramHash);

  await sendMessage(chatId, formatStrategyReview(review), [
    { text: "Review Strategy", url: reviewUrl(token) }
  ]);
}

async function runVaultLp(
  chatId: number | string,
  session: TelegramSession,
  intent: string,
  shouldConsumeQuota = true
) {
  if (!intent) {
    const summary = await getVaultLpSummary({ wallet: session.walletAddress });

    await sendMessage(chatId, formatVaultLpSummary(summary), [
      { text: "Deposit 1 DUSDC", callback_data: "suggest:lp_deposit" },
      { text: "Withdraw 1 DUSDC", callback_data: "suggest:lp_withdraw" }
    ]);
    return;
  }

  if (shouldConsumeQuota && !(await consumeQuotaOrReply(chatId, session))) {
    return;
  }

  if (await askClarificationIfMissing(chatId, session, "vault_lp", intent, [])) {
    return;
  }

  const review = await compileVaultLpIntent(intent, {
    wallet: session.walletAddress
  });

  if (review.intent.status === "needs_clarification") {
    await askClarification(chatId, session, "vault_lp", intent, review.intent.missing);
    return;
  }

  const token = encodeReviewSeed(createReviewSeed({
    source: "telegram",
    message: intent,
    modeHint: "vault_lp",
    telegramHash: session.telegramHash
  }));

  await writeAgentMemory(session.profileId!, {
    lastTradeShape: summarizeVaultLpShape(review)
  });
  await clearPendingTelegramIntent(session.telegramHash);

  await sendMessage(chatId, formatVaultLpReview(review), [
    { text: "Review Vault LP", url: vaultLpReviewUrl(token) }
  ]);
}

async function sendLogin(chatId: number | string, userId: number | string, prefix?: string) {
  const token = createTelegramLoginToken({ telegramUserId: userId, chatId });

  await sendMessage(chatId, [
    prefix,
    "You can use DeepPilot as a chat-first Predict assistant after wallet setup.",
    "",
    "Try these after connecting:",
    "- /news BTC",
    "- /markets",
    "- /trade Bet 1 DUSDC on BTC DOWN at the nearest settlement",
    "- /strategy Build a 1 DUSDC hedge strategy, mostly BTC UP, nearest settlement",
    "- /lp deposit 1 DUSDC",
    "",
    "Account setup",
    "1. Tap Connect wallet.",
    "2. Open the Web page and connect your Sui wallet on testnet.",
    "3. Sign the wallet-link message. This proves wallet ownership; Telegram never receives your private key.",
    "4. If prompted, create your DeepPilot Profile NFT.",
    "5. Return here and tap /start to use news, trade, and strategy shortcuts."
  ].filter(Boolean).join("\n"), [
    { text: "Connect wallet", url: telegramLoginUrl(token) }
  ]);
}

async function sendCreateProfile(chatId: number | string, userId: number | string) {
  const token = createTelegramLoginToken({ telegramUserId: userId, chatId });

  await sendMessage(chatId, [
    "Wallet linked.",
    "",
    "Next step: create your DeepPilot Profile NFT.",
    "The Profile stores your plan, quota snapshot, Telegram binding hash, and memory namespace. It does not store your private key or raw Telegram ID.",
    "",
    "After creation, Telegram can generate news summaries, trade reviews, and strategy review links. Wallet signing still happens only in the Web Review page."
  ].join("\n"), [
    { text: "Create Profile", url: telegramLoginUrl(token) }
  ]);
}

async function sendWelcome(chatId: number | string, session: TelegramSession) {
  const quota = await getQuotaStatus(session.profileId!);

  await sendMessage(chatId, [
    "DeepPilot is ready. Feel free to chat with the bot.",
    `Wallet: ${shortAddress(session.walletAddress)}`,
    `Profile NFT: ${shortAddress(session.profileId)}`,
    `Quota: ${quota.remaining}/${quota.limit} left today`,
    "",
    "What you can do now:",
    "1. Ask for BTC news or risk context.",
    "2. Ask for active DeepBook Predict markets.",
    "3. Ask DeepPilot to prepare a trade review.",
    "4. Ask for a multi-leg strategy candidate.",
    "5. Deposit or withdraw Vault LP through a Web Review link.",
    "",
    "Trading never signs inside Telegram. The bot sends a Web Review link, then you confirm with your Sui wallet.",
    "",
    "Tap a shortcut below or send natural language like:",
    "buy 1 DUSDC BTC DOWN nearest settlement"
  ].join("\n"), suggestionButtons());
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

async function sendHelp(chatId: number | string) {
  await sendMessage(chatId, helpText(), suggestionButtons());
}

async function sendIdeas(chatId: number | string) {
  await sendMessage(chatId, [
    "DeepPilot ideas",
    "",
    "Market context:",
    "- /news BTC",
    "- What changed in BTC today?",
    "",
    "Single trade reviews:",
    "- /trade Bet 1 DUSDC on BTC UP at the nearest settlement",
    "- /trade Bet 1 DUSDC on BTC DOWN at the nearest settlement",
    "",
    "Strategy candidates:",
    "- /strategy Build a 1 DUSDC hedge strategy, mostly BTC UP, nearest settlement",
    "- /strategy Split 1 DUSDC BTC DOWN across nearest, 1h, and 2h expiries",
    "",
    "Vault LP:",
    "- /lp",
    "- /lp deposit 1 DUSDC",
    "- /lp withdraw 1 DUSDC",
    "",
    "You can also type these as normal chat messages. Clear trade or strategy intent returns a Web Review link."
  ].join("\n"), suggestionButtons());
}

async function sendStrategyGuide(chatId: number | string) {
  await sendMessage(chatId, [
    "Strategy mode prepares a candidate plan, not investment advice.",
    "",
    "Good examples:",
    "- /strategy Build a 1 DUSDC hedge strategy, mostly BTC UP, nearest settlement",
    "- /strategy Build a 1 DUSDC hedge strategy, mostly BTC DOWN, nearest settlement",
    "- /strategy Split 1 DUSDC BTC UP across nearest, 1h, and 2h expiries",
    "- /strategy Split 1 DUSDC BTC DOWN across nearest, 1h, and 2h expiries",
    "",
    "DeepPilot will return a Web Review link. Wallet signing happens only after live quote, Guardian, Trading Balance, and gas checks."
  ].join("\n"), strategySuggestionButtons());
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
  const source = memory?.source === "memwal" ? "Walrus Memory" : "Redis fallback";

  await sendMessage(chatId, memory
    ? `Memory source: ${source}\n${memoryContextText(memory)}`
    : "No memory yet. Enable Walrus Memory in Profile for portable agent context, or keep using Redis fallback.");
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

function formatVaultLpSummary(summary: Awaited<ReturnType<typeof getVaultLpSummary>>) {
  return [
    "Vault LP",
    `Vault value: ${formatRawDusdc(summary.vault.vault_value)} DUSDC`,
    `Share price: ${summary.vault.plp_share_price.toFixed(6)} DUSDC`,
    `Utilization: ${(summary.vault.utilization * 100).toFixed(2)}%`,
    `Available withdrawal: ${formatRawDusdc(summary.vault.available_withdrawal)} DUSDC`,
    "",
    "Use /lp deposit 1 DUSDC or /lp withdraw 1 DUSDC to prepare a Web Review link."
  ].join("\n");
}

function formatVaultLpReview(review: VaultLpReview) {
  const actionLabel = review.intent.action === "deposit" ? "Deposit to Vault LP" : review.intent.action === "withdraw" ? "Withdraw from Vault LP" : "Vault LP info";

  return [
    actionLabel,
    `Amount: ${formatRawDusdc(review.execution.amountRaw)} DUSDC`,
    `Share price: ${review.summary.vault.plp_share_price.toFixed(6)} DUSDC`,
    review.transactionData?.plpSharesRaw ? `Estimated PLP: ${formatRawDusdc(review.transactionData.plpSharesRaw)} PLP` : null,
    review.transactionData?.estimatedDusdcOutRaw ? `Estimated DUSDC out: ${formatRawDusdc(review.transactionData.estimatedDusdcOutRaw)} DUSDC` : null,
    `Readiness: ${review.execution.canSign ? "ready" : "blocked"}`,
    review.execution.reason,
    "",
    "PLP is a vault share, not fixed yield. Open Web Review to refresh vault state and sign with your wallet."
  ].filter(Boolean).join("\n");
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

function summarizeVaultLpShape(review: VaultLpReview) {
  return `vault_lp ${review.intent.action} ${formatRawDusdc(review.execution.amountRaw)} DUSDC`;
}

function summarizeMarketThesis(answer: string) {
  return answer
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function telegramMissingFields(mode: ClarifiableMode, intent: string, upstreamMissing: string[]) {
  const missing = new Set(normalizeMissingFields(mode, upstreamMissing));

  if (referencesStoredShape(intent)) {
    return [...missing];
  }

  if (mode === "trade") {
    if (!hasCurrencyAmount(intent)) {
      missing.add("amount");
    }

    if (!hasTradeDirection(intent)) {
      missing.add("direction");
    }

    if (!hasExpiryPlan(intent) && !hasObjectId(intent)) {
      missing.add("expiry");
    }
  }

  if (mode === "strategy") {
    if (!hasCurrencyAmount(intent)) {
      missing.add("amount");
    }

    if (!hasStrategyShape(intent)) {
      missing.add("strategy_shape");
    }

    if (!hasStrategyDirection(intent)) {
      missing.add("direction");
    }

    if (!hasExpiryPlan(intent)) {
      missing.add("expiry");
    }
  }

  if (mode === "vault_lp") {
    const infoOnly = /\b(show|check|info|status|performance)\b|查看|看看|表现|信息|状态/.test(intent.toLowerCase());
    const hasAction = /\b(deposit|supply|mint|add|provide|withdraw|remove|exit|redeem)\b|存入|充值|放进|提供|加入|做|取出|赎回|退出/i.test(intent);

    if (!infoOnly && !hasAction) {
      missing.add("action");
    }

    if (!infoOnly && !hasCurrencyAmount(intent)) {
      missing.add("amount");
    }
  }

  return [...missing];
}

function normalizeMissingFields(mode: ClarifiableMode, missing: string[]) {
  const aliases: Record<string, string> = {
    budget: "amount",
    quote: "amount",
    payment: "amount",
    side: "direction",
    expiryPreference: "expiry",
    oracle: "expiry",
    oracleId: "expiry",
    settlement: "expiry",
    method: mode === "vault_lp" ? "action" : "strategy_shape",
    shape: "strategy_shape"
  };

  return [...new Set(missing
    .map((item) => aliases[item] ?? item)
    .filter((item) => item === "amount" || item === "direction" || item === "expiry" || item === "strategy_shape" || item === "action"))];
}

function formatClarificationQuestion(mode: ClarifiableMode, missing: string[]) {
  const questions = missing.map((field) => {
    if (mode === "vault_lp" && field === "action") {
      return "Do you want to deposit to Vault LP or withdraw from Vault LP?";
    }

    if (field === "amount") {
      return mode === "strategy"
        ? "What total budget should DeepPilot allocate? Example: 1 DUSDC."
        : "How much DUSDC do you want to use? Example: 1 DUSDC.";
    }

    if (field === "direction") {
      return mode === "strategy"
        ? "Should the strategy lean UP, DOWN, or market-neutral hedge?"
        : "Which side do you want: BTC UP or BTC DOWN?";
    }

    if (field === "strategy_shape") {
      return "Do you want a hedge, split ladder, or single directional plan?";
    }

    if (field === "expiry") {
      return mode === "strategy"
        ? "Use nearest settlement, 1h/2h/3h ladder, or a specific expiry?"
        : "Which settlement do you want: nearest active, 1h, 2h, or a specific time?";
    }

    return "Please clarify the missing field.";
  });

  return [
    "I need one more detail before creating a Web Review link.",
    ...questions,
    "",
    "Reply with the missing detail, or send /cancel to discard this request."
  ].join("\n");
}

function mergePendingIntentText(pendingIntent: PendingTelegramIntent, clarification: string) {
  return `${pendingIntent.originalText}\nClarification: ${clarification.trim()}`;
}

function hasCurrencyAmount(raw: string) {
  return (
    /(\d+(?:\.\d+)?)\s*(?:d?usdc|usdc|u|\$)/i.test(normalizeCurrencyText(raw)) ||
    /\b(a|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:d?usdc|usdc|u)\b/i.test(raw)
  );
}

function hasTradeDirection(raw: string) {
  return /\b(up|down|call|put|long|short)\b|涨|跌|做多|做空|看涨|看跌/i.test(raw);
}

function hasStrategyDirection(raw: string) {
  return hasTradeDirection(raw) || /\b(market-neutral|neutral|balanced|mostly|overweight)\b|中性|双向|对冲|大头/i.test(raw);
}

function hasStrategyShape(raw: string) {
  return /\b(strategy|hedge|split|ladder|multi-leg|multi leg|single directional|directional)\b|策略|对冲|分批|阶梯|多笔|多腿|一小时|两小时|二小时|三小时|1h|2h|3h|1小时|2小时|3小时/i.test(raw);
}

function hasExpiryPlan(raw: string) {
  return /\b(next|nearest|fastest|earliest|settlement|expiry|today|tonight|tomorrow|1h|2h|3h|one hour|two hour|three hour|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2})\b|最近|最快|结算|到期|今天|今晚|明天|一小时|两小时|二小时|三小时|[0-2]?\d点/i.test(raw);
}

function hasObjectId(raw: string) {
  return /0x[a-fA-F0-9]{16,64}/.test(raw);
}

function referencesStoredShape(raw: string) {
  return /\b(same|repeat|again|last time|previous|as before)\b|跟上一次|和上次一样|照旧|同样/i.test(raw);
}

function normalizeCurrencyText(raw: string) {
  return raw.replace(/([a-z])\s+(?=[a-z])/gi, "$1");
}

function reviewUrl(token: string) {
  return `${appBaseUrl().replace(/\/$/, "")}/trade?review=${encodeURIComponent(token)}`;
}

function vaultLpReviewUrl(token: string) {
  return `${appBaseUrl().replace(/\/$/, "")}/vault-lp?review=${encodeURIComponent(token)}`;
}

function sourceLine(titles: string[]) {
  return titles.length ? `Sources: ${titles.join(" · ")}` : "Sources: Predict data and local docs.";
}

function helpText() {
  return [
    "DeepPilot commands",
    "",
    "Setup",
    "/login - connect wallet",
    "/start - show shortcuts and account state",
    "/ideas - prompt examples and shortcuts",
    "/profile - profile and quota",
    "/plans - Standard / Pro / Max",
    "/quota - remaining daily AI quota",
    "",
    "Market and execution",
    "/markets - active BTC Predict markets",
    "/news BTC - market news and risk context",
    "/trade <intent> - create Web Review link",
    "/strategy <intent> - create multi-leg Web Review link",
    "/lp - Vault LP summary",
    "/lp deposit 1 DUSDC - create Vault LP deposit review",
    "/lp withdraw 1 DUSDC - create Vault LP withdraw review",
    "/memory - show Walrus or fallback memory",
    "/forget - clear Redis fallback memory",
    "",
    "Natural language also works. If your message is a clear buy/bet/open-position intent, the bot compiles a fresh Predict review and returns a Web Review & Sign link."
  ].join("\n");
}

function suggestionButtons(): TelegramInlineButton[][] {
  return chunkButtons(TELEGRAM_SUGGESTIONS.map((suggestion) => ({
    text: suggestion.label,
    callback_data: `suggest:${suggestion.id}`
  })), 2);
}

function strategySuggestionButtons(): TelegramInlineButton[][] {
  return chunkButtons(TELEGRAM_SUGGESTIONS
    .filter((suggestion) => suggestion.id.startsWith("hedge_") || suggestion.id.startsWith("split_") || suggestion.id.startsWith("trade_") || suggestion.id === "news_btc" || suggestion.id === "markets")
    .map((suggestion) => ({
      text: suggestion.label,
      callback_data: `suggest:${suggestion.id}`
    })), 2);
}

function chunkButtons(buttons: TelegramInlineButton[], size: number): TelegramInlineButton[][] {
  const rows: TelegramInlineButton[][] = [];

  for (let index = 0; index < buttons.length; index += size) {
    rows.push(buttons.slice(index, index + size));
  }

  return rows;
}

async function sendMessage(chatId: number | string, text: string, buttons: TelegramButtonRows = []) {
  const inlineKeyboard = normalizeButtonRows(buttons);

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: truncate(text, 3900),
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard.length
      ? { inline_keyboard: inlineKeyboard }
      : undefined
  });
}

async function answerCallbackQuery(callbackQueryId: string) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId
  });
}

function normalizeButtonRows(buttons: TelegramButtonRows): TelegramInlineButton[][] {
  if (!buttons.length) {
    return [];
  }

  return Array.isArray(buttons[0])
    ? buttons as TelegramInlineButton[][]
    : [buttons as TelegramInlineButton[]];
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

function formatRawDusdc(value: string | number | bigint | null | undefined) {
  const raw = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? BigInt(Math.trunc(value))
      : typeof value === "string" && /^\d+$/.test(value)
        ? BigInt(value)
        : null;

  if (raw === null) {
    return "--";
  }

  return (Number(raw) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  });
}

function shortAddress(value: string | null | undefined) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "--";
}

export const telegramClarificationTestHooks = {
  telegramMissingFields,
  formatClarificationQuestion,
  mergePendingIntentText
};
