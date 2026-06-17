import { allowAnonymousAiRequests } from "./deep-pilot-config";
import { consumeQuota } from "./quota";
import { getTelegramSession, getTelegramSessionByWallet } from "./telegram-session";
import type { QuotaStatus } from "./types";

export class QuotaIdentityRequiredError extends Error {
  constructor() {
    super("Connect a wallet with a DeepPilot Profile before using AI quota.");
    this.name = "QuotaIdentityRequiredError";
  }
}

export async function consumeRequestQuota(input: {
  profileId?: string | null;
  telegramHash?: string | null;
  walletAddress?: string | null;
}): Promise<QuotaStatus | null> {
  const directProfile = input.profileId?.trim();

  if (directProfile) {
    return await consumeQuota(directProfile);
  }

  const telegramHash = input.telegramHash?.trim();

  if (!telegramHash) {
    const walletAddress = input.walletAddress?.trim();

    if (walletAddress) {
      const session = await getTelegramSessionByWallet(walletAddress);

      if (session?.profileId) {
        return await consumeQuota(session.profileId);
      }
    }

    if (allowAnonymousAiRequests()) {
      return null;
    }

    throw new QuotaIdentityRequiredError();
  }

  const session = await getTelegramSession(telegramHash);

  if (!session?.profileId) {
    if (allowAnonymousAiRequests()) {
      return null;
    }

    throw new QuotaIdentityRequiredError();
  }

  return await consumeQuota(session.profileId);
}

export function isQuotaIdentityRequiredError(error: unknown) {
  return error instanceof QuotaIdentityRequiredError;
}
