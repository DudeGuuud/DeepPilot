import type { ProfileActivityItem } from "./types";

const RECEIPT_STORAGE_KEY = "deeppilot.previewReceipts.v1";
const RECEIPT_LIMIT = 25;

export type StoredPreviewReceipt = ProfileActivityItem & {
  walletAddress: string;
  network: "devnet" | "testnet";
  status: string;
  note: string;
};

export function readPreviewReceipts(walletAddress?: string | null): StoredPreviewReceipt[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECEIPT_STORAGE_KEY) ?? "[]") as StoredPreviewReceipt[];

    return parsed.filter((receipt) => !walletAddress || receipt.walletAddress === walletAddress);
  } catch {
    return [];
  }
}

export function storePreviewReceipt(receipt: StoredPreviewReceipt) {
  if (typeof window === "undefined") {
    return;
  }

  const receipts = [receipt, ...readPreviewReceipts().filter((item) => item.id !== receipt.id)].slice(0, RECEIPT_LIMIT);
  // This is browser-local demo evidence only; it is not an on-chain activity index.
  window.localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(receipts));
}
