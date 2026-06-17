import { redisDelete, redisGetJson, redisSetJson } from "./redis-store";
import type { DeepPilotPlanName, TelegramSession } from "./types";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function getTelegramSession(telegramHash: string) {
  return await redisGetJson<TelegramSession>(sessionKey(telegramHash));
}

export async function getTelegramSessionByWallet(walletAddress: string) {
  const telegramHash = await redisGetJson<string>(walletSessionKey(walletAddress.toLowerCase()));

  return telegramHash ? await getTelegramSession(telegramHash) : null;
}

export async function upsertTelegramSession(input: {
  telegramHash: string;
  chatId: string;
  walletAddress?: string | null;
  profileId?: string | null;
  managerId?: string | null;
  plan?: DeepPilotPlanName;
  memoryNamespace?: string | null;
}) {
  const existing = await getTelegramSession(input.telegramHash);
  const now = new Date().toISOString();
  const session: TelegramSession = {
    telegramHash: input.telegramHash,
    chatId: input.chatId,
    walletAddress: input.walletAddress ?? existing?.walletAddress ?? null,
    profileId: input.profileId ?? existing?.profileId ?? null,
    managerId: input.managerId ?? existing?.managerId ?? null,
    plan: input.plan ?? existing?.plan ?? "standard",
    memoryNamespace: input.memoryNamespace ?? existing?.memoryNamespace ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const previousWallet = existing?.walletAddress?.toLowerCase() ?? null;
  const nextWallet = session.walletAddress?.toLowerCase() ?? null;
  const previousProfile = existing?.profileId ?? null;
  const nextProfile = session.profileId ?? null;

  if (previousWallet && previousWallet !== nextWallet) {
    await redisDelete(walletSessionKey(previousWallet));
  }

  if (previousProfile && previousProfile !== nextProfile) {
    await redisDelete(profileSessionKey(previousProfile));
  }

  await redisSetJson(sessionKey(input.telegramHash), session, SESSION_TTL_SECONDS);

  if (session.walletAddress) {
    await redisSetJson(walletSessionKey(session.walletAddress.toLowerCase()), input.telegramHash, SESSION_TTL_SECONDS);
  }

  if (session.profileId) {
    await redisSetJson(profileSessionKey(session.profileId), input.telegramHash, SESSION_TTL_SECONDS);
  }

  return session;
}

export async function clearTelegramMemoryFallback(profileId: string) {
  await redisDelete(`memory:last:${profileId}`);
}

export function sessionKey(telegramHash: string) {
  return `tg:session:${telegramHash}`;
}

export function walletSessionKey(walletAddress: string) {
  return `wallet:profile:${walletAddress}`;
}

export function profileSessionKey(profileId: string) {
  return `profile:telegram:${profileId}`;
}
