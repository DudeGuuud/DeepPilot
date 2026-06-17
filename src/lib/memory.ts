import { memWalConfig } from "./deep-pilot-config";
import { redisGetJson, redisSetJson } from "./redis-store";

export type AgentMemoryRecord = {
  riskPreference?: string;
  lastMarketThesis?: string;
  lastTradeShape?: string;
  preferredExpiryStyle?: string;
  keeperHistory?: string;
  updatedAt: string;
  source: "upstash_fallback" | "memwal";
};

export async function readAgentMemory(profileId: string) {
  return await redisGetJson<AgentMemoryRecord>(memoryKey(profileId));
}

export async function writeAgentMemory(profileId: string, update: Partial<Omit<AgentMemoryRecord, "updatedAt" | "source">>) {
  const current = await readAgentMemory(profileId);
  const merged: AgentMemoryRecord = {
    ...current,
    ...compactMemoryUpdate(update),
    updatedAt: new Date().toISOString(),
    source: "upstash_fallback"
  };

  const memwal = memWalConfig();

  if (memwal.accountId && memwal.delegateKey && memwal.serverUrl) {
    await writeMemWalBestEffort(profileId, merged);
  }

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
    memory.keeperHistory ? `keeper history: ${memory.keeperHistory}` : null
  ].filter(Boolean).join("\n");
}

async function writeMemWalBestEffort(profileId: string, memory: AgentMemoryRecord) {
  const config = memWalConfig();

  try {
    await fetch(`${config.serverUrl!.replace(/\/$/, "")}/remember`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.delegateKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        accountId: config.accountId,
        namespace: `deeppilot:${profileId}`,
        memory
      }),
      cache: "no-store"
    });
  } catch {
    // Walrus Memory is an enhancement path. A relayer outage must not block chat or trade review.
  }
}

function compactMemoryUpdate(update: Partial<Omit<AgentMemoryRecord, "updatedAt" | "source">>) {
  return Object.fromEntries(
    Object.entries(update)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => [key, String(value).trim().slice(0, 700)])
  );
}

function memoryKey(profileId: string) {
  return `memory:last:${profileId}`;
}
