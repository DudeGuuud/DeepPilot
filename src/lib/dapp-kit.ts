import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { clientGrpcUrls, clientNetwork } from "./client-config";

export const dAppKit = createDAppKit({
  networks: ["devnet", "testnet"],
  defaultNetwork: clientNetwork,
  enableBurnerWallet: true,
  createClient(network) {
    return new SuiGrpcClient({
      network,
      baseUrl: clientGrpcUrls[network]
    });
  }
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
