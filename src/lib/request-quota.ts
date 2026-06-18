import { allowAnonymousAiRequests } from "./deep-pilot-config";
import { consumeQuota } from "./quota";
import { getTelegramSession, getTelegramSessionByWallet } from "./telegram-session";
import type { QuotaStatus, TelegramSession } from "./types";

type RequestQuotaInput = {
  profileId?: string | null;
  telegramHash?: string | null;
  walletAddress?: string | null;
};

export type RequestQuotaIdentity = {
  profileId: string;
  session: TelegramSession;
  source: "telegram" | "wallet";
};

export type RequestQuotaAuthorization = {
  identity: RequestQuotaIdentity | null;
  quota: QuotaStatus | null;
};

export class QuotaIdentityRequiredError extends Error {
  constructor() {
    super("Connect a wallet with a DeepPilot Profile before using AI quota.");
    this.name = "QuotaIdentityRequiredError";
  }
}

export class QuotaIdentityMismatchError extends Error {
  constructor(message = "Connected wallet does not match the DeepPilot Profile session.") {
    super(message);
    this.name = "QuotaIdentityMismatchError";
  }
}

export async function authorizeRequestQuota(
  input: RequestQuotaInput,
  options: { consume?: boolean } = {}
): Promise<RequestQuotaAuthorization> {
  const identity = await resolveRequestQuotaIdentity(input);
  const shouldConsume = options.consume ?? true;

  return {
    identity,
    quota: identity && shouldConsume ? await consumeQuota(identity.profileId) : null
  };
}

export async function consumeRequestQuota(input: RequestQuotaInput): Promise<QuotaStatus | null> {
  return (await authorizeRequestQuota(input, { consume: true })).quota;
}

export async function resolveRequestQuotaIdentity(input: RequestQuotaInput): Promise<RequestQuotaIdentity | null> {
  const profileId = input.profileId?.trim() || null;
  const telegramHash = input.telegramHash?.trim() || null;
  const walletAddress = input.walletAddress?.trim().toLowerCase() || null;

  if (profileId && !telegramHash && !walletAddress) {
    if (allowAnonymousAiRequests()) {
      return null;
    }

    throw new QuotaIdentityRequiredError();
  }

  const byTelegram = telegramHash ? await getTelegramSession(telegramHash) : null;
  const byWallet = walletAddress ? await getTelegramSessionByWallet(walletAddress) : null;
  const session = byTelegram ?? byWallet;

  if (!session?.profileId) {
    if (allowAnonymousAiRequests()) {
      return null;
    }

    throw new QuotaIdentityRequiredError();
  }

  if (telegramHash && session.telegramHash !== telegramHash) {
    throw new QuotaIdentityMismatchError("Telegram session does not match this quota request.");
  }

  if (walletAddress && session.walletAddress?.toLowerCase() !== walletAddress) {
    throw new QuotaIdentityMismatchError("Connected wallet does not match the DeepPilot Profile session.");
  }

  if (profileId && session.profileId.toLowerCase() !== profileId.toLowerCase()) {
    throw new QuotaIdentityMismatchError("Profile NFT does not match this quota request.");
  }

  return {
    profileId: session.profileId,
    session,
    source: byTelegram ? "telegram" : "wallet"
  };
}

export function quotaIdentityErrorStatus(error: unknown) {
  if (error instanceof QuotaIdentityMismatchError) {
    return 403;
  }

  return 401;
}

export function isQuotaIdentityRequiredError(error: unknown) {
  return error instanceof QuotaIdentityRequiredError || error instanceof QuotaIdentityMismatchError;
}
