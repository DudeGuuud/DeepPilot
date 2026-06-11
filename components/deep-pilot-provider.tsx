"use client";

import { DAppKitProvider } from "@mysten/dapp-kit-react";

import { MarketDataProvider } from "@/components/market-data-provider";
import { Toaster } from "@/components/ui/toaster";
import { dAppKit } from "@/src/lib/dapp-kit";

export function DeepPilotProvider({ children }: { children: React.ReactNode }) {
  return (
    <DAppKitProvider dAppKit={dAppKit}>
      <MarketDataProvider>{children}</MarketDataProvider>
      <Toaster />
    </DAppKitProvider>
  );
}
