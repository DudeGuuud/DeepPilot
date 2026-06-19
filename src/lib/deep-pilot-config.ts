import type { DeepPilotPlanConfig, DeepPilotPlanName } from "./types";

export const PLAN_DISPLAY_LIMITS: Record<DeepPilotPlanName, number> = {
  standard: 10,
  pro: 50,
  max: 100
};

export function appBaseUrl() {
  return trimEnv("APP_BASE_URL") || "http://localhost:3000";
}

export function telegramBotToken() {
  return trimEnv("TELEGRAM_BOT_TOKEN");
}

export function telegramWebhookSecret() {
  return trimEnv("TELEGRAM_WEBHOOK_SECRET");
}

export function telegramLinkSecret() {
  return secretOrLocalFallback(
    "TELEGRAM_LINK_SECRET",
    "deeppilot-local-telegram-link-secret",
    ["REVIEW_SEED_SECRET"]
  );
}

export function telegramLinkSalt() {
  return secretOrLocalFallback("TELEGRAM_LINK_SALT", "deeppilot-local-telegram-link-salt");
}

export function reviewSeedSecret() {
  return secretOrLocalFallback("REVIEW_SEED_SECRET", "deeppilot-local-review-seed-secret");
}

export function planPriceMist() {
  return trimEnv("PLAN_PRICE_MIST") || "100000000";
}

export function planDurationDays() {
  const value = Number.parseInt(trimEnv("PLAN_DURATION_DAYS") || "30", 10);

  return Number.isFinite(value) && value > 0 ? value : 30;
}

export function quotaV1DailyLimit() {
  const value = Number.parseInt(trimEnv("QUOTA_V1_DAILY_LIMIT") || "50", 10);

  return Number.isFinite(value) && value > 0 ? value : 50;
}

export function allowAnonymousAiRequests() {
  return trimEnv("DEEP_PILOT_ALLOW_ANON_AI") === "true";
}

export function getPlanConfig(plan: DeepPilotPlanName): DeepPilotPlanConfig {
  return {
    name: plan,
    label: plan === "standard" ? "Standard" : plan === "pro" ? "Pro" : "Max",
    displayLimit: PLAN_DISPLAY_LIMITS[plan],
    effectiveDailyLimit: quotaV1DailyLimit(),
    priceMist: plan === "standard" ? "0" : planPriceMist(),
    durationDays: plan === "standard" ? 0 : planDurationDays()
  };
}

export function profilePackageConfig() {
  return {
    packageId: trimEnv("DEEP_PILOT_PROFILE_PACKAGE_ID"),
    registryId: trimEnv("DEEP_PILOT_PROFILE_REGISTRY_ID"),
    treasuryId: trimEnv("DEEP_PILOT_PROFILE_TREASURY_ID")
  };
}

export function memWalConfig() {
  const timeoutMs = Number.parseInt(trimEnv("MEMWAL_TIMEOUT_MS") || "1500", 10);

  return {
    enabled: trimEnv("MEMWAL_ENABLED") !== "false",
    accountId: trimEnv("MEMWAL_ACCOUNT_ID"),
    delegateKey: trimEnv("MEMWAL_DELEGATE_KEY"),
    serverUrl: trimEnv("MEMWAL_SERVER_URL"),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500
  };
}

function trimEnv(key: string) {
  return process.env[key]?.trim() || "";
}

function secretOrLocalFallback(key: string, fallback: string, alternativeKeys: string[] = []) {
  const direct = trimEnv(key);

  if (direct) {
    return direct;
  }

  for (const alternativeKey of alternativeKeys) {
    const alternative = trimEnv(alternativeKey);

    if (alternative) {
      return alternative;
    }
  }

  if (isLocalDevelopment()) {
    return fallback;
  }

  throw new Error(`${key} must be configured outside local development.`);
}

function isLocalDevelopment() {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  try {
    const hostname = new URL(appBaseUrl()).hostname;

    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
