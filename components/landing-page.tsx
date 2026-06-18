import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Bot,
  ClipboardCheck,
  ExternalLink,
  LockKeyhole,
  Radar,
  ShieldCheck,
  Wallet
} from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { TELEGRAM_BOT_HANDLE, TELEGRAM_BOT_URL } from "@/src/lib/public-links";
import { cn } from "@/src/lib/utils";

const capabilities = [
  {
    title: "Find live BTC markets",
    description: "See active BTC prediction markets, expiry, oracle freshness, and liquidity context before choosing where to act.",
    icon: BarChart3,
    stat: "01 / discover"
  },
  {
    title: "Start from plain language",
    description: "Ask in the Web terminal or Telegram, then let DeepPilot turn the prompt into a wallet-reviewed flow.",
    icon: Bot,
    stat: "02 / ask"
  },
  {
    title: "Read the RiskOps result",
    description: "Review stale oracle, indexer lag, vault utilization, trade size, and quote availability before the wallet opens.",
    icon: ShieldCheck,
    stat: "03 / review"
  },
  {
    title: "Preflight balance and gas",
    description: "DeepPilot checks Trading Balance funding, wallet network, and SUI gas readiness before asking for a signature.",
    icon: ClipboardCheck,
    stat: "04 / sign"
  },
  {
    title: "Track what happened",
    description: "Profile keeps Trading Balance, positions, live or indexed PnL, settlement status, and local receipts visible after review.",
    icon: Wallet,
    stat: "05 / track"
  }
] as const;

const tickerItems = [
  "Live BTC markets",
  "Telegram /login",
  "Telegram /trade",
  "RiskOps checks",
  "Quote freshness",
  "Trading Balance",
  "Web Review links",
  "SUI gas preflight",
  "Wallet-confirmed",
  "PnL tracking",
  "Settlement receipts",
  "Receipts"
] as const;

const reviewRows = [
  ["source", "Telegram or web prompt", "accepted"],
  ["oracle", "active BTC window + freshness", "live"],
  ["quote", "cost and payout checked", "fresh"],
  ["riskops", "stale / lag / vault checks", "clear"],
  ["balance", "Trading Balance preflight", "ready"],
  ["wallet", "user-confirmed signing", "gated"]
] as const;

const riskOpsSignals = [
  ["Market health", "active oracle, expiry, indexer lag"],
  ["Quote freshness", "cost, payout, and quote expiry"],
  ["Balance preflight", "Trading Balance and SUI gas"],
  ["After signing", "positions, PnL, settlements, receipts"]
] as const;

const workflow = [
  {
    title: "Ask",
    description: "Start in the Web terminal or message the Telegram bot with market, news, trade, or strategy intent."
  },
  {
    title: "Choose",
    description: "Review the active market, time left, and estimated outcome."
  },
  {
    title: "Check",
    description: "Read RiskOps checks for market health, quote freshness, balance readiness, and wallet gas."
  },
  {
    title: "Review",
    description: "Open the Web Review link from Telegram or continue in the Web app to verify refresh-sensitive details."
  },
  {
    title: "Sign",
    description: "Approve or reject from the connected Sui wallet."
  },
  {
    title: "Track",
    description: "Return to Profile for balances, positions, settlements, and receipts."
  }
] as const;

const guardRails = [
  "AI helps organize the review; it does not make the user's trading decision.",
  "RiskOps checks market state, quote freshness, Trading Balance, wallet gas, and receipt visibility.",
  "Telegram starts review links and account binding, while execution still requires wallet confirmation in Web.",
  "Secrets and deployment settings stay server-side and are not shown on this page.",
  "DeepPilot is built for DeepBook Predict markets, not order matching.",
  "Signing stays user-controlled and only appears after the required checks pass."
] as const;

const telegramCommands = [
  ["/login", "bind Telegram to a wallet through a signed Web challenge"],
  ["/markets", "scan live BTC Predict markets before choosing a review"],
  ["/news BTC", "summarize market context before drafting an intent"],
  ["/trade ...", "create a Web Review link for a single Predict action"],
  ["/strategy ...", "create a Web Review link for a multi-leg strategy"]
] as const;

export function LandingPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <SiteHeader fixed activePath="/landing" />
      <Hero />
      <CapabilityStream />
      <TelegramSection />
      <ReviewStream />
      <Workflow />
      <SafetyBoundary />
    </main>
  );
}

function Hero() {
  return (
    <section className="relative min-h-[92svh] border-b border-border pt-28 lg:pt-16">
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(rgba(250,250,250,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(250,250,250,0.035)_1px,transparent_1px)] bg-[size:44px_44px]" />
      <div className="landing-scanline absolute inset-x-0 top-20 -z-10 h-24 border-y border-emerald-300/15 bg-emerald-300/5" />

      <div className="mx-auto grid min-h-[calc(100svh-9rem)] w-full max-w-[1580px] items-start gap-10 px-4 py-5 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(460px,0.65fr)] lg:px-8">
        <div className="landing-rise max-w-5xl">
          <p className="flex flex-wrap items-center gap-3 text-sm font-medium uppercase tracking-[0.26em] text-muted-foreground">
            <span className="landing-breathe" />
            DeepPilot for prediction markets
            <span className="text-sky-100">Web + Telegram handoff</span>
          </p>
          <h1 className="mt-5 text-5xl font-semibold leading-none tracking-tight text-foreground sm:text-6xl lg:text-7xl 2xl:text-8xl">
            Review before Predict.
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-muted-foreground sm:text-xl sm:leading-9">
            DeepPilot helps users discover live BTC markets, ask in plain language, continue from Telegram, run RiskOps checks, and sign only after wallet-ready checks pass.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button asChild size="lg" className="h-12 px-6 text-base">
              <Link href={"/trade" as Route}>
                Start a Review
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 border-border bg-background/70 px-6 text-base">
              <Link href={"/markets" as Route}>Browse Markets</Link>
            </Button>
            <Button asChild size="lg" variant="ghost" className="h-12 px-6 text-base">
              <Link href={"/profile" as Route}>View Profile</Link>
            </Button>
            <Button asChild size="lg" variant="ghost" className="h-12 px-6 text-base">
              <a href={TELEGRAM_BOT_URL} rel="noreferrer" target="_blank">
                Open Telegram Bot
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>

          <div className="mt-8 grid border-y border-border sm:grid-cols-2">
            {riskOpsSignals.map(([label, value], index) => (
              <div
                key={label}
                className={cn(
                  "border-border py-4",
                  index !== riskOpsSignals.length - 1 && "border-b",
                  index % 2 === 0 ? "sm:border-r sm:pr-6" : "sm:pl-6",
                  index < 2 ? "sm:border-b" : "sm:border-b-0"
                )}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-100">{label}</p>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">{value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="landing-rise landing-rise-delay min-w-0">
          <HeroTerminal />
        </div>
      </div>

      <Ticker />

    </section>
  );
}

function HeroTerminal() {
  return (
    <div className="border-y border-border bg-background/82 py-5">
      <div className="flex items-center justify-between gap-4 border-b border-border px-1 pb-4">
        <SectionLabel icon={<Radar className="h-4 w-4" />} label="Review stream" />
        <span className="font-mono text-xs text-emerald-100">live checks</span>
      </div>

      <div className="divide-y divide-border">
        {reviewRows.map(([label, value, state]) => (
          <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)_74px] gap-3 py-4 text-sm sm:grid-cols-[130px_minmax(0,1fr)_94px]">
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate text-foreground">{value}</span>
            <span className="text-right font-mono text-xs text-emerald-100">{state}</span>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 border-t border-border pt-5 sm:grid-cols-3">
        <Metric label="Risk" value="ALLOW" />
        <Metric label="Review" value="READY" />
        <Metric label="Signing" value="WALLET" />
      </div>
    </div>
  );
}

function Ticker() {
  return (
    <div className="landing-ticker-window border-y border-border bg-background/70 py-3">
      <div className="landing-ticker-track">
        {[...tickerItems, ...tickerItems].map((item, index) => (
          <span key={`${item}-${index}`} className="mx-6 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function CapabilityStream() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto grid w-full max-w-[1580px] gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(280px,0.42fr)_minmax(0,1fr)] lg:px-8">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">what users can do</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Decide with context.
          </h2>
          <p className="mt-5 text-sm leading-6 text-muted-foreground">
            Find a market, ask for help, review risk, sign from wallet, and check outcomes later.
          </p>
        </div>

        <div className="divide-y divide-border border-y border-border">
          {capabilities.map((item) => {
            const Icon = item.icon;

            return (
              <div key={item.title} className="grid gap-4 py-7 md:grid-cols-[44px_minmax(0,0.7fr)_minmax(0,1fr)] md:items-start">
                <Icon className="h-5 w-5 text-foreground" />
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{item.stat}</p>
                  <h3 className="mt-2 text-lg font-semibold text-foreground">{item.title}</h3>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TelegramSection() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto grid w-full max-w-[1580px] gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(280px,0.42fr)_minmax(0,1fr)] lg:px-8">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SectionLabel icon={<Bot className="h-4 w-4" />} label="Telegram bot" />
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Start in chat. Sign in Web.
          </h2>
          <p className="mt-5 text-sm leading-6 text-muted-foreground">
            {TELEGRAM_BOT_HANDLE} lets users bind a wallet, check markets, read BTC context, and generate review links from plain-language commands.
          </p>
          <Button asChild variant="outline" className="mt-7 h-11 border-border bg-background/70 px-5">
            <a href={TELEGRAM_BOT_URL} rel="noreferrer" target="_blank">
              Open {TELEGRAM_BOT_HANDLE}
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>

        <div className="border-y border-border">
          {telegramCommands.map(([command, description]) => (
            <div key={command} className="grid gap-3 border-b border-border py-5 last:border-b-0 md:grid-cols-[150px_minmax(0,1fr)_56px] md:items-center">
              <span className="font-mono text-xs text-emerald-100">{command}</span>
              <span className="text-sm leading-6 text-muted-foreground">{description}</span>
              <span className="h-px w-14 justify-self-end bg-sky-300" />
            </div>
          ))}
          <div className="grid gap-3 border-t border-border py-5 md:grid-cols-[150px_minmax(0,1fr)_56px] md:items-center">
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">Boundary</span>
            <span className="text-sm leading-6 text-foreground">
              Telegram prepares the review. Wallet signing stays in the Web flow after fresh RiskOps and balance checks.
            </span>
            <span className="h-px w-14 justify-self-end bg-emerald-300" />
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewStream() {
  return (
    <section className="relative border-b border-border">
      <div className="absolute inset-y-0 left-1/2 hidden w-px bg-border lg:block" />
      <div className="mx-auto grid min-h-screen w-full max-w-[1580px] gap-8 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div className="flex flex-col justify-center">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">before signing</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Review before signing.
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-6 text-muted-foreground">
            DeepPilot does not rush users into a wallet prompt. It turns a request into a review, explains the state, then lets the user decide.
          </p>
        </div>

        <div className="flex flex-col justify-center border-y border-border">
          <StreamLine label="Prompt" value="plain-language request" tone="sky" />
          <StreamLine label="Market" value="active BTC market selected" tone="default" />
          <StreamLine label="Estimate" value="payout view prepared" tone="default" />
          <StreamLine label="Risk" value="allow / reduce / block explained" tone="emerald" />
          <StreamLine label="Wallet" value="confirm after checks" tone="emerald" />
        </div>
      </div>
    </section>
  );
}

function Workflow() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto w-full max-w-[1580px] px-4 py-20 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">user path</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">From question to wallet decision.</h2>
        </div>

        <div className="mt-12 border-y border-border">
          {workflow.map((item, index) => (
            <div key={item.title} className="grid gap-4 border-b border-border py-6 last:border-b-0 md:grid-cols-[120px_minmax(0,0.32fr)_minmax(0,1fr)] md:items-center">
              <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
              <h3 className="text-xl font-semibold text-foreground">{item.title}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SafetyBoundary() {
  return (
    <section className="min-h-[80vh]">
      <div className="mx-auto grid w-full max-w-[1580px] gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,0.62fr)_minmax(0,0.88fr)] lg:px-8">
        <div>
          <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">
            <LockKeyhole className="h-4 w-4" />
            What DeepPilot will and will not do
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Wallet control.
          </h2>
        </div>

        <div className="divide-y divide-border border-y border-border">
          {guardRails.map((item) => (
            <div key={item} className="flex gap-4 py-5">
              <BadgeCheck className="mt-1 h-4 w-4 shrink-0 text-emerald-100" />
              <p className="text-sm leading-6 text-muted-foreground">{item}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-border pl-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-sm text-emerald-100">{value}</p>
    </div>
  );
}

function SectionLabel({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
      {icon}
      {label}
    </div>
  );
}

function StreamLine({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: "default" | "emerald" | "sky";
}) {
  return (
    <div className="landing-stream-row grid grid-cols-[120px_minmax(0,1fr)_56px] items-center gap-4 border-b border-border py-5 last:border-b-0">
      <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-sm text-foreground">{value}</span>
      <span
        className={cn(
          "h-px w-14 justify-self-end",
          tone === "emerald" ? "bg-emerald-300" : tone === "sky" ? "bg-sky-300" : "bg-border"
        )}
      />
    </div>
  );
}
