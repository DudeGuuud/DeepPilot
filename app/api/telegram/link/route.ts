import { NextResponse } from "next/server";
import { z } from "zod";

import { appBaseUrl, getPlanConfig, profilePackageConfig } from "@/src/lib/deep-pilot-config";
import { parseJsonBody } from "@/src/lib/http";
import { verifyTelegramWalletLink } from "@/src/lib/telegram-auth";
import { upsertTelegramSession } from "@/src/lib/telegram-session";

export const runtime = "nodejs";

const bodySchema = z.object({
  token: z.string().trim().min(20),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/),
  signature: z.string().trim().min(20)
});

export async function POST(request: Request) {
  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return NextResponse.json({ error: "Invalid Telegram link payload." }, { status: 400 });
  }

  try {
    const verified = await verifyTelegramWalletLink({
      token: body.data.token,
      walletAddress: body.data.walletAddress,
      signature: body.data.signature
    });
    const session = await upsertTelegramSession({
      telegramHash: verified.telegramHash,
      chatId: verified.chatId,
      walletAddress: verified.walletAddress,
      memoryNamespace: `telegram:${verified.telegramHash.slice(0, 16)}`
    });

    return NextResponse.json({
      session,
      linkHost: new URL(appBaseUrl()).host,
      profileConfig: profilePackageConfig(),
      plans: {
        standard: getPlanConfig("standard"),
        pro: getPlanConfig("pro"),
        max: getPlanConfig("max")
      }
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Telegram wallet link failed."
    }, { status: 400 });
  }
}
