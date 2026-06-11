"use client";

import type { UTCTimestamp } from "lightweight-charts";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PredictChartPoint, PredictOracleHistory } from "@/src/lib/types";

export function PredictMarketChart({
  oracleId,
  strike
}: {
  oracleId?: string;
  strike?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [history, setHistory] = useState<PredictOracleHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!oracleId) {
      setHistory(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/oracles/${oracleId}/history`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Oracle history unavailable.");
        }

        return response.json() as Promise<PredictOracleHistory>;
      })
      .then((payload) => {
        if (!cancelled) {
          setHistory(payload);
        }
      })
      .catch((chartError) => {
        if (!cancelled) {
          setError(chartError instanceof Error ? chartError.message : "Oracle history unavailable.");
          setHistory(null);
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
  }, [oracleId]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container || !history?.points.length) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void import("lightweight-charts").then(({ createChart, LineSeries, LineStyle }) => {
      if (disposed) {
        return;
      }

      const chart = createChart(container, {
        width: Math.max(320, Math.floor(container.clientWidth)),
        height: 240,
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
        timeScale: {
          borderColor: "rgba(255,255,255,0.12)",
          timeVisible: true,
          secondsVisible: false
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
          title: "strike"
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
  }, [history, strike]);

  return (
    <Card className="glass-line">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Price History</CardTitle>
            <CardDescription>{oracleId ? shortAddress(oracleId) : "Select an oracle"}</CardDescription>
          </div>
          {loading ? <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </div>
      </CardHeader>
      <CardContent>
        {!oracleId ? (
          <div className="rounded-md border border-border bg-background/60 p-3 text-sm text-muted-foreground">
            Choose a Predict oracle to load spot and forward history.
          </div>
        ) : loading && !history ? (
          <div className="flex h-[240px] items-center justify-center rounded-md border border-border bg-background/60 text-sm text-muted-foreground">
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
            <div ref={containerRef} className="h-[240px] w-full" />
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>Spot</span>
              <span className="text-blue-200">Forward</span>
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
