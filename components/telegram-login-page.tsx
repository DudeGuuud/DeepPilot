"use client";

import { useCurrentAccount, useCurrentNetwork, useDAppKit } from "@mysten/dapp-kit-react";
import { Check, ExternalLink, LockKeyhole, Sparkles, Wallet } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  buildCreateDeepPilotProfileTransaction,
  buildSubscribePlanTransaction,
  extractDeepPilotProfileId,
  type DeepPilotPlan
} from "@/src/lib/profile-execution";
import { assertExecuted, getExecutedDigest } from "@/src/lib/predict-execution";
import type { DeepPilotPlanConfig, TelegramSession } from "@/src/lib/types";
import { cn } from "@/src/lib/utils";
import { explainWalletExecutionError } from "@/src/lib/wallet-errors";

type TokenPayload = {
  telegramHash: string;
  chatId: string;
  nonce: string;
  expiresAt: string;
};

type SessionResponse = {
  token: TokenPayload;
  session: TelegramSession | null;
  linkHost: string;
  profileConfig: {
    packageId: string;
    registryId: string;
    treasuryId: string;
  };
  plans: Record<"standard" | "pro" | "max", DeepPilotPlanConfig>;
  error?: string;
};

export function TelegramLoginPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const showPlans = searchParams.get("plans") === "1";
  const account = useCurrentAccount();
  const currentNetwork = useCurrentNetwork();
  const dAppKit = useDAppKit();
  const { toast } = useToast();
  const [data, setData] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetNetwork = currentNetwork === "devnet" ? "devnet" : "testnet";

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/telegram/session?token=${encodeURIComponent(token)}`, {
          cache: "no-store"
        });
        const payload = await response.json() as SessionResponse;

        if (!response.ok) {
          throw new Error(payload.error ?? "Telegram session failed.");
        }

        if (!cancelled) {
          setData(payload);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Telegram session failed.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (token) {
      void load();
    } else {
      setLoading(false);
      setError("Missing Telegram login token.");
    }

    return () => {
      cancelled = true;
    };
  }, [token]);

  const linkMessage = useMemo(() => {
    if (!data?.token || !account?.address) {
      return null;
    }

    return [
      "DeepPilot Telegram wallet link v1",
      `domain=${data.linkHost}`,
      `telegramHash=${data.token.telegramHash}`,
      `wallet=${account.address}`,
      `nonce=${data.token.nonce}`,
      `expiresAt=${data.token.expiresAt}`
    ].join("\n");
  }, [account?.address, data?.token]);

  async function refreshSession() {
    const response = await fetch(`/api/telegram/session?token=${encodeURIComponent(token)}`, {
      cache: "no-store"
    });
    const payload = await response.json() as SessionResponse;

    if (!response.ok) {
      throw new Error(payload.error ?? "Telegram session refresh failed.");
    }

    setData(payload);
    return payload;
  }

  async function linkWallet() {
    if (!account?.address || !linkMessage) {
      setError("Connect a Sui wallet before linking Telegram.");
      return;
    }

    setBusy("link");
    setError(null);

    try {
      const signed = await dAppKit.signPersonalMessage({
        message: new TextEncoder().encode(linkMessage)
      });
      const response = await fetch("/api/telegram/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          walletAddress: account.address,
          signature: signed.signature
        })
      });
      const payload = await response.json() as SessionResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Telegram wallet link failed.");
      }

      setData(payload);
      toast({
        variant: "success",
        title: "Telegram wallet linked",
        description: shortAddress(account.address)
      });
    } catch (linkError) {
      setError(explainWalletExecutionError(linkError));
    } finally {
      setBusy(null);
    }
  }

  async function createProfile() {
    if (!account?.address) {
      setError("Connect a wallet before creating Profile NFT.");
      return;
    }

    if (!data?.profileConfig.packageId || !data.profileConfig.registryId) {
      setError("Profile package or registry is not configured.");
      return;
    }

    setBusy("profile");
    setError(null);

    try {
      const transaction = buildCreateDeepPilotProfileTransaction({
        packageId: data.profileConfig.packageId,
        registryId: data.profileConfig.registryId,
        telegramHash: data.token.telegramHash,
        memoryNamespace: `telegram:${data.token.telegramHash.slice(0, 16)}`
      });
      const signed = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest = getExecutedDigest(signed);
      const confirmed = await dAppKit.getClient(targetNetwork).waitForTransaction({
        digest,
        include: {
          effects: true,
          events: true,
          objectTypes: true
        }
      });
      assertExecuted(confirmed);
      const profileId = extractDeepPilotProfileId(confirmed, data.profileConfig.packageId);

      if (!profileId) {
        throw new Error("Profile was created, but DeepPilot could not identify the new object id.");
      }

      await updateTelegramSession({
        profileId,
        walletAddress: account.address,
        profileCreateDigest: digest
      });
      await refreshSession();
      toast({
        variant: "success",
        title: "Profile NFT created",
        description: shortAddress(profileId)
      });
    } catch (profileError) {
      setError(explainWalletExecutionError(profileError));
    } finally {
      setBusy(null);
    }
  }

  async function subscribe(plan: "pro" | "max") {
    if (!account?.address || !data?.session?.profileId) {
      setError("Create Profile NFT before subscribing.");
      return;
    }

    if (!data.profileConfig.packageId || !data.profileConfig.treasuryId) {
      setError("Profile package or treasury is not configured.");
      return;
    }

    setBusy(plan);
    setError(null);

    try {
      const planCode: DeepPilotPlan = plan === "pro" ? 1 : 2;
      const transaction = buildSubscribePlanTransaction({
        packageId: data.profileConfig.packageId,
        profileId: data.session.profileId,
        treasuryId: data.profileConfig.treasuryId,
        plan: planCode,
        priceMist: data.plans[plan].priceMist
      });
      const signed = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest = getExecutedDigest(signed);
      const confirmed = await dAppKit.getClient(targetNetwork).waitForTransaction({
        digest,
        include: {
          effects: true
        }
      });
      assertExecuted(confirmed);
      await updateTelegramSession({
        plan,
        walletAddress: account.address,
        planDigest: digest
      });
      await refreshSession();
      toast({
        variant: "success",
        title: `${data.plans[plan].label} active`,
        description: "Telegram session updated"
      });
    } catch (subscribeError) {
      setError(explainWalletExecutionError(subscribeError));
    } finally {
      setBusy(null);
    }
  }

  async function updateTelegramSession(input: {
    walletAddress?: string;
    profileId?: string;
    profileCreateDigest?: string;
    plan?: "pro" | "max";
    planDigest?: string;
  }) {
    const response = await fetch("/api/telegram/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        ...input
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? "Telegram session update failed.");
    }
  }

  return (
    <AppShell
      title="Telegram wallet link"
      description="Bind Telegram to a wallet, create a Profile NFT, and manage AI quota plans."
      meta={<Badge variant="outline">testnet</Badge>}
    >
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="glass-line">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              Connect Telegram
            </CardTitle>
            <CardDescription>
              The bot can preview trades, but wallet signing always happens in the Web review flow.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? <p className="text-sm text-muted-foreground">Loading Telegram session...</p> : null}
            {error ? <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</div> : null}

            <div className="grid gap-2 text-sm">
              <StatusRow label="Telegram token" value={data?.token ? "valid" : "missing"} active={Boolean(data?.token)} />
              <StatusRow label="Wallet" value={account?.address ? shortAddress(account.address) : "connect wallet"} active={Boolean(account?.address)} />
              <StatusRow label="Linked wallet" value={data?.session?.walletAddress ? shortAddress(data.session.walletAddress) : "not linked"} active={Boolean(data?.session?.walletAddress)} />
              <StatusRow label="Profile NFT" value={data?.session?.profileId ? shortAddress(data.session.profileId) : "not created"} active={Boolean(data?.session?.profileId)} />
              <StatusRow label="Plan" value={data?.session?.plan ?? "standard"} active={Boolean(data?.session)} />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={linkWallet} disabled={!account?.address || busy !== null || Boolean(data?.session?.walletAddress)}>
                <LockKeyhole className="mr-2 h-4 w-4" />
                {busy === "link" ? "Signing..." : "Sign wallet link"}
              </Button>
              <Button
                variant="secondary"
                onClick={createProfile}
                disabled={!data?.session?.walletAddress || Boolean(data?.session?.profileId) || busy !== null}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                {busy === "profile" ? "Creating..." : "Create Profile NFT"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className={cn("glass-line", showPlans && "border-primary/50")}>
          <CardHeader>
            <CardTitle>Plans</CardTitle>
            <CardDescription>Demo quota is currently 50 messages/day for all plans.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data ? (Object.entries(data.plans) as Array<["standard" | "pro" | "max", DeepPilotPlanConfig]>).map(([key, plan]) => (
              <div key={key} className="rounded-md border border-border/80 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{plan.label}</p>
                    <p className="text-xs text-muted-foreground">
                      Future limit {plan.displayLimit}/day · v1 effective {plan.effectiveDailyLimit}/day
                    </p>
                  </div>
                  {data.session?.plan === key ? <Check className="h-4 w-4 text-emerald-300" /> : null}
                </div>
                {key !== "standard" ? (
                  <Button
                    className="mt-3 w-full"
                    variant="secondary"
                    onClick={() => subscribe(key)}
                    disabled={!data.session?.profileId || busy !== null}
                  >
                    {busy === key ? "Subscribing..." : `Subscribe ${plan.label} · 0.1 SUI`}
                  </Button>
                ) : null}
              </div>
            )) : null}
            <a className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground" href="/profile">
              Open Profile <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function StatusRow({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/45 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xs", active ? "text-foreground" : "text-muted-foreground")}>{value}</span>
    </div>
  );
}

function shortAddress(value: string | null | undefined) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "--";
}
