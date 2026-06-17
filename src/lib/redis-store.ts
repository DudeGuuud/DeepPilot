type StoredValue = {
  value: unknown;
  expiresAt: number | null;
};

type DeepPilotRedisGlobal = typeof globalThis & {
  __deepPilotRedisFallback?: Map<string, StoredValue>;
};

export function redisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim() && process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

export async function redisGet<T>(key: string): Promise<T | null> {
  if (redisConfigured()) {
    return await redisCommand<T | null>("GET", key);
  }

  const item = fallbackStore().get(key);

  if (!item) {
    return null;
  }

  if (item.expiresAt && item.expiresAt <= Date.now()) {
    fallbackStore().delete(key);
    return null;
  }

  return item.value as T;
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const value = await redisGet<string>(key);

  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function redisSet<T>(key: string, value: T, ttlSeconds?: number) {
  if (redisConfigured()) {
    if (ttlSeconds) {
      await redisCommand("SET", key, value, "EX", ttlSeconds);
    } else {
      await redisCommand("SET", key, value);
    }

    return;
  }

  fallbackStore().set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1_000 : null
  });
}

export async function redisSetIfAbsent<T>(key: string, value: T, ttlSeconds: number) {
  if (redisConfigured()) {
    const result = await redisCommand<string | null>("SET", key, value, "EX", ttlSeconds, "NX");

    return result === "OK";
  }

  const store = fallbackStore();
  const existing = store.get(key);

  if (existing && (!existing.expiresAt || existing.expiresAt > Date.now())) {
    return false;
  }

  store.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1_000
  });

  return true;
}

export async function redisSetJson<T>(key: string, value: T, ttlSeconds?: number) {
  await redisSet(key, JSON.stringify(value), ttlSeconds);
}

export async function redisDelete(key: string) {
  if (redisConfigured()) {
    await redisCommand("DEL", key);
    return;
  }

  fallbackStore().delete(key);
}

export async function redisEval<T>(script: string, keys: string[], args: Array<string | number>) {
  if (!redisConfigured()) {
    throw new Error("Redis EVAL is unavailable in fallback mode.");
  }

  return await redisCommand<T>("EVAL", script, String(keys.length), ...keys, ...args.map(String));
}

export async function redisCommand<T = unknown>(...args: unknown[]): Promise<T> {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    throw new Error("Upstash Redis is not configured.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(args),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Redis command failed with ${response.status}.`);
  }

  const payload = await response.json() as { result?: T; error?: string };

  if (payload.error) {
    throw new Error(payload.error);
  }

  return payload.result as T;
}

export function redisFallbackSource() {
  return redisConfigured() ? "upstash" as const : "memory" as const;
}

function fallbackStore() {
  const runtime = globalThis as DeepPilotRedisGlobal;

  runtime.__deepPilotRedisFallback ??= new Map<string, StoredValue>();
  return runtime.__deepPilotRedisFallback;
}
