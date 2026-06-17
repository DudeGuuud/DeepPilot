import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import { Circle } from "lucide-react";

import { cn } from "@/src/lib/utils";

const navItems = [
  { href: "/landing", label: "Home" },
  { href: "/markets", label: "Markets" },
  { href: "/trade", label: "Trade" },
  { href: "/profile", label: "Profile" }
] as const;

type SiteHeaderProps = {
  activePath?: string | null;
  rightSlot?: ReactNode;
  fixed?: boolean;
};

export function SiteHeader({ activePath, rightSlot, fixed = false }: SiteHeaderProps) {
  return (
    <header
      className={cn(
        "border-b border-border bg-background/82 backdrop-blur",
        fixed ? "fixed inset-x-0 top-0 z-30" : "w-full"
      )}
    >
      <div className="mx-auto flex w-full max-w-[1580px] flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <Link href={"/landing" as Route} className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center border border-border bg-background">
              <Circle className="h-3 w-3 fill-white text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">DeepPilot</p>
              <p className="truncate text-sm font-semibold text-foreground">Prediction market reviews</p>
            </div>
          </Link>
          <div className="lg:hidden">{rightSlot}</div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            {navItems.map((item) => {
              const active = activePath === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href as Route}
                  className={cn(
                    "border-b border-transparent pb-1 transition-colors hover:border-foreground/40 hover:text-foreground",
                    active && "border-foreground text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="hidden lg:block">{rightSlot}</div>
        </div>
      </div>
    </header>
  );
}
