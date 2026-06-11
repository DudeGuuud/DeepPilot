"use client";

import Link from "next/link";
import type { Route } from "next";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { BarChart3, Circle, ShieldCheck, UserRound } from "lucide-react";

import { cn } from "@/src/lib/utils";

const WalletStatus = dynamic(() => import("@/components/wallet-status").then((mod) => mod.WalletStatus), {
  ssr: false,
  loading: () => (
    <div className="inline-flex h-8 w-32 items-center rounded-md border border-border bg-card px-3 font-mono text-[11px] text-muted-foreground">
      wallet loading
    </div>
  )
});

const navItems = [
  { href: "/markets", label: "Markets", icon: BarChart3 },
  { href: "/trade", label: "Trade", icon: ShieldCheck },
  { href: "/profile", label: "Profile", icon: UserRound }
] as const;

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="flex flex-col gap-3 rounded-lg border border-border bg-card/80 px-3 py-3 shadow-sm sm:px-4 lg:flex-row lg:items-center lg:justify-between">
      <Link href={"/markets" as Route} className="flex min-w-0 items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-background">
          <Circle className="h-3 w-3 fill-white text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">DeepPilot</p>
          <p className="truncate text-sm font-semibold text-foreground">Predict RiskOps</p>
        </div>
      </Link>

      <nav className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background/60 p-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;

          return (
            <Link
              key={item.href}
              href={item.href as Route}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-sm px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                active && "bg-secondary text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <WalletStatus />
    </header>
  );
}
