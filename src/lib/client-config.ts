export type ClientNetwork = "devnet" | "testnet";

export const clientNetwork: ClientNetwork = process.env.NEXT_PUBLIC_SUI_NETWORK === "devnet" ? "devnet" : "testnet";

export const clientGrpcUrls = {
  devnet: readPublicRpcEnv("NEXT_PUBLIC_SUI_DEVNET_GRPC_URL", "https://fullnode.devnet.sui.io:443", "fullnode.devnet.sui.io"),
  testnet: readPublicRpcEnv("NEXT_PUBLIC_SUI_TESTNET_GRPC_URL", "https://fullnode.testnet.sui.io:443", "fullnode.testnet.sui.io")
} as const;

function readPublicEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();

  return value && value.length > 0 ? value : fallback;
}

function readPublicRpcEnv(name: string, fallback: string, allowedHost: string) {
  const value = readPublicEnv(name, fallback);
  const parsed = new URL(value);

  if (
    parsed.protocol !== "https:" ||
    // 只允许官方 Sui 公开 RPC 域名，允许默认端口或显式 :443。
    parsed.hostname !== allowedHost ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new Error(`${name} must be the allowlisted Sui HTTPS RPC endpoint.`);
  }

  return parsed.href;
}
