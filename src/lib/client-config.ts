export type ClientNetwork = "devnet" | "testnet";

export const clientNetwork: ClientNetwork = process.env.NEXT_PUBLIC_SUI_NETWORK === "devnet" ? "devnet" : "testnet";

export const clientGrpcUrls = {
  devnet: readPublicEnv("NEXT_PUBLIC_SUI_DEVNET_GRPC_URL", "https://fullnode.devnet.sui.io:443"),
  testnet: readPublicEnv("NEXT_PUBLIC_SUI_TESTNET_GRPC_URL", "https://fullnode.testnet.sui.io:443")
} as const;

function readPublicEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();

  return value && value.length > 0 ? value : fallback;
}
