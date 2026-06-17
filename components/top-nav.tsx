"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

import { SiteHeader } from "@/components/site-header";

const WalletStatus = dynamic(() => import("@/components/wallet-status").then((mod) => mod.WalletStatus), {
  ssr: false,
  loading: () => (
    <div className="inline-flex h-8 w-32 items-center rounded-md border border-border bg-card px-3 font-mono text-[11px] text-muted-foreground">
      wallet loading
    </div>
  )
});

export function TopNav() {
  const pathname = usePathname();

  return <SiteHeader activePath={pathname} rightSlot={<WalletStatus />} />;
}
