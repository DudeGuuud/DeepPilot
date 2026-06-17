import { Suspense } from "react";

import { TelegramLoginPage } from "@/components/telegram-login-page";

export default function TelegramLoginRoute() {
  return (
    <Suspense fallback={null}>
      <TelegramLoginPage />
    </Suspense>
  );
}
