"use client";

import { useCurrentNetwork, useDAppKit } from "@mysten/dapp-kit-react";
import { AlertTriangle, Check, RefreshCw, Wallet } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  assertExecuted,
  buildCreatePredictManagerTransaction,
  extractPredictManagerId,
  getExecutedDigest
} from "@/src/lib/predict-execution";
import { cn } from "@/src/lib/utils";
import { explainWalletExecutionError } from "@/src/lib/wallet-errors";

type PredictNetwork = "devnet" | "testnet";

type PredictManagerOnboardingModalProps = {
  open: boolean;
  packageId?: string | null;
  network: PredictNetwork;
  walletAddress?: string | null;
  context?: "profile" | "trade";
  onDismiss: () => void;
  onCreated: (result: { managerId: string; digest: string; network: PredictNetwork }) => void | Promise<void>;
};

export function PredictManagerOnboardingModal({
  open,
  packageId,
  network,
  walletAddress,
  context = "profile",
  onDismiss,
  onCreated
}: PredictManagerOnboardingModalProps) {
  const { toast } = useToast();
  const dAppKit = useDAppKit();
  const currentNetwork = useCurrentNetwork();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingRef = useRef(false);

  if (!open) {
    return null;
  }

  async function createManager() {
    if (signingRef.current) {
      return;
    }

    if (!packageId) {
      setError("Predict package id is unavailable.");
      return;
    }

    if (currentNetwork && currentNetwork !== network) {
      setError(`Switch wallet network to ${network} before creating a PredictManager.`);
      return;
    }

    signingRef.current = true;
    setBusy(true);
    setError(null);

    try {
      const transaction = buildCreatePredictManagerTransaction({
        packageId,
        gasBudget: 12_000_000
      });
      const signed = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest = getExecutedDigest(signed);
      const confirmed = await dAppKit.getClient(network).waitForTransaction({
        digest,
        include: {
          effects: true,
          events: true,
          objectTypes: true
        }
      });
      assertExecuted(confirmed);
      const managerId = extractPredictManagerId(confirmed, packageId);

      if (!managerId) {
        throw new Error("PredictManager was created, but DeepPilot could not identify the new object id.");
      }

      await onCreated({ managerId, digest, network });
      toast({
        title: "PredictManager created",
        description: `${shortAddress(managerId)} indexed soon by Predict server`
      });
    } catch (createError) {
      const message = explainWalletExecutionError(createError);
      setError(message);
      toast({
        variant: "destructive",
        title: "PredictManager creation failed",
        description: message
      });
    } finally {
      signingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/82 px-4 backdrop-blur-md">
      <Card className="glass-line w-full max-w-lg overflow-hidden border-border/80 shadow-2xl">
        <CardHeader className="border-b border-border/70 bg-card/70">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <CardTitle>Create PredictManager</CardTitle>
              </div>
              <CardDescription className="mt-2 leading-6">
                DeepBook Predict stores balances and positions inside one reusable manager object.
              </CardDescription>
            </div>
            <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
              {network}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="rounded-md border border-border bg-background/60 p-3 text-sm leading-6 text-muted-foreground">
            {context === "trade"
              ? "Create a PredictManager first. After it is confirmed, DeepPilot will refresh the trade review before minting."
              : "Create a PredictManager to load server-indexed positions, PnL, balances, and keeper state."}
          </div>

          <div className="grid gap-2 text-sm">
            <StatusLine label="Wallet" value={walletAddress ? shortAddress(walletAddress) : "connect wallet"} active={Boolean(walletAddress)} />
            <StatusLine label="Predict package" value={packageId ? shortAddress(packageId) : "unavailable"} active={Boolean(packageId)} />
            <StatusLine label="User pays gas" value="required" active />
          </div>

          {error ? (
            <div className="flex gap-2 rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onDismiss} disabled={busy}>
              Dismiss
            </Button>
            <Button onClick={createManager} disabled={busy || !walletAddress || !packageId}>
              {busy ? <RefreshCw className="animate-spin" /> : <Wallet />}
              Create PredictManager
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusLine({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div className="grid grid-cols-[116px_1fr_18px] items-center gap-3 rounded-md border border-border bg-background/55 px-3 py-2">
      <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs text-foreground/85">{value}</span>
      <Check className={cn("h-4 w-4", active ? "text-foreground" : "text-muted-foreground/35")} />
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
