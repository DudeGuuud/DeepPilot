"use client";

import type { Time, UTCTimestamp } from "lightweight-charts";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PredictChartPoint, PredictOracleHistory } from "@/src/lib/types";

const CHART_HEIGHT = 206;
const ORACLE_HISTORY_REFRESH_MS = 3_000;

export function PredictMarketChart({
  oracleId,
  strike,
  strikeLabel = "strike"
}: {
  oracleId?: string;
  strike?: number | null;
  strikeLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [history, setHistory] = useState<PredictOracleHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserTimeZone, setBrowserTimeZone] = useState("UTC");

  useEffect(() => {
    setBrowserTimeZone(resolveBrowserTimeZone());
  }, []);

  useEffect(() => {
    if (!oracleId) {
      setHistory(null);
      return;
    }

    let cancelled = false;
    let hasHistory = false;
    let inFlight = false;

    async function loadHistory(showSpinner: boolean) {
      if (inFlight) {
        return;
      }

      inFlight = true;

      if (showSpinner) {
        setLoading(true);
      }

      try {
        const response = await fetch(`/api/oracles/${oracleId}/history`, {
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error("Oracle history unavailable.");
        }

        const payload = await response.json() as PredictOracleHistory;

        if (!cancelled) {
          hasHistory = true;
          setHistory(payload);
          setError(null);
        }
      } catch (chartError) {
        if (!cancelled && !hasHistory) {
          setError(chartError instanceof Error ? chartError.message : "Oracle history unavailable.");
          setHistory(null);
        }
      } finally {
        if (!cancelled && showSpinner) {
          setLoading(false);
        }
        inFlight = false;
      }
    }

    void loadHistory(true);
    const intervalId = window.setInterval(() => {
      void loadHistory(false);
    }, ORACLE_HISTORY_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [oracleId]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container || !history?.points.length) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | null = null;
    const tickTimeFormatter = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: browserTimeZone
    });
    const labelTimeFormatter = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: browserTimeZone,
      timeZoneName: "short"
    });

    void import("lightweight-charts").then(({ createChart, LineSeries, LineStyle }) => {
      if (disposed) {
        return;
      }

      const chart = createChart(container, {
        width: Math.max(320, Math.floor(container.clientWidth)),
        height: CHART_HEIGHT,
        layout: {
          background: { color: "transparent" },
          textColor: "#a1a1aa"
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.06)" },
          horzLines: { color: "rgba(255,255,255,0.06)" }
        },
        rightPriceScale: {
          borderColor: "rgba(255,255,255,0.12)"
        },
        localization: {
          locale: navigator.language,
          timeFormatter: (time: Time) => formatChartTime(time, labelTimeFormatter)
        },
        timeScale: {
          borderColor: "rgba(255,255,255,0.12)",
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: Time) => formatChartTime(time, tickTimeFormatter)
        }
      });
      const spotData = toLineData(history.points, (point) => point.spot);
      const forwardData = toLineData(history.points, (point) => point.forward);
      const spotSeries = chart.addSeries(LineSeries, {
        color: "#fafafa",
        lineWidth: 2,
        priceLineVisible: false
      });
      const forwardSeries = chart.addSeries(LineSeries, {
        color: "#93c5fd",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false
      });

      spotSeries.setData(spotData);
      forwardSeries.setData(forwardData);

      if (typeof strike === "number" && Number.isFinite(strike)) {
        spotSeries.createPriceLine({
          price: strike,
          color: "#fbbf24",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: strikeLabel
        });
      }

      chart.timeScale().fitContent();
      const observer = new ResizeObserver(([entry]) => {
        chart.applyOptions({ width: Math.floor(entry.contentRect.width) });
      });
      observer.observe(container);

      cleanup = () => {
        observer.disconnect();
        chart.remove();
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [browserTimeZone, history, strike]);

  return (
    <Card className="glass-line">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Price History</CardTitle>
            <CardDescription className="text-xs">{oracleId ? shortAddress(oracleId) : "Select an oracle"}</CardDescription>
          </div>
          {loading ? <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {!oracleId ? (
          <div className="rounded-md border border-border bg-background/60 p-3 text-sm text-muted-foreground">
            Choose a Predict oracle to load spot and forward history.
          </div>
        ) : loading && !history ? (
          <div className="flex h-[206px] items-center justify-center rounded-md border border-border bg-background/60 text-sm text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            Loading oracle history.
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : !history?.points.length ? (
          <div className="rounded-md border border-border bg-background/60 p-3 text-sm text-muted-foreground">
            No price history returned for this oracle.
          </div>
        ) : (
          <>
            <div ref={containerRef} className="h-[206px] w-full" />
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>Spot</span>
              <span className="text-blue-200">Forward</span>
              <span>{browserTimeZone}</span>
              {history?.capped ? <span>bounded server preview</span> : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function toLineData(points: PredictChartPoint[], selectValue: (point: PredictChartPoint) => number | null) {
  const bySecond = new Map<number, number>();

  for (const point of points) {
    const value = selectValue(point);

    if (typeof value === "number" && Number.isFinite(value)) {
      bySecond.set(Math.floor(point.time / 1_000), value);
    }
  }

  return Array.from(bySecond, ([time, value]) => ({
    time: time as UTCTimestamp,
    value
  }));
}

function resolveBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatChartTime(time: Time, formatter: Intl.DateTimeFormat) {
  return formatter.format(chartTimeToDate(time));
}

function chartTimeToDate(time: Time) {
  if (typeof time === "number") {
    return new Date(time * 1_000);
  }

  if (typeof time === "string") {
    return new Date(`${time}T00:00:00.000Z`);
  }

  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}
