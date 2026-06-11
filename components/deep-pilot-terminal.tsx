"use client";

import { DAppKitProvider, useCurrentAccount, useCurrentNetwork } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  CircleDashed,
  Fuel,
  LockKeyhole,
  Play,
  RefreshCw,
  Shield,
  Wallet,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/components/ui/use-toast";
import { dAppKit } from "@/src/lib/dapp-kit";
import { cn } from "@/src/lib/utils";
import type { CompileResult, GuardianFinding, RiskLevel } from "@/src/lib/types";

const DEFAULT_INTENT = "Buy 20 USDC worth of SUI on DeepBook if slippage stays under 0.5%";

type CompileApiResult = CompileResult & {
  sui?: {
    network: string;
    transport: string;
    extension: string;
  };
};

type SponsorReceipt = {
  approved: boolean;
  receipt?: {
    digest: string;
    status: string;
    sender: string;
    sponsor: string;
    gasMode: string;
    submitted: boolean;
    note: string;
  };
  reason?: string;
};

export default function DeepPilotTerminal() {
  return (
    <DAppKitProvider dAppKit={dAppKit}>
      <TerminalExperience />
      <Toaster />
    </DAppKitProvider>
  );
}

function TerminalExperience() {
  const { toast } = useToast();
  const account = useCurrentAccount();
  const network = useCurrentNetwork();
  const [intent, setIntent] = useState(DEFAULT_INTENT);
  const [compiled, setCompiled] = useState<CompileApiResult | null>(null);
  const [receipt, setReceipt] = useState<SponsorReceipt | null>(null);
  const [busy, setBusy] = useState<"compile" | "sponsor" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);

  useEffect(() => {
    void compile(DEFAULT_INTENT);
  }, []);

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

    setBusy("sponsor");
    setError(null);

    try {
      const response = await fetch("/api/sponsor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent })
      });
      const payload = (await response.json()) as SponsorReceipt;
      setReceipt(payload);

      if (!response.ok) {
        throw new Error(payload.reason ?? "Sponsor policy rejected this PTB.");
      }

      toast({
        title: "Transaction preview signed",
        description: payload.receipt ? `${payload.receipt.digest} · not submitted` : "Sponsored transaction preview is ready."
      });
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

  return (
    <main className="terminal-shell px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4">
        <header className="flex flex-col gap-4 py-2 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-card">
                <Circle className="h-3 w-3 fill-white text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">DeepPilot</p>
                <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  Trade by intent. Execute with proof.
                </h1>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
              {compiled?.sui?.transport ?? "SuiGrpcClient"}
            </Badge>
            <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
              {network ?? "devnet"}
            </Badge>
            <div className="h-8 rounded-md border border-border bg-card px-2 [&_button]:h-6 [&_button]:rounded-sm [&_button]:text-xs">
              <ConnectButton />
            </div>
          </div>
        </header>

        <div className="terminal-grid">
          <section className="flex min-w-0 flex-col gap-3">
            <Card className="glass-line">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>Intent</CardTitle>
                    <CardDescription>Natural language, constrained output.</CardDescription>
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
                  placeholder="Buy 20 USDC of SUI on DeepBook if slippage stays under 0.5%"
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

            <CompilerCard compiled={compiled} busy={busy === "compile"} />
            <PtbCard compiled={compiled} />
          </section>

          <section className="market-column flex min-w-0 flex-col gap-3">
            <MarketCard compiled={compiled} />
            <DepthCard compiled={compiled} />
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
      </div>
    </main>
  );
}

function CompilerCard({ compiled, busy }: { compiled: CompileApiResult | null; busy: boolean }) {
  const fallback = [
    "Parsing intent",
    "Reading DeepBook liquidity",
    "Compiling PTB",
    "Running Guardian checks",
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
      </CardContent>
    </Card>
  );
}

function MarketCard({ compiled }: { compiled: CompileApiResult | null }) {
  const quote = compiled?.quote;

  return (
    <Card className="glass-line">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Market</CardTitle>
            <CardDescription>{quote?.pair ?? "SUI/USDC"}</CardDescription>
          </div>
          <Badge variant="outline" className="border-border text-muted-foreground">
            DeepBook V3
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {!quote ? (
          <MutedBox>{compiled?.intent.status === "ready" ? "Stablecoin path selected." : "Awaiting DeepBook quote."}</MutedBox>
        ) : (
          <div className="grid gap-3 sm:grid-cols-4">
            <MarketMetric label="Mid" value={`$${quote.midPrice.toFixed(4)}`} />
            <MarketMetric label="Bid" value={`$${quote.bestBid.toFixed(4)}`} />
            <MarketMetric label="Ask" value={`$${quote.bestAsk.toFixed(4)}`} />
            <MarketMetric label="Spread" value={`${quote.spreadBps} bps`} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DepthCard({ compiled }: { compiled: CompileApiResult | null }) {
  const quote = compiled?.quote;

  return (
    <Card>
      <CardHeader className="pb-2">
        <SectionHeading title="Book Depth" detail={quote ? `$${quote.visibleDepthUsd.toLocaleString()}` : "waiting"} />
      </CardHeader>
      <CardContent>
        {!quote ? (
          <MutedBox>No depth snapshot.</MutedBox>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            <BookSide label="Bids" levels={quote.bids} />
            <BookSide label="Asks" levels={quote.asks} ask />
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
              {guardian?.decision === "block" ? "Modify intent or refresh quote." : "Pre-sign checks are within policy."}
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
          <p className="mt-1 text-xs text-muted-foreground">{accountAddress ? shortAddress(accountAddress) : "Mock signer available"}</p>
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

function BookSide({
  label,
  levels,
  ask = false
}: {
  label: string;
  levels: Array<{ price: number; size: number; total: number }>;
  ask?: boolean;
}) {
  const max = Math.max(...levels.map((level) => level.total));

  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">Size</p>
      </div>
      <div className="space-y-2">
        {levels.map((level) => (
          <div key={`${label}-${level.price}`} className="grid grid-cols-[72px_1fr_56px] items-center gap-2 text-xs">
            <span className="text-foreground/85">{level.price.toFixed(4)}</span>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn("book-bar", ask && "ask")} style={{ width: `${Math.max(8, level.total / max * 100)}%` }} />
            </div>
            <span className="text-right text-muted-foreground">{level.size}</span>
          </div>
        ))}
      </div>
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
