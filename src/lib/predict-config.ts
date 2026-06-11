import type { PredictDeployment } from "./types";

const DEFAULT_PREDICT_SERVER_URL = "https://predict-server.testnet.mystenlabs.com";
const DEFAULT_PREDICT_PACKAGE_ID = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";
const DEFAULT_PREDICT_ID = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
const DEFAULT_DUSDC_TYPE = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC";
const DEFAULT_PLP_TYPE = "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP";
const ALLOWED_PREDICT_HOSTS = new Set(["predict-server.testnet.mystenlabs.com"]);

export const predictDeployment: PredictDeployment = {
  network: readNetwork("PREDICT_NETWORK", "testnet"),
  serverUrl: readUrlEnv("PREDICT_SERVER_URL", DEFAULT_PREDICT_SERVER_URL, ALLOWED_PREDICT_HOSTS),
  packageId: readEnv("PREDICT_PACKAGE_ID", DEFAULT_PREDICT_PACKAGE_ID),
  predictId: readEnv("PREDICT_OBJECT_ID", DEFAULT_PREDICT_ID),
  quoteAssetType: readEnv("PREDICT_DUSDC_TYPE", DEFAULT_DUSDC_TYPE),
  plpCoinType: readEnv("PREDICT_PLP_COIN_TYPE", DEFAULT_PLP_TYPE),
  sourceBranch: readEnv("PREDICT_SOURCE_BRANCH", "predict-testnet-4-16")
};

export const onchainAuditEnabled = readBoolean("PREDICT_ENABLE_ONCHAIN_LOG", false);

function readEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();

  return value && value.length > 0 ? value : fallback;
}

function readUrlEnv(name: string, fallback: string, allowedHosts: Set<string>) {
  const value = readEnv(name, fallback);
  const parsed = new URL(value);

  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.host)) {
    throw new Error(`${name} must be an allowlisted HTTPS endpoint.`);
  }

  return parsed.origin;
}

function readNetwork(name: string, fallback: PredictDeployment["network"]) {
  const value = process.env[name]?.trim();

  return value === "devnet" || value === "testnet" || value === "mainnet" ? value : fallback;
}

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();

  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }

  if (value === "false" || value === "0" || value === "no") {
    return false;
  }

  return fallback;
}
