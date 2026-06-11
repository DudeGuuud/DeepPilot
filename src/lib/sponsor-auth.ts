import { createHash, randomUUID } from "node:crypto";

import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

const CHALLENGE_TTL_MS = 120_000;

type SponsorChallenge = {
  walletAddress: string;
  network: "devnet" | "testnet";
  ptbDigest: string;
  nonce: string;
  expiresAt: string;
};

type SponsorChallengeStore = Map<string, SponsorChallenge>;

type DeepPilotGlobal = typeof globalThis & {
  __deepPilotSponsorChallenges?: SponsorChallengeStore;
};

export function issueSponsorChallenge(input: Omit<SponsorChallenge, "nonce" | "expiresAt">) {
  cleanupChallenges();

  const challenge: SponsorChallenge = {
    ...input,
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()
  };

  getChallengeStore().set(challenge.nonce, challenge);

  return {
    ...challenge,
    message: buildSponsorMessage(challenge)
  };
}

export async function verifySponsorAuthorization(input: SponsorChallenge & { signature: string }) {
  const store = getChallengeStore();
  const challenge = store.get(input.nonce);

  // A nonce is single-use even when verification fails; otherwise replay probing is cheap.
  store.delete(input.nonce);

  if (!challenge || Date.parse(challenge.expiresAt) <= Date.now()) {
    return false;
  }

  if (
    challenge.walletAddress !== input.walletAddress ||
    challenge.network !== input.network ||
    challenge.ptbDigest !== input.ptbDigest ||
    challenge.expiresAt !== input.expiresAt
  ) {
    return false;
  }

  try {
    await verifyPersonalMessageSignature(new TextEncoder().encode(buildSponsorMessage(challenge)), input.signature, {
      address: input.walletAddress
    });
    return true;
  } catch {
    return false;
  }
}

export function hashIntent(intent: string) {
  return createHash("sha256").update(intent).digest("hex");
}

function buildSponsorMessage(challenge: SponsorChallenge) {
  return [
    "DeepPilot sponsor authorization v1",
    `wallet=${challenge.walletAddress}`,
    `network=${challenge.network}`,
    `ptbDigest=${challenge.ptbDigest}`,
    `nonce=${challenge.nonce}`,
    `expiresAt=${challenge.expiresAt}`
  ].join("\n");
}

function cleanupChallenges() {
  const now = Date.now();

  for (const [nonce, challenge] of getChallengeStore()) {
    if (Date.parse(challenge.expiresAt) <= now) {
      getChallengeStore().delete(nonce);
    }
  }
}

function getChallengeStore() {
  const runtime = globalThis as DeepPilotGlobal;

  // In-memory nonce state is a local safety net; use shared storage in multi-instance production.
  runtime.__deepPilotSponsorChallenges ??= new Map<string, SponsorChallenge>();
  return runtime.__deepPilotSponsorChallenges;
}
