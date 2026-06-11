import { z } from "zod";

type ParseOptions = {
  maxBytes?: number;
};

type RateLimitOptions = {
  scope: string;
  maxRequests: number;
  windowMs: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type DeepPilotGlobal = typeof globalThis & {
  __deepPilotRateLimits?: Map<string, RateLimitBucket>;
};

const DEFAULT_JSON_MAX_BYTES = 4_096;

export async function parseJsonBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
  options: ParseOptions = {}
): Promise<{ success: true; data: z.infer<TSchema> } | { success: false }> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_MAX_BYTES;
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { success: false };
  }

  try {
    const raw = await request.text();

    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      return { success: false };
    }

    const parsed = schema.safeParse(JSON.parse(raw));

    return parsed.success ? { success: true, data: parsed.data } : { success: false };
  } catch {
    return { success: false };
  }
}

export function checkRateLimit(
  request: Request,
  { scope, maxRequests, windowMs }: RateLimitOptions
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const store = getRateLimitStore();
  const now = Date.now();
  const key = `${scope}:${requestIp(request)}`;
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (current.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000))
    };
  }

  current.count += 1;
  return { allowed: true };
}

export function rateLimitHeaders(retryAfterSeconds: number) {
  return {
    "retry-after": String(retryAfterSeconds)
  };
}

function getRateLimitStore() {
  const runtime = globalThis as DeepPilotGlobal;

  // Single-process guard only. Production multi-instance deployments should use Redis/KV.
  runtime.__deepPilotRateLimits ??= new Map<string, RateLimitBucket>();
  return runtime.__deepPilotRateLimits;
}

function requestIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "local";
}
