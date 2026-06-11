"use client";

import { useCurrentAccount, useCurrentNetwork, useDAppKit } from "@mysten/dapp-kit-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  Fuel,
  LockKeyhole,
  Play,
  RefreshCw,
  Shield,
  Wallet,
  X
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { PredictMarketChart } from "@/components/predict-market-chart";
import { TradeTicket } from "@/components/trade-ticket";
import { storePreviewReceipt } from "@/src/lib/receipts";
import { cn } from "@/src/lib/utils";
import type { CompileResult, GuardianFinding, PredictMarketSnapshot, RiskLevel } from "@/src/lib/types";

const DEFAULT_INTENT = "Buy 10 DUSDC BTC UP near 62500 on the next active DeepBook Predict oracle";

type CompileApiResult = CompileResult & {
  predict?: {
    network: string;
    transport: string;
    endpoint: string;
    predictId: string;
    quoteAsset: string;
  };
};

type SponsorReceipt = {
  approved: boolean;
  receipt?: {
    digest: string;
    status: string;
    walletAddress: string;
    network: "devnet" | "testnet";
    nonce: string;
    expiresAt: string;
    intentHash: string;
    sender: string;
    sponsor: string;
    gasMode: string;
    submitted: boolean;
    note: string;
  };
  reason?: string;
};

export default function DeepPilotTerminal() {
  return <TerminalExperience />;
}

function TerminalExperience() {
  const { toast } = useToast();
  const dAppKit = useDAppKit();
  const account = useCurrentAccount();
  const network = useCurrentNetwork();
  const searchParams = useSearchParams();
  const urlOracleId = useMemo(() => oracleIdFromSearch(searchParams), [searchParams]);
  const urlStrike = useMemo(() => strikeFromSearch(searchParams), [searchParams]);
  const defaultIntent = useMemo(() => defaultIntentFromSearch(searchParams), [searchParams]);
  const [intent, setIntent] = useState(defaultIntent);
  const [compiled, setCompiled] = useState<CompileApiResult | null>(null);
  const [receipt, setReceipt] = useState<SponsorReceipt | null>(null);
  const [busy, setBusy] = useState<"compile" | "sponsor" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);

  useEffect(() => {
    setIntent(defaultIntent);
    void compile(defaultIntent);
  }, [defaultIntent]);

  const chips = useMemo(
    () =>
      intent
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 10),
    [intent]
  );

  async function compile(nextIntent = intent) {
    setBusy("compile");
    setError(null);
    setReceipt(null);

    try {
      const response = await fetch("/api/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: nextIntent })
      });

      if (!response.ok) {
        throw new Error("Intent compile failed.");
      }

      setCompiled((await response.json()) as CompileApiResult);
    } catch (compileError) {
      setError(compileError instanceof Error ? compileError.message : "Intent compile failed.");
    } finally {
      setBusy(null);
    }
  }

  async function sponsor() {
    if (!compiled?.ptb || compiled.guardian.blocked) {
      toast({
        variant: "destructive",
        title: "Execution blocked",
        description: compiled?.guardian.summary ?? "Guardian requires a valid PTB before signing."
      });
      return;
    }

    if (!account) {
      toast({
        variant: "destructive",
        title: "Wallet required",
        description: "Connect a wallet before authorizing a sponsor preview."
      });
      return;
    }

    setBusy("sponsor");
    setError(null);

    try {
      const sponsorNetwork = network === "devnet" ? "devnet" : "testnet";
      const challengeParams = new URLSearchParams({
        walletAddress: account.address,
        network: sponsorNetwork,
        ptbDigest: compiled.ptb.digestPreview
      });
      const challengeResponse = await fetch(`/api/sponsor?${challengeParams.toString()}`);

      if (!challengeResponse.ok) {
        throw new Error("Sponsor authorization challenge failed.");
      }

      const challenge = (await challengeResponse.json()) as {
        nonce: string;
        expiresAt: string;
        message: string;
      };
      const signed = await dAppKit.signPersonalMessage({
        message: new TextEncoder().encode(challenge.message)
      });
      const response = await fetch("/api/sponsor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent,
          walletAddress: account.address,
          network: sponsorNetwork,
          ptbDigest: compiled.ptb.digestPreview,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
          signature: signed.signature
        })
      });
      const payload = (await response.json()) as SponsorReceipt;
      setReceipt(payload);

      if (!response.ok) {
        throw new Error(payload.reason ?? "Sponsor policy rejected this PTB.");
      }

      toast({
        title: "Transaction preview authorized",
        description: payload.receipt ? `${payload.receipt.digest} · not submitted` : "Sponsored transaction preview is ready."
      });

      if (payload.receipt) {
        savePreviewReceipt(payload.receipt, intent, compiled);
      }
    } catch (sponsorError) {
      const message = sponsorError instanceof Error ? sponsorError.message : "Sponsor preview failed.";
      setError(message);
      toast({
        variant: "destructive",
        title: "Transaction preview failed",
        description: message
      });
    } finally {
      setBusy(null);
    }
  }

  const guardian = compiled?.guardian;
  const blocked = guardian?.blocked ?? true;
  const marketStrike = compiled?.market?.metrics.selectedStrike;
  const intentStrike = compiled?.intent.status === "ready" ? compiled.intent.strike : undefined;
  const selectedOracleId =
    compiled?.market?.oracle.oracle_id ??
    (compiled?.intent.status === "ready" ? compiled.intent.oracleId : undefined) ??
    urlOracleId ??
    undefined;
  const selectedStrike =
    typeof marketStrike === "number" ? marketStrike : typeof intentStrike === "number" ? intentStrike : urlStrike;

  return (
    <AppShell
      title="Trade BTC Predict with risk proof"
      description="Use the ticket for quote, buy, and sell previews; the intent compiler adds a transparent Guardian and sponsor-policy audit layer."
      meta={
        <>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {compiled?.predict?.transport ?? "Predict server"}
          </Badge>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {network ?? "testnet"}
          </Badge>
        </>
      }
    >
        <div className="terminal-grid">
          <section className="flex min-w-0 flex-col gap-3">
            <Card className="glass-line">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>Intent</CardTitle>
                    <CardDescription>Editable compiler input from the trade ticket.</CardDescription>
                  </div>
                  <Button size="sm" onClick={() => compile()} disabled={busy !== null}>
                    {busy === "compile" ? <RefreshCw className="animate-spin" /> : <Play />}
                    Run
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Textarea
                  className="min-h-[132px] resize-none border-border bg-background/70 text-base leading-7"
                  value={intent}
                  onChange={(event) => setIntent(event.target.value)}
                  placeholder="Buy 10 DUSDC BTC UP near 62500 on the next active Predict oracle"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {chips.map((chip, index) => (
                    <Badge
                      key={`${chip}-${index}`}
                      variant="secondary"
                      className="border border-border bg-secondary/70 text-muted-foreground"
                    >
                      {chip}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            <TradeTicket
              market={compiled?.market ?? null}
              initialOracleId={urlOracleId}
              initialStrike={urlStrike}
              onGenerate={(nextIntent) => {
                setIntent(nextIntent);
                void compile(nextIntent);
              }}
            />
            <CompilerCard compiled={compiled} busy={busy === "compile"} />
            <PtbCard compiled={compiled} />
          </section>

          <section className="market-column flex min-w-0 flex-col gap-3">
            <PredictMarketChart oracleId={selectedOracleId} strike={selectedStrike} />
            <MarketCard compiled={compiled} />
            <VaultCard compiled={compiled} />
          </section>

          <aside className="flex min-w-0 flex-col gap-3">
            <GuardianCard
              compiled={compiled}
              expandedFinding={expandedFinding}
              onExpand={setExpandedFinding}
            />
            <GasCard compiled={compiled} accountAddress={account?.address} />
            <ExecutionCard
              compiled={compiled}
              receipt={receipt}
              error={error}
              busy={busy === "sponsor"}
              blocked={blocked}
              onConfirm={sponsor}
            />
          </aside>
        </div>
    </AppShell>
  );
}

function CompilerCard({ compiled, busy }: { compiled: CompileApiResult | null; busy: boolean }) {
  const fallback = [
    "Parsing intent",
    "Reading DeepBook Predict state",
    "Running Guardian checks",
    "Compiling Predict PTB preview",
    "Awaiting confirmation"
  ];
  const timeline = compiled?.timeline ?? fallback.map((label) => ({ label, state: "pending" as const }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <SectionHeading title="Compiler" detail="5 stages" />
      </CardHeader>
      <CardContent className="space-y-1">
        {timeline.map((item, index) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.03 }}
            className="grid grid-cols-[24px_1fr_auto] items-center gap-3 rounded-md px-1 py-2"
          >
            <StatusIcon state={item.state} busy={busy} />
            <span className="min-w-0 truncate text-sm text-foreground">{item.label}</span>
            <span className="text-xs capitalize text-muted-foreground">{item.state}</span>
          </motion.div>
        ))}
      </CardContent>
    </Card>
  );
}

function PtbCard({ compiled }: { compiled: CompileApiResult | null }) {
  const commands = compiled?.ptb?.commands ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <SectionHeading title="PTB" detail={commands.length ? `${commands.length} commands` : "locked"} />
      </CardHeader>
      <CardContent className="space-y-2">
        {commands.length === 0 ? (
          <MutedBox>{compiled?.guardian.blocked ? "Blocked before signing." : "Awaiting compile."}</MutedBox>
        ) : (
          commands.map((command) => (
            <div key={command.index} className="rounded-md border border-border bg-background/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{command.command}</p>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{command.target}</p>
                </div>
                <Badge variant="outline" className="shrink-0 border-border text-[10px] uppercase text-muted-foreground">
                  {command.riskGate}
                </Badge>
              </div>
            </div>
          ))
        )}
        <MutedBox>
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Digest</span>
          <span className="mt-1 block break-all font-mono text-xs text-foreground/80">
            {compiled?.ptb?.digestPreview ?? "not compiled"}
          </span>
        </MutedBox>
        {compiled?.ptb?.requirements.length ? (
          <div className="space-y-2">
            {compiled.ptb.requirements.map((requirement) => (
              <div key={requirement.label} className="grid grid-cols-[1fr_18px] items-start gap-2 rounded-md border border-border bg-background/60 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{requirement.label}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{requirement.detail}</p>
                </div>
                {requirement.satisfied ? <Check className="h-4 w-4 text-foreground" /> : <X className="h-4 w-4 text-destructive" />}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MarketCard({ compiled }: { compiled: CompileApiResult | null }) {
  const market = compiled?.market;

  return (
    <Card className="glass-line">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Oracle</CardTitle>
            <CardDescription>{market ? shortAddress(market.oracle.oracle_id) : "BTC Predict oracle"}</CardDescription>
          </div>
          <Badge variant="outline" className="border-border text-muted-foreground">
            DeepBook Predict
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {!market ? (
          <MutedBox>{compiled?.intent.status === "ready" ? "Predict state unavailable." : "Awaiting Predict state."}</MutedBox>
        ) : (
          <div className="grid gap-3 sm:grid-cols-4">
            <MarketMetric label="Spot" value={formatUsd(market.metrics.spot)} />
            <MarketMetric label="Forward" value={formatUsd(market.metrics.forward)} />
            <MarketMetric label="Strike" value={formatUsd(market.metrics.selectedStrike)} />
            <MarketMetric label="Oracle Age" value={formatAge(market.metrics.oracleAgeMs)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VaultCard({ compiled }: { compiled: CompileApiResult | null }) {
  const market = compiled?.market;

  return (
    <Card>
      <CardHeader className="pb-2">
        <SectionHeading title="Vault Risk" detail={market ? `${(market.metrics.vaultUtilization * 100).toFixed(2)}% used` : "waiting"} />
      </CardHeader>
      <CardContent>
        {!market ? (
          <MutedBox>No vault snapshot.</MutedBox>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <MarketMetric label="Available" value={`${market.metrics.availableLiquidityDusdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} DUSDC`} />
            <MarketMetric label="Notional" value={`${market.metrics.notionalDusdc.toLocaleString()} DUSDC`} />
            <MarketMetric label="Max Payout Use" value={`${(market.metrics.maxPayoutUtilization * 100).toFixed(2)}%`} />
            <MarketMetric label="Ask Bounds" value={market.metrics.askBoundsAvailable ? "available" : "fallback"} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GuardianCard({
  compiled,
  expandedFinding,
  onExpand
}: {
  compiled: CompileApiResult | null;
  expandedFinding: string | null;
  onExpand: (value: string | null) => void;
}) {
  const guardian = compiled?.guardian;
  const level = guardian?.level ?? "medium";

  return (
    <Card className="glass-line">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Guardian</CardTitle>
            <CardDescription>{guardian?.summary ?? "Scanning intent."}</CardDescription>
          </div>
          <Shield className={cn("h-5 w-5", riskColor(level))} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[96px_1fr] items-center gap-4">
          <div className="grid aspect-square place-items-center rounded-full border border-border bg-background">
            <div className="text-center">
              <p className={cn("text-3xl font-semibold tracking-tight", riskColor(level))}>{guardian?.score ?? "--"}</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{level}</p>
            </div>
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", guardian?.blocked ? "bg-destructive" : "bg-foreground pulse-dot")} />
              <p className="text-sm text-foreground">{guardian?.blocked ? "Signing locked" : "Confirmation enabled"}</p>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              {guardian?.decision === "block" ? "Modify intent or refresh Predict state." : "Pre-sign checks are within policy."}
            </p>
          </div>
        </div>

        <Separator className="my-4" />

        <div className="space-y-2">
          {(guardian?.findings.length ?? 0) === 0 ? (
            <MutedBox>Guardian checks passed.</MutedBox>
          ) : (
            guardian?.findings.map((finding) => (
              <FindingCard
                key={`${finding.type}-${finding.title}`}
                finding={finding}
                expanded={expandedFinding === finding.type}
                onToggle={() => onExpand(expandedFinding === finding.type ? null : finding.type)}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function GasCard({ compiled, accountAddress }: { compiled: CompileApiResult | null; accountAddress?: string }) {
  const gas = compiled?.gas;

  return (
    <Card>
      <CardHeader className="pb-2">
        <SectionHeading title="Gas" detail={gas?.approved ? "approved" : "policy"} icon={<Fuel className="h-4 w-4" />} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border bg-background/60 p-3">
          <p className="text-sm font-medium text-foreground">{gas?.label ?? "Awaiting policy"}</p>
          <p className="mt-1 text-xs text-muted-foreground">{accountAddress ? shortAddress(accountAddress) : "Wallet not connected"}</p>
        </div>
        <div className="space-y-1">
          {(gas?.checks ?? []).map((check) => (
            <div key={check.label} className="grid grid-cols-[1fr_18px] items-center gap-2 py-1.5">
              <span className="min-w-0 truncate text-sm text-muted-foreground">{check.label}</span>
              {check.passed ? <Check className="h-4 w-4 text-foreground" /> : <X className="h-4 w-4 text-destructive" />}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ExecutionCard({
  compiled,
  receipt,
  error,
  busy,
  blocked,
  onConfirm
}: {
  compiled: CompileApiResult | null;
  receipt: SponsorReceipt | null;
  error: string | null;
  busy: boolean;
  blocked: boolean;
  onConfirm: () => void;
}) {
  const canConfirm = Boolean(compiled?.ptb && !blocked && compiled.gas.approved);

  return (
    <Card className="glass-line">
      <CardHeader className="pb-3">
        <SectionHeading title="Execution" detail="preview only" icon={<Wallet className="h-4 w-4" />} />
      </CardHeader>
      <CardContent>
        <Button
          className="h-11 w-full"
          variant={canConfirm ? "default" : "destructive"}
          disabled={!canConfirm || busy}
          onClick={onConfirm}
        >
          {busy ? <RefreshCw className="animate-spin" /> : blocked ? <AlertTriangle /> : <LockKeyhole />}
          {blocked ? "Blocked by Guardian" : "Confirm guarded execution"}
        </Button>

        <AnimatePresence>
          {receipt?.receipt ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 rounded-md border border-border bg-background/70 p-3"
            >
              <div className="flex items-center gap-2 text-foreground">
                <Check className="h-4 w-4" />
                <p className="text-sm font-medium">Signed preview ready</p>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{receipt.receipt.digest}</p>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {error ? (
          <div className="mt-4 rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : null}

        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {compiled?.ptb?.simulated.reason ?? "No transaction submitted."}
        </p>
      </CardContent>
    </Card>
  );
}

function defaultIntentFromSearch(searchParams: { get(name: string): string | null }) {
  const oracleId = oracleIdFromSearch(searchParams);
  const strike = strikeFromSearch(searchParams);

  if (!oracleId) {
    return DEFAULT_INTENT;
  }

  const strikeText = typeof strike === "number" ? ` near ${strike}` : "";
  return `Quote 10 DUSDC BTC UP${strikeText} using oracle ${oracleId}`;
}

function oracleIdFromSearch(searchParams: { get(name: string): string | null }) {
  const oracleId = searchParams.get("oracleId");

  if (!oracleId || !/^0x[a-fA-F0-9]{16,64}$/.test(oracleId)) {
    return null;
  }

  return oracleId;
}

function strikeFromSearch(searchParams: { get(name: string): string | null }) {
  const strike = searchParams.get("strike");
  const numericStrike = strike ? Number(strike) : NaN;

  return Number.isFinite(numericStrike) ? numericStrike : null;
}

function savePreviewReceipt(
  receipt: NonNullable<SponsorReceipt["receipt"]>,
  intent: string,
  compiled: CompileApiResult
) {
  storePreviewReceipt({
    id: receipt.digest,
    time: new Date().toISOString(),
    type: "sponsor_preview",
    oracleId: compiled.market?.oracle.oracle_id,
    digest: receipt.digest,
    guardianDecision: compiled.guardian.decision,
    summary: `Preview authorized for: ${intent}`,
    walletAddress: receipt.walletAddress,
    network: receipt.network,
    status: receipt.status,
    note: receipt.note
  });
}

function SectionHeading({ title, detail, icon }: { title: string; detail: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <CardTitle className="truncate">{title}</CardTitle>
      </div>
      <CardDescription className="shrink-0">{detail}</CardDescription>
    </div>
  );
}

function StatusIcon({ state, busy }: { state: "complete" | "blocked" | "pending"; busy: boolean }) {
  if (state === "complete") {
    return <Check className="h-4 w-4 text-foreground" />;
  }

  if (state === "blocked") {
    return <X className="h-4 w-4 text-destructive" />;
  }

  return <CircleDashed className={cn("h-4 w-4 text-muted-foreground", busy && "animate-spin")} />;
}

function MarketMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-lg font-semibold tracking-tight text-foreground">{value}</p>
    </div>
  );
}

function FindingCard({
  finding,
  expanded,
  onToggle
}: {
  finding: GuardianFinding;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button className="w-full rounded-md border border-border bg-background/60 p-3 text-left transition-colors hover:bg-accent/60" onClick={onToggle}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{finding.title}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{finding.type}</p>
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </div>
      {expanded ? <p className="mt-3 text-sm leading-6 text-muted-foreground">{finding.explanation}</p> : null}
    </button>
  );
}

function MutedBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-border bg-background/60 p-3 text-sm text-muted-foreground">{children}</div>;
}

function riskColor(level: RiskLevel) {
  switch (level) {
    case "low":
      return "text-foreground";
    case "medium":
      return "text-zinc-300";
    case "high":
      return "text-amber-200";
    case "blocked":
      return "text-destructive";
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatUsd(value: number | null) {
  return value === null ? "--" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatAge(valueMs: PredictMarketSnapshot["metrics"]["oracleAgeMs"]) {
  if (valueMs === null) {
    return "--";
  }

  return valueMs < 1_000 ? `${valueMs}ms` : `${(valueMs / 1_000).toFixed(1)}s`;
}
