import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const GRPC_URLS = {
  devnet: "https://fullnode.devnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443"
} as const;

export const dAppKit = createDAppKit({
  networks: ["devnet", "testnet"],
  defaultNetwork: "devnet",
  enableBurnerWallet: true,
  createClient(network) {
    return new SuiGrpcClient({
      network,
      baseUrl: GRPC_URLS[network]
    });
  }
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}

