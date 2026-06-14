"use client";

import Link from "next/link";
import type { Route } from "next";
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/app-shell";
import {
  useMarketDiscovery,
  type MarketExpiryFilter,
  type MarketRiskFilter
} from "@/components/market-data-provider";
import { PredictMarketChart } from "@/components/predict-market-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/src/lib/utils";
import type { MarketListItem } from "@/src/lib/types";

const MARKET_PAGE_SIZE = 4;

export function MarketsPage() {
  const [expiry, setExpiry] = useState<MarketExpiryFilter>("all");
  const [risk, setRisk] = useState<MarketRiskFilter>("all");
  const [page, setPage] = useState(1);
  const [selectedOracleId, setSelectedOracleId] = useState<string | null>(null);
  const { detail, error, loading, refresh, stale, ttlMs, updatedAt } = useMarketDiscovery({
    status: "active",
    asset: "BTC",
    expiry,
    risk,
    page,
    pageSize: MARKET_PAGE_SIZE,
    selectedOracleId
  });

  const markets = detail?.markets ?? [];
  const pagination = detail?.pagination;
  const selected = useMemo(() => {
    const manuallySelected = markets.find((market) => market.oracleId === selectedOracleId);
    const candidates = [detail?.selectedMarket, ...markets].filter((market): market is MarketListItem => Boolean(market));

    return manuallySelected ?? selectActionableMarket(candidates) ?? detail?.selectedMarket ?? markets[0] ?? null;
  }, [detail?.selectedMarket, markets, selectedOracleId]);

  return (
    <AppShell
      title="Predict market discovery"
      description="Browse active DeepBook Predict BTC oracles, preview price history, then open the selected market in the trade cockpit."
      meta={
        <>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn(loading && "animate-spin")} />
            {loading ? "Syncing" : "Refresh"}
          </Button>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {detail?.status.status ?? "Predict"}
          </Badge>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {pagination ? `${pagination.totalItems} markets` : `${markets.length} markets`}
          </Badge>
          <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
            {updatedAt ? `${stale ? "stale" : "updated"} ${formatAgo(updatedAt)}` : `${Math.round(ttlMs / 1_000)}s cadence`}
          </Badge>
        </>
      }
    >
      <div className="markets-grid grid gap-4 lg:grid-cols-[minmax(0,0.98fr)_minmax(420px,0.72fr)]">
        <section className="markets-list-column min-w-0 space-y-3">
          <Card>
            <CardContent className="grid gap-3 pt-5 md:grid-cols-3">
              <FilterSelect label="Asset" value="BTC" disabled>
                <option value="BTC">BTC</option>
              </FilterSelect>
              <FilterSelect
                label="Expiry"
                value={expiry}
                onChange={(value) => {
                  setExpiry(value as MarketExpiryFilter);
                  resetPaging();
                }}
              >
                <option value="all">all</option>
                <option value="next">next</option>
                <option value="today">today</option>
                <option value="this_week">this week</option>
              </FilterSelect>
              <FilterSelect
                label="Risk"
                value={risk}
                onChange={(value) => {
                  setRisk(value as MarketRiskFilter);
                  resetPaging();
                }}
              >
                <option value="all">all</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="blocked">blocked</option>
                <option value="unknown">unknown</option>
              </FilterSelect>
            </CardContent>
          </Card>

          {error ? (
            <Card className="border-destructive/35 bg-destructive/10">
              <CardContent className="flex items-center gap-3 pt-5 text-sm text-destructive-foreground">
                <AlertTriangle className="h-4 w-4" />
                {error}
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-3 xl:grid-cols-2">
            {markets.map((market) => (
              <MarketCard
                key={market.oracleId}
                market={market}
                selected={market.oracleId === selected?.oracleId}
                onSelect={() => setSelectedOracleId(market.oracleId)}
              />
            ))}
          </div>

          <PaginationBar
            pagination={pagination}
            visibleCount={markets.length}
            risk={risk}
            loading={loading}
            onPrevious={() => {
              if (pagination?.hasPreviousPage) {
                setSelectedOracleId(null);
                setPage(pagination.page - 1);
              }
            }}
            onNext={() => {
              if (pagination?.hasNextPage) {
                setSelectedOracleId(null);
                setPage(pagination.page + 1);
              }
            }}
          />

          {!loading && markets.length === 0 ? (
            <Card>
              <CardContent className="flex items-center gap-3 pt-5 text-sm text-muted-foreground">
                <Search className="h-4 w-4" />
                No Predict markets matched the current filters.
              </CardContent>
            </Card>
          ) : null}
        </section>

        <aside className="markets-detail-column space-y-3">
          <MarketChartPanel market={selected} loading={loading} />
        </aside>
      </div>
    </AppShell>
  );

  function resetPaging() {
    setPage(1);
    setSelectedOracleId(null);
  }
}

function FilterSelect({
  label,
  value,
  onChange,
  disabled,
  children
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
      <select
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-55"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function MarketCard({
  market,
  selected,
  onSelect
}: {
  market: MarketListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const tradeHref = tradeHrefForMarket(market);

  return (
    <article
      className={cn(
        "rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent/45",
        selected && "border-foreground/45 bg-accent/50"
      )}
    >
      <button type="button" className="block w-full text-left" onClick={onSelect}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">BTC expiry market</p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{shortAddress(market.oracleId)}</p>
          </div>
          <RiskBadge level={market.riskLevel} />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Metric label="Expiry" value={formatTime(market.expiry)} />
          <Metric label="Time left" value={formatDuration(market.timeToExpiryMs)} />
          <Metric label="Spot" value={formatUsd(market.spot)} />
          <Metric label="Forward" value={formatUsd(market.forward)} />
          <Metric label="Strike" value={formatUsd(market.selectedStrike)} />
          <Metric label="Vault use" value={`${(market.vaultUtilization * 100).toFixed(2)}%`} />
        </div>

        <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">{market.guardianSummary}</p>
      </button>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">Preview chart here, execute in Trade.</span>
        <Button asChild size="sm" variant="outline" className="h-8 shrink-0">
          <Link href={tradeHref as Route}>
            Open market
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </article>
  );
}

function selectActionableMarket(markets: MarketListItem[]) {
  const now = Date.now();

  return (
    markets.find((market) => market.status === "active" && market.expiry > now && market.riskLevel !== "blocked") ??
    markets.find((market) => market.status === "active" && market.expiry > now) ??
    null
  );
}

function MarketChartPanel({ market, loading }: { market: MarketListItem | null; loading: boolean }) {
  if (loading && !market) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 pt-5 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Loading Predict markets.
        </CardContent>
      </Card>
    );
  }

  if (!market) {
    return (
      <Card>
        <CardContent className="pt-5 text-sm text-muted-foreground">Select an active market to preview its price history.</CardContent>
      </Card>
    );
  }

  return <PredictMarketChart oracleId={market.oracleId} strike={market.selectedStrike} />;
}

function PaginationBar({
  pagination,
  visibleCount,
  risk,
  loading,
  onPrevious,
  onNext
}: {
  pagination?: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  visibleCount: number;
  risk: MarketRiskFilter;
  loading: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (!pagination || pagination.totalItems === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          Page {pagination.page} / {pagination.totalPages}
        </span>
        <span className="ml-2">
          {visibleCount} visible, {pagination.totalItems} matching status/expiry
        </span>
        {risk !== "all" ? (
          <span className="ml-2 text-amber-200">risk filter is scoped to this loaded page</span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button size="sm" variant="outline" disabled={loading || !pagination.hasPreviousPage} onClick={onPrevious}>
          <ChevronLeft />
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={loading || !pagination.hasNextPage} onClick={onNext}>
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function RiskBadge({ level }: { level: MarketListItem["riskLevel"] }) {
  return (
    <Badge variant="outline" className={cn("border-border text-xs capitalize", riskColor(level))}>
      {level}
    </Badge>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function riskColor(level: MarketListItem["riskLevel"]) {
  switch (level) {
    case "low":
      return "text-emerald-200";
    case "medium":
      return "text-zinc-200";
    case "high":
      return "text-amber-200";
    case "blocked":
      return "text-destructive";
    case "unknown":
      return "text-muted-foreground";
  }
}

function formatUsd(value: number | null) {
  return value === null ? "--" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(valueMs: number | null) {
  if (valueMs === null || valueMs <= 0) {
    return "--";
  }

  const minutes = Math.round(valueMs / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.round(hours / 24)}d`;
}

function formatAgo(value: number) {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000));

  if (seconds < 2) {
    return "now";
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  return `${Math.round(seconds / 60)}m ago`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function tradeHrefForMarket(market: MarketListItem) {
  const params = new URLSearchParams({
    oracleId: market.oracleId
  });

  if (market.selectedStrike !== null) {
    params.set("strike", String(market.selectedStrike));
  }

  return `/trade?${params.toString()}`;
}
