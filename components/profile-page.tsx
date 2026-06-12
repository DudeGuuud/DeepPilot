"use client";

import { useCurrentAccount, useCurrentNetwork } from "@mysten/dapp-kit-react";
import { AlertTriangle, Check, RefreshCw, Wallet } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readPreviewReceipts } from "@/src/lib/receipts";
import type { ProfileActivityItem, ProfileSummary } from "@/src/lib/types";

type ProfileTab = "positions" | "activity" | "risk" | "receipts" | "keeper";

export function ProfilePage() {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();
  const searchParams = useSearchParams();
  const managerId = searchParams.get("managerId");
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [receipts, setReceipts] = useState<ProfileActivityItem[]>([]);
  const [tab, setTab] = useState<ProfileTab>("positions");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReceipts(readPreviewReceipts(account?.address));
  }, [account?.address]);

  useEffect(() => {
    const params = new URLSearchParams();

    if (account?.address) {
      params.set("wallet", account.address);
    }

    if (managerId) {
      params.set("managerId", managerId);
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
  }, [account?.address, managerId]);

  const activity = useMemo(() => [...receipts, ...(profile?.activity ?? [])], [profile?.activity, receipts]);

  return (
    <AppShell
      title="Profile and receipts"
      description="Review wallet state, manager linkage, local preview receipts, and the gaps before real Predict portfolio reporting."
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
            <SummaryCard label="Redeemable" value={formatDusdc(profile?.redeemableValueDusdc ?? null)} />
            <SummaryCard label="Realized PnL" value={formatDusdc(profile?.realizedPnlDusdc ?? null)} />
            <SummaryCard label="Awaiting settlement" value={formatCount(profile?.awaitingSettlement ?? null)} />
            <SummaryCard label="Guardian blocks" value={String(profile?.guardianBlockedCount ?? 0)} />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap gap-2">
                {(["positions", "activity", "risk", "receipts", "keeper"] as const).map((item) => (
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
                managerLinked={profile?.managerLinked ?? false}
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
              <StatusRow label="PredictManager linked" active={profile?.managerLinked ?? false} />
              <StatusRow label="Preview receipts" active={receipts.length > 0} />
              <StatusRow label="Walrus / Seal configured" active={profile?.memory.sealedReceipts.status === "ready"} />
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
    const items = tab === "receipts" ? activity.filter((item) => item.type === "sponsor_preview") : activity;

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
      <EmptyState text="No local preview receipts yet." />
    );
  }

  if (tab === "positions") {
    return managerLinked ? <EmptyState text="Manager linked, but detailed positions are not loaded in the MVP." /> : <EmptyState text="Manager not linked. No positions or PnL are shown." />;
  }

  if (tab === "risk") {
    return profile ? (
      <div className="grid gap-3 lg:grid-cols-2">
        <PolicyBox title="Public index" items={profile.indexPolicy.publicValues} />
        <PolicyBox title="Consent required" items={profile.indexPolicy.consentRequiredValues} />
        <PolicyBox title="Private memory" items={profile.indexPolicy.privateValues} />
        <div className="rounded-md border border-border bg-background/60 p-3">
          <p className="text-sm font-medium text-foreground">Walrus / Seal</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{profile.memory.sealedReceipts.policy}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {profile.memory.longTermMemory.provider} · {profile.memory.longTermMemory.namespace ?? "wallet required"}
          </p>
        </div>
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

function formatCount(value: number | null) {
  return value === null ? "--" : value.toLocaleString();
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
