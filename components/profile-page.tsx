"use client";

import { useCurrentAccount, useCurrentNetwork } from "@mysten/dapp-kit-react";
import { AlertTriangle, Check, LockKeyhole, RefreshCw, Wallet } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { PredictManagerOnboardingModal } from "@/components/predict-manager-onboarding-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readPreviewReceipts, storePreviewReceipt } from "@/src/lib/receipts";
import type { ProfileActivityItem, ProfilePosition, ProfileSummary } from "@/src/lib/types";

type ProfileTab = "positions" | "pnl" | "activity" | "risk" | "receipts" | "keeper";

export function ProfilePage() {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();
  const searchParams = useSearchParams();
  const urlManagerId = searchParams.get("managerId");
  const [localManagerId, setLocalManagerId] = useState<string | null>(urlManagerId);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [receipts, setReceipts] = useState<ProfileActivityItem[]>([]);
  const [tab, setTab] = useState<ProfileTab>("positions");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [managerPromptDismissed, setManagerPromptDismissed] = useState(false);
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
    const params = new URLSearchParams();

    if (account?.address) {
      params.set("wallet", account.address);
    }

    if (effectiveManagerId) {
      params.set("managerId", effectiveManagerId);
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/profile?${params.toString()}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Profile summary unavailable.");
        }

        return response.json() as Promise<ProfileSummary>;
      })
      .then((payload) => {
        if (!cancelled) {
          setProfile(payload);
        }
      })
      .catch((profileError) => {
        if (!cancelled) {
          setError(profileError instanceof Error ? profileError.message : "Profile summary unavailable.");
          setProfile(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [account?.address, effectiveManagerId, reloadNonce]);

  const activity = useMemo(() => [...receipts, ...(profile?.activity ?? [])], [profile?.activity, receipts]);
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

  return (
    <AppShell
      title="Profile and portfolio"
      description="Review PredictManager state, server-indexed positions, PnL, local execution receipts, and keeper status."
      meta={
        <>
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

      {error ? (
        <Card className="mb-3 border-destructive/35 bg-destructive/10">
          <CardContent className="flex items-center gap-3 pt-5 text-sm text-destructive-foreground">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <SummaryCard label="Trading balance" value={formatDusdc(profile?.tradingBalanceDusdc ?? null)} />
            <SummaryCard label="Open exposure" value={formatDusdc(profile?.openExposureDusdc ?? null)} />
            <SummaryCard label="Unrealized PnL" value={formatSignedDusdc(profile?.pnl?.unrealizedPnlDusdc ?? null)} />
            <SummaryCard label="Realized PnL" value={formatSignedDusdc(profile?.realizedPnlDusdc ?? null)} />
            <SummaryCard label="Redeemable" value={formatDusdc(profile?.redeemableValueDusdc ?? null)} />
            <SummaryCard label="Awaiting settlement" value={formatCount(profile?.awaitingSettlement ?? null)} />
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
              />
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-3">
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
              <StatusRow label="Memory preview" active={profile?.memory.preview.status === "preview_only"} />
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

function TabContent({
  tab,
  activity,
  loading,
  managerLinked,
  profile
}: {
  tab: ProfileTab;
  activity: ProfileActivityItem[];
  loading: boolean;
  managerLinked: boolean;
  profile: ProfileSummary | null;
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
      ? activity.filter((item) => item.type === "sponsor_preview" || item.type === "manager_create" || item.type === "predict_mint")
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

    return <PositionsTable positions={profile.positions} />;
  }

  if (tab === "pnl") {
    return profile?.pnl ? (
      <div className="grid gap-3 md:grid-cols-3">
        <PnlCard label="Unrealized PnL" value={formatSignedDusdc(profile.pnl.unrealizedPnlDusdc)} />
        <PnlCard label="Realized PnL" value={formatSignedDusdc(profile.pnl.realizedPnlDusdc)} />
        <PnlCard label="Total PnL" value={formatSignedDusdc(profile.pnl.totalPnlDusdc)} />
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
        <MemoryPreviewPanel profile={profile} />
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

function MemoryPreviewPanel({ profile }: { profile: ProfileSummary }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Encrypted memory preview</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{profile.memory.preview.policy}</p>
        </div>
        <LockKeyhole className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-3 grid gap-2">
        {profile.memory.preview.keys.map((item) => (
          <div key={item.key} className="rounded-md border border-border bg-background/50 p-2">
            <p className="text-xs font-medium text-foreground">{item.label}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {profile.memory.longTermMemory.provider} · {profile.memory.longTermMemory.namespace ?? "wallet required"}
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

function PositionsTable({ positions }: { positions: ProfilePosition[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/45">
      <div className="hidden grid-cols-[1.5fr_0.9fr_0.9fr_0.9fr] gap-3 border-b border-border bg-card/60 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground lg:grid">
        <span>Holding</span>
        <span>Exit value</span>
        <span>PnL</span>
        <span>Status</span>
      </div>
      <div className="divide-y divide-border/75">
        {positions.map((position) => (
          <PositionRow key={position.id} position={position} />
        ))}
      </div>
    </div>
  );
}

function PositionRow({ position }: { position: ProfilePosition }) {
  const exitValue = positionExitValue(position);
  const pnlValue = positionPnlValue(position);

  return (
    <div className="grid gap-4 px-3 py-3 lg:grid-cols-[1.5fr_0.9fr_0.9fr_0.9fr] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{formatHoldingTitle(position)}</p>
          <Badge variant="outline" className="border-border text-muted-foreground">
            {formatDusdc(position.openQuantityDusdc)}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Expires {formatExpiry(position.expiry)}</p>
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer text-muted-foreground/80 hover:text-foreground">Details</summary>
          <div className="mt-2 space-y-1 rounded-md border border-border bg-background/55 p-2">
            <p>Strike: {formatPositionStrike(position)}</p>
            <p className="break-all">Oracle: {position.oracleId ?? "--"}</p>
            <p>Estimate: {formatQuoteStatus(position.quoteStatus)}</p>
          </div>
        </details>
      </div>

      <PortfolioMetric
        label="Exit value"
        value={formatDusdc(exitValue)}
        detail={formatQuoteStatus(position.quoteStatus)}
      />
      <PortfolioMetric
        label="PnL"
        value={formatSignedDusdc(pnlValue)}
        detail={position.livePnlDusdc !== null ? "Live estimate" : position.unrealizedPnlDusdc !== null ? "Indexed estimate" : "--"}
      />
      <div className="flex flex-wrap items-center gap-2 lg:block">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground lg:hidden">Status</span>
        <Badge variant="outline" className="border-border text-muted-foreground">
          {formatPortfolioStatus(position)}
        </Badge>
        <Button className="mt-0 h-8 lg:mt-2" size="sm" variant="outline" disabled>
          {formatPositionAction(position)}
        </Button>
      </div>
    </div>
  );
}

function PortfolioMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground lg:hidden">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground lg:mt-0">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function PnlCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">Server indexed PnL</p>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <p className="mt-2 truncate text-xl font-semibold tracking-tight text-foreground">{value}</p>
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

function formatSignedDusdc(value: number | null) {
  if (value === null) {
    return "--";
  }

  const sign = value > 0 ? "+" : "";

  return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC`;
}

function formatCount(value: number | null) {
  return value === null ? "--" : value.toLocaleString();
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

function positionExitValue(position: ProfilePosition) {
  return position.liveExitValueDusdc ?? position.currentValueDusdc;
}

function positionPnlValue(position: ProfilePosition) {
  return position.livePnlDusdc ?? position.unrealizedPnlDusdc;
}

function formatPortfolioStatus(position: ProfilePosition) {
  if (position.canRedeem) {
    return "Redeemable";
  }

  if (position.action === "monitor_settlement") {
    return position.status.toLowerCase().includes("pending") ? "Waiting settlement" : "Open";
  }

  return "Closed";
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

function formatPositionAction(position: ProfilePosition) {
  if (position.canRedeem) {
    return "Redeem";
  }

  if (position.action === "monitor_settlement") {
    return "Monitor";
  }

  return "Closed";
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
