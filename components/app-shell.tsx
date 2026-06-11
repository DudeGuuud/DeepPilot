"use client";

import type { ReactNode } from "react";

import { TopNav } from "@/components/top-nav";

type AppShellProps = {
  title: string;
  description: string;
  meta?: ReactNode;
  children: ReactNode;
};

export function AppShell({ title, description, meta, children }: AppShellProps) {
  return (
    <main className="min-h-screen overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <TopNav />
        <section className="flex flex-col gap-3 py-1 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">DeepBook Predict</p>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          {meta ? <div className="flex shrink-0 flex-wrap items-center gap-2">{meta}</div> : null}
        </section>
        {children}
      </div>
    </main>
  );
}
