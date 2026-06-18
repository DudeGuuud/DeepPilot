import type { Metadata } from "next";

import { LandingPage } from "@/components/landing-page";

export const metadata: Metadata = {
  title: "DeepPilot | Safer Natural-Language Prediction Trading",
  description: "Ask AI about markets, turn plain language into a reviewed DeepBook Predict trade, and sign only after quote, risk, balance, and wallet checks."
};

export default function LandingRoute() {
  return <LandingPage />;
}
