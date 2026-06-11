import { NextResponse } from "next/server";

import { auditLogPackageId, sponsorLimits } from "@/src/lib/execution-config";
import { onchainAuditEnabled, predictDeployment } from "@/src/lib/predict-config";

export function GET() {
  return NextResponse.json({
    ok: true,
    predict: {
      network: predictDeployment.network,
      serverUrl: predictDeployment.serverUrl,
      predictId: predictDeployment.predictId,
      onchainAuditEnabled,
      auditLogPackageId
    },
    sponsor: sponsorLimits,
    stack: {
      next: "16.2.9",
      react: "19.2.7",
      sui: "@mysten/sui 2.17.0",
      dappKit: "@mysten/dapp-kit-react 2.0.3",
      deepbookPredict: "predict-server.testnet.mystenlabs.com"
    }
  });
}
