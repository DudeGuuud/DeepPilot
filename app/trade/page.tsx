import { Suspense } from "react";

import DeepPilotTerminalShell from "@/components/deep-pilot-terminal-shell";

export default function TradePage() {
  return (
    <Suspense fallback={null}>
      <DeepPilotTerminalShell />
    </Suspense>
  );
}
