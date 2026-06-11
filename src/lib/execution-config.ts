const DEFAULT_PREVIEW_SENDER = "0x0000000000000000000000000000000000000000000000000000000000000a11";
const DEFAULT_PREVIEW_SPONSOR = "0x00000000000000000000000000000000000000000000000000000000000005aa";
const DEFAULT_PREVIEW_MANAGER = "0x00000000000000000000000000000000000000000000000000000000feed0001";
const DEFAULT_AUDIT_LOG_PACKAGE = "deep_pilot_log";
const SUI_ID_PATTERN = /^0x[a-fA-F0-9]{1,64}$/;

export const previewAccounts = {
  sender: readSuiId("PREDICT_PREVIEW_SENDER", DEFAULT_PREVIEW_SENDER),
  sponsor: readSuiId("PREDICT_PREVIEW_SPONSOR", DEFAULT_PREVIEW_SPONSOR),
  manager: readSuiId("PREDICT_PREVIEW_MANAGER", DEFAULT_PREVIEW_MANAGER)
};

export const sponsorLimits = {
  maxGasBudget: readInteger("SPONSOR_MAX_GAS_BUDGET", 20_000_000),
  maxTradeSizeDusdc: readNumber("SPONSOR_MAX_TRADE_SIZE_DUSDC", 1_000)
};

export const auditLogPackageId = readEnv("DEEP_PILOT_LOG_PACKAGE_ID", DEFAULT_AUDIT_LOG_PACKAGE);
export const auditLogPackageIsPublished = SUI_ID_PATTERN.test(auditLogPackageId);

// These values are server-only so Vercel can swap demo accounts without shipping them to the browser bundle.
function readEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();

  return value && value.length > 0 ? value : fallback;
}

function readSuiId(name: string, fallback: string) {
  const value = readEnv(name, fallback);

  if (!SUI_ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed Sui address or object id.`);
  }

  return value;
}

function readInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readNumber(name: string, fallback: number) {
  const value = Number.parseFloat(process.env[name] ?? "");

  return Number.isFinite(value) && value > 0 ? value : fallback;
}
