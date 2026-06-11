import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    ok: true,
    stack: {
      next: "16.2.9",
      react: "19.2.7",
      sui: "@mysten/sui 2.17.0",
      dappKit: "@mysten/dapp-kit-react 2.0.3",
      deepbook: "@mysten/deepbook-v3 1.4.1"
    }
  });
}

