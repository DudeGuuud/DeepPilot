import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pilotDir = resolve(root, ".deeppilot");
const clientConfig = resolve(pilotDir, "client.yaml");
const metadataPath = resolve(pilotDir, "testnet-key.json");

mkdirSync(pilotDir, { recursive: true });

function runSui(args: string[]) {
  const result = spawnSync("sui", args, {
    cwd: root,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sui ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function activeAddress() {
  const output = runSui(["client", "--client.config", clientConfig, "active-address", "--json"]);
  return JSON.parse(output) as string;
}

function createAddress() {
  const output = runSui([
    "client",
    "--client.config",
    clientConfig,
    "-y",
    "new-address",
    "ed25519",
    "deeppilot-testnet",
    "--json"
  ]);
  const jsonStart = output.lastIndexOf("{");
  const payload = JSON.parse(output.slice(jsonStart)) as { address: string; alias: string; keyScheme: string };
  return payload.address;
}

let address: string;

if (existsSync(clientConfig)) {
  address = activeAddress();
} else {
  address = createAddress();
}

runSui(["client", "--client.config", clientConfig, "switch", "--env", "testnet"]);

const metadata = {
  address,
  alias: "deeppilot-testnet",
  network: "testnet",
  clientConfig,
  keystorePath: resolve(dirname(clientConfig), "sui.keystore"),
  generatedAt: new Date().toISOString(),
  note: "Recovery phrase and private key are intentionally not stored in this metadata file."
};

writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

console.log(JSON.stringify(metadata, null, 2));
