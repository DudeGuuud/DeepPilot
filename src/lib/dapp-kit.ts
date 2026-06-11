import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { clientGrpcUrls, clientNetwork } from "./client-config";

export const dAppKit = createDAppKit({
  networks: ["devnet", "testnet"],
  defaultNetwork: clientNetwork,
  // Burner wallets are useful for demos, but production sponsor flows need explicit wallet custody.
  enableBurnerWallet: false,
  // Avoid auto-registering the hosted Slush wallet; extension wallets remain available via Wallet Standard.
  slushWalletConfig: null,
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
