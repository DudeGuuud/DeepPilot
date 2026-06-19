import { z } from "zod";

import { predictDeployment } from "./predict-config";
import { createPredictClientPreview, normalizeDusdc, toDusdcBaseUnits } from "./predict";
import type {
  VaultLpAction,
  VaultLpFlowItem,
  VaultLpIntent,
  VaultLpPerformancePoint,
  VaultLpReview,
  VaultLpSummary,
  VaultSummary
} from "./types";

const PREDICT_TIMEOUT_MS = 5_000;
const LP_DISCLOSURE =
  "PLP is a share of the DeepBook Predict vault, not a fixed-yield product. Estimates use current vault state and may change before wallet execution.";

const vaultSummarySchema: z.ZodType<VaultSummary> = z.object({
  predict_id: z.string(),
  vault_balance: z.number().finite(),
  vault_value: z.number().finite(),
  total_mtm: z.number().finite(),
  total_max_payout: z.number().finite(),
  available_liquidity: z.number().finite(),
  available_withdrawal: z.number().finite(),
  plp_total_supply: z.number().finite(),
  plp_share_price: z.number().finite(),
  utilization: z.number().finite(),
  max_payout_utilization: z.number().finite()
});

const performanceSchema = z.object({
  points: z.array(z.object({
    timestamp_ms: z.number().finite(),
    share_price: z.number().finite(),
    vault_value: z.union([z.number(), z.string()]),
    total_shares: z.union([z.number(), z.string()])
  })).default([])
});

const flowRowSchema = z.object({
  digest: z.string().nullable().optional(),
  checkpoint_timestamp_ms: z.number().finite().nullable().optional(),
  supplier: z.string().nullable().optional(),
  withdrawer: z.string().nullable().optional(),
  amount: z.union([z.number(), z.string()]).nullable().optional(),
  shares_minted: z.union([z.number(), z.string()]).nullable().optional(),
  shares_burned: z.union([z.number(), z.string()]).nullable().optional()
}).passthrough();

const flowsSchema = z.array(flowRowSchema);

export async function getVaultLpSummary(input: { wallet?: string | null; flowLimit?: number } = {}): Promise<VaultLpSummary> {
  const limit = Math.max(1, Math.min(100, input.flowLimit ?? 30));
  const [vault, performance, supplies, withdrawals] = await Promise.all([
    fetchPredict(`/predicts/${predictDeployment.predictId}/vault/summary`, vaultSummarySchema),
    fetchPredict(`/predicts/${predictDeployment.predictId}/vault/performance?range=ALL`, performanceSchema),
    fetchPredict(`/lp/supplies?limit=${limit}`, flowsSchema),
    fetchPredict(`/lp/withdrawals?limit=${limit}`, flowsSchema)
  ]);

  if (vault.predict_id !== predictDeployment.predictId) {
    throw new Error("Predict vault summary does not match the configured Predict object.");
  }

  const wallet = input.wallet?.toLowerCase() ?? null;
  const flows = [
    ...supplies.map((row, index) => flowFromRow("supply", row, index)),
    ...withdrawals.map((row, index) => flowFromRow("withdraw", row, index))
  ]
    .filter((flow) => !wallet || flow.wallet?.toLowerCase() === wallet)
    .sort((left, right) => (right.timestampMs ?? 0) - (left.timestampMs ?? 0))
    .slice(0, limit);

  return {
    predict: createPredictClientPreview(),
    quoteAssetType: predictDeployment.quoteAssetType,
    plpCoinType: predictDeployment.plpCoinType,
    vault: normalizeVault(vault),
    performance: performance.points
      .map((point): VaultLpPerformancePoint => ({
        timestampMs: point.timestamp_ms,
        sharePrice: point.share_price,
        vaultValueRaw: rawString(point.vault_value),
        totalSharesRaw: rawString(point.total_shares)
      }))
      .slice(-240),
    flows,
    fetchedAt: new Date().toISOString()
  };
}

export async function compileVaultLpIntent(input: string, options: { wallet?: string | null } = {}): Promise<VaultLpReview> {
  const summary = await getVaultLpSummary({ wallet: options.wallet });
  const intent = parseVaultLpIntent(input);
  const execution = buildExecution(intent, summary);
  const transactionData = intent.status === "ready" && execution.canSign && intent.action !== "info" && intent.amountRaw
    ? {
        kind: "VaultLpTransaction" as const,
        network: predictDeployment.network,
        packageId: predictDeployment.packageId,
        predictObject: predictDeployment.predictId,
        quoteAssetType: predictDeployment.quoteAssetType,
        plpCoinType: predictDeployment.plpCoinType,
        action: intent.action,
        amountRaw: intent.amountRaw,
        plpSharesRaw: execution.plpSharesRaw,
        estimatedDusdcOutRaw: intent.action === "withdraw" ? intent.amountRaw : null,
        target: `${predictDeployment.packageId}::predict::${intent.action === "deposit" ? "supply" : "withdraw"}`
      }
    : null;

  return {
    intent,
    summary,
    execution,
    transactionData,
    timeline: [
      {
        label: "Parsing Vault LP intent",
        state: intent.status === "ready" ? "complete" : "blocked",
        detail: intent.reason
      },
      {
        label: "Reading Predict vault state",
        state: "complete",
        detail: `Share price ${summary.vault.plp_share_price.toFixed(6)}`
      },
      {
        label: "Preparing LP transaction",
        state: transactionData ? "complete" : intent.action === "info" ? "complete" : "blocked",
        detail: transactionData?.target ?? "No wallet transaction required"
      }
    ],
    disclosure: LP_DISCLOSURE,
    fetchedAt: new Date().toISOString()
  };
}

export function parseVaultLpIntent(input: string): VaultLpIntent {
  const raw = input.trim();
  const normalized = normalizeCurrencyText(raw).toLowerCase();
  const action = detectVaultLpAction(normalized);
  const amountDusdc = detectAmount(raw);
  const amountRaw = amountDusdc === null ? null : toDusdcBaseUnits(amountDusdc).toString();
  const missing: string[] = [];

  if (action !== "info" && amountDusdc === null) {
    missing.push("amount");
  }

  if (missing.length) {
    return {
      status: "needs_clarification",
      action,
      amountDusdc,
      amountRaw,
      raw,
      missing,
      reason: "Specify the DUSDC amount for this Vault LP operation."
    };
  }

  return {
    status: "ready",
    action,
    amountDusdc,
    amountRaw,
    raw,
    missing: [],
    reason: action === "info" ? "Vault LP information request." : `Prepare Vault LP ${action}.`
  };
}

export function isVaultLpRequest(input: string) {
  const raw = input.toLowerCase();
  const compact = normalizeCurrencyText(input).toLowerCase();

  return (
    /\b(vault\s*lp|lp\s*vault|liquidity provider|provide liquidity|predict vault|plp)\b/i.test(raw) ||
    /(vaultlp|lpvault|liquidityprovider|provideliquidity|predictvault|plp)/i.test(compact) ||
    /(存入|充值|放进|提供|做|加入|取出|赎回|退出).*(lp|vault|流动性|plp)/i.test(input) ||
    /(lp|vault|流动性|plp).*(存入|充值|放进|提供|做|加入|取出|赎回|退出)/i.test(input)
  );
}

function buildExecution(intent: VaultLpIntent, summary: VaultLpSummary) {
  const sharePrice = summary.vault.plp_share_price;
  const amountRaw = intent.amountRaw;
  const amount = amountRaw ? BigInt(amountRaw) : null;
  const plpSharesRaw = intent.action === "withdraw" && amount && sharePrice > 0
    ? ceilDivBySharePrice(amount, sharePrice).toString()
    : intent.action === "deposit" ? null : null;
  const checks = [
    {
      label: "Vault state",
      passed: summary.vault.predict_id === predictDeployment.predictId,
      detail: "DeepBook Predict vault summary loaded."
    },
    {
      label: "Share price",
      passed: Number.isFinite(sharePrice) && sharePrice > 0,
      detail: `${sharePrice.toFixed(6)} DUSDC per PLP`
    },
    {
      label: "Available withdrawal",
      passed: intent.action !== "withdraw" || Boolean(amount && BigInt(summary.vault.available_withdrawal) >= amount),
      detail: `${normalizeDusdc(summary.vault.available_withdrawal).toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC available`
    }
  ];
  const canSign =
    intent.status === "ready" &&
    intent.action !== "info" &&
    Boolean(amount && amount > 0n) &&
    checks.every((check) => check.passed);

  return {
    canSign,
    action: intent.action,
    reason: canSign
      ? "Vault LP review is ready. Wallet DUSDC/PLP and gas are checked immediately before signing."
      : intent.action === "info"
        ? "Information request only."
        : checks.find((check) => !check.passed)?.detail ?? intent.reason,
    amountRaw,
    plpSharesRaw,
    availableWithdrawalRaw: summary.vault.available_withdrawal.toString(),
    sharePrice,
    checks
  };
}

function detectVaultLpAction(normalized: string): VaultLpAction {
  if (/\b(withdraw|remove|exit|redeem)\b|取出|赎回|退出/.test(normalized)) {
    return "withdraw";
  }

  if (/\b(deposit|supply|mint|add|provide)\b|存入|充值|放进|提供|加入|做/.test(normalized)) {
    return "deposit";
  }

  return "info";
}

function detectAmount(raw: string) {
  const match = normalizeCurrencyText(raw).match(/(\d+(?:\.\d+)?)\s*(?:d?usdc|u|\$)/i);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const decimals = match[1].split(".")[1]?.length ?? 0;

  return Number.isFinite(value) && value > 0 && decimals <= 6 ? value : null;
}

function ceilDivBySharePrice(amountRaw: bigint, sharePrice: number) {
  const estimated = Number(amountRaw) / sharePrice;

  if (!Number.isFinite(estimated) || estimated <= 0 || estimated > Number.MAX_SAFE_INTEGER) {
    throw new Error("Vault LP withdraw amount is outside the supported preview range.");
  }

  return BigInt(Math.ceil(estimated));
}

function flowFromRow(kind: "supply" | "withdraw", row: z.infer<typeof flowRowSchema>, index: number): VaultLpFlowItem {
  const wallet = kind === "supply" ? row.supplier : row.withdrawer;
  const shares = kind === "supply" ? row.shares_minted : row.shares_burned;

  return {
    id: `${kind}:${row.digest ?? index}:${row.checkpoint_timestamp_ms ?? "unknown"}`,
    kind,
    digest: row.digest ?? null,
    timestampMs: row.checkpoint_timestamp_ms ?? null,
    wallet: typeof wallet === "string" ? wallet : null,
    amountRaw: rawStringOrNull(row.amount),
    sharesRaw: rawStringOrNull(shares)
  };
}

function normalizeVault(vault: VaultSummary): VaultSummary {
  return {
    predict_id: vault.predict_id,
    vault_balance: vault.vault_balance,
    vault_value: vault.vault_value,
    total_mtm: vault.total_mtm,
    total_max_payout: vault.total_max_payout,
    available_liquidity: vault.available_liquidity,
    available_withdrawal: vault.available_withdrawal,
    plp_total_supply: vault.plp_total_supply,
    plp_share_price: vault.plp_share_price,
    utilization: vault.utilization,
    max_payout_utilization: vault.max_payout_utilization
  };
}

async function fetchPredict<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREDICT_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`${predictDeployment.serverUrl}${path}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });
  } catch {
    throw new Error("Predict server request failed.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Predict server ${path} returned ${response.status}`);
  }

  const parsed = schema.safeParse(await response.json());

  if (!parsed.success) {
    throw new Error("Predict server returned an invalid Vault LP payload.");
  }

  return parsed.data;
}

function rawString(value: string | number) {
  return typeof value === "number" ? Math.trunc(value).toString() : value;
}

function rawStringOrNull(value: string | number | null | undefined) {
  return value === null || value === undefined ? null : rawString(value);
}

function normalizeCurrencyText(raw: string) {
  return raw.replace(/([a-z])\s+(?=[a-z])/gi, "$1");
}
