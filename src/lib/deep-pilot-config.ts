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
  return trimEnv("TELEGRAM_LINK_SECRET") || trimEnv("REVIEW_SEED_SECRET") || "deeppilot-local-telegram-link-secret";
}

export function telegramLinkSalt() {
  return trimEnv("TELEGRAM_LINK_SALT") || "deeppilot-local-telegram-link-salt";
}

export function reviewSeedSecret() {
  return trimEnv("REVIEW_SEED_SECRET") || trimEnv("DEEPSEEK_API_KEY") || "deeppilot-local-review-seed-secret";
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
  return {
    accountId: trimEnv("MEMWAL_ACCOUNT_ID"),
    delegateKey: trimEnv("MEMWAL_DELEGATE_KEY"),
    serverUrl: trimEnv("MEMWAL_SERVER_URL")
  };
}

function trimEnv(key: string) {
  return process.env[key]?.trim() || "";
}
