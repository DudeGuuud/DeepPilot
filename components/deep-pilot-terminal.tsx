"use client";

import { useCurrentAccount, useCurrentNetwork, useDAppKit } from "@mysten/dapp-kit-react";
import type { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
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
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { PredictMarketChart } from "@/components/predict-market-chart";
import { TradeTicket } from "@/components/trade-ticket";
import {
  assertExecuted,
  buildBatchPredictMintTransaction,
  buildBinaryMintTransaction,
  buildCreatePredictManagerTransaction,
  buildVaultLpSupplyTransaction,
  buildVaultLpWithdrawTransaction,
  extractPredictManagerId,
  getExecutedDigest
} from "@/src/lib/predict-execution";
import { storePreviewReceipt } from "@/src/lib/receipts";
import { readCoinBalanceRaw, readSuiBalanceRaw } from "@/src/lib/sui-balances";
import { cn } from "@/src/lib/utils";
import { explainWalletExecutionError } from "@/src/lib/wallet-errors";
import type {
  CompileResult,
  BatchPredictMintTransactionData,
  CompiledTradeLeg,
  ExecutionReadinessCheck,
  GuardianFinding,
  MarketDiscoveryResult,
  MarketListItem,
  PilotMessageSummary,
  PilotMode,
  PilotStreamEvent,
  PredictMarketSnapshot,
  RagSource,
  RiskLevel,
  StrategyReview,
  VaultLpReview,
  VaultSummary
} from "@/src/lib/types";

const DEFAULT_INTENT = "";
const COMPOSER_HINT = "Ask market context or draft a Predict transaction";
const SAMPLE_INTENT = "Bet 1 DUSDC on BTC DOWN at the nearest settlement";
const EXAMPLE_INTENTS = [
  "Summarize BTC news and market risks",
  "Build a 1 DUSDC hedge strategy, mostly BTC UP, nearest settlement",
  "Split 1 DUSDC BTC UP across nearest, 1h, and 2h expiries",
  "Deposit 1 DUSDC to Vault LP",
  "Show Vault LP performance",
  SAMPLE_INTENT,
  "Check active Predict markets and vault risk"
];
const AI_DISCLOSURE =
  "This answer is AI-generated for information organization and risk explanation only. It is not investment advice; verify original sources and the wallet confirmation screen.";
const MARKET_PREVIEW_REFRESH_MS = 2_500;
const REVIEW_AUTO_REFRESH_MS = 18_000;
const MIN_SUI_GAS_BALANCE_MIST = 20_000_000n;
const MIST_PER_SUI = 1_000_000_000n;
const DUSDC_BASE_UNITS = 1_000_000n;
const CONVERSATION_CONTEXT_TTL_MS = 5 * 60 * 1_000;

type RunPilotOptions = {
  openTradeModal?: boolean;
  clearComposer?: boolean;
  ignorePendingClarification?: boolean;
};

type TradeModalStatus =
  | "idle"
  | "compiling"
  | "quote_ready"
  | "funding_required"
  | "review_changed"
  | "preflight_failed"
  | "ready_to_sign"
  | "signing"
  | "executed"
  | "failed";

type PreflightSnapshot = {
  suiBalanceRaw: string;
  requiredSuiRaw: string;
  estimatedPaymentRaw: string | null;
  managerBalanceRaw: string | null;
  fundingShortfallRaw: string | null;
};

type PreflightExecutionLike = {
  estimatedPaymentRaw: string | null;
  managerBalanceRaw: string | null;
  fundingShortfallRaw: string | null;
};

type CompileApiResult = CompileResult & {
  predict?: {
    network: string;
    transport: string;
    endpoint: string;
    predictId: string;
    quoteAsset: string;
  };
};

type StrategyApiReview = StrategyReview & {
  predict?: {
    network: string;
    transport: string;
    endpoint: string;
    predictId: string;
    quoteAsset: string;
  };
};

type ExecutionReceipt = {
  digest: string;
  status: "success" | "failed";
  walletAddress: string;
  network: "devnet" | "testnet";
  action: "manager_create" | "predict_mint" | "strategy_batch_mint" | "vault_lp_supply" | "vault_lp_withdraw";
  managerId?: string | null;
  note: string;
};

type PilotMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode?: PilotMode;
  reviewAction?: {
    kind: "trade" | "strategy" | "vault_lp" | "profile";
    label: string;
    description: string;
    href?: string;
  };
  sources?: RagSource[];
  pending?: boolean;
  createdAt?: number;
};

type PendingPilotClarification = {
  mode: Exclude<PilotMode, "chat">;
  originalText: string;
  missing: string[];
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
  const urlManagerId = useMemo(() => managerIdFromSearch(searchParams), [searchParams]);
  const reviewToken = useMemo(() => reviewTokenFromSearch(searchParams), [searchParams]);
  const [activeRouteOracleId, setActiveRouteOracleId] = useState<string | null>(null);
  const routeOracleIsActive = Boolean(urlOracleId && activeRouteOracleId === urlOracleId);
  const routeIntent = DEFAULT_INTENT;
  const routeStateKey = `${urlOracleId ?? ""}:${urlStrike ?? ""}`;
  const [intent, setIntent] = useState(routeIntent);
  const [managerId, setManagerId] = useState<string | null>(urlManagerId);
  const [messages, setMessages] = useState<PilotMessage[]>([]);
  const [pilotMode, setPilotMode] = useState<PilotMode | null>(null);
  const [ragSources, setRagSources] = useState<RagSource[]>([]);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [marketPreview, setMarketPreview] = useState<MarketDiscoveryResult | null>(null);
  const [compiled, setCompiled] = useState<CompileApiResult | null>(null);
  const [strategyReview, setStrategyReview] = useState<StrategyApiReview | null>(null);
  const [vaultLpReview, setVaultLpReview] = useState<VaultLpReview | null>(null);
  const [vaultLpModalOpen, setVaultLpModalOpen] = useState(false);
  const [vaultLpDetailsExpanded, setVaultLpDetailsExpanded] = useState(false);
  const [selectedStrategyLegIds, setSelectedStrategyLegIds] = useState<string[]>([]);
  const [streamTimeline, setStreamTimeline] = useState<CompileResult["timeline"]>([]);
  const [receipt, setReceipt] = useState<ExecutionReceipt | null>(null);
  const [busy, setBusy] = useState<"pilot" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [tradeModalOpen, setTradeModalOpen] = useState(false);
  const [tradeModalStatus, setTradeModalStatus] = useState<TradeModalStatus>("idle");
  const [tradeDetailsExpanded, setTradeDetailsExpanded] = useState(false);
  const [pendingClarification, setPendingClarification] = useState<PendingPilotClarification | null>(null);
  const [preflightSnapshot, setPreflightSnapshot] = useState<PreflightSnapshot | null>(null);
  const [confirmedReviewFingerprint, setConfirmedReviewFingerprint] = useState<string | null>(null);
  const [activeReviewMessageId, setActiveReviewMessageId] = useState<string | null>(null);
  const executionRef = useRef(false);
  const pilotAbortRef = useRef<AbortController | null>(null);
  const loadedReviewTokenRef = useRef<string | null>(null);
  const runPilotRef = useRef<(nextIntent?: string, managerOverride?: string | null, options?: RunPilotOptions) => Promise<void>>(async () => {});
  runPilotRef.current = runPilot;
  const resetPilotRuntime = useCallback((nextIntent = DEFAULT_INTENT) => {
    setIntent(nextIntent);
    setMessages([]);
    setPilotMode(null);
    setRagSources([]);
    setSourcesExpanded(false);
    setCompiled(null);
    setStrategyReview(null);
    setVaultLpReview(null);
    setVaultLpModalOpen(false);
    setVaultLpDetailsExpanded(false);
    setSelectedStrategyLegIds([]);
    setStreamTimeline([]);
    setReceipt(null);
    setBusy(null);
    setError(null);
    setExpandedFinding(null);
    setTradeModalOpen(false);
    setTradeModalStatus("idle");
    setTradeDetailsExpanded(false);
    setPendingClarification(null);
    setPreflightSnapshot(null);
    setConfirmedReviewFingerprint(null);
    setActiveReviewMessageId(null);
    pilotAbortRef.current?.abort();
    pilotAbortRef.current = null;
  }, []);

  useEffect(() => {
    resetPilotRuntime(routeIntent);
  }, [resetPilotRuntime, routeIntent, routeStateKey]);

  useEffect(() => {
    if (!reviewToken) {
      return;
    }

    const token = reviewToken;
    const walletAddress = account?.address ?? null;

    if (!walletAddress) {
      const pendingWalletKey = `${token}:needs-wallet`;

      if (loadedReviewTokenRef.current !== pendingWalletKey) {
        loadedReviewTokenRef.current = pendingWalletKey;
        toast({
          variant: "destructive",
          title: "Connect wallet",
          description: "Please connect your wallet first to open this review."
        });
      }

      return;
    }

    if (loadedReviewTokenRef.current === `${token}:${walletAddress ?? "no-wallet"}`) {
      return;
    }

    let cancelled = false;

    async function loadReviewSeed() {
      try {
        const walletQuery = walletAddress ? `&wallet=${encodeURIComponent(walletAddress)}` : "";
        const response = await fetch(`/api/review-seed?token=${encodeURIComponent(token)}${walletQuery}`, {
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error("Review link is invalid or expired.");
        }

        const payload = await response.json() as { seed?: { message?: string } };
        const message = payload.seed?.message?.trim();

        if (!cancelled && message) {
          loadedReviewTokenRef.current = `${token}:${walletAddress ?? "no-wallet"}`;
          await runPilotRef.current(message, managerId, { openTradeModal: true, clearComposer: false, ignorePendingClarification: true });
        }
      } catch (seedError) {
        if (!cancelled) {
          setError(seedError instanceof Error ? seedError.message : "Review link is invalid or expired.");
        }
      }
    }

    void loadReviewSeed();

    return () => {
      cancelled = true;
    };
  }, [account?.address, managerId, reviewToken]);

  useEffect(() => {
    const stopPendingPilot = () => {
      pilotAbortRef.current?.abort();
      pilotAbortRef.current = null;
      setBusy(null);
      setMessages((current) => current.map((message) => message.pending ? { ...message, pending: false } : message));
    };

    const onPageHide = () => {
      stopPendingPilot();
    };

    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  useEffect(() => {
    setManagerId(urlManagerId);
  }, [urlManagerId]);

  useEffect(() => {
    setActiveRouteOracleId(null);
  }, [urlOracleId]);

  useEffect(() => {
    setConfirmedReviewFingerprint(null);
    setPreflightSnapshot(null);
  }, [account?.address]);

  const effectiveStrategyReview = useMemo(
    () => strategyReview ? applyStrategySelection(strategyReview, selectedStrategyLegIds) : null,
    [selectedStrategyLegIds, strategyReview]
  );

  useEffect(() => {
    if (
      !tradeModalOpen ||
      busy ||
      tradeModalStatus === "compiling" ||
      tradeModalStatus === "signing" ||
      tradeModalStatus === "executed" ||
      (!compiled && !effectiveStrategyReview)
    ) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    async function refreshOpenReview() {
      if (cancelled || inFlight || !pageIsVisible()) {
        return;
      }

      inFlight = true;

      try {
        if (effectiveStrategyReview) {
          const currentFingerprint = strategyExecutableFingerprint(effectiveStrategyReview);
          const refreshed = applyStrategySelection(
            await refreshStrategyBeforeSigning(effectiveStrategyReview),
            selectedStrategyLegIds
          );

          if (cancelled) {
            return;
          }

          setStrategyReview(refreshed);

          if (!isStrategyReviewActive(refreshed)) {
            setConfirmedReviewFingerprint(null);
            setTradeModalStatus("failed");
            setError(refreshed.reviewFreshness.reason);
            return;
          }

          if (currentFingerprint !== strategyExecutableFingerprint(refreshed)) {
            setConfirmedReviewFingerprint(strategyExecutableFingerprint(refreshed));
            setTradeModalStatus("review_changed");
          }
          return;
        }

        if (compiled) {
          const currentFingerprint = executableFingerprint(compiled);
          const refreshed = await refreshReviewBeforeSigning(compiled);

          if (cancelled) {
            return;
          }

          setCompiled(refreshed);

          if (!isReviewActive(refreshed)) {
            setConfirmedReviewFingerprint(null);
            setTradeModalStatus("failed");
            setError(refreshed.reviewFreshness?.reason ?? "Market expired, refresh review.");
            return;
          }

          if (currentFingerprint !== executableFingerprint(refreshed)) {
            setConfirmedReviewFingerprint(executableFingerprint(refreshed));
            setTradeModalStatus("review_changed");
          }
        }
      } catch {
        // Background refresh should not interrupt a readable review. Explicit signing still runs a hard refresh.
      } finally {
        inFlight = false;
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshOpenReview();
    }, REVIEW_AUTO_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [busy, compiled, effectiveStrategyReview, selectedStrategyLegIds, tradeModalOpen, tradeModalStatus]);

  useEffect(() => {
    let cancelled = false;
    let hasPreview = false;
    let inFlight = false;

    async function loadMarketPreview() {
      if (inFlight || !pageIsVisible()) {
        return;
      }

      inFlight = true;

      try {
        const response = await fetch(marketPreviewEndpoint(urlOracleId), {
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error("Market preview unavailable.");
        }

        const payload = await response.json() as MarketDiscoveryResult;

        if (!cancelled) {
          hasPreview = true;
          setMarketPreview(payload);
          setActiveRouteOracleId(urlOracleId && payload.selectedMarket?.oracleId === urlOracleId ? urlOracleId : null);
        }
      } catch {
        if (!cancelled && !hasPreview) {
          setMarketPreview(null);
          setActiveRouteOracleId(null);
        }
      } finally {
        inFlight = false;
      }
    }

    void loadMarketPreview();
    const intervalId = window.setInterval(() => {
      void loadMarketPreview();
    }, MARKET_PREVIEW_REFRESH_MS);
    const onVisibilityChange = () => {
      void loadMarketPreview();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [urlOracleId]);

  async function runPilot(nextIntent = intent, managerOverride = managerId, options: RunPilotOptions = {}) {
    const trimmedIntent = nextIntent.trim();

    if (!trimmedIntent) {
      return;
    }

    const clarification = options.ignorePendingClarification ? null : pendingClarification;
    const requestIntent = clarification ? mergePendingClarification(clarification, trimmedIntent) : trimmedIntent;
    const conversation = buildConversationForPilot(messages);
    const lastMarketThesis = latestMarketThesis(messages);
    pilotAbortRef.current?.abort();
    const controller = new AbortController();
    const assistantId = createMessageId("assistant");
    const startedAt = Date.now();
    pilotAbortRef.current = controller;
    setBusy("pilot");
    setError(null);
    setReceipt(null);
    setCompiled(null);
    setStrategyReview(null);
    setVaultLpReview(null);
    setVaultLpModalOpen(false);
    setVaultLpDetailsExpanded(false);
    setSelectedStrategyLegIds([]);
    setConfirmedReviewFingerprint(null);
    setPreflightSnapshot(null);
    setPilotMode(null);
    setRagSources([]);
    setSourcesExpanded(false);
    setStreamTimeline([]);
    setTradeDetailsExpanded(false);
    setActiveReviewMessageId(null);
    setTradeModalStatus(options.openTradeModal ? "compiling" : "idle");
    setTradeModalOpen(Boolean(options.openTradeModal));
    if (!clarification || options.ignorePendingClarification) {
      setPendingClarification(null);
    }
    if (options.clearComposer !== false) {
      setIntent("");
    }
    setMessages((current) => {
      const nextMessages: PilotMessage[] = [
        ...current,
        {
          id: createMessageId("user"),
          role: "user",
          content: trimmedIntent,
          createdAt: startedAt
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          pending: true,
          createdAt: startedAt
        }
      ];

      return nextMessages.slice(-8);
    });

    try {
      const response = await fetch("/api/pilot/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: requestIntent,
          walletAddress: account?.address,
          managerId: managerOverride ?? undefined,
          conversation,
          lastMarketThesis
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
      if (event.mode === "trade" || event.mode === "strategy") {
        setTradeModalOpen(true);
        setTradeModalStatus("compiling");
      } else if (event.mode === "vault_lp") {
        setVaultLpModalOpen(true);
      }
      updateAssistantMessage(assistantId, {
        mode: event.mode
      });
      return;
    }

    if (event.type === "answer_delta") {
      setPilotMode(null);
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
      if (tradeModalOpen || pilotMode === "trade" || pilotMode === "strategy") {
        setTradeModalStatus("compiling");
      }
      setStreamTimeline((current) => upsertStage(current, event));
      return;
    }

    if (event.type === "clarification") {
      setPendingClarification({
        mode: event.mode,
        originalText: event.originalText,
        missing: event.missing
      });
      setPilotMode("chat");
      setTradeModalOpen(false);
      setTradeModalStatus("idle");
      setVaultLpModalOpen(false);
      setVaultLpDetailsExpanded(false);
      setCompiled(null);
      setStrategyReview(null);
      setVaultLpReview(null);
      setSelectedStrategyLegIds([]);
      setActiveReviewMessageId(null);
      updateAssistantMessage(assistantId, {
        mode: undefined,
        pending: false,
        content: event.question,
        reviewAction: undefined
      });
      return;
    }

    if (event.type === "compiled") {
      const result = event.result as CompileApiResult;
      const compiledManagerId = result.profile?.managerId ?? result.ptb?.execution.managerId ?? null;
      const needsProfile = needsDeepPilotProfile(result);

      if (compiledManagerId) {
        setManagerId(compiledManagerId);
        updateManagerInUrl(compiledManagerId);
      }

      setCompiled(result);
      setStrategyReview(null);
      setVaultLpReview(null);
      setVaultLpModalOpen(false);
      setSelectedStrategyLegIds([]);
      setPilotMode("trade");
      setPendingClarification(null);
      setTradeModalOpen(!needsProfile);
      setTradeModalStatus(tradeStatusForCompiled(result));
      setTradeDetailsExpanded(false);
      setActiveReviewMessageId(needsProfile ? null : assistantId);
      updateAssistantMessage(assistantId, {
        mode: "trade",
        pending: false,
        content: tradeAssistantCopy(result),
        reviewAction: needsProfile
          ? profileReviewAction()
          : {
              kind: "trade",
              label: "Open Review & Sign",
              description: "Resume the prepared Predict trade review."
            }
      });
      return;
    }

    if (event.type === "strategy_compiled") {
      const review = event.review as StrategyApiReview;
      const compiledManagerId = review.aggregateReadiness.managerId ?? null;
      const needsProfile = strategyNeedsDeepPilotProfile(review);

      if (compiledManagerId) {
        setManagerId(compiledManagerId);
        updateManagerInUrl(compiledManagerId);
      }

      setCompiled(null);
      setStrategyReview(review);
      setVaultLpReview(null);
      setVaultLpModalOpen(false);
      setSelectedStrategyLegIds(defaultSelectedStrategyLegIds(review));
      setPilotMode("strategy");
      setPendingClarification(null);
      setTradeModalOpen(!needsProfile);
      setTradeModalStatus(strategyStatusForReview(review));
      setTradeDetailsExpanded(false);
      setActiveReviewMessageId(needsProfile ? null : assistantId);
      updateAssistantMessage(assistantId, {
        mode: "strategy",
        pending: false,
        content: strategyAssistantCopy(review),
        reviewAction: needsProfile
          ? profileReviewAction()
          : {
              kind: "strategy",
              label: "Open Strategy Review",
              description: "Resume the prepared multi-leg review."
            }
      });
      return;
    }

    if (event.type === "vault_lp_compiled") {
      setCompiled(null);
      setStrategyReview(null);
      setSelectedStrategyLegIds([]);
      setVaultLpReview(event.review);
      setPilotMode("vault_lp");
      setPendingClarification(null);
      setTradeModalOpen(false);
      setVaultLpModalOpen(true);
      setVaultLpDetailsExpanded(false);
      setActiveReviewMessageId(assistantId);
      updateAssistantMessage(assistantId, {
        mode: "vault_lp",
        pending: false,
        content: vaultLpAssistantCopy(event.review),
        reviewAction: {
          kind: "vault_lp",
          label: "Open Vault LP Review",
          description: "Resume the prepared Vault LP review."
        }
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

  function openActiveReviewFromChat(messageId: string) {
    if (messageId !== activeReviewMessageId || (!compiled && !effectiveStrategyReview && !vaultLpReview)) {
      toast({
        variant: "destructive",
        title: "Review unavailable",
        description: "This chat message no longer has the active review. Generate a fresh review before signing."
      });
      return;
    }

    if (vaultLpReview) {
      setPilotMode("vault_lp");
      setVaultLpModalOpen(true);
      return;
    }

    setPilotMode(effectiveStrategyReview ? "strategy" : "trade");
    setTradeModalOpen(true);
    if (tradeModalStatus === "idle") {
      setTradeModalStatus(effectiveStrategyReview ? strategyStatusForReview(effectiveStrategyReview) : tradeStatusForCompiled(compiled!));
    }
  }

  function profileReviewAction(): PilotMessage["reviewAction"] {
    return {
      kind: "profile",
      label: "Create Profile",
      description: "Create your DeepPilot Profile NFT before continuing this review.",
      href: "/profile?profile=1"
    };
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    submitIntent();
  }

  async function executePredict() {
    if (executionRef.current) {
      return;
    }

    if (effectiveStrategyReview) {
      await executeStrategy(effectiveStrategyReview);
      return;
    }

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
        description: "Connect a wallet before signing a Predict transaction."
      });
      return;
    }

    executionRef.current = true;
    setBusy("execute");
    setError(null);
    setPreflightSnapshot(null);
    setTradeModalOpen(true);
    setTradeModalStatus("ready_to_sign");

    try {
      const executionNetwork = compiled.ptb.transactionData.network === "devnet" ? "devnet" : "testnet";

      if (network && network !== executionNetwork) {
        throw new Error(`Switch wallet network to ${executionNetwork} before signing.`);
      }

      if (!compiled.ptb.execution.managerId) {
        await signCreateManager(compiled, executionNetwork);
        return;
      }

      const executableReview = await refreshExecutableReview(compiled);
      validateReviewForSigning(executableReview);
      await signPredictMint(executableReview, executionNetwork);
    } catch (executionError) {
      const message = explainWalletExecutionError(executionError);
      setError(message);
      setTradeModalStatus((current) => current === "review_changed" || current === "preflight_failed" || current === "funding_required" ? current : "failed");
      toast({
        variant: "destructive",
        title: "Wallet execution failed",
        description: message
      });
    } finally {
      executionRef.current = false;
      setBusy(null);
    }
  }

  async function signCreateManager(current: CompileApiResult, executionNetwork: "devnet" | "testnet") {
    if (!account) {
      throw new Error("Connect a wallet before creating a PredictManager.");
    }

    await preflightSuiGas({
      network: executionNetwork,
      owner: account.address,
      execution: current.ptb?.execution ?? null
    });
    setTradeModalStatus("signing");

    const transaction = buildCreatePredictManagerTransaction({
      packageId: current.ptb!.transactionData.packageId
    });
    const confirmed = await signAndSubmitTransaction(transaction, executionNetwork);
    const digest = getExecutedDigest(confirmed);
    const createdManagerId = extractPredictManagerId(confirmed, current.ptb!.transactionData.packageId);

    if (!createdManagerId) {
      throw new Error("PredictManager was created, but DeepPilot could not identify the new object id.");
    }

    setManagerId(createdManagerId);
    updateManagerInUrl(createdManagerId);

    const executionReceipt: ExecutionReceipt = {
      digest,
      status: "success",
      walletAddress: account.address,
      network: executionNetwork,
      action: "manager_create",
      managerId: createdManagerId,
      note: "Created official DeepBook PredictManager. Re-run review before minting."
    };
    setReceipt(executionReceipt);
    setTradeModalStatus("executed");
    saveExecutionReceipt(executionReceipt, intent, current);

    toast({
      variant: "success",
      title: "PredictManager created",
      description: `${shortAddress(createdManagerId)} · review refreshed`
    });
    await runPilot(intent.trim(), createdManagerId, { openTradeModal: true, clearComposer: false, ignorePendingClarification: true });
  }

  async function refreshExecutableReview(current: CompileApiResult) {
    let executableReview = current;
    const compiledFingerprint = executableFingerprint(current);
    const canSignConfirmedReview =
      current.reviewFreshness?.refreshed &&
      confirmedReviewFingerprint === compiledFingerprint &&
      isReviewSignableNow(current);

    if (!canSignConfirmedReview) {
      const refreshed = await refreshReviewBeforeSigning(current);

      if (!isReviewActive(refreshed)) {
        setCompiled(refreshed);
        setConfirmedReviewFingerprint(null);
        throw new Error(refreshed.reviewFreshness?.reason || "Market expired, refresh review");
      }

      if (!refreshed.ptb || refreshed.guardian.blocked) {
        setCompiled(refreshed);
        setConfirmedReviewFingerprint(null);
        throw new Error(refreshed.guardian.summary || "Execution blocked after refreshing review.");
      }

      const refreshedFingerprint = executableFingerprint(refreshed);
      setCompiled(refreshed);

      if (current.ptb?.execution.managerId && compiledFingerprint !== refreshedFingerprint) {
        setConfirmedReviewFingerprint(refreshedFingerprint);
        setTradeDetailsExpanded(false);
        setTradeModalStatus("review_changed");
        throw new Error("Review changed. Check the updated quote, then click Review & Sign again.");
      }

      setConfirmedReviewFingerprint(refreshedFingerprint);
      executableReview = refreshed;
    } else if (!isReviewActive(executableReview)) {
      setConfirmedReviewFingerprint(null);
      throw new Error(executableReview.reviewFreshness?.reason || "Market expired, refresh review");
    }

    return executableReview;
  }

  function validateReviewForSigning(current: CompileApiResult) {
    if (current.quote?.status !== "available" || new Date(current.quote.expiresAt).getTime() <= Date.now()) {
      setCompiled(current);
      setConfirmedReviewFingerprint(null);
      throw new Error("Quote is stale or unavailable. Refresh the review before signing.");
    }

    if (!current.ptb || current.guardian.blocked) {
      throw new Error(current.guardian.summary || "Execution blocked after refreshing review.");
    }

    if (current.ptb.execution.fundingStatus !== "sufficient" && current.ptb.execution.fundingStatus !== "not_required") {
      setTradeModalStatus("funding_required");
      throw new Error("Trading Balance is insufficient. Add DUSDC to your PredictManager in Profile before opening this position.");
    }
  }

  async function signPredictMint(current: CompileApiResult, executionNetwork: "devnet" | "testnet") {
    if (!account || !current.ptb) {
      throw new Error("Connect a wallet before signing a Predict transaction.");
    }

    const built = buildBinaryMintTransaction({
      transactionData: current.ptb.transactionData,
      managerId: current.ptb.execution.managerId
    });
    setCompiled(current);
    await preflightMintExecution({
      network: executionNetwork,
      owner: account.address,
      execution: current.ptb.execution
    });
    setConfirmedReviewFingerprint(null);
    setTradeModalStatus("signing");
    const confirmed = await signAndSubmitTransaction(built.transaction, executionNetwork);
    const digest = getExecutedDigest(confirmed);

    const executionReceipt: ExecutionReceipt = {
      digest,
      status: "success",
      walletAddress: account.address,
      network: executionNetwork,
      action: "predict_mint",
      managerId: built.managerId,
      note: "Executed DeepBook Predict mint using pre-funded Trading Balance."
    };
    setReceipt(executionReceipt);
    setTradeModalStatus("executed");
    saveExecutionReceipt(executionReceipt, current.intent.raw, current);

    toast({
      variant: "success",
      title: "Predict trade executed",
      description: digest
    });
  }

  async function executeStrategy(current: StrategyApiReview) {
    if (executionRef.current) {
      return;
    }

    if (!account) {
      toast({
        variant: "destructive",
        title: "Wallet required",
        description: "Connect a wallet before signing a strategy batch."
      });
      return;
    }

    executionRef.current = true;
    setBusy("execute");
    setError(null);
    setPreflightSnapshot(null);
    setTradeModalOpen(true);
    setTradeModalStatus("ready_to_sign");

    try {
      const executionNetwork = current.batchTransactionData?.network === "devnet" ? "devnet" : "testnet";

      if (network && network !== executionNetwork) {
        throw new Error(`Switch wallet network to ${executionNetwork} before signing.`);
      }

      const executableReview = await refreshExecutableStrategyReview(current);
      validateStrategyForSigning(executableReview);
      await signStrategyBatch(executableReview, executionNetwork);
    } catch (strategyError) {
      const message = explainWalletExecutionError(strategyError);
      setError(message);
      setTradeModalStatus((currentStatus) => currentStatus === "review_changed" || currentStatus === "preflight_failed" || currentStatus === "funding_required" ? currentStatus : "failed");
      toast({
        variant: "destructive",
        title: "Strategy execution failed",
        description: message
      });
    } finally {
      executionRef.current = false;
      setBusy(null);
    }
  }

  async function refreshExecutableStrategyReview(current: StrategyApiReview) {
    let executableReview = current;
    const currentFingerprint = strategyExecutableFingerprint(current);
    const canSignConfirmedReview =
      current.reviewFreshness.refreshed &&
      confirmedReviewFingerprint === currentFingerprint &&
      isStrategyReviewSignableNow(current);

    if (!canSignConfirmedReview) {
      const refreshed = applyStrategySelection(
        await refreshStrategyBeforeSigning(current),
        selectedStrategyLegIds
      );

      if (!isStrategyReviewActive(refreshed)) {
        setStrategyReview(refreshed);
        setConfirmedReviewFingerprint(null);
        throw new Error(refreshed.reviewFreshness.reason || "One selected strategy leg expired. Refresh review.");
      }

      if (!refreshed.aggregateReadiness.canSign || !refreshed.batchTransactionData) {
        setStrategyReview(refreshed);
        setConfirmedReviewFingerprint(null);
        throw new Error(refreshed.aggregateReadiness.reason);
      }

      const refreshedFingerprint = strategyExecutableFingerprint(refreshed);
      setStrategyReview(refreshed);

      if (currentFingerprint !== refreshedFingerprint) {
        setConfirmedReviewFingerprint(refreshedFingerprint);
        setTradeDetailsExpanded(false);
        setTradeModalStatus("review_changed");
        throw new Error("Strategy review changed. Check the updated legs, then click Review & Sign again.");
      }

      setConfirmedReviewFingerprint(refreshedFingerprint);
      executableReview = refreshed;
    } else if (!isStrategyReviewActive(executableReview)) {
      setConfirmedReviewFingerprint(null);
      throw new Error(executableReview.reviewFreshness.reason || "One selected strategy leg expired. Refresh review.");
    }

    return executableReview;
  }

  function validateStrategyForSigning(current: StrategyApiReview) {
    if (!current.batchTransactionData || !current.aggregateReadiness.canSign) {
      if (current.aggregateReadiness.fundingStatus === "insufficient") {
        setTradeModalStatus("funding_required");
        throw new Error("Trading Balance is insufficient. Add DUSDC to your PredictManager in Profile before opening this strategy.");
      }

      throw new Error(current.aggregateReadiness.reason);
    }

    if (!isStrategyReviewSignableNow(current)) {
      setConfirmedReviewFingerprint(null);
      throw new Error("Strategy quote is stale or unavailable. Refresh the review before signing.");
    }
  }

  async function signStrategyBatch(current: StrategyApiReview, executionNetwork: "devnet" | "testnet") {
    if (!account || !current.batchTransactionData) {
      throw new Error("Connect a wallet before signing a strategy batch.");
    }

    const built = buildBatchPredictMintTransaction({
      transactionData: current.batchTransactionData,
      managerId: current.aggregateReadiness.managerId
    });
    setStrategyReview(current);
    await preflightSuiGas({
      network: executionNetwork,
      owner: account.address,
      execution: current.aggregateReadiness
    });
    setConfirmedReviewFingerprint(null);
    setTradeModalStatus("signing");
    const confirmed = await signAndSubmitTransaction(built.transaction, executionNetwork);
    const digest = getExecutedDigest(confirmed);

    const executionReceipt: ExecutionReceipt = {
      digest,
      status: "success",
      walletAddress: account.address,
      network: executionNetwork,
      action: "strategy_batch_mint",
      managerId: built.managerId,
      note: `Executed ${built.legCount} DeepBook Predict legs in one batch transaction.`
    };
    setReceipt(executionReceipt);
    setTradeModalStatus("executed");
    saveExecutionReceipt(executionReceipt, current.plan.raw, current);

    toast({
      variant: "success",
      title: "Strategy batch executed",
      description: digest
    });
  }

  async function executeVaultLpReview(current: VaultLpReview) {
    if (executionRef.current) {
      return;
    }

    if (!account || !current.transactionData) {
      toast({
        variant: "destructive",
        title: "Wallet required",
        description: "Connect a wallet and prepare a signable Vault LP review."
      });
      return;
    }

    executionRef.current = true;
    setBusy("execute");
    setError(null);

    try {
      const executionNetwork = current.transactionData.network === "devnet" ? "devnet" : "testnet";

      if (network && network !== executionNetwork) {
        throw new Error(`Switch wallet network to ${executionNetwork} before signing.`);
      }

      const client = dAppKit.getClient(executionNetwork);
      const suiBalanceRaw = await readSuiBalanceRaw(client, account.address);

      if (suiBalanceRaw < MIN_SUI_GAS_BALANCE_MIST) {
        throw new Error(`Need testnet SUI for gas. Wallet ${shortAddress(account.address)} has ${formatRawSui(suiBalanceRaw)} SUI on ${executionNetwork}; keep at least ${formatRawSui(MIN_SUI_GAS_BALANCE_MIST)} SUI available before signing.`);
      }

      if (current.transactionData.action === "deposit") {
        const walletDusdc = readCoinBalanceRaw(await client.getBalance({
          owner: account.address,
          coinType: current.transactionData.quoteAssetType
        }));

        if (walletDusdc < BigInt(current.transactionData.amountRaw)) {
          throw new Error(`Wallet DUSDC is insufficient. Need ${formatRawDusdc(current.transactionData.amountRaw)} DUSDC before supplying Vault LP.`);
        }
      } else {
        const requiredSharesRaw = current.transactionData.plpSharesRaw;

        if (!requiredSharesRaw) {
          throw new Error("Vault LP withdraw review is missing PLP shares.");
        }

        const walletPlp = readCoinBalanceRaw(await client.getBalance({
          owner: account.address,
          coinType: current.transactionData.plpCoinType
        }));

        if (walletPlp < BigInt(requiredSharesRaw)) {
          throw new Error(`Wallet PLP is insufficient. Need ${formatRawDusdc(requiredSharesRaw)} PLP shares before withdrawing.`);
        }
      }

      const transaction = current.transactionData.action === "deposit"
        ? buildVaultLpSupplyTransaction({
            packageId: current.transactionData.packageId,
            predictObject: current.transactionData.predictObject,
            quoteAssetType: current.transactionData.quoteAssetType,
            amountRaw: current.transactionData.amountRaw,
            recipient: account.address
          })
        : buildVaultLpWithdrawTransaction({
            packageId: current.transactionData.packageId,
            predictObject: current.transactionData.predictObject,
            quoteAssetType: current.transactionData.quoteAssetType,
            plpCoinType: current.transactionData.plpCoinType,
            plpSharesRaw: current.transactionData.plpSharesRaw!,
            recipient: account.address
          });

      const confirmed = await signAndSubmitTransaction(transaction, executionNetwork);
      const digest = getExecutedDigest(confirmed);
      const action = current.transactionData.action === "deposit" ? "vault_lp_supply" : "vault_lp_withdraw";

      const executionReceipt: ExecutionReceipt = {
        digest,
        status: "success",
        walletAddress: account.address,
        network: executionNetwork,
        action,
        note: `${current.transactionData.action === "deposit" ? "Supplied wallet DUSDC to" : "Withdrew wallet PLP from"} DeepBook Predict Vault LP.`
      };

      setReceipt(executionReceipt);
      saveVaultLpExecutionReceipt(executionReceipt, current);
      setVaultLpReview({
        ...current,
        timeline: current.timeline.map((step) => step.label === "Ready to sign"
          ? { ...step, state: "complete", detail: digest }
          : step)
      });

      toast({
        variant: "success",
        title: current.transactionData.action === "deposit" ? "Vault LP supplied" : "Vault LP withdrawn",
        description: digest
      });
    } catch (vaultLpError) {
      const message = explainWalletExecutionError(vaultLpError);
      setError(message);
      toast({
        variant: "destructive",
        title: "Vault LP execution failed",
        description: message
      });
    } finally {
      executionRef.current = false;
      setBusy(null);
    }
  }

  async function preflightSuiGas({
    network: executionNetwork,
    owner,
    execution
  }: {
    network: "devnet" | "testnet";
    owner: string;
    execution: PreflightExecutionLike | null;
  }) {
    setTradeModalStatus("ready_to_sign");

    try {
      const client = dAppKit.getClient(executionNetwork);
      const suiBalanceRaw = await readSuiBalanceRaw(client, owner);

      setPreflightSnapshot({
        suiBalanceRaw: suiBalanceRaw.toString(),
        requiredSuiRaw: MIN_SUI_GAS_BALANCE_MIST.toString(),
        estimatedPaymentRaw: execution?.estimatedPaymentRaw ?? null,
        managerBalanceRaw: execution?.managerBalanceRaw ?? null,
        fundingShortfallRaw: execution?.fundingShortfallRaw ?? null
      });

      if (suiBalanceRaw < MIN_SUI_GAS_BALANCE_MIST) {
        setTradeModalStatus("preflight_failed");
        throw new Error(`Need testnet SUI for gas. Wallet ${shortAddress(owner)} has ${formatRawSui(suiBalanceRaw)} SUI on ${executionNetwork}; keep at least ${formatRawSui(MIN_SUI_GAS_BALANCE_MIST)} SUI available before signing.`);
      }
    } catch (preflightError) {
      setTradeModalStatus("preflight_failed");
      throw preflightError;
    }
  }

  async function signAndSubmitTransaction(transaction: Transaction, executionNetwork: "devnet" | "testnet") {
    dAppKit.switchNetwork(executionNetwork);

    const signed = await dAppKit.signTransaction({ transaction });
    const submitted = await dAppKit.getClient(executionNetwork).executeTransaction({
      transaction: fromBase64(signed.bytes),
      signatures: [signed.signature],
      include: {
        effects: true,
        events: true,
        objectTypes: true
      }
    });

    assertExecuted(submitted);
    return submitted;
  }

  async function preflightMintExecution({
    network: executionNetwork,
    owner,
    execution
  }: {
    network: "devnet" | "testnet";
    owner: string;
    execution: NonNullable<CompileApiResult["ptb"]>["execution"];
  }) {
    await preflightSuiGas({
      network: executionNetwork,
      owner,
      execution
    });

    if (execution.fundingStatus !== "sufficient" && execution.fundingStatus !== "not_required") {
      setTradeModalStatus("preflight_failed");
      throw new Error("Trading Balance is insufficient. Add DUSDC to your PredictManager in Profile before opening this position.");
    }
  }

  async function refreshReviewBeforeSigning(current: CompileApiResult): Promise<CompileApiResult> {
    const response = await fetch("/api/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: current.intent.raw || intent.trim(),
        walletAddress: account?.address,
        managerId: current.ptb?.execution.managerId ?? managerId ?? undefined,
        parsedIntent: current.intent,
        refreshed: true
      })
    });

    if (!response.ok) {
      throw new Error("Could not refresh review before signing.");
    }

    return await response.json() as CompileApiResult;
  }

  async function refreshStrategyBeforeSigning(current: StrategyApiReview): Promise<StrategyApiReview> {
    const response = await fetch("/api/strategy/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: current.plan.raw,
        walletAddress: account?.address,
        managerId: current.aggregateReadiness.managerId ?? managerId ?? undefined,
        refreshed: true,
        lockedLegs: strategyLockedLegs(current),
        conversation: buildConversationForPilot(messages),
        lastMarketThesis: latestMarketThesis(messages)
      })
    });

    if (!response.ok) {
      throw new Error("Could not refresh strategy review before signing.");
    }

    return await response.json() as StrategyApiReview;
  }

  const guardian = compiled?.guardian;
  const blocked = effectiveStrategyReview ? !effectiveStrategyReview.aggregateReadiness.canSign : guardian?.blocked ?? true;
  const marketStrike = compiled?.market?.metrics.selectedStrike;
  const intentStrike = compiled?.intent.status === "ready" ? compiled.intent.strike : undefined;
  const effectiveUrlOracleId = routeOracleIsActive ? urlOracleId : null;
  const effectiveUrlStrike = routeOracleIsActive ? urlStrike : null;
  const selectedOracleId =
    compiled?.market?.oracle.oracle_id ??
    (compiled?.intent.status === "ready" ? compiled.intent.oracleId : undefined) ??
    effectiveUrlOracleId ??
    marketPreview?.selectedMarket?.oracleId ??
    undefined;
  const selectedStrike =
    typeof marketStrike === "number"
      ? marketStrike
      : typeof intentStrike === "number"
        ? intentStrike
        : effectiveUrlStrike ?? marketPreview?.selectedMarket?.selectedStrike;
  const hasLockedStrike = Boolean(compiled?.market || intentStrike || effectiveUrlStrike);
  const selectedStrikeLabel = hasLockedStrike ? "strike" : "ATM ref";
  const showPilotActions = Boolean(pilotMode || compiled || effectiveStrategyReview || vaultLpReview || busy === "pilot" || receipt || error || ragSources.length > 0);

  return (
    <AppShell
      title="DeepPilot execution cockpit"
      description="Ask about markets, or turn one sentence into a Guardian-reviewed DeepBook Predict transaction preview."
      meta={
        <>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {compiled?.predict?.transport ?? effectiveStrategyReview?.predict?.transport ?? "Predict server"}
          </Badge>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {network ?? "testnet"}
          </Badge>
        </>
      }
    >
        <TradeReviewModal
          open={tradeModalOpen}
          status={tradeModalStatus}
          compiled={compiled}
          strategyReview={effectiveStrategyReview}
          pilotMode={pilotMode}
          streamTimeline={streamTimeline}
          receipt={receipt}
          error={error}
          busy={busy === "execute"}
          blocked={blocked}
          detailsExpanded={tradeDetailsExpanded}
          expandedFinding={expandedFinding}
          preflight={preflightSnapshot}
          accountAddress={account?.address}
          onClose={() => {
            if (busy !== "execute") {
              setTradeModalOpen(false);
            }
          }}
          onDetailsChange={setTradeDetailsExpanded}
          onExpandFinding={setExpandedFinding}
          onToggleStrategyLeg={(legId) => {
            setSelectedStrategyLegIds((current) => current.includes(legId)
              ? current.filter((id) => id !== legId)
              : [...current, legId]);
            setConfirmedReviewFingerprint(null);
          }}
          onConfirm={executePredict}
        />
        <TerminalVaultLpReviewModal
          open={vaultLpModalOpen}
          review={vaultLpReview}
          receipt={receipt?.action === "vault_lp_supply" || receipt?.action === "vault_lp_withdraw" ? receipt : null}
          error={error}
          busy={busy === "execute"}
          detailsExpanded={vaultLpDetailsExpanded}
          onDetailsChange={setVaultLpDetailsExpanded}
          onClose={() => {
            if (busy !== "execute") {
              setVaultLpModalOpen(false);
            }
          }}
          onConfirm={() => {
            if (vaultLpReview) {
              void executeVaultLpReview(vaultLpReview);
            }
          }}
        />

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
              activeReviewMessageId={activeReviewMessageId}
              busy={busy === "pilot"}
              onChange={setIntent}
              onSubmit={submitIntent}
              onKeyDown={onComposerKeyDown}
              onOpenReview={openActiveReviewFromChat}
              onExample={(example) => {
                setIntent(example);
                void runPilot(example, managerId, { ignorePendingClarification: true });
              }}
            />
          </section>

          <aside className="audit-column flex min-w-0 flex-col gap-3">
            {showPilotActions ? (
              <PilotActionsCard
                pilotMode={pilotMode}
                tradeStatus={tradeModalStatus}
                busy={busy === "pilot"}
                compiled={compiled}
                strategyReview={effectiveStrategyReview}
                vaultLpReview={vaultLpReview}
                receipt={receipt}
                error={error}
                sources={ragSources}
                sourcesExpanded={sourcesExpanded}
                onToggleSources={() => setSourcesExpanded((current) => !current)}
                onOpenReview={() => {
                  if (vaultLpReview) {
                    setVaultLpModalOpen(true);
                  } else {
                    setTradeModalOpen(true);
                  }
                }}
              />
            ) : null}
            <TradeTicket
              market={compiled?.market ?? null}
              initialOracleId={effectiveUrlOracleId ?? marketPreview?.selectedMarket?.oracleId}
              initialStrike={effectiveUrlStrike ?? marketPreview?.selectedMarket?.selectedStrike}
              onGenerate={(nextIntent) => {
                setIntent(nextIntent);
                void runPilot(nextIntent, managerId, { openTradeModal: true, ignorePendingClarification: true });
              }}
            />
          </aside>
        </div>
    </AppShell>
  );

}

function PilotConsole({
  intent,
  messages,
  activeReviewMessageId,
  busy,
  onChange,
  onSubmit,
  onKeyDown,
  onOpenReview,
  onExample
}: {
  intent: string;
  messages: PilotMessage[];
  activeReviewMessageId: string | null;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onOpenReview: (messageId: string) => void;
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
      <CardContent className="space-y-3 p-4 pt-0">
        {messages.length > 0 ? (
          <div className="pilot-transcript rounded-md border border-border bg-background/45 p-3">
            <div className="space-y-3">
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  canOpenReview={message.id === activeReviewMessageId}
                  onOpenReview={onOpenReview}
                />
              ))}
              <div ref={transcriptEndRef} aria-hidden="true" />
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <Textarea
            id="pilot-composer"
            className="min-h-[104px] resize-none border-border/80 bg-background/70 py-2.5 text-sm leading-6 shadow-none placeholder:text-muted-foreground/45 focus-visible:ring-1 focus-visible:ring-ring/70"
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

        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">Examples</span>
          <div className="flex gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0">
            {EXAMPLE_INTENTS.map((example) => (
              <button
                key={example}
                className="min-w-[178px] shrink-0 rounded-md border border-border bg-secondary/70 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:border-zinc-500 hover:bg-accent hover:text-foreground disabled:opacity-50 sm:min-w-0 sm:shrink"
                onClick={() => onExample(example)}
                disabled={busy}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MessageBubble({
  message,
  canOpenReview,
  onOpenReview
}: {
  message: PilotMessage;
  canOpenReview: boolean;
  onOpenReview: (messageId: string) => void;
}) {
  const isUser = message.role === "user";
  const reviewAction = !isUser && canOpenReview ? message.reviewAction : null;

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
        {reviewAction ? (
          <div className="mt-3 border-t border-border pt-3">
            <Button
              type="button"
              size="sm"
              className="h-8 w-full justify-center gap-2 rounded-md sm:w-auto"
              onClick={() => {
                if (reviewAction.href) {
                  window.location.assign(reviewAction.href);
                  return;
                }

                onOpenReview(message.id);
              }}
            >
              {reviewAction.kind === "profile" ? <UserRound className="h-4 w-4" /> : <ClipboardCheck className="h-4 w-4" />}
              {reviewAction.label}
            </Button>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{reviewAction.description}</p>
          </div>
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

function PilotActionsCard({
  pilotMode,
  tradeStatus,
  busy,
  compiled,
  strategyReview,
  vaultLpReview,
  receipt,
  error,
  sources,
  sourcesExpanded,
  onToggleSources,
  onOpenReview
}: {
  pilotMode: PilotMode | null;
  tradeStatus: TradeModalStatus;
  busy: boolean;
  compiled: CompileApiResult | null;
  strategyReview: StrategyApiReview | null;
  vaultLpReview: VaultLpReview | null;
  receipt: ExecutionReceipt | null;
  error: string | null;
  sources: RagSource[];
  sourcesExpanded: boolean;
  onToggleSources: () => void;
  onOpenReview: () => void;
}) {
  const hasStrategy = pilotMode === "strategy" || Boolean(strategyReview);
  const hasVaultLp = pilotMode === "vault_lp" || Boolean(vaultLpReview);
  const hasTrade = pilotMode === "trade" || Boolean(compiled) || hasStrategy || hasVaultLp;
  const modeLabel = pilotMode ? pilotMode.toUpperCase() : busy ? "ROUTING" : "STANDBY";

  return (
    <Card className="glass-line">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Pilot Actions</CardTitle>
            </div>
            <CardDescription className="text-xs">{modeLabel}</CardDescription>
          </div>
          {hasTrade ? (
            <Button size="sm" variant="outline" onClick={onOpenReview}>
              <ClipboardCheck />
              Review
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {hasVaultLp && vaultLpReview ? (
          <>
            <StatusPill status={receipt ? "executed" : vaultLpReview.execution.canSign ? "quote_ready" : "preflight_failed"} compiled={null} receipt={receipt} error={error} />
            <VaultLpSummaryBlock review={vaultLpReview} />
          </>
        ) : hasStrategy && strategyReview ? (
          <>
            <StatusPill status={tradeStatus} compiled={null} strategyReview={strategyReview} receipt={receipt} error={error} />
            <StrategySummaryBlock review={strategyReview} />
          </>
        ) : hasTrade ? (
          <>
            <StatusPill status={tradeStatus} compiled={compiled} receipt={receipt} error={error} />
            <ReviewSummaryBlock compiled={compiled} busy={busy} />
          </>
        ) : pilotMode === "chat" ? (
          <CompactSources sources={sources} expanded={sourcesExpanded} onToggle={onToggleSources} />
        ) : busy ? (
          <MutedBox>Classifying request and preparing the next step.</MutedBox>
        ) : (
          <MutedBox>Ask a market question or use the ticket below to draft a Predict trade.</MutedBox>
        )}
      </CardContent>
    </Card>
  );
}

function TradeReviewModal({
  open,
  status,
  compiled,
  strategyReview,
  pilotMode,
  streamTimeline,
  receipt,
  error,
  busy,
  blocked,
  detailsExpanded,
  expandedFinding,
  preflight,
  accountAddress,
  onClose,
  onDetailsChange,
  onExpandFinding,
  onToggleStrategyLeg,
  onConfirm
}: {
  open: boolean;
  status: TradeModalStatus;
  compiled: CompileApiResult | null;
  strategyReview: StrategyApiReview | null;
  pilotMode: PilotMode | null;
  streamTimeline: CompileResult["timeline"];
  receipt: ExecutionReceipt | null;
  error: string | null;
  busy: boolean;
  blocked: boolean;
  detailsExpanded: boolean;
  expandedFinding: string | null;
  preflight: PreflightSnapshot | null;
  accountAddress?: string;
  onClose: () => void;
  onDetailsChange: (value: boolean) => void;
  onExpandFinding: (value: string | null) => void;
  onToggleStrategyLeg: (legId: string) => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  const action = strategyReview ? strategyExecutionAction(strategyReview, blocked) : executionAction(compiled, blocked);
  const canConfirm = action.canConfirm && !busy && status !== "executed";
  const quoteOnly = !strategyReview && isQuoteOnlyResult(compiled);
  const fundingRequired = strategyReview?.aggregateReadiness.fundingStatus === "insufficient" || isFundingRequiredResult(compiled);
  const isStrategyModal = Boolean(strategyReview) || pilotMode === "strategy";
  const showDetails = isStrategyModal || detailsExpanded;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/82 px-3 py-5 backdrop-blur-md">
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-review-modal-title"
        initial={{ opacity: 0, scale: 0.98, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 10 }}
        className="trade-review-modal glass-line max-h-[92vh] w-full max-w-5xl overflow-hidden rounded-lg border border-border shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/75 bg-card/75 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-md border border-border bg-background/80">
                {status === "signing" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
              </div>
              <div className="min-w-0">
                <h2 id="trade-review-modal-title" className="truncate text-base font-semibold text-foreground">
                  {strategyReview ? strategyModalTitle(status, strategyReview) : tradeModalTitle(status, compiled)}
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{strategyReview ? strategyModalSubtitle(status, strategyReview) : tradeModalSubtitle(status, compiled)}</p>
              </div>
            </div>
          </div>
          <Button size="icon" variant="ghost" aria-label="Close trade review" onClick={onClose} disabled={busy}>
            <X />
          </Button>
        </div>

        <div className="max-h-[calc(92vh-82px)] overflow-y-auto p-4">
          <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-3">
              <StatusPill status={status} compiled={compiled} strategyReview={strategyReview} receipt={receipt} error={error} />
              {strategyReview ? <StrategySummaryBlock review={strategyReview} /> : <ReviewSummaryBlock compiled={compiled} busy={status === "compiling"} />}
              {strategyReview
                ? <StrategyModalSteps status={status} review={strategyReview} preflight={preflight} busy={busy} />
                : <TradeModalSteps status={status} compiled={compiled} streamTimeline={streamTimeline} preflight={preflight} busy={busy} />}
            </div>

            <div className="space-y-3">
              {receipt ? (
                <div className="rounded-md border border-border bg-background/70 p-3">
                  <div className="flex items-center gap-2 text-foreground">
                    <Check className="h-4 w-4" />
                    <p className="text-sm font-medium">{receipt.action === "manager_create" ? "PredictManager created" : "Executed"}</p>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{receipt.digest}</p>
                </div>
              ) : null}

              {error ? (
                <div className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm leading-6 text-destructive-foreground">
                  {error}
                </div>
              ) : null}

              <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center", isStrategyModal ? "sm:justify-end" : "sm:justify-between")}>
                {!isStrategyModal ? (
                  <Button variant="outline" onClick={() => onDetailsChange(!detailsExpanded)}>
                    <ChevronDown className={cn("transition-transform", detailsExpanded && "rotate-180")} />
                    {detailsExpanded ? "Hide details" : "Show details"}
                  </Button>
                ) : null}
                <Button
                  className="h-10"
                  variant={canConfirm ? "default" : blocked ? "destructive" : "outline"}
                  disabled={!canConfirm}
                  onClick={() => {
                    if (action.href) {
                      window.location.href = action.href;
                      return;
                    }

                    onConfirm();
                  }}
                >
                  {busy ? <RefreshCw className="animate-spin" /> : action.href ? <Wallet /> : canConfirm ? <LockKeyhole /> : <AlertTriangle />}
                  {status === "executed" ? "Executed" : action.label}
                </Button>
              </div>

              <AnimatePresence initial={false}>
                {showDetails ? (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-3 overflow-hidden"
                  >
                    {strategyReview ? (
                      <StrategyLegsCard review={strategyReview} onToggleLeg={onToggleStrategyLeg} />
                    ) : isStrategyModal ? null : !quoteOnly ? <OutcomeQuoteCard compiled={compiled} busy={status === "compiling"} /> : null}
                    {strategyReview ? (
                      <StrategySafetyCard review={strategyReview} />
                    ) : isStrategyModal ? null : (
                      <SafetyChecksCard
                        compiled={compiled}
                        busy={status === "compiling"}
                        streamTimeline={streamTimeline}
                        expandedFinding={expandedFinding}
                        onExpand={onExpandFinding}
                      />
                    )}
                    {!strategyReview && !quoteOnly && !fundingRequired ? (
                      <>
                        <TransactionCard compiled={compiled} accountAddress={accountAddress} />
                        <ExecutionCard
                          compiled={compiled}
                          receipt={receipt}
                          error={error}
                          busy={busy}
                          blocked={blocked}
                          onConfirm={onConfirm}
                          showButton={false}
                        />
                      </>
                    ) : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function TerminalVaultLpReviewModal({
  open,
  review,
  receipt,
  error,
  busy,
  detailsExpanded,
  onDetailsChange,
  onClose,
  onConfirm
}: {
  open: boolean;
  review: VaultLpReview | null;
  receipt: ExecutionReceipt | null;
  error: string | null;
  busy: boolean;
  detailsExpanded: boolean;
  onDetailsChange: (value: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  const canConfirm = Boolean(review?.transactionData && review.execution.canSign && !busy && !receipt);
  const isInfoOnly = review?.intent.action === "info";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/82 px-3 py-5 backdrop-blur-md">
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-lp-review-modal-title"
        initial={{ opacity: 0, scale: 0.98, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 10 }}
        className="trade-review-modal glass-line max-h-[92vh] w-full max-w-4xl overflow-hidden rounded-lg border border-border shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/75 bg-card/75 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-md border border-border bg-background/80">
                {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Fuel className="h-4 w-4" />}
              </div>
              <div className="min-w-0">
                <h2 id="vault-lp-review-modal-title" className="truncate text-base font-semibold text-foreground">
                  Vault LP Review
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {review
                    ? `${review.intent.action.toUpperCase()} · ${formatRawDusdc(review.execution.amountRaw)} DUSDC · PLP is a vault share, not fixed yield.`
                    : "Preparing Vault LP review."}
                </p>
              </div>
            </div>
          </div>
          <Button size="icon" variant="ghost" aria-label="Close Vault LP review" onClick={onClose} disabled={busy}>
            <X />
          </Button>
        </div>

        <div className="max-h-[calc(92vh-82px)] overflow-y-auto p-4">
          <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-3">
              <div className={cn(
                "rounded-md border p-3",
                review?.execution.canSign ? "border-border bg-background/70" : "border-destructive/35 bg-destructive/10"
              )}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{review?.execution.canSign ? "Ready to sign" : "Review blocked"}</p>
                  <Badge variant="outline">{review ? (review.execution.canSign ? "READY" : "BLOCKED") : "PENDING"}</Badge>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{review?.execution.reason ?? "Waiting for vault state."}</p>
              </div>

              <div className="rounded-md border border-border bg-background/55 p-3">
                {(review?.timeline ?? []).map((step) => (
                  <div key={step.label} className="grid grid-cols-[24px_1fr] gap-3 py-1.5">
                    <StatusIcon state={step.state} busy={busy || step.state === "pending"} />
                    <div>
                      <p className="text-sm text-foreground">{step.label}</p>
                      <p className="text-xs text-muted-foreground">{step.detail}</p>
                    </div>
                  </div>
                ))}
              </div>

              {receipt ? (
                <div className="rounded-md border border-border bg-background/70 p-3">
                  <div className="flex items-center gap-2 text-foreground">
                    <Check className="h-4 w-4" />
                    <p className="text-sm font-medium">{receipt.action === "vault_lp_supply" ? "Vault LP supplied" : "Vault LP withdrawn"}</p>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{receipt.digest}</p>
                </div>
              ) : null}

              {error ? (
                <div className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm leading-6 text-destructive-foreground">
                  {error}
                </div>
              ) : null}
            </div>

            <div className="space-y-3">
              {review ? <VaultLpSummaryBlock review={review} /> : <MutedBox>Preparing Vault LP summary.</MutedBox>}
              <div className="grid grid-cols-2 gap-2">
                <MiniMetric label="Amount" value={`${formatRawDusdc(review?.execution.amountRaw ?? null)} DUSDC`} />
                <MiniMetric label="Available" value={`${formatRawDusdc(review?.execution.availableWithdrawalRaw ?? null)} DUSDC`} />
                <MiniMetric label="Est. shares" value={review?.transactionData?.plpSharesRaw ? `${formatRawDusdc(review.transactionData.plpSharesRaw)} PLP` : "--"} />
                <MiniMetric label="Est. DUSDC out" value={review?.transactionData?.estimatedDusdcOutRaw ? `${formatRawDusdc(review.transactionData.estimatedDusdcOutRaw)} DUSDC` : "--"} />
              </div>

              <div className="rounded-md border border-border bg-background/55 p-3">
                {review?.execution.checks.map((check) => (
                  <div key={check.label} className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
                    <div>
                      <p className="text-sm text-foreground">{check.label}</p>
                      <p className="text-xs text-muted-foreground">{check.detail}</p>
                    </div>
                    <Badge variant="outline" className={check.passed ? "text-emerald-300" : "text-red-300"}>
                      {check.passed ? "OK" : "BLOCK"}
                    </Badge>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Button variant="outline" onClick={() => onDetailsChange(!detailsExpanded)}>
                  <ChevronDown className={cn("transition-transform", detailsExpanded && "rotate-180")} />
                  {detailsExpanded ? "Hide details" : "Show details"}
                </Button>
                <Button className="h-10" disabled={!canConfirm} onClick={onConfirm}>
                  {busy ? <RefreshCw className="animate-spin" /> : canConfirm ? <LockKeyhole /> : <AlertTriangle />}
                  {receipt ? "Executed" : isInfoOnly ? "No signature needed" : "Review & Sign"}
                </Button>
              </div>

              {detailsExpanded ? (
                <pre className="max-h-52 overflow-auto rounded-md border border-border bg-background/70 p-3 text-xs text-muted-foreground">
                  {JSON.stringify(review?.transactionData ?? review?.intent ?? null, null, 2)}
                </pre>
              ) : null}

              <p className="rounded-md border border-border bg-background/55 p-3 text-xs leading-5 text-muted-foreground">
                {review?.disclosure ?? "PLP is a vault share. Final execution depends on wallet confirmation and current on-chain vault state."}
              </p>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function StatusPill({
  status,
  compiled,
  strategyReview,
  receipt,
  error
}: {
  status: TradeModalStatus;
  compiled?: CompileApiResult | null;
  strategyReview?: StrategyApiReview | null;
  receipt: ExecutionReceipt | null;
  error: string | null;
}) {
  const guardianBlocked = isGuardianBlockedReview(status, compiled ?? null);
  const blocked = status === "failed" || status === "preflight_failed" || status === "funding_required";
  const complete = status === "executed";
  const label = strategyReview && !complete ? "Strategy review" : guardianBlocked ? "Review blocked" : tradeStatusLabel(status);
  const description = guardianBlocked
    ? compiled?.guardian.summary ?? "Guardian blocked this review before wallet signing."
    : strategyReview && !complete
      ? strategyReview.aggregateReadiness.reason
    : tradeStatusDescription(status);

  return (
    <div className={cn(
      "rounded-md border p-3",
      blocked ? "border-destructive/35 bg-destructive/10" : "border-border bg-background/60"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {complete && receipt
              ? `${receipt.action === "manager_create" ? "Manager created" : "Transaction executed"} · ${shortAddress(receipt.digest)}`
              : error ?? description}
          </p>
        </div>
        {complete ? <Check className="h-4 w-4 text-foreground" /> : blocked ? <AlertTriangle className="h-4 w-4 text-destructive" /> : <CircleDashed className="h-4 w-4 text-muted-foreground" />}
      </div>
    </div>
  );
}

function ReviewSummaryBlock({
  compiled,
  busy
}: {
  compiled: CompileApiResult | null;
  busy: boolean;
}) {
  const rows = reviewSummaryRows(compiled, busy);

  return (
    <div className="rounded-md border border-border bg-background/55">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[92px_1fr] gap-3 border-b border-border/70 px-3 py-2 last:border-b-0">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate font-mono text-xs text-foreground/85">{value}</span>
        </div>
      ))}
    </div>
  );
}

function StrategySummaryBlock({ review }: { review: StrategyApiReview }) {
  const rows: Array<[string, string]> = [
    ["Mode", "STRATEGY"],
    ["Legs", `${review.aggregateReadiness.readyLegCount}/${review.aggregateReadiness.selectedLegCount} ready`],
    ["Payment", `${formatRawDusdc(review.aggregateReadiness.estimatedPaymentRaw)} DUSDC`],
    ["Balance", `${formatRawDusdc(review.aggregateReadiness.managerBalanceRaw)} DUSDC`],
    ["Funding", review.aggregateReadiness.fundingStatus.toUpperCase()]
  ];

  return (
    <div className="rounded-md border border-border bg-background/55">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[92px_1fr] gap-3 border-b border-border/70 px-3 py-2 last:border-b-0">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate font-mono text-xs text-foreground/85">{value}</span>
        </div>
      ))}
    </div>
  );
}

function VaultLpSummaryBlock({ review }: { review: VaultLpReview }) {
  const rows: Array<[string, string]> = [
    ["Mode", "VAULT LP"],
    ["Action", review.intent.action.toUpperCase()],
    ["Amount", `${formatRawDusdc(review.execution.amountRaw)} DUSDC`],
    ["Share", `${review.summary.vault.plp_share_price.toFixed(6)} DUSDC`],
    ["Ready", review.execution.canSign ? "YES" : "NO"]
  ];

  return (
    <div className="rounded-md border border-border bg-background/55">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[92px_1fr] gap-3 border-b border-border/70 px-3 py-2 last:border-b-0">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate font-mono text-xs text-foreground/85">{value}</span>
        </div>
      ))}
    </div>
  );
}

function CompactSources({
  sources,
  expanded,
  onToggle
}: {
  sources: RagSource[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (sources.length === 0) {
    return <MutedBox>Waiting for Predict oracle, news, and local docs context.</MutedBox>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{sources.length} refs</span>
        <Button size="sm" variant="outline" onClick={onToggle}>
          <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
          {expanded ? "Hide" : "Show"}
        </Button>
      </div>
      <div className="space-y-1">
        {(expanded ? sources : sources.slice(0, 6)).map((source) => (
          <div key={source.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-border bg-background/45 px-2 py-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">{source.id}</span>
            <span className="min-w-0 truncate text-xs text-foreground/85">{compactSourceTitle(source)}</span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{source.sourceType}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TradeModalSteps({
  status,
  compiled,
  streamTimeline,
  preflight,
  busy
}: {
  status: TradeModalStatus;
  compiled: CompileApiResult | null;
  streamTimeline: CompileResult["timeline"];
  preflight: PreflightSnapshot | null;
  busy: boolean;
}) {
  const timeline = compiled?.timeline ?? streamTimeline;
  const quoteOnly = compiled?.intent.status === "ready" && compiled.intent.action === "predict_quote_only";
  const fundingStatus = compiled?.ptb?.execution.fundingStatus;
  const fundingBlocked = status === "funding_required" || fundingStatus === "insufficient";
  const stageState = (label: string): "complete" | "blocked" | "pending" => {
    const match = timeline.find((item) => item.label.toLowerCase().includes(label.toLowerCase()));

    return match?.state ?? (compiled ? "complete" : "pending");
  };
  const baseSteps: Array<{ label: string; state: "complete" | "blocked" | "pending"; detail: string }> = [
    {
      label: "Parsing intent",
      state: stageState("Parsing intent"),
      detail: compiled?.intent.status === "ready" ? compiled.intent.action.replaceAll("_", " ") : "Classifying request"
    },
    {
      label: "Resolving active oracle",
      state: stageState("Resolving"),
      detail: compiled?.market?.oracle.oracle_id ? shortAddress(compiled.market.oracle.oracle_id) : "Nearest active market"
    },
    {
      label: "Quoting payout",
      state: compiled?.quote?.status === "available" ? "complete" : compiled?.quote?.status === "unavailable" ? "blocked" : stageState("Quoting"),
      detail: compiled?.quote?.status === "available"
        ? `${formatDusdc(compiled.quote.estimatedCostDusdc)} DUSDC est. pay`
        : quoteOnly ? "No mint quote required" : "DeepBook Predict quote"
    },
    {
      label: "Guardian checks",
      state: compiled?.guardian.blocked ? "blocked" : compiled ? "complete" : "pending",
      detail: compiled?.guardian.decision ? compiled.guardian.decision.toUpperCase() : "Risk policy"
    }
  ];
  const executableSteps: Array<{ label: string; state: "complete" | "blocked" | "pending"; detail: string }> = quoteOnly
    ? [
        {
          label: "Quote complete",
          state: compiled ? "complete" : "pending",
          detail: "No wallet action required"
        }
      ]
    : fundingBlocked
      ? [
          {
            label: "Checking Trading Balance",
            state: "blocked",
            detail: `Shortfall ${formatRawDusdc(compiled?.ptb?.execution.fundingShortfallRaw)} DUSDC`
          }
        ]
      : [
        {
          label: "Checking Trading Balance",
          state: stageState("Checking Trading Balance"),
          detail: compiled?.ptb?.execution.fundingStatus === "insufficient"
            ? `Shortfall ${formatRawDusdc(compiled.ptb.execution.fundingShortfallRaw)} DUSDC`
            : compiled?.ptb?.execution.fundingStatus ?? "Manager payment readiness"
        },
        {
          label: "SUI gas preflight",
          state: status === "preflight_failed" ? "blocked" : preflight || status === "signing" || status === "executed" ? "complete" : "pending",
          detail: preflight ? `SUI ${formatRawSui(preflight.suiBalanceRaw)} · payment ${formatRawDusdc(preflight.estimatedPaymentRaw)} DUSDC` : "SUI gas and pre-funded payment"
        },
        {
          label: status === "executed" ? "Executed" : "Ready to sign",
          state: status === "executed" ? "complete" : status === "failed" ? "blocked" : status === "signing" ? "pending" : compiled?.ptb?.execution.canSign && !compiled.guardian.blocked ? "complete" : "pending",
          detail: status === "signing" ? "Wallet confirmation open" : "User-triggered wallet signature"
        }
      ];
  const steps = [...baseSteps, ...executableSteps];

  return (
    <div className="rounded-md border border-border bg-background/55 p-3">
      <div className="space-y-1">
        {steps.map((step, index) => (
          <motion.div
            key={step.label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.03 }}
            className="grid grid-cols-[24px_1fr] gap-3 rounded-md py-1.5"
          >
            <StatusIcon state={step.state} busy={busy || status === "compiling" || status === "signing"} />
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{step.label}</p>
              <p className="truncate text-xs text-muted-foreground">{step.detail}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function StrategyModalSteps({
  status,
  review,
  preflight,
  busy
}: {
  status: TradeModalStatus;
  review: StrategyApiReview;
  preflight: PreflightSnapshot | null;
  busy: boolean;
}) {
  const steps: Array<{ label: string; state: "complete" | "blocked" | "pending"; detail: string }> = [
    {
      label: "Planning strategy",
      state: review.plan.missing.length ? "blocked" : "complete",
      detail: review.plan.missing.length ? `Missing ${review.plan.missing.join(", ")}` : review.plan.thesis
    },
    {
      label: "Compiling legs",
      state: review.compiledLegs.some((leg) => leg.status === "blocked") ? "blocked" : "complete",
      detail: `${review.aggregateReadiness.readyLegCount}/${review.compiledLegs.length} legs ready`
    },
    {
      label: "Aggregate Trading Balance",
      state: review.aggregateReadiness.fundingStatus === "sufficient" ? "complete" : "blocked",
      detail: review.aggregateReadiness.fundingStatus === "insufficient"
        ? `Shortfall ${formatRawDusdc(review.aggregateReadiness.fundingShortfallRaw)} DUSDC`
        : `${formatRawDusdc(review.aggregateReadiness.estimatedPaymentRaw)} DUSDC estimated pay`
    },
    {
      label: "SUI gas preflight",
      state: status === "preflight_failed" ? "blocked" : preflight || status === "signing" || status === "executed" ? "complete" : "pending",
      detail: preflight ? `SUI ${formatRawSui(preflight.suiBalanceRaw)}` : "Wallet pays gas automatically"
    },
    {
      label: status === "executed" ? "Executed" : "Ready to batch sign",
      state: status === "executed" ? "complete" : status === "failed" ? "blocked" : status === "signing" ? "pending" : review.aggregateReadiness.canSign ? "complete" : "pending",
      detail: `${review.aggregateReadiness.selectedLegCount} selected legs`
    }
  ];

  return (
    <div className="rounded-md border border-border bg-background/55 p-3">
      <div className="space-y-1">
        {steps.map((step, index) => (
          <motion.div
            key={step.label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.03 }}
            className="grid grid-cols-[24px_1fr] gap-3 rounded-md py-1.5"
          >
            <StatusIcon state={step.state} busy={busy || status === "compiling" || status === "signing"} />
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{step.label}</p>
              <p className="truncate text-xs text-muted-foreground">{step.detail}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
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
              <MarketMetric label="Quote Age" value={formatQuoteAge(quote.fetchedAt)} />
            </div>
            <p className="rounded-md border border-border bg-background/40 p-3 text-xs leading-5 text-muted-foreground">
              {quote.warning} Estimate may drift before signing; DeepPilot refreshes this review before opening the wallet.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StrategyLegsCard({
  review,
  onToggleLeg
}: {
  review: StrategyApiReview;
  onToggleLeg: (legId: string) => void;
}) {
  return (
    <Card className="glass-line overflow-hidden">
      <CardHeader className="p-4 pb-2">
        <SectionHeading
          title="Strategy Legs"
          detail={`${review.aggregateReadiness.selectedLegCount} selected`}
          icon={<ClipboardCheck className="h-4 w-4" />}
        />
        <CardDescription className="text-xs">
          Candidate plan only. Batch signing uses selected ready legs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <div className="rounded-md border border-border bg-background/55 p-3">
          <p className="text-sm text-foreground">{review.plan.thesis}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {review.plan.riskNotes.map((note) => (
              <Badge key={note} variant="outline" className="border-border text-[10px] text-muted-foreground">
                {note}
              </Badge>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-border">
          <div className="grid grid-cols-[36px_1fr_94px_94px_86px] gap-2 border-b border-border bg-background/70 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <span />
            <span>Outcome</span>
            <span>Est. Pay</span>
            <span>Max Payout</span>
            <span>Status</span>
          </div>
          {review.compiledLegs.map((leg) => {
            const quote = leg.result?.quote;
            const disabled = leg.status === "blocked";

            return (
              <div key={leg.id} className="grid grid-cols-[36px_1fr_94px_94px_86px] gap-2 border-b border-border/70 px-3 py-2 last:border-b-0">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-foreground"
                    checked={leg.selected}
                    disabled={disabled}
                    onChange={() => onToggleLeg(leg.id)}
                    aria-label={`Select ${leg.id}`}
                  />
                </label>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    BTC {leg.leg.direction?.toUpperCase() ?? "--"}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {formatExpiry(quote?.expiry ?? leg.result?.market?.oracle.expiry ?? null)} · {quote?.oracleId ? shortAddress(quote.oracleId) : leg.blockReason ?? leg.leg.note}
                  </p>
                </div>
                <span className="self-center text-xs text-foreground">{formatDusdc(quote?.estimatedCostDusdc ?? null)}</span>
                <span className="self-center text-xs text-foreground">{formatDusdc(quote?.maxPayoutDusdc ?? null)}</span>
                <Badge variant="outline" className={cn("h-7 justify-center border-border text-[10px]", leg.status === "blocked" && "border-destructive/35 text-destructive")}>
                  {leg.status}
                </Badge>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function StrategySafetyCard({ review }: { review: StrategyApiReview }) {
  return (
    <Card className="glass-line">
      <CardHeader className="pb-2">
        <SectionHeading
          title="Batch Readiness"
          detail={review.aggregateReadiness.canSign ? "READY" : "LOCKED"}
          icon={<Shield className="h-4 w-4" />}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <MarketMetric label="Estimated Pay" value={`${formatRawDusdc(review.aggregateReadiness.estimatedPaymentRaw)} DUSDC`} />
          <MarketMetric label="Trading Balance" value={`${formatRawDusdc(review.aggregateReadiness.managerBalanceRaw)} DUSDC`} />
          <MarketMetric label="Shortfall" value={`${formatRawDusdc(review.aggregateReadiness.fundingShortfallRaw)} DUSDC`} />
        </div>
        <div className="space-y-1">
          {review.aggregateReadiness.checks.map((check) => (
            <div key={check.label} className="grid grid-cols-[24px_1fr] gap-3 rounded-md py-1.5">
              <StatusIcon state={check.passed ? "complete" : "blocked"} busy={false} />
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{check.label}</p>
                <p className="truncate text-xs text-muted-foreground">{check.detail}</p>
              </div>
            </div>
          ))}
        </div>
        <EncryptedMemoryPreviewCard />
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

function EncryptedMemoryPreviewCard() {
  const keys = ["risk preference", "last market thesis", "keeper history", "sealed receipt pointer"];

  return (
    <div className="rounded-md border border-border bg-background/45 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Encrypted memory preview</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Seal-encrypted memory preview; not uploaded until user opts in.
          </p>
        </div>
        <LockKeyhole className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {keys.map((key) => (
          <Badge key={key} variant="outline" className="border-border text-[10px] text-muted-foreground">
            {key}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function SafetyChecksCard({
  compiled,
  busy,
  streamTimeline,
  expandedFinding,
  onExpand
}: {
  compiled: CompileApiResult | null;
  busy: boolean;
  streamTimeline: CompileResult["timeline"];
  expandedFinding: string | null;
  onExpand: (value: string | null) => void;
}) {
  const guardian = compiled?.guardian;
  const quoteOnly = isQuoteOnlyResult(compiled);
  const fundingRequired = isFundingRequiredResult(compiled);
  const level = guardian?.level ?? "medium";
  const fallback = [
    "Parsing intent",
    "Reading DeepBook Predict state",
    "Running Guardian checks",
    "Compiling Predict PTB preview",
    "Awaiting confirmation"
  ];
  const sourceTimeline = compiled?.timeline ?? (streamTimeline.length ? streamTimeline : fallback.map((label) => ({ label, state: "pending" as const })));
  const timeline = quoteOnly
    ? sourceTimeline.filter((item) => {
        const label = item.label.toLowerCase();

        return !label.includes("trading balance") && !label.includes("quoting predict payout");
      })
    : fundingRequired
      ? sourceTimeline.filter((item) => !item.label.toLowerCase().includes("building ptb preview"))
    : sourceTimeline;

  return (
    <Card className="glass-line">
      <CardHeader className="pb-2">
        <SectionHeading
          title="Safety Checks"
          detail={guardian?.decision ? guardian.decision.toUpperCase() : `${timeline.length} steps`}
          icon={<Shield className={cn("h-4 w-4", riskColor(level))} />}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border bg-background/60 p-3">
          <div className="grid gap-3 sm:grid-cols-[128px_1fr] sm:items-center">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-1">
              <div className="rounded-md border border-border bg-background/75 p-2.5 text-center">
                <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Score</p>
                <p className={cn("mt-1 text-xl font-semibold tracking-tight", riskColor(level))}>{guardian?.score ?? "--"}</p>
              </div>
              <div className="rounded-md border border-border bg-background/75 p-2.5 text-center">
                <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Risk</p>
                <p className={cn("mt-1 text-sm font-semibold uppercase tracking-[0.12em]", riskColor(level))}>{level}</p>
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {guardian?.blocked
                  ? "Signing locked"
                  : fundingRequired
                    ? "Policy passes; funding required"
                    : quoteOnly ? "Policy checks pass" : "Pre-sign checks pass"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {guardian?.summary ?? "Guardian is checking market, quote, and policy state."}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-1">
          {timeline.map((item, index) => (
            <motion.div
              key={item.label}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.03 }}
              className="grid grid-cols-[24px_1fr_auto] items-center gap-3 rounded-md px-1 py-1.5"
            >
              <StatusIcon state={item.state} busy={busy} />
              <span className="min-w-0 truncate text-sm text-foreground">{item.label}</span>
              <span className="text-xs capitalize text-muted-foreground">{item.state}</span>
            </motion.div>
          ))}
        </div>

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

        <EncryptedMemoryPreviewCard />
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

function TransactionCard({
  compiled,
  accountAddress
}: {
  compiled: CompileApiResult | null;
  accountAddress?: string;
}) {
  const commands = compiled?.ptb?.commands ?? [];
  const gas = compiled?.gas;

  return (
    <Card className="glass-line">
      <CardHeader className="pb-2">
        <SectionHeading
          title="Transaction"
          detail={commands.length ? `${commands.length} commands` : "locked"}
          icon={<Fuel className="h-4 w-4" />}
        />
      </CardHeader>
      <CardContent className="space-y-3">
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

        <div className="grid gap-2">
          <MutedBox>
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Digest</span>
            <span className="mt-1 block break-all font-mono text-xs text-foreground/80">
              {compiled?.ptb?.digestPreview ?? "not compiled"}
            </span>
          </MutedBox>
          <MutedBox>
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Wallet / Gas</span>
            <span className="mt-1 block text-sm text-foreground/80">Wallet auto gas</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              {accountAddress ? shortAddress(accountAddress) : "Wallet not connected"} · {gas?.approved ? "preview policy approved" : "preview policy locked"}
            </span>
          </MutedBox>
          {compiled?.ptb?.sizing ? (
            <MutedBox>
              <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Sizing</span>
              <span className="mt-1 block text-sm text-foreground/80">{compiled.ptb.sizing.label}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{compiled.ptb.sizing.reason}</span>
            </MutedBox>
          ) : null}
        </div>

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

function ExecutionCard({
  compiled,
  receipt,
  error,
  busy,
  blocked,
  onConfirm,
  showButton = true
}: {
  compiled: CompileApiResult | null;
  receipt: ExecutionReceipt | null;
  error: string | null;
  busy: boolean;
  blocked: boolean;
  onConfirm: () => void;
  showButton?: boolean;
}) {
  const readiness = compiled?.ptb?.execution;
  const action = executionAction(compiled, blocked);

  return (
    <Card className="glass-line">
      <CardHeader className="pb-3">
        <SectionHeading title="Execution" detail="wallet tx" icon={<Wallet className="h-4 w-4" />} />
      </CardHeader>
      <CardContent>
        {showButton ? (
          <Button
            className="h-11 w-full"
            variant={action.canConfirm ? "default" : blocked ? "destructive" : "outline"}
            disabled={!action.canConfirm || busy}
            onClick={() => {
              if (action.href) {
                window.location.href = action.href;
                return;
              }

              onConfirm();
            }}
          >
            {busy ? <RefreshCw className="animate-spin" /> : action.href ? <Wallet /> : !action.canConfirm ? <AlertTriangle /> : <LockKeyhole />}
            {action.label}
          </Button>
        ) : null}

        {readiness ? (
          <div className={cn("space-y-1", showButton && "mt-4")}>
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
          {receipt ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 rounded-md border border-border bg-background/70 p-3"
            >
              <div className="flex items-center gap-2 text-foreground">
                <Check className="h-4 w-4" />
                <p className="text-sm font-medium">{receipt.action === "manager_create" ? "PredictManager created" : "Executed"}</p>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{receipt.digest}</p>
              {receipt.managerId ? (
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{receipt.managerId}</p>
              ) : null}
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

function executionAction(compiled: CompileApiResult | null, blocked: boolean) {
  const readiness = compiled?.ptb?.execution;
  const quoteOnly = isQuoteOnlyResult(compiled);
  const canCreateManager = Boolean(compiled?.ptb && !readiness?.managerId && readiness?.walletAddress && !blocked);
  const quoteAvailable = Boolean(compiled?.quote?.status === "available");
  const fundingRequired = readiness?.fundingStatus === "insufficient" || (readiness?.fundingStatus === "unknown" && Boolean(readiness.managerId));
  const canMint = Boolean(compiled?.ptb && readiness?.canSign && !blocked && compiled.gas.approved && quoteAvailable);
  const fundingHref = fundingRequired ? profileFundingHref(compiled) : null;
  const canConfirm = canCreateManager || canMint || Boolean(fundingHref);
  const label = blocked
    ? "Blocked by Guardian"
    : quoteOnly
      ? "Quote only"
    : fundingHref
      ? "Open Profile Funding"
      : canCreateManager
      ? "Create PredictManager"
      : canMint
        ? "Review & Sign"
        : compiled && !compiled.ptb
          ? "No wallet action"
        : !readiness?.walletAddress
          ? "Connect wallet"
          : "Review locked";

  return { canConfirm, label, href: fundingHref };
}

function strategyExecutionAction(review: StrategyApiReview, blocked: boolean) {
  const fundingRequired = review.aggregateReadiness.fundingStatus === "insufficient";
  const fundingHref = fundingRequired ? profileFundingHrefForManager(review.aggregateReadiness.managerId) : null;
  const canRefreshAndBatch = Boolean(review.batchTransactionData && review.aggregateReadiness.canSign && !blocked && isStrategyReviewActive(review));
  const canConfirm = canRefreshAndBatch || Boolean(fundingHref);
  const label = fundingHref
    ? "Open Profile Funding"
    : canRefreshAndBatch
      ? "Batch Review & Sign"
      : !review.aggregateReadiness.walletAddress
        ? "Connect wallet"
        : "Strategy locked";

  return { canConfirm, label, href: fundingHref };
}

function isQuoteOnlyResult(compiled: CompileApiResult | null) {
  return compiled?.intent.status === "ready" && compiled.intent.action === "predict_quote_only";
}

function isFundingRequiredResult(compiled: CompileApiResult | null) {
  return compiled?.ptb?.execution.fundingStatus === "insufficient";
}

function profileFundingHref(compiled: CompileApiResult | null) {
  const managerId = compiled?.ptb?.execution.managerId ?? compiled?.profile?.managerId;

  return profileFundingHrefForManager(managerId);
}

function profileFundingHrefForManager(managerId?: string | null) {
  const params = new URLSearchParams({ fund: "1" });

  if (managerId) {
    params.set("managerId", managerId);
  }

  return `/profile?${params.toString()}`;
}

function needsDeepPilotProfile(result: CompileResult | null | undefined) {
  return Boolean(result?.profile?.wallet && !result.profile.deepPilotProfileId);
}

function strategyNeedsDeepPilotProfile(review: StrategyReview | null | undefined) {
  return Boolean(review?.compiledLegs.some((leg) => needsDeepPilotProfile(leg.result)));
}

function reviewSummaryRows(compiled: CompileApiResult | null, busy: boolean): Array<[string, string]> {
  const quote = compiled?.quote;

  if (!compiled) {
    return [
      ["Guardian", busy ? "checking" : "waiting"],
      ["Quote", busy ? "checking" : "waiting"],
      ["PTB", "waiting"]
    ];
  }

  if (quote?.status === "available") {
    return [
      ["Outcome", `BTC ${quote.direction?.toUpperCase() ?? "--"}`],
      ["Est. pay", `${formatDusdc(quote.estimatedCostDusdc)} DUSDC`],
      ["Max payout", `${formatDusdc(quote.maxPayoutDusdc)} DUSDC`],
      ["Funding", fundingSummary(compiled)],
      ["Expiry", formatExpiry(quote.expiry)],
      ["Guardian", compiled.guardian.decision.toUpperCase()]
    ];
  }

  const firstCommand = compiled.ptb?.commands[0] ?? null;

  return [
    ["Guardian", compiled.guardian.decision.toUpperCase()],
    ["Quote", quote?.status === "unavailable" ? "unavailable" : "not required"],
    ["PTB", compiled.ptb?.digestPreview ? shortAddress(compiled.ptb.digestPreview) : "not compiled"],
    ["Move target", firstCommand?.target ? compactMiddle(firstCommand.target, 18) : "locked"]
  ];
}

function fundingSummary(compiled: CompileApiResult) {
  const execution = compiled.ptb?.execution;

  if (!execution) {
    return "waiting";
  }

  if (execution.fundingStatus === "sufficient") {
    return "ready";
  }

  if (execution.fundingStatus === "insufficient") {
    return `short ${formatRawDusdc(execution.fundingShortfallRaw)} DUSDC`;
  }

  if (execution.fundingStatus === "not_required") {
    return "not required";
  }

  return "unknown";
}

function tradeModalTitle(status: TradeModalStatus, compiled?: CompileApiResult | null) {
  if (isQuoteOnlyResult(compiled ?? null)) {
    return "Predict quote preview";
  }

  if (isGuardianBlockedReview(status, compiled ?? null)) {
    return "Review blocked";
  }

  switch (status) {
    case "compiling":
      return "Preparing Predict review";
    case "quote_ready":
      return "Review Predict trade";
    case "funding_required":
      return "Funding required";
    case "review_changed":
      return "Review updated";
    case "preflight_failed":
      return "Wallet preflight failed";
    case "ready_to_sign":
      return "Checking wallet balances";
    case "signing":
      return "Wallet signing";
    case "executed":
      return "Execution complete";
    case "failed":
      return "Execution failed";
    default:
      return "Predict trade review";
  }
}

function strategyModalTitle(status: TradeModalStatus, review: StrategyApiReview) {
  if (status === "funding_required") {
    return "Strategy funding required";
  }

  if (status === "review_changed") {
    return "Strategy review changed";
  }

  if (status === "signing") {
    return "Confirm strategy batch";
  }

  if (status === "executed") {
    return "Strategy executed";
  }

  if (!review.aggregateReadiness.canSign) {
    return "Strategy candidate";
  }

  return "Strategy batch review";
}

function tradeModalSubtitle(status: TradeModalStatus, compiled: CompileApiResult | null) {
  if (compiled?.intent.status === "ready" && compiled.intent.action === "predict_quote_only") {
    return "Quote-only preview · no wallet action required";
  }

  if (isGuardianBlockedReview(status, compiled)) {
    return compiled?.guardian.summary ?? "Guardian blocked this review before wallet signing.";
  }

  if (compiled?.quote?.status === "available") {
    return `BTC ${compiled.quote.direction?.toUpperCase() ?? "--"} · ${formatDusdc(compiled.quote.estimatedCostDusdc)} DUSDC estimated pay · ${formatExpiry(compiled.quote.expiry)}`;
  }

  return tradeStatusDescription(status);
}

function strategyModalSubtitle(status: TradeModalStatus, review: StrategyApiReview) {
  if (status === "funding_required") {
    return "Trading Balance is insufficient for the selected strategy legs.";
  }

  if (status === "review_changed") {
    return "One or more selected legs changed after refresh. Review the updated batch before signing.";
  }

  if (status === "executed") {
    return "Receipt saved locally. Predict positions may take a moment to appear in Profile.";
  }

  return `${review.aggregateReadiness.selectedLegCount} selected legs · ${formatRawDusdc(review.aggregateReadiness.estimatedPaymentRaw)} DUSDC estimated payment · candidate plan, not investment advice.`;
}

function tradeStatusLabel(status: TradeModalStatus) {
  switch (status) {
    case "compiling":
      return "Compiling review";
    case "quote_ready":
      return "Review ready";
    case "funding_required":
      return "Funding required";
    case "review_changed":
      return "Review changed";
    case "preflight_failed":
      return "Preflight failed";
    case "ready_to_sign":
      return "Preflight running";
    case "signing":
      return "Waiting for wallet";
    case "executed":
      return "Executed";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

function tradeStatusDescription(status: TradeModalStatus) {
  switch (status) {
    case "compiling":
      return "DeepPilot is parsing the request, resolving the active oracle, quoting payout, and running Guardian.";
    case "quote_ready":
      return "Review the outcome, safety checks, and next action before continuing.";
    case "funding_required":
      return "Trading Balance is insufficient. Add DUSDC to your PredictManager in Profile before opening this position.";
    case "review_changed":
      return "The refreshed quote or executable payload changed. Check the updated review, then sign again.";
    case "preflight_failed":
      return "Wallet balances do not satisfy the transaction requirements.";
    case "ready_to_sign":
      return "Checking SUI gas and pre-funded Trading Balance before opening the wallet.";
    case "signing":
      return "Confirm or reject the transaction in your wallet.";
    case "executed":
      return "Receipt saved locally. The Predict server may take a moment to index the position.";
    case "failed":
      return "The transaction did not execute. Check the message and try again after fixing the issue.";
    default:
      return "Use the ticket or Pilot Console to prepare a Predict trade.";
  }
}

function tradeStatusForCompiled(result: CompileApiResult): TradeModalStatus {
  if (result.intent.status === "needs_clarification" || result.guardian.blocked) {
    return "failed";
  }

  const fundingStatus = result.ptb?.execution.fundingStatus;

  if (fundingStatus === "insufficient" || (fundingStatus === "unknown" && Boolean(result.ptb?.execution.managerId))) {
    return "funding_required";
  }

  return "quote_ready";
}

function isGuardianBlockedReview(status: TradeModalStatus, compiled: CompileApiResult | null) {
  return status === "failed" && Boolean(compiled?.guardian.blocked);
}

function tradeAssistantCopy(compiled: CompileApiResult) {
  if (compiled.intent.status === "needs_clarification") {
    return `I need one more field before building a transaction review: ${compiled.intent.missing.join(", ")}.\n${compiled.intent.reason}`;
  }

  if (compiled.guardian.decision === "block") {
    return `Guardian returned BLOCK.\n${compiled.guardian.summary}\nReview the blocked checks on the right before changing the intent.`;
  }

  const execution = compiled.ptb?.execution;

  if (execution?.fundingStatus === "insufficient" || (execution?.fundingStatus === "unknown" && Boolean(execution.managerId))) {
    return [
      "Trading Balance is insufficient; fund in Profile before opening this trade.",
      `Estimated payment: ${formatRawDusdc(execution.estimatedPaymentRaw)} DUSDC`,
      `Trading Balance: ${formatRawDusdc(execution.managerBalanceRaw)} DUSDC`,
      `Shortfall: ${formatRawDusdc(execution.fundingShortfallRaw)} DUSDC`
    ].join("\n");
  }

  if (compiled.intent.action === "predict_quote_only") {
    return [
      "Predict market preview is ready.",
      `Guardian: ${compiled.guardian.decision.toUpperCase()}`,
      "No wallet signature is required for this read-only preview."
    ].join("\n");
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

function vaultLpAssistantCopy(review: VaultLpReview) {
  if (review.intent.action === "info") {
    return [
      "Vault LP summary is ready.",
      `Vault value: ${formatRawDusdc(review.summary.vault.vault_value)} DUSDC`,
      `Share price: ${review.summary.vault.plp_share_price.toFixed(6)} DUSDC`,
      `Utilization: ${(review.summary.vault.utilization * 100).toFixed(2)}%`,
      "No wallet signature is required for this read-only view."
    ].join("\n");
  }

  return [
    "Vault LP review is ready.",
    `Action: ${review.intent.action.toUpperCase()}`,
    `Amount: ${formatRawDusdc(review.execution.amountRaw)} DUSDC`,
    `Share price: ${review.summary.vault.plp_share_price.toFixed(6)} DUSDC`,
    review.transactionData?.plpSharesRaw ? `Estimated PLP: ${formatRawDusdc(review.transactionData.plpSharesRaw)} PLP` : null,
    review.transactionData?.estimatedDusdcOutRaw ? `Estimated DUSDC out: ${formatRawDusdc(review.transactionData.estimatedDusdcOutRaw)} DUSDC` : null,
    review.execution.canSign ? "Open the Vault LP review before signing." : review.execution.reason
  ].filter(Boolean).join("\n");
}

function createMessageId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildConversationForPilot(messages: PilotMessage[]): PilotMessageSummary[] {
  const freshAfter = Date.now() - CONVERSATION_CONTEXT_TTL_MS;

  return messages
    .filter((message) => {
      if (message.mode !== "chat" || message.pending || !message.content.trim()) {
        return false;
      }

      return typeof message.createdAt === "number" && message.createdAt >= freshAfter;
    })
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: sanitizePilotContext(message.content).slice(0, 850),
      mode: message.mode,
      sourceTitles: message.sources?.slice(0, 4).map((source) => source.title.slice(0, 160))
    }));
}

function mergePendingClarification(pending: PendingPilotClarification, clarification: string) {
  return `${pending.originalText}\nClarification: ${clarification.trim()}`;
}

function latestMarketThesis(messages: PilotMessage[]) {
  const freshAfter = Date.now() - CONVERSATION_CONTEXT_TTL_MS;
  const latest = [...messages].reverse().find((message) =>
    message.role === "assistant" &&
    message.mode === "chat" &&
    !message.pending &&
    message.content.trim() &&
    typeof message.createdAt === "number" &&
    message.createdAt >= freshAfter
  );

  return latest ? sanitizePilotContext(latest.content).slice(0, 1200) : undefined;
}

function sanitizePilotContext(value: string) {
  return value
    .replace(/0x[a-fA-F0-9]{16,64}/g, "0x...")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultSelectedStrategyLegIds(review: StrategyApiReview) {
  return review.compiledLegs
    .filter((leg) => leg.selected && leg.status !== "blocked")
    .map((leg) => leg.id);
}

function applyStrategySelection(review: StrategyApiReview, selectedIds: string[]): StrategyApiReview {
  const selected = new Set(selectedIds);
  const compiledLegs = review.compiledLegs.map((leg) => ({
    ...leg,
    selected: selected.has(leg.id) && leg.status !== "blocked"
  }));
  const aggregateReadiness = buildClientAggregateReadiness(compiledLegs);
  const batchTransactionData = aggregateReadiness.canSign
    ? buildClientBatchTransactionData(review, compiledLegs)
    : null;

  return {
    ...review,
    compiledLegs,
    aggregateReadiness,
    batchTransactionData
  };
}

function buildClientAggregateReadiness(compiledLegs: CompiledTradeLeg[]): StrategyApiReview["aggregateReadiness"] {
  const selected = compiledLegs.filter((leg) => leg.selected);
  const ready = selected.filter((leg) => leg.status === "ready" && leg.result?.ptb?.execution.canSign);
  const firstResult = selected.find((leg) => leg.result)?.result ?? null;
  const profile = firstResult?.profile ?? null;
  const managerId = firstResult?.ptb?.execution.managerId ?? profile?.managerId ?? null;
  const walletAddress = profile?.wallet ?? firstResult?.ptb?.execution.walletAddress ?? null;
  const managerBalanceRaw = profile?.tradingBalanceRaw ?? firstResult?.ptb?.execution.managerBalanceRaw ?? null;
  const estimatedPaymentRaw = sumRawAmounts(selected.map((leg) => leg.result?.quote?.estimatedCostRaw ?? null));
  const funding = clientFundingStatus(managerBalanceRaw, estimatedPaymentRaw);
  const checks: ExecutionReadinessCheck[] = [
    {
      label: "Selected legs",
      passed: selected.length > 0,
      detail: selected.length ? `${selected.length} selected legs` : "Select at least one ready leg."
    },
    {
      label: "Every selected leg ready",
      passed: selected.length > 0 && selected.length === ready.length,
      detail: `${ready.length}/${selected.length} selected legs ready.`
    },
    {
      label: "Wallet connected",
      passed: Boolean(walletAddress),
      detail: walletAddress ?? "Connect wallet before batch signing."
    },
    {
      label: "PredictManager linked",
      passed: Boolean(managerId),
      detail: managerId ?? "Create or load PredictManager before batch signing."
    },
    {
      label: "Aggregate Trading Balance",
      passed: funding.status === "sufficient",
      detail: funding.detail
    }
  ];
  const canSign = checks.every((check) => check.passed);

  return {
    canSign,
    mode: canSign ? "wallet_transaction" : "preview_only",
    reason: canSign
      ? "All selected legs are ready for one batch wallet signature."
      : "Batch signing is locked until every selected leg and aggregate funding check passes.",
    walletAddress,
    managerId,
    selectedLegCount: selected.length,
    readyLegCount: ready.length,
    blockedLegCount: selected.length - ready.length,
    estimatedPaymentRaw,
    estimatedPaymentDusdc: rawDusdcNumber(estimatedPaymentRaw),
    managerBalanceRaw,
    managerBalanceDusdc: rawDusdcNumber(managerBalanceRaw),
    fundingShortfallRaw: funding.shortfallRaw,
    fundingStatus: funding.status,
    checks
  };
}

function buildClientBatchTransactionData(
  review: StrategyApiReview,
  compiledLegs: CompiledTradeLeg[]
): BatchPredictMintTransactionData | null {
  const selected = compiledLegs.filter((leg) => leg.selected && leg.result?.ptb?.transactionData);
  const first = selected[0]?.result?.ptb?.transactionData;

  if (!first) {
    return null;
  }

  const commands: BatchPredictMintTransactionData["commands"] = [];
  const legs = selected.map((leg) => {
    const transaction = leg.result!.ptb!.transactionData;
    const keyCommand = transaction.commands.find((command) => command.target.includes("::market_key::"));
    const mintCommand = transaction.commands.find((command) => command.target.endsWith("::predict::mint"));

    if (keyCommand) {
      commands.push({ ...keyCommand, index: commands.length + 1, command: `${leg.id}: ${keyCommand.command}` });
    }

    if (mintCommand) {
      commands.push({ ...mintCommand, index: commands.length + 1, command: `${leg.id}: ${mintCommand.command}` });
    }

    return {
      legId: leg.id,
      oracleId: transaction.key.oracleId,
      expiry: transaction.key.expiry,
      strikeScaled: transaction.key.strikeScaled,
      direction: transaction.key.direction,
      keyTarget: transaction.key.target,
      mintTarget: transaction.mint.target,
      quantityRaw: transaction.mint.quantityRaw,
      estimatedCostRaw: transaction.quote?.estimatedCostRaw ?? null
    };
  });

  return {
    kind: "BatchProgrammableTransaction",
    network: first.network,
    packageId: first.packageId,
    predictObject: first.predictObject,
    quoteAssetType: first.quoteAssetType,
    manager: review.aggregateReadiness.managerId ?? first.manager,
    legs,
    commands
  };
}

function strategyStatusForReview(review: StrategyApiReview): TradeModalStatus {
  if (review.aggregateReadiness.fundingStatus === "insufficient") {
    return "funding_required";
  }

  return review.aggregateReadiness.canSign ? "quote_ready" : "failed";
}

function strategyAssistantCopy(review: StrategyApiReview) {
  const lines = [
    "Strategy candidate is ready for review.",
    `Thesis: ${review.plan.thesis}`,
    `Legs: ${review.aggregateReadiness.readyLegCount}/${review.aggregateReadiness.selectedLegCount} ready`,
    `Estimated payment: ${formatRawDusdc(review.aggregateReadiness.estimatedPaymentRaw)} DUSDC`,
    `Trading Balance: ${formatRawDusdc(review.aggregateReadiness.managerBalanceRaw)} DUSDC`
  ];

  if (review.plan.missing.length) {
    lines.push(`Missing before signing: ${review.plan.missing.join(", ")}`);
  }

  if (!review.aggregateReadiness.canSign) {
    lines.push(review.aggregateReadiness.reason);
  }

  lines.push("This is a candidate plan, not investment advice. Review every leg before signing.");

  return lines.join("\n");
}

function isStrategyReviewActive(review: StrategyApiReview) {
  return review.reviewFreshness.active && review.compiledLegs
    .filter((leg) => leg.selected)
    .every((leg) => {
      const market = leg.result?.market;

      return Boolean(market && market.oracle.status === "active" && market.oracle.expiry > market.status.current_time_ms);
    });
}

function isStrategyReviewSignableNow(review: StrategyApiReview) {
  if (!isStrategyReviewActive(review)) {
    return false;
  }

  return review.compiledLegs
    .filter((leg) => leg.selected)
    .every((leg) => leg.result?.quote?.status === "available" && new Date(leg.result.quote.expiresAt).getTime() > Date.now());
}

function strategyExecutableFingerprint(review: StrategyApiReview) {
  return JSON.stringify({
    selected: review.compiledLegs
      .filter((leg) => leg.selected)
      .map((leg) => ({
        id: leg.id,
        oracleId: leg.result?.ptb?.transactionData.oracleId ?? null,
        key: leg.result?.ptb?.transactionData.key ?? null,
        mintTarget: leg.result?.ptb?.transactionData.mint.target ?? null
      })),
    managerId: review.aggregateReadiness.managerId
  });
}

function strategyLockedLegs(review: StrategyApiReview) {
  return review.compiledLegs.map((leg) => ({
    id: leg.id,
    oracleId: leg.result?.ptb?.transactionData.oracleId ?? leg.leg.oracleId ?? null,
    direction: leg.result?.ptb?.transactionData.key.direction ?? leg.leg.direction ?? null,
    strike: leg.leg.strike ?? leg.result?.quote?.strike ?? null
  }));
}

function isReviewActive(compiled: CompileApiResult) {
  if (!compiled.reviewFreshness?.active) {
    return false;
  }

  const market = compiled.market;

  if (!market) {
    return true;
  }

  return market.oracle.status === "active" && market.oracle.expiry > market.status.current_time_ms;
}

function isReviewSignableNow(compiled: CompileApiResult) {
  if (!isReviewActive(compiled)) {
    return false;
  }

  if (compiled.intent.status === "ready" && compiled.intent.action === "predict_binary_mint") {
    return Boolean(compiled.quote?.status === "available" && new Date(compiled.quote.expiresAt).getTime() > Date.now());
  }

  return true;
}

function executableFingerprint(compiled: CompileApiResult) {
  const transaction = compiled.ptb?.transactionData;

  return JSON.stringify({
    packageId: transaction?.packageId ?? null,
    predictObject: transaction?.predictObject ?? null,
    manager: compiled.ptb?.execution.managerId ?? transaction?.manager ?? null,
    oracleId: transaction?.oracleId ?? null,
    key: transaction?.key ?? null,
    mintTarget: transaction?.mint.target ?? null,
    commandTargets: transaction?.commands.map((command) => command.target) ?? [],
    quoteBudgetRaw: compiled.quote?.quoteBudgetRaw ?? null
  });
}

function parseRawAmount(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function sumRawAmounts(values: Array<string | null | undefined>) {
  let total = 0n;

  for (const value of values) {
    if (!value || !/^\d+$/.test(value)) {
      return null;
    }

    total += BigInt(value);
  }

  return total.toString();
}

function clientFundingStatus(managerBalanceRaw: string | null, estimatedPaymentRaw: string | null) {
  if (!estimatedPaymentRaw || !/^\d+$/.test(estimatedPaymentRaw)) {
    return {
      status: "unknown" as const,
      shortfallRaw: null,
      detail: "Aggregate payment is unavailable until every selected leg has a quote."
    };
  }

  if (!managerBalanceRaw || !/^\d+$/.test(managerBalanceRaw)) {
    return {
      status: "unknown" as const,
      shortfallRaw: estimatedPaymentRaw,
      detail: "Trading Balance is unavailable or not indexed yet."
    };
  }

  const required = BigInt(estimatedPaymentRaw);
  const balance = BigInt(managerBalanceRaw);
  const shortfall = balance >= required ? 0n : required - balance;

  if (shortfall > 0n) {
    return {
      status: "insufficient" as const,
      shortfallRaw: shortfall.toString(),
      detail: `Trading Balance is short by ${formatRawDusdc(shortfall.toString())} DUSDC.`
    };
  }

  return {
    status: "sufficient" as const,
    shortfallRaw: "0",
    detail: `${formatRawDusdc(managerBalanceRaw)} DUSDC Trading Balance available.`
  };
}

function rawDusdcNumber(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const raw = BigInt(value);

  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  return Number(raw) / Number(DUSDC_BASE_UNITS);
}

function marketPreviewEndpoint(urlOracleId: string | null) {
  const params = new URLSearchParams({
    status: "active",
    expiry: urlOracleId ? "all" : "next",
    pageSize: "1"
  });

  if (urlOracleId) {
    params.set("selectedOracleId", urlOracleId);
  }

  return `/api/markets?${params.toString()}`;
}

function oracleIdFromSearch(searchParams: { get(name: string): string | null }) {
  const oracleId = searchParams.get("oracleId");

  if (!oracleId || !/^0x[a-fA-F0-9]{16,64}$/.test(oracleId)) {
    return null;
  }

  return oracleId;
}

function managerIdFromSearch(searchParams: { get(name: string): string | null }) {
  const managerId = searchParams.get("managerId");

  if (!managerId || !/^0x[a-fA-F0-9]{16,64}$/.test(managerId)) {
    return null;
  }

  return managerId;
}

function reviewTokenFromSearch(searchParams: { get(name: string): string | null }) {
  const token = searchParams.get("review");

  return token && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

function strikeFromSearch(searchParams: { get(name: string): string | null }) {
  const strike = searchParams.get("strike");
  const numericStrike = strike ? Number(strike) : NaN;

  return Number.isFinite(numericStrike) ? numericStrike : null;
}

function updateManagerInUrl(managerId: string) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("managerId", managerId);
  window.history.replaceState(null, "", url.toString());
}

function saveExecutionReceipt(
  receipt: ExecutionReceipt,
  intent: string,
  review: CompileApiResult | StrategyApiReview
) {
  const isStrategy = "plan" in review;

  storePreviewReceipt({
    id: receipt.digest,
    time: new Date().toISOString(),
    type: activityTypeForExecution(receipt.action),
    oracleId: isStrategy ? review.compiledLegs[0]?.result?.market?.oracle.oracle_id : review.market?.oracle.oracle_id,
    digest: receipt.digest,
    guardianDecision: isStrategy ? undefined : review.guardian.decision,
    summary: receipt.action === "manager_create"
      ? "PredictManager created"
      : receipt.action === "strategy_batch_mint"
        ? `Strategy batch executed for: ${intent}`
        : `Predict mint executed for: ${intent}`,
    walletAddress: receipt.walletAddress,
    network: receipt.network,
    status: receipt.status,
    note: receipt.note
  });
}

function activityTypeForExecution(action: ExecutionReceipt["action"]): Parameters<typeof storePreviewReceipt>[0]["type"] {
  switch (action) {
    case "strategy_batch_mint":
      return "predict_mint";
    case "manager_create":
    case "predict_mint":
    case "vault_lp_supply":
    case "vault_lp_withdraw":
      return action;
  }
}

function saveVaultLpExecutionReceipt(receipt: ExecutionReceipt, review: VaultLpReview) {
  storePreviewReceipt({
    id: receipt.digest,
    time: new Date().toISOString(),
    type: activityTypeForExecution(receipt.action),
    digest: receipt.digest,
    summary: `${review.intent.action === "deposit" ? "Vault LP supply" : "Vault LP withdraw"} ${formatRawDusdc(review.execution.amountRaw)} DUSDC`,
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

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/55 p-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-2 truncate font-mono text-xs text-foreground/85">{value}</p>
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

function formatRawDusdc(value: string | number | bigint | null | undefined) {
  const raw = typeof value === "bigint" ? value : parseRawAmount(value);
  const whole = Number(raw) / Number(DUSDC_BASE_UNITS);

  return whole.toLocaleString("en-US", {
    minimumFractionDigits: whole > 0 && whole < 1 ? 4 : 2,
    maximumFractionDigits: whole > 0 && whole < 1 ? 6 : 2
  });
}

function formatRawSui(value: string | bigint) {
  const raw = typeof value === "bigint" ? value : parseRawAmount(value);
  const whole = Number(raw) / Number(MIST_PER_SUI);

  return whole.toLocaleString("en-US", {
    minimumFractionDigits: whole > 0 && whole < 1 ? 4 : 2,
    maximumFractionDigits: whole > 0 && whole < 1 ? 6 : 4
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

function formatQuoteAge(value: string) {
  const time = new Date(value).getTime();

  if (!Number.isFinite(time)) {
    return "--";
  }

  const seconds = Math.max(0, Math.round((Date.now() - time) / 1_000));

  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
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

function pageIsVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function formatAge(valueMs: PredictMarketSnapshot["metrics"]["oracleAgeMs"]) {
  if (valueMs === null) {
    return "--";
  }

  return valueMs < 1_000 ? `${valueMs}ms` : `${(valueMs / 1_000).toFixed(1)}s`;
}
