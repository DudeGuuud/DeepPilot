import { MemWal, type RecallMemory } from "@mysten-incubation/memwal";

import { memWalConfig } from "./deep-pilot-config";
import { readDeepPilotProfileMemoryPointer } from "./profile-execution";
import { redisGetJson, redisSetJson } from "./redis-store";

export type AgentMemoryRecord = {
  riskPreference?: string;
  lastMarketThesis?: string;
  lastTradeShape?: string;
  preferredExpiryStyle?: string;
  keeperHistory?: string;
  languagePreference?: string;
  walrusContext?: string;
  updatedAt: string;
  source: "upstash_fallback" | "memwal";
};

const MEMORY_FIELD_LABELS: Array<[keyof Omit<AgentMemoryRecord, "updatedAt" | "source" | "walrusContext">, string]> = [
  ["riskPreference", "risk preference"],
  ["lastMarketThesis", "last market thesis"],
  ["lastTradeShape", "last trade shape"],
  ["preferredExpiryStyle", "preferred expiry style"],
  ["keeperHistory", "keeper history"],
  ["languagePreference", "language preference"]
];
const MAX_SAFE_MEMORY_FIELD_CHARS = 700;
const MAX_RECALLED_CONTEXT_CHARS = 1_200;

export async function readAgentMemory(profileId: string) {
  const fallback = await redisGetJson<AgentMemoryRecord>(memoryKey(profileId));
  const recalled = await recallMemWalBestEffort(profileId);

  if (!recalled) {
    return fallback;
  }

  return {
    ...fallback,
    walrusContext: recalled,
    updatedAt: fallback?.updatedAt ?? new Date().toISOString(),
    source: "memwal" as const
  };
}

export async function writeAgentMemory(profileId: string, update: Partial<Omit<AgentMemoryRecord, "updatedAt" | "source">>) {
  const current = await redisGetJson<AgentMemoryRecord>(memoryKey(profileId));
  const merged: AgentMemoryRecord = {
    ...current,
    ...compactMemoryUpdate(update),
    updatedAt: new Date().toISOString(),
    source: "upstash_fallback"
  };

  await writeMemWalBestEffort(profileId, merged);

  await redisSetJson(memoryKey(profileId), merged, 60 * 60 * 24 * 180);
  return merged;
}

export function memoryContextText(memory: AgentMemoryRecord | null) {
  if (!memory) {
    return null;
  }

  return [
    memory.riskPreference ? `risk preference: ${memory.riskPreference}` : null,
    memory.lastMarketThesis ? `last market thesis: ${memory.lastMarketThesis}` : null,
    memory.lastTradeShape ? `last trade shape: ${memory.lastTradeShape}` : null,
    memory.preferredExpiryStyle ? `preferred expiry style: ${memory.preferredExpiryStyle}` : null,
    memory.keeperHistory ? `keeper history: ${memory.keeperHistory}` : null,
    memory.languagePreference ? `language preference: ${memory.languagePreference}` : null,
    memory.walrusContext ? `walrus memory: ${memory.walrusContext}` : null
  ].filter(Boolean).join("\n");
}

async function writeMemWalBestEffort(profileId: string, memory: AgentMemoryRecord) {
  const text = buildSafeMemoryText(memory);

  if (!text) {
    return false;
  }

  try {
    const client = await createMemWalClient(profileId);

    if (!client) {
      return false;
    }

    try {
      await withTimeout(client.remember(text), memWalConfig().timeoutMs);
      return true;
    } finally {
      client.destroy();
    }
  } catch {
    // Walrus Memory is an enhancement path. A relayer outage must not block chat or trade review.
    return false;
  }
}

function compactMemoryUpdate(update: Partial<Omit<AgentMemoryRecord, "updatedAt" | "source">>) {
  return Object.fromEntries(
    Object.entries(update)
      .filter(([key, value]) => key !== "walrusContext" && typeof value === "string" && value.trim())
      .map(([key, value]) => [key, sanitizeMemoryValue(String(value))])
  );
}

function memoryKey(profileId: string) {
  return `memory:last:${profileId}`;
}

async function recallMemWalBestEffort(profileId: string) {
  try {
    const client = await createMemWalClient(profileId);

    if (!client) {
      return null;
    }

    const result = await (async () => {
      try {
        return await withTimeout(
          client.recall({
          query: "DeepPilot user risk preference, last market thesis, last trade shape, preferred expiry style, keeper history, language preference",
          limit: 5,
          namespace: memoryNamespace(profileId),
          maxDistance: 0.8
          }),
          memWalConfig().timeoutMs
        );
      } finally {
        client.destroy();
      }
    })();

    const lines = result.results
      .map((item) => sanitizeRecalledMemory(item))
      .filter(Boolean)
      .slice(0, 5);

    return lines.length ? lines.join("\n").slice(0, MAX_RECALLED_CONTEXT_CHARS) : null;
  } catch {
    return null;
  }
}

async function createMemWalClient(profileId: string) {
  const config = memWalConfig();

  if (!config.enabled || !config.accountId || !config.delegateKey) {
    return null;
  }

  const namespace = memoryNamespace(profileId);
  const pointer = await readDeepPilotProfileMemoryPointer(profileId).catch(() => null);

  if (
    !pointer?.accountId ||
    pointer.accountId.toLowerCase() !== config.accountId.toLowerCase() ||
    pointer.namespace !== namespace
  ) {
    return null;
  }

  return MemWal.create({
    key: config.delegateKey,
    accountId: config.accountId,
    serverUrl: config.serverUrl || undefined,
    namespace
  });
}

function buildSafeMemoryText(memory: AgentMemoryRecord) {
  const lines = MEMORY_FIELD_LABELS
    .map(([key, label]) => {
      const value = memory[key];

      return value ? `${label}: ${sanitizeMemoryValue(value)}` : null;
    })
    .filter(Boolean);

  return lines.length ? `DeepPilot user memory\n${lines.join("\n")}` : null;
}

function sanitizeMemoryValue(value: string) {
  return value
    .replace(/\b[A-Za-z0-9+/=]{80,}\b/g, "[redacted_long_token]")
    .replace(/0x[a-fA-F0-9]{48,64}/g, "[redacted_object_id]")
    .trim()
    .slice(0, MAX_SAFE_MEMORY_FIELD_CHARS);
}

function sanitizeRecalledMemory(memory: RecallMemory) {
  return sanitizeMemoryValue(memory.text).slice(0, 320);
}

function memoryNamespace(profileId: string) {
  return `deeppilot:${profileId.toLowerCase()}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Walrus Memory request timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
