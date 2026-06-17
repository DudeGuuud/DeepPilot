import { quotaV1DailyLimit } from "./deep-pilot-config";
import { redisEval, redisFallbackSource, redisGet, redisSet } from "./redis-store";
import type { QuotaStatus } from "./types";

const QUOTA_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local limit = tonumber(ARGV[1])
if current and tonumber(current) >= limit then
  return {0, tonumber(current), limit, redis.call("TTL", KEYS[1])}
end
current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end
return {1, tonumber(current), limit, redis.call("TTL", KEYS[1])}
`;

export async function getQuotaStatus(profileId: string): Promise<QuotaStatus> {
  const key = quotaKey(profileId);
  const used = Number(await redisGet<string | number>(key) ?? 0);
  const limit = quotaV1DailyLimit();

  return {
    profileId,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: new Date(Date.now() + secondsUntilNextUtcDay() * 1_000).toISOString(),
    exhausted: used >= limit,
    allowed: used < limit,
    source: redisFallbackSource()
  };
}

export async function consumeQuota(profileId: string): Promise<QuotaStatus> {
  const limit = quotaV1DailyLimit();
  const ttl = secondsUntilNextUtcDay();
  const key = quotaKey(profileId);

  if (redisFallbackSource() === "upstash") {
    const result = await redisEval<Array<number | string>>(QUOTA_SCRIPT, [key], [limit, ttl]);
    const allowed = Number(result[0]) === 1;
    const used = Number(result[1] ?? 0);
    const ttlSeconds = Math.max(1, Number(result[3] ?? ttl));

    return {
      profileId,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
      exhausted: !allowed || used >= limit,
      allowed,
      source: "upstash"
    };
  }

  const current = Number(await redisGet<string | number>(key) ?? 0);

  if (current >= limit) {
    return {
      profileId,
      used: current,
      limit,
      remaining: 0,
      resetAt: new Date(Date.now() + ttl * 1_000).toISOString(),
      exhausted: true,
      allowed: false,
      source: "memory"
    };
  }

  const used = current + 1;
  await redisSet(key, used, ttl);

  return {
    profileId,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: new Date(Date.now() + ttl * 1_000).toISOString(),
    exhausted: used >= limit,
    allowed: true,
    source: "memory"
  };
}

export function quotaKey(profileId: string) {
  return `quota:${profileId}:${utcDay()}`;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));

  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1_000));
}
