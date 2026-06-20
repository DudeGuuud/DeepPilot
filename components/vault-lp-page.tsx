"use client";

import { useCurrentAccount, useCurrentNetwork, useDAppKit } from "@mysten/dapp-kit-react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CircleDashed, LockKeyhole, RefreshCw, Shield, Vault, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  assertExecuted,
  buildVaultLpSupplyTransaction,
  buildVaultLpWithdrawTransaction,
  getExecutedDigest
} from "@/src/lib/predict-execution";
import { readPreviewReceipts, storePreviewReceipt, type StoredPreviewReceipt } from "@/src/lib/receipts";
import { readCoinBalanceRaw, readSuiBalanceRaw } from "@/src/lib/sui-balances";
import type { ProfileActivityItem, VaultLpReview, VaultLpSummary } from "@/src/lib/types";
import { cn } from "@/src/lib/utils";
import { explainWalletExecutionError } from "@/src/lib/wallet-errors";

const DUSDC_BASE_UNITS = 1_000_000n;
const MIN_SUI_GAS_BALANCE_MIST = 20_000_000n;
const MIST_PER_SUI = 1_000_000_000n;
const REFRESH_MS = 5_000;

export function VaultLpPage() {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();
  const dAppKit = useDAppKit();
  const searchParams = useSearchParams();
  const reviewToken = searchParams.get("review");
  const { toast } = useToast();
  const [summary, setSummary] = useState<VaultLpSummary | null>(null);
  const [review, setReview] = useState<VaultLpReview | null>(null);
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("1");
  const [walletDusdcRaw, setWalletDusdcRaw] = useState<string | null>(null);
  const [walletPlpRaw, setWalletPlpRaw] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<ProfileActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"compile" | "sign" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const loadedReviewTokenRef = useRef<string | null>(null);

  const targetNetwork = summary?.predict.network === "devnet" ? "devnet" : "testnet";
  const walletPlpValueRaw = useMemo(() => {
    if (!summary || !walletPlpRaw) {
      return null;
    }

    return Math.floor(Number(walletPlpRaw) * summary.vault.plp_share_price).toString();
  }, [summary, walletPlpRaw]);
  const supplyRaw = useMemo(() => aggregateFlow(summary, account?.address, "supply"), [account?.address, summary]);
  const withdrawRaw = useMemo(() => aggregateFlow(summary, account?.address, "withdraw"), [account?.address, summary]);
  const netSuppliedRaw = supplyRaw - withdrawRaw;
  const estimatedPnlRaw = walletPlpValueRaw === null ? null : BigInt(walletPlpValueRaw) - netSuppliedRaw;

  const loadSummary = useCallback(async () => {
    const walletQuery = account?.address ? `?wallet=${encodeURIComponent(account.address)}` : "";
    const response = await fetch(`/api/vault-lp${walletQuery}`, { cache: "no-store" });
    const payload = await response.json() as VaultLpSummary & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? "Vault LP summary unavailable.");
    }

    setSummary(payload);
  }, [account?.address]);

  useEffect(() => {
    setReceipts(readPreviewReceipts(account?.address).filter((receipt) => receipt.type === "vault_lp_supply" || receipt.type === "vault_lp_withdraw"));
  }, [account?.address]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function refresh() {
      if (inFlight || document.visibilityState !== "visible") {
        return;
      }

      inFlight = true;

      try {
        await loadSummary();
        if (!cancelled) {
          setError(null);
          setLoading(false);
        }
      } catch (summaryError) {
        if (!cancelled) {
          setError(summaryError instanceof Error ? summaryError.message : "Vault LP summary unavailable.");
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const interval = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadSummary]);

  useEffect(() => {
    if (!summary || !account?.address) {
      setWalletDusdcRaw(null);
      setWalletPlpRaw(null);
      return;
    }

    let cancelled = false;
    const client = dAppKit.getClient(summary.predict.network === "devnet" ? "devnet" : "testnet");

    Promise.all([
      client.getBalance({ owner: account.address, coinType: summary.quoteAssetType }),
      client.getBalance({ owner: account.address, coinType: summary.plpCoinType })
    ])
      .then(([dusdc, plp]) => {
        if (!cancelled) {
          setWalletDusdcRaw(readCoinBalanceRaw(dusdc).toString());
          setWalletPlpRaw(readCoinBalanceRaw(plp).toString());
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWalletDusdcRaw(null);
          setWalletPlpRaw(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [account?.address, dAppKit, summary]);

  useEffect(() => {
    const token = reviewToken;

    if (!token || loadedReviewTokenRef.current === `${token}:${account?.address ?? "no-wallet"}`) {
      return;
    }

    const stableToken = token;
    const walletAddress = account?.address ?? null;

    if (!walletAddress) {
      const pendingWalletKey = `${stableToken}:needs-wallet`;

      if (loadedReviewTokenRef.current !== pendingWalletKey) {
        loadedReviewTokenRef.current = pendingWalletKey;
        toast({
          title: "Connect wallet",
          description: "Please connect your wallet first to open this Vault LP review."
        });
      }

      return;
    }

    const reviewWalletAddress = walletAddress;
    let cancelled = false;

    async function loadReview() {
      try {
        const walletQuery = `&wallet=${encodeURIComponent(reviewWalletAddress)}`;
        const response = await fetch(`/api/review-seed?token=${encodeURIComponent(stableToken)}${walletQuery}`, {
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error("Vault LP review link is invalid or expired.");
        }

        const payload = await response.json() as { seed?: { message?: string; modeHint?: string } };

        if (payload.seed?.modeHint !== "vault_lp") {
          throw new Error("This review link is not a Vault LP review.");
        }

        if (!cancelled && payload.seed.message) {
          loadedReviewTokenRef.current = `${stableToken}:${reviewWalletAddress}`;
          await compileReview(payload.seed.message);
        }
      } catch (reviewError) {
        if (!cancelled) {
          setError(reviewError instanceof Error ? reviewError.message : "Vault LP review link failed.");
        }
      }
    }

    void loadReview();

    return () => {
      cancelled = true;
    };
  }, [account?.address, reviewToken]);

  async function compileReview(input = `${mode === "deposit" ? "Deposit" : "Withdraw"} ${amount} DUSDC ${mode === "deposit" ? "to" : "from"} Vault LP`) {
    setBusy("compile");
    setError(null);

    try {
      const response = await fetch("/api/vault-lp/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: input,
          walletAddress: account?.address
        })
      });
      const payload = await response.json() as VaultLpReview & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Vault LP review failed.");
      }

      setReview(payload);
      setSummary(payload.summary);
      setModalOpen(true);
    } catch (compileError) {
      setError(compileError instanceof Error ? compileError.message : "Vault LP review failed.");
    } finally {
      setBusy(null);
    }
  }

  async function signReview() {
    if (!review?.transactionData || !account?.address) {
      setError("Connect wallet and prepare a signable Vault LP review first.");
      return;
    }

    setBusy("sign");
    setError(null);

    try {
      if (network && network !== review.transactionData.network) {
        throw new Error(`Switch wallet network to ${review.transactionData.network} before signing.`);
      }

      const client = dAppKit.getClient(review.transactionData.network === "devnet" ? "devnet" : "testnet");
      const suiRaw = await readSuiBalanceRaw(client, account.address);

      if (suiRaw < MIN_SUI_GAS_BALANCE_MIST) {
        throw new Error(`Need testnet SUI for gas. Wallet has ${formatRawSui(suiRaw)} SUI; keep at least 0.0200 SUI available.`);
      }

      if (review.transactionData.action === "deposit") {
        const balance = readCoinBalanceRaw(await client.getBalance({
          owner: account.address,
          coinType: review.transactionData.quoteAssetType
        }));

        if (balance < BigInt(review.transactionData.amountRaw)) {
          throw new Error(`Wallet DUSDC is insufficient. Need ${formatRawDusdc(review.transactionData.amountRaw)}.`);
        }
      } else {
        const shares = review.transactionData.plpSharesRaw;

        if (!shares) {
          throw new Error("Vault LP withdraw review is missing PLP shares.");
        }

        const balance = readCoinBalanceRaw(await client.getBalance({
          owner: account.address,
          coinType: review.transactionData.plpCoinType
        }));

        if (balance < BigInt(shares)) {
          throw new Error(`Wallet PLP is insufficient. Need ${formatRawDusdc(shares)} PLP shares.`);
        }
      }

      const transaction = review.transactionData.action === "deposit"
        ? buildVaultLpSupplyTransaction({
            packageId: review.transactionData.packageId,
            predictObject: review.transactionData.predictObject,
            quoteAssetType: review.transactionData.quoteAssetType,
            amountRaw: review.transactionData.amountRaw,
            recipient: account.address
          })
        : buildVaultLpWithdrawTransaction({
            packageId: review.transactionData.packageId,
            predictObject: review.transactionData.predictObject,
            quoteAssetType: review.transactionData.quoteAssetType,
            plpCoinType: review.transactionData.plpCoinType,
            plpSharesRaw: review.transactionData.plpSharesRaw!,
            recipient: account.address
          });
      const signed = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest = getExecutedDigest(signed);
      const confirmed = await client.waitForTransaction({
        digest,
        include: {
          effects: true,
          events: true
        }
      });
      assertExecuted(confirmed);

      const receipt: StoredPreviewReceipt = {
        id: digest,
        time: new Date().toISOString(),
        type: review.transactionData.action === "deposit" ? "vault_lp_supply" : "vault_lp_withdraw",
        digest,
        summary: `${review.transactionData.action === "deposit" ? "Deposited" : "Withdrew"} ${formatRawDusdc(review.transactionData.amountRaw)} DUSDC ${review.transactionData.action === "deposit" ? "to" : "from"} Vault LP`,
        walletAddress: account.address,
        network: review.transactionData.network === "devnet" ? "devnet" : "testnet",
        status: "success",
        note: "Local Vault LP execution receipt."
      };

      storePreviewReceipt(receipt);
      setReceipts(readPreviewReceipts(account.address).filter((item) => item.type === "vault_lp_supply" || item.type === "vault_lp_withdraw"));
      toast({
        variant: "success",
        title: "Vault LP transaction executed",
        description: digest
      });
      setModalOpen(false);
      await loadSummary();
    } catch (signError) {
      setError(explainWalletExecutionError(signError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell
      title="Vault LP"
      description="Supply DUSDC into DeepBook Predict vault liquidity, receive PLP shares, and review withdrawals before signing."
      meta={<Badge variant="outline">{targetNetwork}</Badge>}
    >
      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <Card className="glass-line">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Vault className="h-4 w-4 text-muted-foreground" />
              Mint / Withdraw
            </CardTitle>
            <CardDescription>Wallet funds only. This does not use PredictManager Trading Balance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Button variant={mode === "deposit" ? "default" : "outline"} onClick={() => setMode("deposit")}>
                <ArrowDownToLine className="h-4 w-4" />
                Mint PLP
              </Button>
              <Button variant={mode === "withdraw" ? "default" : "outline"} onClick={() => setMode("withdraw")}>
                <ArrowUpFromLine className="h-4 w-4" />
                Withdraw
              </Button>
            </div>
            <label className="block space-y-1">
              <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Amount</span>
              <input
                className="h-11 w-full rounded-md border border-input bg-background/70 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="1"
              />
            </label>
            <Button className="h-11 w-full" disabled={busy !== null} onClick={() => void compileReview()}>
              {busy === "compile" ? <RefreshCw className="animate-spin" /> : <LockKeyhole />}
              Prepare Review
            </Button>
            {error ? <p className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-xs text-destructive-foreground">{error}</p> : null}
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2">
          <MetricCard label="Vault value" value={formatRawDusdc(summary?.vault.vault_value)} />
          <MetricCard label="Share price" value={summary ? `${summary.vault.plp_share_price.toFixed(6)} DUSDC` : "--"} />
          <MetricCard label="Utilization" value={summary ? `${(summary.vault.utilization * 100).toFixed(2)}%` : "--"} />
          <MetricCard label="Available withdrawal" value={formatRawDusdc(summary?.vault.available_withdrawal)} />
          <MetricCard label="Your PLP" value={walletPlpRaw === null ? "--" : `${formatRawDusdc(walletPlpRaw)} PLP`} />
          <MetricCard label="Est. value" value={formatRawDusdc(walletPlpValueRaw)} />
          <MetricCard label="Net supplied" value={`${formatRawDusdc(netSuppliedRaw)} DUSDC`} />
          <MetricCard label="P/L" value={`${formatSignedRawDusdc(estimatedPnlRaw)} DUSDC`} tone={estimatedPnlRaw === null ? "muted" : estimatedPnlRaw >= 0n ? "positive" : "negative"} />
        </div>
      </div>

      <Card className="glass-line">
        <CardHeader>
          <CardTitle>Vault LP records</CardTitle>
          <CardDescription>Indexed Predict flows plus local signed receipts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? <p className="text-sm text-muted-foreground">Loading Vault LP data...</p> : null}
          <div className="grid gap-2 lg:grid-cols-2">
            {[...(summary?.flows ?? []), ...receipts.map((receipt) => ({
              id: receipt.id,
              kind: receipt.type === "vault_lp_supply" ? "supply" as const : "withdraw" as const,
              digest: receipt.digest ?? null,
              timestampMs: Date.parse(receipt.time),
              wallet: account?.address ?? null,
              amountRaw: null,
              sharesRaw: null
            }))].slice(0, 12).map((flow) => (
              <div key={flow.id} className="rounded-md border border-border bg-background/55 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium capitalize text-foreground">{flow.kind}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{flow.timestampMs ? new Date(flow.timestampMs).toLocaleString() : "local receipt"}</p>
                  </div>
                  <Badge variant="outline">{flow.amountRaw ? `${formatRawDusdc(flow.amountRaw)} DUSDC` : "receipt"}</Badge>
                </div>
                <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{flow.digest ?? flow.id}</p>
              </div>
            ))}
          </div>
          {!loading && !summary?.flows.length && !receipts.length ? (
            <p className="rounded-md border border-border bg-background/55 p-3 text-sm text-muted-foreground">No Vault LP records for this wallet yet.</p>
          ) : null}
        </CardContent>
      </Card>

      <VaultLpReviewModal
        open={modalOpen}
        review={review}
        busy={busy === "sign"}
        walletDusdcRaw={walletDusdcRaw}
        walletPlpRaw={walletPlpRaw}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
        onClose={() => setModalOpen(false)}
        onSign={() => void signReview()}
      />
    </AppShell>
  );
}

function VaultLpReviewModal({
  open,
  review,
  busy,
  walletDusdcRaw,
  walletPlpRaw,
  detailsOpen,
  onDetailsOpenChange,
  onClose,
  onSign
}: {
  open: boolean;
  review: VaultLpReview | null;
  busy: boolean;
  walletDusdcRaw: string | null;
  walletPlpRaw: string | null;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  onClose: () => void;
  onSign: () => void;
}) {
  const canSign = Boolean(review?.transactionData && !busy);
  const isInfoOnly = review?.intent.action === "info";

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-lg border border-border bg-background shadow-2xl"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.98 }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Vault LP Review</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {review ? `${review.intent.action.toUpperCase()} · ${formatRawDusdc(review.execution.amountRaw)} DUSDC` : "Preparing review"}
                </p>
              </div>
              <button className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-4 p-4 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="space-y-3">
                <div className="rounded-md border border-border bg-background/55 p-3">
                  {(review?.timeline ?? []).map((step) => (
                    <div key={step.label} className="grid grid-cols-[24px_1fr] gap-3 py-1.5">
                      <CircleDashed className={cn("mt-0.5 h-4 w-4", step.state === "complete" ? "text-emerald-300" : step.state === "blocked" ? "text-red-300" : "animate-spin text-muted-foreground")} />
                      <div>
                        <p className="text-sm text-foreground">{step.label}</p>
                        <p className="text-xs text-muted-foreground">{step.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <MetricCard label="Wallet DUSDC" value={formatRawDusdc(walletDusdcRaw)} />
                  <MetricCard label="Wallet PLP" value={walletPlpRaw === null ? "--" : `${formatRawDusdc(walletPlpRaw)} PLP`} />
                  <MetricCard label="Share price" value={review ? `${review.summary.vault.plp_share_price.toFixed(6)}` : "--"} />
                  <MetricCard label="Available withdrawal" value={formatRawDusdc(review?.summary.vault.available_withdrawal)} />
                </div>
              </div>

              <div className="space-y-3">
                <Card className="glass-line">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Shield className="h-4 w-4 text-muted-foreground" />
                      Readiness
                    </CardTitle>
                    <CardDescription>{review?.execution.reason ?? "Waiting for review."}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {review?.execution.checks.map((check) => (
                      <div key={check.label} className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/55 p-2">
                        <div>
                          <p className="text-sm text-foreground">{check.label}</p>
                          <p className="text-xs text-muted-foreground">{check.detail}</p>
                        </div>
                        <Badge variant="outline" className={check.passed ? "text-emerald-300" : "text-red-300"}>{check.passed ? "OK" : "BLOCK"}</Badge>
                      </div>
                    ))}
                    <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onDetailsOpenChange(!detailsOpen)}>
                      {detailsOpen ? "Hide details" : "Show details"}
                    </button>
                    {detailsOpen ? (
                      <pre className="max-h-48 overflow-auto rounded-md border border-border bg-background/70 p-3 text-xs text-muted-foreground">
                        {JSON.stringify(review?.transactionData ?? review?.intent ?? null, null, 2)}
                      </pre>
                    ) : null}
                    <p className="rounded-md border border-border bg-background/55 p-3 text-xs leading-5 text-muted-foreground">{review?.disclosure}</p>
                    <Button className="h-11 w-full" disabled={!canSign} onClick={onSign}>
                      {busy ? <RefreshCw className="animate-spin" /> : canSign ? <LockKeyhole /> : <AlertTriangle />}
                      {isInfoOnly ? "No signature needed" : "Review & Sign"}
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function MetricCard({ label, value, tone = "muted" }: { label: string; value: string; tone?: "positive" | "negative" | "muted" }) {
  return (
    <div className="rounded-md border border-border bg-background/55 p-3">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className={cn("mt-2 truncate text-lg font-semibold text-foreground", tone === "positive" && "text-emerald-300", tone === "negative" && "text-red-300")}>{value}</p>
    </div>
  );
}

function aggregateFlow(summary: VaultLpSummary | null, wallet: string | undefined, kind: "supply" | "withdraw") {
  if (!summary || !wallet) {
    return 0n;
  }

  return summary.flows
    .filter((flow) => flow.kind === kind && flow.wallet?.toLowerCase() === wallet.toLowerCase())
    .reduce((total, flow) => total + parseRaw(flow.amountRaw), 0n);
}

function formatRawDusdc(value: string | number | bigint | null | undefined) {
  const raw = parseRaw(value);
  const whole = Number(raw) / Number(DUSDC_BASE_UNITS);

  return `${whole.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function formatSignedRawDusdc(value: bigint | null) {
  if (value === null) {
    return "--";
  }

  const sign = value > 0n ? "+" : value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;

  return `${sign}${formatRawDusdc(abs)}`;
}

function formatRawSui(value: bigint) {
  return (Number(value) / Number(MIST_PER_SUI)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function parseRaw(value: string | number | bigint | null | undefined) {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}
