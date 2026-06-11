import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const metadataPath = resolve(root, ".deeppilot", "devnet-key.json");

if (!existsSync(metadataPath)) {
  throw new Error("Run `bun run sui:devnet-key` before signing a mock transaction.");
}

const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
  address: string;
  keystorePath: string;
  network: string;
};
const keystore = JSON.parse(readFileSync(metadata.keystorePath, "utf8")) as string[];
const signer = keystore
  .map((entry) => Ed25519Keypair.fromSecretKey(fromBase64(entry).slice(1)))
  .find((keypair) => keypair.toSuiAddress() === metadata.address);

if (!signer) {
  throw new Error(`No key in ${metadata.keystorePath} matches ${metadata.address}.`);
}

const tx = new Transaction();
tx.setSender(metadata.address);
tx.setGasBudget(1_000_000);
tx.setExpiration({ None: true });

const [dust] = tx.splitCoins(tx.gas, [1_000]);
tx.transferObjects([dust], tx.pure.address(metadata.address));

const bytes = await tx.build({ onlyTransactionKind: true });
const data = toBase64(bytes);
const signed = await signer.signTransaction(bytes);

console.log(
  JSON.stringify(
    {
      network: metadata.network,
      signer: signer.toSuiAddress(),
      intent: "TransactionData",
      txKindBytes: data.slice(0, 48),
      signaturePreview: `${signed.signature.slice(0, 28)}...${signed.signature.slice(-12)}`,
      submitted: false
    },
    null,
    2
  )
);
