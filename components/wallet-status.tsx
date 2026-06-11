"use client";

import { useCurrentAccount, useCurrentNetwork } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";

import { Badge } from "@/components/ui/badge";

export function WalletStatus() {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="h-8 border-border bg-card text-muted-foreground">
        {network ?? "testnet"}
      </Badge>
      <Badge variant="outline" className="h-8 border-border bg-card font-mono text-muted-foreground">
        {account ? shortAddress(account.address) : "wallet disconnected"}
      </Badge>
      <div className="h-8 rounded-md border border-border bg-card px-2 [&_button]:h-6 [&_button]:rounded-sm [&_button]:text-xs">
        <ConnectButton />
      </div>
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
