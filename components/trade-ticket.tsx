"use client";

import { ArrowDown, ArrowUp, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PredictDirection, PredictMarketSnapshot } from "@/src/lib/types";

type TicketMode = "buy" | "sell";

export function TradeTicket({
  market,
  initialOracleId,
  initialStrike,
  onGenerate
}: {
  market: PredictMarketSnapshot | null;
  initialOracleId?: string | null;
  initialStrike?: number | null;
  onGenerate: (intent: string) => void;
}) {
  const [direction, setDirection] = useState<PredictDirection>("up");
  const [mode, setMode] = useState<TicketMode>("buy");
  const [amount, setAmount] = useState("0.01");
  const [strike, setStrike] = useState(initialStrike ? String(initialStrike) : "");
  const [strikeEdited, setStrikeEdited] = useState(false);

  useEffect(() => {
    if (strikeEdited) {
      return;
    }

    const nextStrike = market?.metrics.selectedStrike ?? initialStrike;

    if (typeof nextStrike === "number" && Number.isFinite(nextStrike)) {
      setStrike(String(nextStrike));
    }
  }, [initialStrike, market?.metrics.selectedStrike, strikeEdited]);

  const oracleId = market?.oracle.oracle_id ?? initialOracleId ?? undefined;
  const canRedeem = Boolean(oracleId);
  const canPrepare = Boolean(oracleId && amount.trim());

  return (
    <Card className="glass-line">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm">Trade Ticket</CardTitle>
            <CardDescription className="text-xs">Open or close a Predict position.</CardDescription>
          </div>
          <Badge variant="outline" className="shrink-0 border-border text-xs text-muted-foreground">
            {oracleId ? shortAddress(oracleId) : "next oracle"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={direction === "up" ? "default" : "outline"}
            onClick={() => setDirection("up")}
          >
            <ArrowUp />
            UP
          </Button>
          <Button
            type="button"
            variant={direction === "down" ? "default" : "outline"}
            onClick={() => setDirection("down")}
          >
            <ArrowDown />
            DOWN
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(["buy", "sell"] as const).map((ticketMode) => (
            <Button
              key={ticketMode}
              type="button"
              variant={mode === ticketMode ? "default" : "outline"}
              disabled={ticketMode === "sell" && !canRedeem}
              onClick={() => setMode(ticketMode)}
            >
              {ticketMode === "buy" ? "BUY" : "CLOSE"}
            </Button>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Amount</span>
            <input
              className="h-10 w-full rounded-md border border-input bg-background/70 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Strike</span>
            <input
              className="h-10 w-full rounded-md border border-input bg-background/70 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              inputMode="decimal"
              value={strike}
              onChange={(event) => {
                setStrikeEdited(true);
                setStrike(event.target.value);
              }}
              placeholder="auto"
            />
          </label>
        </div>

        <Button className="h-10 w-full" disabled={!canPrepare} onClick={() => onGenerate(buildIntent(mode, direction, amount, strike, oracleId))}>
          <Play />
          {oracleId ? "Prepare trade" : "Waiting for oracle"}
        </Button>
      </CardContent>
    </Card>
  );
}

function buildIntent(
  mode: TicketMode,
  direction: PredictDirection,
  amount: string,
  strike: string,
  oracleId?: string
) {
  if (mode === "sell") {
    return oracleId
      ? `Sell or redeem my BTC Predict position using oracle ${oracleId}`
      : "Sell or redeem my BTC Predict position";
  }

  const directionText = direction === "up" ? "UP" : "DOWN";
  const oracleText = oracleId ? ` using oracle ${oracleId}` : " on the next active DeepBook Predict oracle";
  const strikeText = strike.trim() ? ` at strike ${strike.trim()}` : "";

  return `Buy ${amount.trim() || "0.01"} DUSDC BTC ${directionText}${strikeText}${oracleText}`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
