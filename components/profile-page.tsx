"use client";

import { useCurrentAccount, useCurrentNetwork, useDAppKit } from "@mysten/dapp-kit-react";
import { AlertTriangle, Check, LockKeyhole, RefreshCw, Sparkles, Wallet } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { PredictManagerOnboardingModal } from "@/components/predict-manager-onboarding-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  assertExecuted,
  buildDepositToManagerTransaction,
  buildRedeemPermissionlessTransaction,
  buildWithdrawFromManagerTransaction,
  getExecutedDigest
} from "@/src/lib/predict-execution";
import { buildSetProfileMemoryPointerTransaction } from "@/src/lib/profile-execution";
import { readPreviewReceipts, storePreviewReceipt } from "@/src/lib/receipts";
import { readCoinBalanceRaw, readSuiBalanceRaw } from "@/src/lib/sui-balances";
import type { ProfileActivityItem, ProfilePosition, ProfileSummary } from "@/src/lib/types";
import { cn } from "@/src/lib/utils";
import { explainWalletExecutionError } from "@/src/lib/wallet-errors";

type ProfileTab = "positions" | "pnl" | "activity" | "risk" | "receipts" | "keeper";
type FundingMode = "deposit" | "withdraw";
type ValueTone = "positive" | "negative" | "muted";

const DUSDC_BASE_UNITS = 1_000_000n;
const MIN_SUI_GAS_BALANCE_MIST = 20_000_000n;
const MIST_PER_SUI = 1_000_000_000n;
const PREDICT_PRICE_SCALE = 1_000_000_000;
const PROFILE_REFRESH_MS = 3_000;

export function ProfilePage() {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();
  const dAppKit = useDAppKit();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const urlManagerId = searchParams.get("managerId");
  const highlightFunding = searchParams.get("fund") === "1";
  const highlightPlans = searchParams.get("plans") === "1";
  const [localManagerId, setLocalManagerId] = useState<string | null>(urlManagerId);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [receipts, setReceipts] = useState<ProfileActivityItem[]>([]);
  const [tab, setTab] = useState<ProfileTab>("positions");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [fundingBusy, setFundingBusy] = useState(false);
  const [fundingMode, setFundingMode] = useState<FundingMode>("deposit");
  const [fundingAmount, setFundingAmount] = useState("10");
  const [walletDusdcRaw, setWalletDusdcRaw] = useState<string | null>(null);
  const [walletDusdcLoading, setWalletDusdcLoading] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [managerPromptDismissed, setManagerPromptDismissed] = useState(false);
  const [profileStale, setProfileStale] = useState(false);
  const [lastProfileRefresh, setLastProfileRefresh] = useState<Date | null>(null);
  const [settlingPositionId, setSettlingPositionId] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const profileLoadedRef = useRef(false);
  const effectiveManagerId = localManagerId ?? urlManagerId;

  useEffect(() => {
    setReceipts(readPreviewReceipts(account?.address));
  }, [account?.address]);

  useEffect(() => {
    setLocalManagerId(urlManagerId);
  }, [urlManagerId]);

  useEffect(() => {
    setManagerPromptDismissed(false);
  }, [account?.address]);

  useEffect(() => {
    profileLoadedRef.current = false;
    setProfile(null);
    setLoading(true);
    setError(null);
    setProfileStale(false);
    setLastProfileRefresh(null);
  }, [account?.address, effectiveManagerId]);

  useEffect(() => {
    const controller = new AbortController();
    const silent = profileLoadedRef.current;

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    fetch(profileEndpoint(account?.address, effectiveManagerId), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Profile summary unavailable.");
        }

        return response.json() as Promise<ProfileSummary>;
      })
      .then((payload) => {
        profileLoadedRef.current = true;
        setProfile(payload);
        setProfileStale(false);
        setLastProfileRefresh(new Date());
        setError(null);
      })
      .catch((profileError) => {
        if (controller.signal.aborted) {
          return;
        }

        const message = profileError instanceof Error ? profileError.message : "Profile summary unavailable.";

        if (silent) {
          setProfileStale(true);
          setError(message);
          return;
        }

        setError(message);
        setProfile(null);
      })
      .finally(() => {
        if (!controller.signal.aborted && !silent) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [account?.address, effectiveManagerId, reloadNonce]);

  useEffect(() => {
    if (!account?.address || !profile?.managerLinked || fundingBusy || settlingPositionId) {
      return;
    }

    function refreshIfVisible() {
      if (document.visibilityState === "visible") {
        setReloadNonce((current) => current + 1);
      }
    }

    const interval = window.setInterval(refreshIfVisible, PROFILE_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [account?.address, fundingBusy, profile?.managerLinked, settlingPositionId]);

  useEffect(() => {
    if (!account?.address || !profile?.quoteAssetType) {
      setWalletDusdcRaw(null);
      return;
    }

    let cancelled = false;
    setWalletDusdcLoading(true);

    dAppKit.getClient(profile.network === "devnet" ? "devnet" : "testnet")
      .getBalance({
        owner: account.address,
        coinType: profile.quoteAssetType
      })
      .then((balance) => {
        if (!cancelled) {
          setWalletDusdcRaw(readCoinBalanceRaw(balance).toString());
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWalletDusdcRaw(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWalletDusdcLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [account?.address, dAppKit, profile?.network, profile?.quoteAssetType, reloadNonce]);

  const activity = useMemo(() => [...receipts, ...(profile?.activity ?? [])], [profile?.activity, receipts]);
  const portfolioSummary = useMemo(() => buildPortfolioSummary(profile), [profile]);
  const showManagerModal = Boolean(account?.address && profile?.managerNeedsCreation && !managerPromptDismissed);

  async function handleManagerCreated({
    managerId,
    digest,
    network: createdNetwork
  }: {
    managerId: string;
    digest: string;
    network: "devnet" | "testnet";
  }) {
    if (!account?.address) {
      return;
    }

    const receipt: ProfileActivityItem & {
      walletAddress: string;
      network: "devnet" | "testnet";
      status: string;
      note: string;
    } = {
      id: digest,
      time: new Date().toISOString(),
      type: "manager_create",
      digest,
      summary: "PredictManager created",
      walletAddress: account.address,
      network: createdNetwork,
      status: "success",
      note: "Created official DeepBook PredictManager. Predict server may need a short indexing delay."
    };

    storePreviewReceipt(receipt);
    setReceipts(readPreviewReceipts(account.address));
    setManagerPromptDismissed(true);
    setLocalManagerId(managerId);
    updateManagerInUrl(managerId);
    setReloadNonce((current) => current + 1);
  }

  async function handleManagerFunding() {
    if (fundingBusy) {
      return;
    }

    setFundingError(null);
    setFundingBusy(true);

    try {
      if (!account?.address) {
        throw new Error("Connect wallet before funding Trading Balance.");
      }

      if (!profile?.managerId || !profile.predictPackageId || !profile.quoteAssetType) {
        throw new Error("Create a PredictManager before funding Trading Balance.");
      }

      const targetNetwork = profile.network === "devnet" ? "devnet" : "testnet";

      if (network && network !== targetNetwork) {
        throw new Error(`Switch wallet network to ${targetNetwork} before funding Trading Balance.`);
      }

      const amountRaw = dusdcToRaw(fundingAmount);

      if (amountRaw <= 0n) {
        throw new Error("Enter a positive DUSDC amount.");
      }

      const client = dAppKit.getClient(targetNetwork);
      const suiBalance = await readSuiBalanceRaw(client, account.address);

      if (suiBalance < MIN_SUI_GAS_BALANCE_MIST) {
        throw new Error(`Need testnet SUI for gas. Wallet ${shortAddress(account.address)} has ${formatRawSui(suiBalance)} SUI on ${targetNetwork}; keep at least ${formatRawSui(MIN_SUI_GAS_BALANCE_MIST)} SUI available.`);
      }

      const transaction = fundingMode === "deposit"
        ? await buildDepositFundingTransaction(amountRaw)
        : buildWithdrawFundingTransaction(amountRaw);
      const signed = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest = getExecutedDigest(signed);
      const confirmed = await client.waitForTransaction({
        digest,
        include: {
          effects: true,
          events: true,
          objectTypes: true
        }
      });
      assertExecuted(confirmed);

      const summary = `${fundingMode === "deposit" ? "Deposited" : "Withdrew"} ${formatRawDusdc(amountRaw)} ${fundingMode === "deposit" ? "to" : "from"} Trading Balance`;
      const receipt: ProfileActivityItem & {
        walletAddress: string;
        network: "devnet" | "testnet";
        status: string;
        note: string;
      } = {
        id: digest,
        time: new Date().toISOString(),
        type: "manager_funding",
        digest,
        summary,
        walletAddress: account.address,
        network: targetNetwork,
        status: "success",
        note: "Explicit PredictManager funding operation signed by the user."
      };

      storePreviewReceipt(receipt);
      setReceipts(readPreviewReceipts(account.address));
      setReloadNonce((current) => current + 1);
      toast({
        variant: "success",
        title: fundingMode === "deposit" ? "Trading Balance funded" : "Trading Balance withdrawn",
        description: digest
      });
    } catch (fundingIssue) {
      const message = explainWalletExecutionError(fundingIssue);
      setFundingError(message);
      toast({
        variant: "destructive",
        title: "Funding failed",
        description: message
      });
    } finally {
      setFundingBusy(false);
    }
  }

  async function handleSettlePosition(position: ProfilePosition) {
    if (settlingPositionId) {
      return;
    }

    setSettleError(null);
    setSettlingPositionId(position.id);

    try {
      if (!account?.address) {
        throw new Error("Connect wallet before settling payout to Trading Balance.");
      }

      if (!profile?.managerId || !profile.predictPackageId || !profile.predictObjectId || !profile.quoteAssetType) {
        throw new Error("Create or load a PredictManager before settling this position.");
      }

      const targetNetwork = profile.network === "devnet" ? "devnet" : "testnet";

      if (network && network !== targetNetwork) {
        throw new Error(`Switch wallet network to ${targetNetwork} before settling this position.`);
      }

      const latestProfile = await fetch(profileEndpoint(account.address, effectiveManagerId))
        .then((response) => {
          if (!response.ok) {
            throw new Error("Profile summary unavailable.");
          }

          return response.json() as Promise<ProfileSummary>;
        });
      const latestPosition = findMatchingPosition(latestProfile.positions, position);

      setProfile(latestProfile);
      setProfileStale(false);
      setLastProfileRefresh(new Date());

      if (!latestPosition?.canRedeem) {
        throw new Error("This position is not ready to settle yet. Refresh after the market is settled.");
      }

      const redeemInput = buildRedeemInput(latestProfile, latestPosition);
      const client = dAppKit.getClient(targetNetwork);
      const suiBalance = await readSuiBalanceRaw(client, account.address);

      if (suiBalance < MIN_SUI_GAS_BALANCE_MIST) {
        throw new Error(`Need testnet SUI for gas. Wallet ${shortAddress(account.address)} has ${formatRawSui(suiBalance)} SUI on ${targetNetwork}; keep at least ${formatRawSui(MIN_SUI_GAS_BALANCE_MIST)} SUI available.`);
      }

      const transaction = buildRedeemPermissionlessTransaction(redeemInput);
      const signed = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest = getExecutedDigest(signed);
      const confirmed = await client.waitForTransaction({
        digest,
        include: {
          effects: true,
          events: true,
          objectTypes: true
        }
      });
      assertExecuted(confirmed);

      const receipt: ProfileActivityItem & {
        walletAddress: string;
        network: "devnet" | "testnet";
        status: string;
        note: string;
      } = {
        id: digest,
        time: new Date().toISOString(),
        type: "redeem",
        digest,
        oracleId: latestPosition.oracleId ?? undefined,
        summary: `Settled ${formatHoldingTitle(latestPosition)} payout to Trading Balance`,
        walletAddress: account.address,
        network: targetNetwork,
        status: "success",
        note: "Payout was deposited into PredictManager Trading Balance. Withdraw separately to move DUSDC back to the wallet."
      };

      storePreviewReceipt(receipt);
      setReceipts(readPreviewReceipts(account.address));
      setReloadNonce((current) => current + 1);
      toast({
        variant: "success",
        title: "Payout settled to Trading Balance",
        description: digest
      });
    } catch (settleIssue) {
      const message = explainWalletExecutionError(settleIssue);
      setSettleError(message);
      toast({
        variant: "destructive",
        title: "Settle failed",
        description: message
      });
    } finally {
      setSettlingPositionId(null);
    }
  }

  async function handleEnableWalrusMemory() {
    if (memoryBusy) {
      return;
    }

    setMemoryBusy(true);

    try {
      if (!account?.address) {
        throw new Error("Connect wallet before enabling Walrus Memory.");
      }

      if (!profile?.deepPilotProfileId || !profile.deepPilotProfilePackageId) {
        throw new Error("Create a DeepPilot Profile NFT before enabling Walrus Memory.");
      }

      const memory = profile.memory.longTermMemory;

      if (!memory.accountId || !memory.namespace) {
        throw new Error("Walrus Memory is not configured for this deployment.");
      }

      const targetNetwork = profile.network === "devnet" ? "devnet" : "testnet";

      if (network && network !== targetNetwork) {
        throw new Error(`Switch wallet network to ${targetNetwork} before enabling Walrus Memory.`);
      }

      const client = dAppKit.getClient(targetNetwork);
      const suiBalance = await readSuiBalanceRaw(client, account.address);

      if (suiBalance < MIN_SUI_GAS_BALANCE_MIST) {
        throw new Error(`Need testnet SUI for gas. Wallet ${shortAddress(account.address)} has ${formatRawSui(suiBalance)} SUI on ${targetNetwork}; keep at least ${formatRawSui(MIN_SUI_GAS_BALANCE_MIST)} SUI available.`);
      }

      const transaction = buildSetProfileMemoryPointerTransaction({
        packageId: profile.deepPilotProfilePackageId,
        profileId: profile.deepPilotProfileId,
        memoryAccountId: memory.accountId,
        memoryNamespace: memory.namespace,
        memoryRootBlobId: memory.rootBlobId
      });
      const signed = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest = getExecutedDigest(signed);
      const confirmed = await client.waitForTransaction({
        digest,
        include: {
          effects: true,
          events: true,
          objectTypes: true
        }
      });
      assertExecuted(confirmed);

      const receipt: ProfileActivityItem & {
        walletAddress: string;
        network: "devnet" | "testnet";
        status: string;
        note: string;
      } = {
        id: digest,
        time: new Date().toISOString(),
        type: "memory_pointer",
        digest,
        summary: "Enabled Walrus Memory pointer",
        walletAddress: account.address,
        network: targetNetwork,
        status: "success",
        note: "Profile NFT now points to the DeepPilot Walrus Memory namespace. This does not grant trading permission."
      };

      storePreviewReceipt(receipt);
      setReceipts(readPreviewReceipts(account.address));
      setReloadNonce((current) => current + 1);
      toast({
        variant: "success",
        title: "Walrus Memory enabled",
        description: digest
      });
    } catch (memoryIssue) {
      const message = explainWalletExecutionError(memoryIssue);
      toast({
        variant: "destructive",
        title: "Memory setup failed",
        description: message
      });
    } finally {
      setMemoryBusy(false);
    }
  }

  async function buildDepositFundingTransaction(amountRaw: bigint) {
    if (!profile || !account?.address) {
      throw new Error("Profile is not loaded.");
    }

    const walletBalance = readCoinBalanceRaw(await dAppKit.getClient(profile.network === "devnet" ? "devnet" : "testnet").getBalance({
      owner: account.address,
      coinType: profile.quoteAssetType
    }));

    if (walletBalance < amountRaw) {
      throw new Error(`Wallet DUSDC is insufficient. Need ${formatRawDusdc(amountRaw)}; wallet has ${formatRawDusdc(walletBalance)}.`);
    }

    return buildDepositToManagerTransaction({
      packageId: profile.predictPackageId,
      managerId: profile.managerId!,
      quoteAssetType: profile.quoteAssetType,
      amountRaw: amountRaw.toString()
    });
  }

  function buildWithdrawFundingTransaction(amountRaw: bigint) {
    if (!profile || !account?.address) {
      throw new Error("Profile is not loaded.");
    }

    const tradingBalanceRaw = parseRawAmount(profile.tradingBalanceRaw);

    if (tradingBalanceRaw < amountRaw) {
      throw new Error(`Trading Balance is insufficient. Available ${formatRawDusdc(tradingBalanceRaw)}.`);
    }

    return buildWithdrawFromManagerTransaction({
      packageId: profile.predictPackageId,
      managerId: profile.managerId!,
      quoteAssetType: profile.quoteAssetType,
      amountRaw: amountRaw.toString(),
      recipient: account.address
    });
  }

  return (
    <AppShell
      title="Profile and portfolio"
      description="Track Predict positions, live value, settlement results, and Trading Balance."
      meta={
        <>
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-border bg-card text-muted-foreground"
            onClick={() => setReloadNonce((current) => current + 1)}
            disabled={fundingBusy || Boolean(settlingPositionId)}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
          <Badge variant="outline" className={cn("h-8 border-border bg-card", profileStale ? "text-amber-200" : "text-emerald-200")}>
            {profileStale ? "stale" : lastProfileRefresh ? "live" : "loading"}
          </Badge>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {network ?? profile?.network ?? "testnet"}
          </Badge>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {account ? shortAddress(account.address) : "wallet required"}
          </Badge>
        </>
      }
    >
      <PredictManagerOnboardingModal
        open={showManagerModal}
        packageId={profile?.predictPackageId}
        network={profile?.network === "devnet" ? "devnet" : "testnet"}
        walletAddress={account?.address}
        context="profile"
        onDismiss={() => setManagerPromptDismissed(true)}
        onCreated={handleManagerCreated}
      />

      {error && !profile ? (
        <Card className="mb-3 border-destructive/35 bg-destructive/10">
          <CardContent className="flex items-center gap-3 pt-5 text-sm text-destructive-foreground">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      ) : null}

      {profileStale && profile ? (
        <Card className="mb-3 border-amber-300/30 bg-amber-500/10">
          <CardContent className="flex items-center gap-3 pt-5 text-sm text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            Live refresh failed. Showing the last portfolio snapshot.
          </CardContent>
        </Card>
      ) : null}

      {settleError ? (
        <Card className="mb-3 border-destructive/35 bg-destructive/10">
          <CardContent className="flex items-center gap-3 pt-5 text-sm text-destructive-foreground">
            <AlertTriangle className="h-4 w-4" />
            {settleError}
          </CardContent>
        </Card>
      ) : null}

      <div className="profile-grid grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="profile-main-column space-y-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Trading Balance" value={formatDusdc(profile?.tradingBalanceDusdc ?? null)} />
            <SummaryCard label="Open Value" value={formatDusdc(portfolioSummary.openValueDusdc)} detail="Live estimate when available" />
            <SummaryCard label="Pending Payout" value={formatDusdc(portfolioSummary.pendingPayoutDusdc)} detail="Settle to balance when ready" />
            <SummaryCard
              label="Portfolio P/L"
              value={formatSignedDusdc(portfolioSummary.portfolioPnlDusdc)}
              detail={portfolioSummary.pnlSource}
              tone={signedTone(portfolioSummary.portfolioPnlDusdc)}
              pulseKey={formatSignedDusdc(portfolioSummary.portfolioPnlDusdc)}
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap gap-2">
                {(["positions", "pnl", "activity", "risk", "receipts", "keeper"] as const).map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={tab === item ? "default" : "outline"}
                    onClick={() => setTab(item)}
                  >
                    {item}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <TabContent
                tab={tab}
                activity={activity}
                loading={loading}
                managerLinked={Boolean(profile?.managerId)}
                profile={profile}
                settlingPositionId={settlingPositionId}
                onSettlePosition={handleSettlePosition}
                memoryBusy={memoryBusy}
                onEnableWalrusMemory={handleEnableWalrusMemory}
              />
            </CardContent>
          </Card>
        </section>

        <aside className="profile-funding-column space-y-3">
          <TradingBalanceFundingCard
            profile={profile}
            accountAddress={account?.address}
            walletDusdcRaw={walletDusdcRaw}
            walletDusdcLoading={walletDusdcLoading}
            mode={fundingMode}
            amount={fundingAmount}
            busy={fundingBusy}
            error={fundingError}
            highlighted={highlightFunding}
            onModeChange={setFundingMode}
            onAmountChange={setFundingAmount}
            onSubmit={handleManagerFunding}
          />
          <PlanStatusCard highlighted={highlightPlans} />
          <Card className="glass-line">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Wallet</CardTitle>
                  <CardDescription>{account ? shortAddress(account.address) : "Connect wallet to personalize"}</CardDescription>
                </div>
                <Wallet className="h-5 w-5 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatusRow label="Wallet connected" active={Boolean(account)} />
              <StatusRow label="PredictManager linked" active={Boolean(profile?.managerId)} />
              <StatusRow label="Local receipts" active={receipts.length > 0} />
              <StatusRow label="Walrus Memory" active={profile?.memory.longTermMemory.status === "enabled"} />
              <div className="rounded-md border border-border bg-background/60 p-3 text-sm leading-6 text-muted-foreground">
                {profile?.message ?? "Loading profile state."}
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </AppShell>
  );
}

function PlanStatusCard({ highlighted }: { highlighted: boolean }) {
  return (
    <Card className={`glass-line ${highlighted ? "border-foreground/45 shadow-[0_0_0_1px_rgba(250,250,250,0.18)]" : ""}`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>AI Plan</CardTitle>
            <CardDescription>Telegram and Web AI quota policy.</CardDescription>
          </div>
          <Sparkles className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <PlanRow label="Standard" detail="10/day future limit" active />
        <PlanRow label="Pro" detail="50/day · 0.1 SUI/month" />
        <PlanRow label="Max" detail="100/day · 0.1 SUI/month" />
        <p className="rounded-md border border-border bg-background/60 p-3 text-xs leading-5 text-muted-foreground">
          Demo quota is enforced as 50 AI messages/day for all plans. Use Telegram login to bind Profile NFT and subscribe.
        </p>
      </CardContent>
    </Card>
  );
}

function PlanRow({ label, detail, active = false }: { label: string; detail: string; active?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {active ? <Badge variant="outline" className="border-border text-muted-foreground">default</Badge> : null}
    </div>
  );
}

function TradingBalanceFundingCard({
  profile,
  accountAddress,
  walletDusdcRaw,
  walletDusdcLoading,
  mode,
  amount,
  busy,
  error,
  highlighted,
  onModeChange,
  onAmountChange,
  onSubmit
}: {
  profile: ProfileSummary | null;
  accountAddress?: string;
  walletDusdcRaw: string | null;
  walletDusdcLoading: boolean;
  mode: FundingMode;
  amount: string;
  busy: boolean;
  error: string | null;
  highlighted: boolean;
  onModeChange: (mode: FundingMode) => void;
  onAmountChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const managerReady = Boolean(profile?.managerId);
  const canSubmit = Boolean(accountAddress && managerReady && !busy);

  return (
    <Card className={`glass-line ${highlighted ? "border-foreground/45 shadow-[0_0_0_1px_rgba(250,250,250,0.18)]" : ""}`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Trading Balance</CardTitle>
            <CardDescription>Fund PredictManager before opening positions.</CardDescription>
          </div>
          <Wallet className="h-5 w-5 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <BalanceBox label="Wallet DUSDC" value={walletDusdcLoading ? "loading" : formatRawDusdc(walletDusdcRaw)} />
          <BalanceBox label="Trading Balance" value={formatRawDusdc(profile?.tradingBalanceRaw)} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant={mode === "deposit" ? "default" : "outline"} onClick={() => onModeChange("deposit")}>
            Deposit
          </Button>
          <Button type="button" variant={mode === "withdraw" ? "default" : "outline"} onClick={() => onModeChange("withdraw")}>
            Withdraw
          </Button>
        </div>

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Amount</span>
          <input
            className="h-10 w-full rounded-md border border-input bg-background/70 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            inputMode="decimal"
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            placeholder="10"
          />
        </label>

        <Button className="h-10 w-full" disabled={!canSubmit} onClick={onSubmit}>
          {busy ? <RefreshCw className="animate-spin" /> : <LockKeyhole />}
          {mode === "deposit" ? "Deposit DUSDC" : "Withdraw DUSDC"}
        </Button>

        {!managerReady ? (
          <p className="rounded-md border border-border bg-background/60 p-3 text-xs leading-5 text-muted-foreground">
            Create a PredictManager before funding Trading Balance.
          </p>
        ) : null}

        {error ? (
          <p className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-xs leading-5 text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BalanceBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

function TabContent({
  tab,
  activity,
  loading,
  managerLinked,
  profile,
  settlingPositionId,
  onSettlePosition,
  memoryBusy,
  onEnableWalrusMemory
}: {
  tab: ProfileTab;
  activity: ProfileActivityItem[];
  loading: boolean;
  managerLinked: boolean;
  profile: ProfileSummary | null;
  settlingPositionId: string | null;
  onSettlePosition: (position: ProfilePosition) => void;
  memoryBusy: boolean;
  onEnableWalrusMemory: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading profile.
      </div>
    );
  }

  if (tab === "activity" || tab === "receipts") {
    const items = tab === "receipts"
      ? activity.filter((item) => item.type === "sponsor_preview" || item.type === "manager_create" || item.type === "manager_funding" || item.type === "predict_mint" || item.type === "redeem" || item.type === "memory_pointer")
      : activity;

    return items.length ? (
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="rounded-md border border-border bg-background/60 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{item.summary}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{item.digest ?? item.oracleId ?? item.id}</p>
              </div>
              <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
                {item.type}
              </Badge>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <EmptyState text="No local execution receipts yet." />
    );
  }

  if (tab === "positions") {
    if (!managerLinked) {
      return <EmptyState text="Create a PredictManager before DeepPilot can show server-indexed positions or PnL." />;
    }

    if (!profile?.positions.length) {
      return <EmptyState text="No Predict positions returned by the public server for this manager." />;
    }

    return (
      <PositionsTable
        positions={profile.positions}
        settlingPositionId={settlingPositionId}
        onSettlePosition={onSettlePosition}
      />
    );
  }

  if (tab === "pnl") {
    return profile?.pnl ? (
      <div className="grid gap-3 md:grid-cols-3">
        <PnlCard label="Unrealized PnL" value={formatSignedDusdc(profile.pnl.unrealizedPnlDusdc)} tone={signedTone(profile.pnl.unrealizedPnlDusdc)} />
        <PnlCard label="Realized PnL" value={formatSignedDusdc(profile.pnl.realizedPnlDusdc)} tone={signedTone(profile.pnl.realizedPnlDusdc)} />
        <PnlCard label="Total PnL" value={formatSignedDusdc(profile.pnl.totalPnlDusdc)} tone={signedTone(profile.pnl.totalPnlDusdc)} />
        <div className="rounded-md border border-border bg-background/60 p-3 md:col-span-3">
          <p className="text-sm font-medium text-foreground">Server indexed PnL</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Source: DeepBook Predict public server · Range: {profile.pnl.range}. This is indexed portfolio data, not live quote mark-to-market.
          </p>
        </div>
      </div>
    ) : (
      <EmptyState text={managerLinked ? "Predict server did not return PnL fields for this manager yet." : "Create a PredictManager before PnL can be indexed."} />
    );
  }

  if (tab === "risk") {
    return profile ? (
      <div className="grid gap-3 lg:grid-cols-2">
        <PolicyBox title="Public index" items={profile.indexPolicy.publicValues} />
        <PolicyBox title="Consent required" items={profile.indexPolicy.consentRequiredValues} />
        <PolicyBox title="Private memory" items={profile.indexPolicy.privateValues} />
        <MemoryPreviewPanel profile={profile} busy={memoryBusy} onEnable={onEnableWalrusMemory} />
      </div>
    ) : (
      <EmptyState text="Guardian risk logs start from local preview receipts and future on-chain audit events." />
    );
  }

  if (!profile?.keeper.items.length) {
    return <EmptyState text="Keeper has no replayed positions for this wallet yet." />;
  }

  return (
    <div className="space-y-2">
      {profile.keeper.items.map((item) => (
        <div key={`${item.oracleId}-${item.action}`} className="rounded-md border border-border bg-background/60 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{item.action}</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.oracleId}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.detail}</p>
            </div>
            <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
              {item.status}
            </Badge>
          </div>
        </div>
      ))}
    </div>
  );
}

function MemoryPreviewPanel({
  profile,
  busy,
  onEnable
}: {
  profile: ProfileSummary;
  busy: boolean;
  onEnable: () => void;
}) {
  const memory = profile.memory.longTermMemory;
  const canEnable = memory.status === "fallback" && Boolean(profile.deepPilotProfileId && profile.deepPilotProfilePackageId && memory.accountId && memory.namespace);

  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Walrus Memory</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            App delegate memory for Telegram and Web context. It stores approved summaries, not raw chats, signatures, or wallet keys.
          </p>
        </div>
        <LockKeyhole className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-3 grid gap-2 rounded-md border border-border bg-background/50 p-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Status</span>
          <Badge variant="outline" className="border-border text-muted-foreground">{memory.status}</Badge>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Namespace</span>
          <span className="truncate font-mono text-foreground">{memory.namespace ?? "not linked"}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Account</span>
          <span className="truncate font-mono text-foreground">{memory.accountId ? shortAddress(memory.accountId) : "not configured"}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Mode</span>
          <span className="font-mono text-foreground">{memory.delegateMode}</span>
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {profile.memory.preview.keys.map((item) => (
          <div key={item.key} className="rounded-md border border-border bg-background/50 p-2">
            <p className="text-xs font-medium text-foreground">{item.label}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.value}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onEnable} disabled={!canEnable || busy}>
          <LockKeyhole className="mr-2 h-4 w-4" />
          {memory.status === "enabled" ? "Enabled" : busy ? "Enabling..." : "Enable Walrus Memory"}
        </Button>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Disable/revoke is intentionally not simulated here. Until a revoke flow is added, clearing Telegram fallback does not delete Walrus Memory blobs.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        {profile.memory.longTermMemory.provider} · {profile.memory.longTermMemory.lastSyncedAt ? `synced ${profile.memory.longTermMemory.lastSyncedAt}` : "Profile pointer required"}
      </p>
    </div>
  );
}

function PolicyBox({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <Badge key={item} variant="outline" className="border-border text-muted-foreground">
            {item}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function PositionsTable({
  positions,
  settlingPositionId,
  onSettlePosition
}: {
  positions: ProfilePosition[];
  settlingPositionId: string | null;
  onSettlePosition: (position: ProfilePosition) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/45">
      <div className="hidden grid-cols-[1.5fr_0.8fr_0.95fr_0.8fr_1fr] gap-3 border-b border-border bg-card/60 px-4 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground lg:grid">
        <span>Outcome</span>
        <span>Stake</span>
        <span>Value</span>
        <span>P/L</span>
        <span>Result</span>
      </div>
      <div className="divide-y divide-border/75">
      {positions.map((position) => (
        <PositionRow
          key={position.id}
          position={position}
          settling={settlingPositionId === position.id}
          onSettlePosition={onSettlePosition}
        />
      ))}
      </div>
    </div>
  );
}

function PositionRow({
  position,
  settling,
  onSettlePosition
}: {
  position: ProfilePosition;
  settling: boolean;
  onSettlePosition: (position: ProfilePosition) => void;
}) {
  const view = positionPortfolioView(position);

  return (
    <div className="grid gap-3 px-4 py-4 lg:grid-cols-[1.5fr_0.8fr_0.95fr_0.8fr_1fr] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-foreground">{formatHoldingTitle(position)}</p>
          <Badge variant="outline" className="border-border text-muted-foreground">
            {formatPositionStrike(position)}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{view.timeline}</p>
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer text-muted-foreground/80 hover:text-foreground">Details</summary>
          <div className="mt-2 space-y-1 rounded-md border border-border bg-background/55 p-2">
            <p>Quantity: {formatDusdc(position.openQuantityDusdc)}</p>
            <p>Status: {position.status || "--"}</p>
            <p>Estimate: {formatQuoteStatus(position.quoteStatus)}</p>
            <p className="break-all">Oracle: {position.oracleId ?? "--"}</p>
          </div>
        </details>
      </div>

      <PositionValueCell label="Stake" value={formatDusdc(view.stakeDusdc)} detail="Cost basis" />
      <PositionValueCell label={view.valueLabel} value={formatDusdc(view.displayValueDusdc)} detail={view.valueDetail} pulseKey={formatDusdc(view.displayValueDusdc)} />
      <PositionValueCell
        label="P/L"
        value={formatSignedDusdc(view.displayPnlDusdc)}
        detail={view.pnlDetail}
        tone={signedTone(view.displayPnlDusdc)}
        pulseKey={formatSignedDusdc(view.displayPnlDusdc)}
      />

      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:block">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground lg:hidden">Result</span>
        <Badge variant="outline" className={cn("border-border", view.resultClassName)}>
          {view.resultLabel}
        </Badge>
        {view.canSettle ? (
          <Button
            className="mt-0 h-8 lg:mt-2"
            size="sm"
            disabled={settling}
            onClick={() => onSettlePosition(position)}
          >
            {settling ? <RefreshCw className="animate-spin" /> : <LockKeyhole />}
            Settle to Balance
          </Button>
        ) : (
          <p className="mt-0 text-xs text-muted-foreground lg:mt-2">{view.actionHint}</p>
        )}
      </div>
    </div>
  );
}

function PositionValueCell({
  label,
  value,
  detail,
  tone = "muted",
  pulseKey
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "positive" | "negative" | "muted";
  pulseKey?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground lg:hidden">{label}</p>
      <p
        key={pulseKey ?? value}
        className={cn(
          "mt-1 truncate text-sm font-semibold pnl-flash lg:mt-0",
          toneClassName(tone)
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function PnlCard({ label, value, tone = "muted" }: { label: string; value: string; tone?: "positive" | "negative" | "muted" }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className={cn("mt-2 text-xl font-semibold tracking-tight", toneClassName(tone))}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">Server indexed PnL</p>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  tone = "muted",
  pulseKey
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative" | "muted";
  pulseKey?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <p key={pulseKey ?? value} className={cn("mt-2 truncate text-xl font-semibold tracking-tight pnl-flash", toneClassName(tone))}>
          {value}
        </p>
        {detail ? <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}

function StatusRow({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/60 p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      {active ? <Check className="h-4 w-4 text-emerald-200" /> : <span className="h-2 w-2 rounded-full bg-muted-foreground/45" />}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-md border border-border bg-background/60 p-4 text-sm text-muted-foreground">{text}</div>;
}

function formatDusdc(value: number | null) {
  return value === null ? "--" : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC`;
}

function formatRawDusdc(value: string | bigint | null | undefined) {
  if (value === null || value === undefined) {
    return "--";
  }

  const raw = typeof value === "bigint" ? value : parseRawAmount(value);
  const whole = Number(raw) / Number(DUSDC_BASE_UNITS);

  return `${whole.toLocaleString(undefined, {
    minimumFractionDigits: whole > 0 && whole < 1 ? 4 : 2,
    maximumFractionDigits: whole > 0 && whole < 1 ? 6 : 2
  })} DUSDC`;
}

function formatRawSui(value: string | bigint | null | undefined) {
  const raw = typeof value === "bigint" ? value : parseRawAmount(value);
  const whole = Number(raw) / Number(MIST_PER_SUI);

  return whole.toLocaleString(undefined, {
    minimumFractionDigits: whole > 0 && whole < 1 ? 4 : 2,
    maximumFractionDigits: whole > 0 && whole < 1 ? 6 : 4
  });
}

function dusdcToRaw(value: string) {
  const trimmed = value.trim();

  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    return 0n;
  }

  const [whole, fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.padEnd(6, "0");

  return BigInt(whole) * DUSDC_BASE_UNITS + BigInt(paddedFraction);
}

function parseRawAmount(value?: string | null) {
  return value && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function formatSignedDusdc(value: number | null) {
  if (value === null) {
    return "--";
  }

  const sign = value > 0 ? "+" : "";

  return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC`;
}

function formatHoldingTitle(position: ProfilePosition) {
  const market = position.market ?? "Predict";
  const side = formatDirection(position);

  return side === "--" ? market : `${market} ${side}`;
}

function formatDirection(position: ProfilePosition) {
  if (position.kind === "range") {
    return "RANGE";
  }

  return position.direction ? position.direction.toUpperCase() : "--";
}

function formatPositionStrike(position: ProfilePosition) {
  if (position.kind === "range") {
    return `${formatUsdNumber(position.lowerStrike)} - ${formatUsdNumber(position.upperStrike)}`;
  }

  return formatUsdNumber(position.strike);
}

function formatUsdNumber(value: number | null) {
  return value === null
    ? "--"
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatExpiry(expiry: number | null) {
  if (expiry === null) {
    return "--";
  }

  const timestamp = expiry > 10_000_000_000 ? expiry : expiry * 1000;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function buildPortfolioSummary(profile: ProfileSummary | null) {
  if (!profile) {
    return {
      openValueDusdc: null,
      pendingPayoutDusdc: null,
      portfolioPnlDusdc: null,
      pnlSource: "No positions"
    };
  }

  const openValues = profile.positions
    .filter((position) => !position.canRedeem && position.action === "monitor_settlement")
    .map((position) => positionPortfolioView(position).displayValueDusdc)
    .filter(isNumber);
  const pendingPayouts = profile.positions
    .filter((position) => position.canRedeem)
    .map((position) => positionPortfolioView(position).displayValueDusdc)
    .filter(isNumber);
  const positionPnls = profile.positions
    .map((position) => positionPortfolioView(position).displayPnlDusdc)
    .filter(isNumber);

  return {
    openValueDusdc: sumOrNull(openValues) ?? 0,
    pendingPayoutDusdc: sumOrNull(pendingPayouts) ?? profile.redeemableValueDusdc ?? 0,
    portfolioPnlDusdc: sumOrNull(positionPnls) ?? profile.pnl?.unrealizedPnlDusdc ?? null,
    pnlSource: positionPnls.length > 0 ? "Position estimates" : profile.pnl ? "Server indexed" : "Unavailable"
  };
}

function positionPortfolioView(position: ProfilePosition) {
  const emptyPosition = (position.openQuantityDusdc ?? 0) <= 0;
  const settled = position.canRedeem || position.quoteStatus === "settled" || emptyPosition;
  const stakeDusdc = position.costBasisDusdc ?? position.openQuantityDusdc;
  const rawDisplayValueDusdc = settled
    ? position.currentValueDusdc ?? position.liveExitValueDusdc
    : position.liveExitValueDusdc ?? position.currentValueDusdc;
  const displayValueDusdc = rawDisplayValueDusdc ?? (emptyPosition ? 0 : null);
  const displayPnlDusdc = position.livePnlDusdc ??
    (emptyPosition ? position.realizedPnlDusdc ?? position.unrealizedPnlDusdc : position.unrealizedPnlDusdc);
  const hasQuantity = (position.openQuantityDusdc ?? 0) > 0;
  const won = displayPnlDusdc !== null && displayPnlDusdc > 0;
  const lost = displayPnlDusdc !== null && displayPnlDusdc < 0;
  const resultLabel = portfolioResultLabel(position, displayPnlDusdc);

  return {
    stakeDusdc,
    displayValueDusdc,
    displayPnlDusdc,
    valueLabel: settled ? "Payout" : "Current value",
    valueDetail: emptyPosition ? "Settled to balance" : settled ? "Settlement value" : formatQuoteStatus(position.quoteStatus),
    pnlDetail: position.livePnlDusdc !== null
      ? "Live estimate"
      : position.unrealizedPnlDusdc !== null ? "Indexed estimate" : "--",
    timeline: settled ? `Settled ${formatExpiry(position.expiry)}` : `Resolves ${formatExpiry(position.expiry)}`,
    resultLabel,
    resultClassName: resultLabel === "Payout ready" || won
      ? "text-emerald-200"
      : lost ? "text-destructive" : "text-muted-foreground",
    canSettle: Boolean(position.canRedeem && hasQuantity && isRedeemableBinaryPosition(position)),
    actionHint: position.canRedeem
      ? "Settlement data is incomplete."
      : position.action === "monitor_settlement"
        ? "Waiting for market settlement."
        : emptyPosition ? "Settled to Trading Balance."
        : "No action required."
  };
}

function portfolioResultLabel(position: ProfilePosition, pnl: number | null) {
  if (position.canRedeem) {
    if (pnl === null) {
      return "Payout ready";
    }

    return pnl >= 0 ? "Won" : "Lost";
  }

  const status = position.status.toLowerCase();

  if ((position.openQuantityDusdc ?? 0) <= 0 || status.includes("settled") || status.includes("closed") || status.includes("redeemed")) {
    if (pnl === null) {
      return "Settled";
    }

    return pnl >= 0 ? "Won" : "Lost";
  }

  if (position.action === "monitor_settlement") {
    return "Awaiting settlement";
  }

  return "Indexing";
}

function isRedeemableBinaryPosition(position: ProfilePosition): position is ProfilePosition & {
  oracleId: string;
  expiry: number;
  strike: number;
  direction: "up" | "down";
  openQuantityRaw: string;
} {
  return position.kind === "binary" &&
    Boolean(position.oracleId) &&
    typeof position.expiry === "number" &&
    typeof position.strike === "number" &&
    (position.direction === "up" || position.direction === "down") &&
    Boolean(position.openQuantityRaw && /^\d+$/.test(position.openQuantityRaw));
}

function buildRedeemInput(profile: ProfileSummary, position: ProfilePosition) {
  if (!profile.managerId) {
    throw new Error("PredictManager is missing.");
  }

  if (!isRedeemableBinaryPosition(position)) {
    throw new Error("This settled position is missing the fields needed to settle to Trading Balance.");
  }

  return {
    packageId: profile.predictPackageId,
    predictObject: profile.predictObjectId,
    managerId: profile.managerId,
    oracleId: position.oracleId,
    quoteAssetType: profile.quoteAssetType,
    expiry: position.expiry,
    strikeScaled: toPredictScaledPrice(position.strike),
    direction: position.direction,
    quantityRaw: position.openQuantityRaw
  };
}

function findMatchingPosition(positions: ProfilePosition[], target: ProfilePosition) {
  return positions.find((position) => position.id === target.id) ??
    positions.find((position) => Boolean(position.oracleId && position.oracleId === target.oracleId));
}

function profileEndpoint(wallet?: string | null, managerId?: string | null) {
  const params = new URLSearchParams();

  if (wallet) {
    params.set("wallet", wallet);
  }

  if (managerId) {
    params.set("managerId", managerId);
  }

  const query = params.toString();

  return query ? `/api/profile?${query}` : "/api/profile";
}

function signedTone(value: number | null): ValueTone {
  if (value === null || value === 0) {
    return "muted";
  }

  return value > 0 ? "positive" : "negative";
}

function toneClassName(tone: ValueTone) {
  if (tone === "positive") {
    return "text-emerald-200";
  }

  if (tone === "negative") {
    return "text-destructive";
  }

  return "text-foreground";
}

function sumOrNull(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toPredictScaledPrice(value: number) {
  return Math.round(value * PREDICT_PRICE_SCALE);
}

function formatQuoteStatus(status: ProfilePosition["quoteStatus"]) {
  if (status === "live") {
    return "Live estimate";
  }

  if (status === "indexed") {
    return "Indexed estimate";
  }

  if (status === "settled") {
    return "Settled";
  }

  return "Unavailable";
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function updateManagerInUrl(managerId: string) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("managerId", managerId);
  window.history.replaceState(null, "", url.toString());
}
