import { predictDeployment } from "./predict-config";
import type { ProfileSummary } from "./types";

const objectIdPattern = /^0x[a-fA-F0-9]{1,64}$/;

type ProfileInput = {
  wallet?: string | null;
  managerId?: string | null;
};

export async function getProfileSummary({ wallet, managerId }: ProfileInput): Promise<ProfileSummary> {
  const normalizedWallet = normalizeObjectId(wallet);
  const normalizedManager = normalizeObjectId(managerId);

  if (!normalizedManager) {
    return emptyProfile(
      normalizedWallet,
      null,
      "No PredictManager is linked yet. DeepPilot will not invent PnL or positions without a manager object."
    );
  }

  const [manager, positions, pnl] = await Promise.all([
    fetchManagerJson(`/managers/${normalizedManager}/summary`),
    fetchManagerJson(`/managers/${normalizedManager}/positions/summary`),
    fetchManagerJson(`/managers/${normalizedManager}/pnl?range=ALL`)
  ]);

  if (!manager && !positions && !pnl) {
    return emptyProfile(
      normalizedWallet,
      normalizedManager,
      "Predict server did not find this manager. Check the manager id before trusting portfolio data."
    );
  }

  return {
    wallet: normalizedWallet,
    managerId: normalizedManager,
    managerLinked: true,
    network: predictDeployment.network,
    openExposureDusdc: null,
    redeemableValueDusdc: null,
    realizedPnlDusdc: null,
    awaitingSettlement: null,
    guardianBlockedCount: 0,
    activity: [],
    message: "Manager endpoints responded. Raw manager payloads are retained server-side for the UI; no synthetic PnL is generated.",
    rawManager: manager,
    rawPositions: positions,
    rawPnl: pnl
  };
}

function emptyProfile(wallet: string | null, managerId: string | null, message: string): ProfileSummary {
  return {
    wallet,
    managerId,
    managerLinked: false,
    network: predictDeployment.network,
    openExposureDusdc: null,
    redeemableValueDusdc: null,
    realizedPnlDusdc: null,
    awaitingSettlement: null,
    guardianBlockedCount: 0,
    activity: [],
    message
  };
}

async function fetchManagerJson(path: string) {
  const response = await fetch(`${predictDeployment.serverUrl}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Predict manager endpoint ${path} returned ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

function normalizeObjectId(value?: string | null) {
  const trimmed = value?.trim();

  return trimmed && objectIdPattern.test(trimmed) ? trimmed : null;
}
