"use client";

import { useCurrentAccount, useCurrentNetwork, useDAppKit } from "@mysten/dapp-kit-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  ClipboardCheck,
  Fuel,
  LockKeyhole,
  RefreshCw,
  Send,
  Shield,
  Sparkles,
  UserRound,
  Wallet,
  X
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

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
import type {
  CompileResult,
  GuardianFinding,
  MarketDiscoveryResult,
  MarketListItem,
  PilotMode,
  PilotStreamEvent,
  PredictMarketSnapshot,
  RagSource,
  RiskLevel,
  VaultSummary
} from "@/src/lib/types";

const DEFAULT_INTENT = "";
const COMPOSER_HINT = "Ask market context or draft a Predict transaction";
const SAMPLE_INTENT = "Bet 10 DUSDC that BTC will be down by 18:00 tonight";
const EXAMPLE_INTENTS = [
  "Why is BTC moving?",
  "Summarize BTC news",
  SAMPLE_INTENT,
  "Check PLP vault risk"
];
const AI_DISCLOSURE =
  "This answer is AI-generated for information organization and risk explanation only. It is not investment advice; verify original sources and the wallet confirmation screen.";
const MARKET_PREVIEW_REFRESH_MS = 2_500;

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

type PilotMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode?: PilotMode;
  sources?: RagSource[];
  pending?: boolean;
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
  const [messages, setMessages] = useState<PilotMessage[]>([]);
  const [pilotMode, setPilotMode] = useState<PilotMode | null>(null);
  const [ragSources, setRagSources] = useState<RagSource[]>([]);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [marketPreview, setMarketPreview] = useState<MarketDiscoveryResult | null>(null);
  const [compiled, setCompiled] = useState<CompileApiResult | null>(null);
  const [streamTimeline, setStreamTimeline] = useState<CompileResult["timeline"]>([]);
  const [receipt, setReceipt] = useState<SponsorReceipt | null>(null);
  const [busy, setBusy] = useState<"pilot" | "sponsor" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const pilotAbortRef = useRef<AbortController | null>(null);
  const runPilotRef = useRef<(nextIntent?: string) => Promise<void>>(async () => {});
  runPilotRef.current = runPilot;

  useEffect(() => {
    setIntent(defaultIntent);
    if (urlOracleId) {
      void runPilotRef.current(defaultIntent);
    }
  }, [defaultIntent, urlOracleId]);

  useEffect(() => {
    let cancelled = false;
    let hasPreview = false;
    let inFlight = false;

    async function loadMarketPreview() {
      if (inFlight) {
        return;
      }

      inFlight = true;

      try {
        const response = await fetch("/api/markets?status=active&expiry=next&pageSize=1", {
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error("Market preview unavailable.");
        }

        const payload = await response.json() as MarketDiscoveryResult;

        if (!cancelled) {
          hasPreview = true;
          setMarketPreview(payload);
        }
      } catch {
        if (!cancelled && !hasPreview) {
          setMarketPreview(null);
        }
      } finally {
        inFlight = false;
      }
    }

    void loadMarketPreview();
    const intervalId = window.setInterval(() => {
      void loadMarketPreview();
    }, MARKET_PREVIEW_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  async function runPilot(nextIntent = intent) {
    const trimmedIntent = nextIntent.trim();

    if (!trimmedIntent) {
      return;
    }

    pilotAbortRef.current?.abort();
    const controller = new AbortController();
    const assistantId = createMessageId("assistant");
    pilotAbortRef.current = controller;
    setBusy("pilot");
    setError(null);
    setReceipt(null);
    setCompiled(null);
    setPilotMode(null);
    setRagSources([]);
    setSourcesExpanded(false);
    setStreamTimeline([]);
    setAuditExpanded(false);
    setMessages((current) => {
      const nextMessages: PilotMessage[] = [
        ...current,
        {
          id: createMessageId("user"),
          role: "user",
          content: trimmedIntent
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          pending: true
        }
      ];

      return nextMessages.slice(-8);
    });

    try {
      const response = await fetch("/api/pilot/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: trimmedIntent,
          walletAddress: account?.address
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error("Pilot request failed.");
      }

      await readPilotStream(response, assistantId);
    } catch (pilotError) {
      if (pilotError instanceof DOMException && pilotError.name === "AbortError") {
        return;
      }

      const message = pilotError instanceof Error ? pilotError.message : "Pilot request failed.";
      setError(message);
      updateAssistantMessage(assistantId, {
        content: message,
        pending: false
      });
    } finally {
      if (pilotAbortRef.current === controller) {
        pilotAbortRef.current = null;
        setBusy(null);
      }
      updateAssistantMessage(assistantId, {
        pending: false
      });
    }
  }

  async function readPilotStream(response: Response, assistantId: string) {
    if (!response.body) {
      throw new Error("Pilot stream unavailable.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const rawEvent of events) {
        const data = rawEvent
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim();

        if (!data) {
          continue;
        }

        handlePilotEvent(JSON.parse(data) as PilotStreamEvent, assistantId);
      }
    }
  }

  function handlePilotEvent(event: PilotStreamEvent, assistantId: string) {
    if (event.type === "mode") {
      setPilotMode(event.mode);
      updateAssistantMessage(assistantId, {
        mode: event.mode
      });
      return;
    }

    if (event.type === "answer_delta") {
      setPilotMode("chat");
      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        mode: "chat",
        content: message.content + event.delta
      }));
      return;
    }

    if (event.type === "sources") {
      setRagSources(event.sources);
      updateAssistantMessage(assistantId, {
        sources: event.sources
      });
      return;
    }

    if (event.type === "stage") {
      setStreamTimeline((current) => upsertStage(current, event));
      return;
    }

    if (event.type === "compiled") {
      setCompiled(event.result as CompileApiResult);
      setPilotMode("trade");
      updateAssistantMessage(assistantId, {
        mode: "trade",
        pending: false,
        content: tradeAssistantCopy(event.result as CompileApiResult)
      });
      return;
    }

    if (event.type === "error") {
      setError(event.error);
      updateAssistantMessage(assistantId, {
        content: event.error,
        pending: false
      });
    }
  }

  function updateAssistantMessage(
    id: string,
    patch:
      | Partial<PilotMessage>
      | ((message: PilotMessage) => PilotMessage)
  ) {
    setMessages((current) => current.map((message) => {
      if (message.id !== id) {
        return message;
      }

      return typeof patch === "function" ? patch(message) : { ...message, ...patch };
    }));
  }

  function submitIntent() {
    void runPilot(intent);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    submitIntent();
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
    marketPreview?.selectedMarket?.oracleId ??
    undefined;
  const selectedStrike =
    typeof marketStrike === "number"
      ? marketStrike
      : typeof intentStrike === "number"
        ? intentStrike
        : urlStrike ?? marketPreview?.selectedMarket?.selectedStrike;
  const hasLockedStrike = Boolean(compiled?.market || intentStrike || urlStrike);
  const selectedStrikeLabel = hasLockedStrike ? "strike" : "ATM ref";

  return (
    <AppShell
      title="DeepPilot execution cockpit"
      description="Ask about markets, or turn one sentence into a Guardian-reviewed DeepBook Predict transaction preview."
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
          <section className="market-column flex min-w-0 flex-col gap-3">
            <PredictMarketChart oracleId={selectedOracleId} strike={selectedStrike} strikeLabel={selectedStrikeLabel} />
            <MarketCard compiled={compiled} preview={marketPreview?.selectedMarket ?? null} strikeLocked={hasLockedStrike} />
            <VaultCard compiled={compiled} previewMarket={marketPreview?.selectedMarket ?? null} previewVault={marketPreview?.vault ?? null} />
          </section>

          <section className="pilot-column flex min-w-0 flex-col gap-3">
            <PilotConsole
              intent={intent}
              messages={messages}
              busy={busy === "pilot"}
              onChange={setIntent}
              onSubmit={submitIntent}
              onKeyDown={onComposerKeyDown}
              onExample={(example) => {
                setIntent(example);
                void runPilot(example);
              }}
            />

            {pilotMode === "trade" || urlOracleId ? (
              <TradeTicket
                market={compiled?.market ?? null}
                initialOracleId={urlOracleId}
                initialStrike={urlStrike}
                onGenerate={(nextIntent) => {
                  setIntent(nextIntent);
                  void runPilot(nextIntent);
                }}
              />
            ) : null}
          </section>

          <aside className="audit-column flex min-w-0 flex-col gap-3">
            {pilotMode === "chat" ? (
              <SourcesCard sources={ragSources} expanded={sourcesExpanded} onToggle={() => setSourcesExpanded((current) => !current)} />
            ) : pilotMode === "trade" ? (
              <>
                <AuditToggle
                  expanded={auditExpanded}
                  busy={busy === "pilot"}
                  compiled={compiled}
                  onToggle={() => setAuditExpanded((current) => !current)}
                />
                <AnimatePresence initial={false}>
                  {auditExpanded ? (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex min-w-0 flex-col gap-3 overflow-hidden"
                    >
                      <OutcomeQuoteCard compiled={compiled} busy={busy === "pilot"} />
                      <CompilerCard compiled={compiled} busy={busy === "pilot"} streamTimeline={streamTimeline} />
                      <GuardianCard
                        compiled={compiled}
                        expandedFinding={expandedFinding}
                        onExpand={setExpandedFinding}
                      />
                      <PtbCard compiled={compiled} />
                      <GasCard compiled={compiled} accountAddress={account?.address} />
                      <ExecutionCard
                        compiled={compiled}
                        receipt={receipt}
                        error={error}
                        busy={busy === "sponsor"}
                        blocked={blocked}
                        onConfirm={sponsor}
                      />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </>
            ) : busy === "pilot" ? (
              <ProcessingCard />
            ) : (
              <IdleAuditCard />
            )}
          </aside>
        </div>
    </AppShell>
  );
}

function PilotConsole({
  intent,
  messages,
  busy,
  onChange,
  onSubmit,
  onKeyDown,
  onExample
}: {
  intent: string;
  messages: PilotMessage[];
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onExample: (example: string) => void;
}) {
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const latestMessage = messages.at(-1);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({
      block: "end",
      behavior: busy ? "smooth" : "auto"
    });
  }, [busy, latestMessage?.content, latestMessage?.pending, messages.length]);

  return (
    <Card className="glass-line">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Type your request here</CardTitle>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="pilot-chat-frame">
          {messages.length > 0 ? (
            <div className="pilot-transcript p-3">
              <div className="space-y-3">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                <div ref={transcriptEndRef} aria-hidden="true" />
              </div>
            </div>
          ) : (
            <div className="grid min-h-[72px] place-items-center border-b border-border/60 px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground/45">
                <Bot className="h-4 w-4" />
                <span>{COMPOSER_HINT}</span>
              </div>
            </div>
          )}

          <div className="pilot-composer-panel p-2.5">
            <div className="flex flex-col gap-2">
              <Textarea
                id="pilot-composer"
                className="min-h-[116px] resize-none border-border/80 bg-background/70 py-2.5 text-sm leading-6 shadow-none placeholder:text-muted-foreground/45 focus-visible:ring-1 focus-visible:ring-ring/70"
                value={intent}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={COMPOSER_HINT}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground/70">Enter to send · Shift+Enter for a new line</span>
                <Button className="h-9 w-full shrink-0 sm:w-auto" onClick={onSubmit} disabled={busy || !intent.trim()}>
                  {busy ? <RefreshCw className="animate-spin" /> : <Send />}
                  Send
                </Button>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              <span className="text-xs text-muted-foreground">Examples</span>
              {EXAMPLE_INTENTS.map((example) => (
                <button
                  key={example}
                  className="block w-full rounded-md border border-border bg-secondary/70 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:border-zinc-500 hover:bg-accent hover:text-foreground disabled:opacity-50"
                  onClick={() => onExample(example)}
                  disabled={busy}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MessageBubble({ message }: { message: PilotMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser ? (
        <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-card">
          <Bot className="h-4 w-4 text-muted-foreground" />
        </div>
      ) : null}
      <div
        className={cn(
          "max-w-[88%] rounded-md border p-3 text-sm leading-6",
          isUser
            ? "border-foreground/15 bg-foreground text-background"
            : "border-border bg-card/80 text-foreground"
        )}
      >
        {message.content ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Processing request...</span>
          </div>
        )}
        {!isUser && message.mode === "chat" && message.content ? (
          <p className="mt-3 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">{AI_DISCLOSURE}</p>
        ) : null}
      </div>
      {isUser ? (
        <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-card">
          <UserRound className="h-4 w-4 text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}

function IdleAuditCard() {
  return (
    <Card className="glass-line">
      <CardHeader className="pb-2">
        <SectionHeading title="Pilot Mode" detail="waiting" icon={<Bot className="h-4 w-4" />} />
      </CardHeader>
      <CardContent>
        <MutedBox>
          Ask a market question to see sources, or submit a trade request to open the Guardian and PTB review.
        </MutedBox>
      </CardContent>
    </Card>
  );
}

function ProcessingCard() {
  return (
    <Card className="glass-line">
      <CardHeader className="pb-2">
        <SectionHeading title="Processing" detail="routing" icon={<RefreshCw className="h-4 w-4 animate-spin" />} />
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-border bg-background/60 p-3">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <span className="h-2 w-2 rounded-full bg-foreground processing-dot" />
            <span className="h-2 w-2 rounded-full bg-foreground processing-dot" style={{ animationDelay: "120ms" }} />
            <span className="h-2 w-2 rounded-full bg-foreground processing-dot" style={{ animationDelay: "240ms" }} />
            <span className="ml-2">Classifying request and preparing the next panel.</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditToggle({
  expanded,
  busy,
  compiled,
  onToggle
}: {
  expanded: boolean;
  busy: boolean;
  compiled: CompileApiResult | null;
  onToggle: () => void;
}) {
  const quote = compiled?.quote;
  const quoteReady = quote?.status === "available";
  const detail = quoteReady
    ? "quote ready"
    : quote?.status === "unavailable"
      ? "quote unavailable"
      : compiled?.guardian.decision
        ? compiled.guardian.decision.toUpperCase()
        : busy ? "checking" : "review";
  const firstCommand = compiled?.ptb?.commands[0] ?? null;
  const summaryRows = compiled
    ? quoteReady
      ? [
          ["Outcome", `BTC ${quote.direction?.toUpperCase() ?? "--"}`],
          ["Est. pay", `${formatDusdc(quote.estimatedCostDusdc)} DUSDC`],
          ["Max payout", `${formatDusdc(quote.maxPayoutDusdc)} DUSDC`],
          ["Return", formatSignedPercent(quote.returnPct)]
        ]
      : [
          ["Guardian", compiled.guardian.decision.toUpperCase()],
          ["Quote", quote?.status === "unavailable" ? "unavailable" : "not required"],
          ["PTB digest", compiled.ptb?.digestPreview ? shortAddress(compiled.ptb.digestPreview) : "not compiled"],
          ["Move target", firstCommand?.target ? compactMiddle(firstCommand.target, 18) : "locked"]
        ]
    : [
        ["Guardian", busy ? "checking" : "waiting"],
        ["Quote", busy ? "checking" : "waiting"],
        ["PTB digest", "waiting"]
      ];

  return (
    <Card className="glass-line">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Trade Review</CardTitle>
            </div>
            <CardDescription className="text-xs">{detail}</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onToggle}>
            <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
            {expanded ? "Hide details" : "Show details"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-4 pt-0">
        <div className="rounded-md border border-border bg-background/55">
          {summaryRows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[86px_1fr] gap-3 border-b border-border/70 px-3 py-2 last:border-b-0">
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
              <span className="min-w-0 truncate font-mono text-xs text-foreground/85">{value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function OutcomeQuoteCard({
  compiled,
  busy
}: {
  compiled: CompileApiResult | null;
  busy: boolean;
}) {
  const quote = compiled?.quote;

  return (
    <Card className="glass-line overflow-hidden">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Outcome Quote</CardTitle>
            </div>
            <CardDescription className="text-xs">
              {quote?.status === "available"
                ? "Vault-backed DeepBook Predict estimate"
                : busy ? "Requesting chain quote" : "Quote unavailable"}
            </CardDescription>
          </div>
          <Badge variant="outline" className="h-7 border-border text-xs text-muted-foreground">
            {quote?.status === "available" ? "live estimate" : quote?.status ?? "waiting"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {!quote ? (
          <QuoteSkeleton busy={busy} />
        ) : quote.status !== "available" ? (
          <MutedBox>{quote.warning ?? "DeepPilot could not verify mint cost and payout before signing."}</MutedBox>
        ) : (
          <>
            <div className="rounded-md border border-border bg-background/55 p-3">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Outcome</p>
                  <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                    BTC {quote.direction?.toUpperCase()}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    Strike {formatUsd(quote.strike)} · {formatExpiry(quote.expiry)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Return if correct</p>
                  <p className="mt-1 text-xl font-semibold text-foreground">{formatSignedPercent(quote.returnPct)}</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MarketMetric label="Est. Pay" value={`${formatDusdc(quote.estimatedCostDusdc)} DUSDC`} />
              <MarketMetric label="Max Payout" value={`${formatDusdc(quote.maxPayoutDusdc)} DUSDC`} />
              <MarketMetric label="Ask Price" value={formatUnitPrice(quote.askPrice)} />
              <MarketMetric label="Bid Price" value={formatUnitPrice(quote.bidPrice)} />
              <MarketMetric label="Quantity" value={formatDusdc(quote.quantityDusdc)} />
              <MarketMetric label="Quote Expires" value={formatQuoteExpiry(quote.expiresAt)} />
            </div>
            <p className="rounded-md border border-border bg-background/40 p-3 text-xs leading-5 text-muted-foreground">
              {quote.warning}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function QuoteSkeleton({ busy }: { busy: boolean }) {
  return (
    <div className="rounded-md border border-border bg-background/55 p-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleDashed className={cn("h-4 w-4", busy && "animate-spin")} />
        <span>{busy ? "Quoting DeepBook payout..." : "Waiting for a binary Predict trade."}</span>
      </div>
    </div>
  );
}

function CompilerCard({
  compiled,
  busy,
  streamTimeline
}: {
  compiled: CompileApiResult | null;
  busy: boolean;
  streamTimeline: CompileResult["timeline"];
}) {
  const fallback = [
    "Parsing intent",
    "Reading DeepBook Predict state",
    "Running Guardian checks",
    "Compiling Predict PTB preview",
    "Awaiting confirmation"
  ];
  const timeline = compiled?.timeline ?? (streamTimeline.length ? streamTimeline : fallback.map((label) => ({ label, state: "pending" as const })));

  return (
    <Card>
      <CardHeader className="pb-2">
        <SectionHeading title="Execution Checklist" detail={`${timeline.length} steps`} />
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

function upsertStage(
  stages: CompileResult["timeline"],
  event: Extract<PilotStreamEvent, { type: "stage" }>
) {
  const next = stages.some((stage) => stage.label === event.label)
    ? stages.map((stage) => stage.label === event.label ? { label: event.label, state: event.state } : stage)
    : [...stages, { label: event.label, state: event.state }];

  return next;
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
        {compiled?.ptb?.sizing ? (
          <MutedBox>
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Sizing</span>
            <span className="mt-1 block text-sm text-foreground/80">{compiled.ptb.sizing.label}</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">{compiled.ptb.sizing.reason}</span>
          </MutedBox>
        ) : null}
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

function SourcesCard({
  sources,
  expanded,
  onToggle
}: {
  sources: RagSource[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Card className="glass-line">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>RAG Sources</CardTitle>
            <CardDescription>{sources.length ? `${sources.length} refs` : "waiting"}</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onToggle} disabled={sources.length === 0}>
            <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
            {expanded ? "Hide" : "Show"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {sources.length === 0 ? (
          <MutedBox>Waiting for Predict oracle, news, and local docs context.</MutedBox>
        ) : !expanded ? (
          <div className="space-y-1">
            {sources.slice(0, 6).map((source) => (
              <div key={source.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-border bg-background/45 px-2 py-1.5">
                <span className="font-mono text-[10px] text-muted-foreground">{source.id}</span>
                <span className="min-w-0 truncate text-xs text-foreground/85">{compactSourceTitle(source)}</span>
                <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{source.sourceType}</span>
              </div>
            ))}
          </div>
        ) : (
          sources.map((source) => (
            <div key={source.id} className="rounded-md border border-border bg-background/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{source.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{source.snippet}</p>
                </div>
                <Badge variant="outline" className="shrink-0 border-border text-[10px] uppercase text-muted-foreground">
                  {source.partial ? "partial" : source.sourceType}
                </Badge>
              </div>
              {source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {source.url}
                </a>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function MarketCard({
  compiled,
  preview,
  strikeLocked
}: {
  compiled: CompileApiResult | null;
  preview: MarketListItem | null;
  strikeLocked: boolean;
}) {
  const market = compiled?.market;
  const oracleId = market?.oracle.oracle_id ?? preview?.oracleId ?? null;
  const expiry = market?.oracle.expiry ?? preview?.expiry ?? null;
  const strikeLabel = strikeLocked ? "Trade Strike" : "ATM Ref";
  const metrics = market
    ? {
        spot: market.metrics.spot,
        forward: market.metrics.forward,
        selectedStrike: market.metrics.selectedStrike,
        oracleAgeMs: market.metrics.oracleAgeMs
      }
    : preview
      ? {
          spot: preview.spot,
          forward: preview.forward,
          selectedStrike: preview.selectedStrike,
          oracleAgeMs: preview.oracleAgeMs
        }
      : null;

  return (
    <Card className="glass-line">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Oracle</CardTitle>
            <CardDescription className="text-xs">{oracleId ? shortAddress(oracleId) : "BTC Predict oracle"}</CardDescription>
          </div>
          <Badge variant="outline" className="h-7 border-border text-xs text-muted-foreground">
            {strikeLocked ? "Review locked" : "Live preview"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {!metrics ? (
          <MutedBox>Loading latest BTC Predict market.</MutedBox>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <MarketMetric label="Spot" value={formatUsd(metrics.spot)} />
            <MarketMetric label="Forward" value={formatUsd(metrics.forward)} />
            <MarketMetric label={strikeLabel} value={formatUsd(metrics.selectedStrike)} />
            <MarketMetric label="Expiry" value={formatExpiry(expiry)} />
            <MarketMetric label="Oracle Age" value={formatAge(metrics.oracleAgeMs)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VaultCard({
  compiled,
  previewMarket,
  previewVault
}: {
  compiled: CompileApiResult | null;
  previewMarket: MarketListItem | null;
  previewVault: VaultSummary | null;
}) {
  const market = compiled?.market;
  const vaultUtilization = market?.metrics.vaultUtilization ?? previewMarket?.vaultUtilization ?? previewVault?.utilization ?? null;
  const maxPayoutUtilization = market?.metrics.maxPayoutUtilization ?? previewMarket?.maxPayoutUtilization ?? previewVault?.max_payout_utilization ?? null;
  const availableLiquidityDusdc =
    market?.metrics.availableLiquidityDusdc ??
    previewMarket?.availableLiquidityDusdc ??
    (previewVault ? previewVault.available_liquidity / 1_000_000 : null);
  const notionalDusdc = market?.metrics.notionalDusdc ?? null;
  const askBoundsAvailable = market?.metrics.askBoundsAvailable ?? previewMarket?.askBoundsAvailable ?? null;
  const hasVault = vaultUtilization !== null || availableLiquidityDusdc !== null;

  return (
    <Card className="glass-line">
      <CardHeader className="p-4 pb-2">
        <SectionHeading title="Vault Risk" detail={vaultUtilization !== null ? `${(vaultUtilization * 100).toFixed(2)}% used` : "waiting"} />
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {!hasVault ? (
          <MutedBox>Loading latest vault snapshot.</MutedBox>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <MarketMetric label="Available" value={availableLiquidityDusdc === null ? "--" : `${formatCompactNumber(availableLiquidityDusdc)} DUSDC`} />
            <MarketMetric label="Notional" value={notionalDusdc === null ? "market preview" : `${notionalDusdc.toLocaleString()} DUSDC`} />
            <MarketMetric label="Max Payout Use" value={maxPayoutUtilization === null ? "--" : `${(maxPayoutUtilization * 100).toFixed(2)}%`} />
            <MarketMetric label="Ask Bounds" value={askBoundsAvailable === null ? "--" : askBoundsAvailable ? "available" : "fallback"} />
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
  const canConfirm = Boolean(compiled?.ptb && compiled.ptb.execution.canSign && !blocked && compiled.gas.approved);
  const readiness = compiled?.ptb?.execution;

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
          {busy ? <RefreshCw className="animate-spin" /> : !canConfirm ? <AlertTriangle /> : <LockKeyhole />}
          {blocked ? "Blocked by Guardian" : canConfirm ? "Review & Sign" : "Review locked"}
        </Button>

        {readiness ? (
          <div className="mt-4 space-y-1">
            {readiness.checks.map((check) => (
              <div key={check.label} className="grid grid-cols-[1fr_18px] items-start gap-2 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-muted-foreground">{check.label}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground/80">{check.detail}</p>
                </div>
                {check.passed ? <Check className="h-4 w-4 text-foreground" /> : <X className="h-4 w-4 text-destructive" />}
              </div>
            ))}
          </div>
        ) : null}

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

function tradeAssistantCopy(compiled: CompileApiResult) {
  if (compiled.intent.status === "needs_clarification") {
    return `I need one more field before building a transaction review: ${compiled.intent.missing.join(", ")}.\n${compiled.intent.reason}`;
  }

  if (compiled.guardian.decision === "block") {
    return `Guardian returned BLOCK.\n${compiled.guardian.summary}\nReview the blocked checks on the right before changing the intent.`;
  }

  const action = compiled.intent.action.replaceAll("_", " ");
  const digest = compiled.ptb?.digestPreview ?? "No PTB digest";
  const quote = compiled.quote?.status === "available"
    ? [
        `Outcome: BTC ${compiled.quote.direction?.toUpperCase() ?? "--"}`,
        `Estimated pay: ${formatDusdc(compiled.quote.estimatedCostDusdc)} DUSDC`,
        `Max payout: ${formatDusdc(compiled.quote.maxPayoutDusdc)} DUSDC`,
        `Return if correct: ${formatSignedPercent(compiled.quote.returnPct)}`
      ]
    : compiled.quote?.status === "unavailable"
      ? [`Quote: unavailable (${compiled.quote.warning ?? "could not verify payout"})`]
      : [];

  return [
    "Draft Predict trade is ready for review.",
    `Action: ${action}`,
    `Guardian: ${compiled.guardian.decision.toUpperCase()}`,
    ...quote,
    `PTB digest: ${digest}`,
    "Use Review & Sign only after checking the Guardian result, Move target, objects, and amount."
  ].join("\n");
}

function createMessageId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
        <CardTitle className="truncate text-sm">{title}</CardTitle>
      </div>
      <CardDescription className="shrink-0 text-xs">{detail}</CardDescription>
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
    <div className="rounded-md border border-border bg-background/60 p-2.5">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1.5 break-words text-sm font-semibold leading-tight tracking-tight text-foreground">{value}</p>
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

function compactMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  const edge = Math.max(4, Math.floor((maxLength - 3) / 2));

  return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function compactSourceTitle(source: RagSource) {
  const cleanTitle = source.title
    .replace(/^(CoinDesk|Cointelegraph|Decrypt):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = source.snippet.replace(/\s+/g, " ").trim();
  const label = cleanTitle || fallback || source.sourceType;

  return label.length > 42 ? `${label.slice(0, 42)}...` : label;
}

function formatUsd(value: number | null) {
  return value === null ? "--" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatDusdc(value: number | null) {
  return value === null
    ? "--"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: value > 0 && value < 1 ? 4 : 2,
        maximumFractionDigits: value > 0 && value < 1 ? 6 : 2
      });
}

function formatUnitPrice(value: number | null) {
  return value === null ? "--" : value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function formatSignedPercent(value: number | null) {
  if (value === null) {
    return "--";
  }

  const sign = value > 0 ? "+" : "";

  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function formatQuoteExpiry(value: string) {
  const time = new Date(value).getTime();

  if (!Number.isFinite(time)) {
    return "--";
  }

  const seconds = Math.max(0, Math.round((time - Date.now()) / 1_000));

  return `${seconds}s`;
}

function formatExpiry(valueMs: number | null) {
  if (valueMs === null) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(valueMs));
}

function formatCompactNumber(value: number) {
  const abs = Math.abs(value);
  const unit =
    abs >= 1_000_000_000
      ? { divisor: 1_000_000_000, suffix: "B" }
      : abs >= 1_000_000
        ? { divisor: 1_000_000, suffix: "M" }
        : abs >= 1_000
          ? { divisor: 1_000, suffix: "K" }
          : null;

  if (!unit) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  const scaled = value / unit.divisor;
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;

  return `${trimTrailingZeros(scaled.toFixed(digits))}${unit.suffix}`;
}

function trimTrailingZeros(value: string) {
  return value.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");
}

function formatAge(valueMs: PredictMarketSnapshot["metrics"]["oracleAgeMs"]) {
  if (valueMs === null) {
    return "--";
  }

  return valueMs < 1_000 ? `${valueMs}ms` : `${(valueMs / 1_000).toFixed(1)}s`;
}
