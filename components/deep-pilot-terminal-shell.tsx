"use client";

import dynamic from "next/dynamic";

const DeepPilotTerminal = dynamic(() => import("./deep-pilot-terminal"), {
  ssr: false,
  loading: () => (
    <main className="terminal-shell grid place-items-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 text-center text-card-foreground shadow-sm">
        <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">DeepPilot</p>
        <p className="mt-3 text-sm text-muted-foreground">Starting terminal</p>
      </div>
    </main>
  )
});

export default function DeepPilotTerminalShell() {
  return <DeepPilotTerminal />;
}
