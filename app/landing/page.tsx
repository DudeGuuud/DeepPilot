import type { Metadata } from "next";

import { LandingPage } from "@/components/landing-page";

export const metadata: Metadata = {
  title: "DeepPilot | Prediction Market Reviews",
  description: "DeepPilot helps users review BTC prediction markets with RiskOps checks, Telegram handoff, wallet preflight, and receipt tracking."
};

export default function LandingRoute() {
  return <LandingPage />;
}
