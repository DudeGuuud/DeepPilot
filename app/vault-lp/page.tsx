import { Suspense } from "react";

import { VaultLpPage } from "@/components/vault-lp-page";

export default function VaultLpRoute() {
  return (
    <Suspense fallback={null}>
      <VaultLpPage />
    </Suspense>
  );
}
