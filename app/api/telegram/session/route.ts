import { NextResponse } from "next/server";
import { z } from "zod";

import { appBaseUrl, getPlanConfig, profilePackageConfig } from "@/src/lib/deep-pilot-config";
import { parseJsonBody } from "@/src/lib/http";
import { verifyDeepPilotPlanChanged, verifyDeepPilotProfileCreated } from "@/src/lib/profile-execution";
import { decodeTelegramLoginToken } from "@/src/lib/telegram-auth";
import { getTelegramSession, upsertTelegramSession } from "@/src/lib/telegram-session";

export const runtime = "nodejs";

const updateSchema = z.object({
  token: z.string().trim().min(20),
  walletAddress: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  profileId: z.string().trim().regex(/^0x[a-fA-F0-9]{1,64}$/).optional(),
  profileCreateDigest: z.string().trim().min(32).max(128).optional(),
  plan: z.enum(["pro", "max"]).optional(),
  planDigest: z.string().trim().min(32).max(128).optional()
});

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Missing Telegram login token." }, { status: 400 });
  }

  try {
    const payload = decodeTelegramLoginToken(token);
    const session = await getTelegramSession(payload.telegramHash);

    return NextResponse.json({
      token: payload,
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
      error: error instanceof Error ? error.message : "Invalid Telegram login token."
    }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const body = await parseJsonBody(request, updateSchema);

  if (!body.success) {
    return NextResponse.json({ error: "Invalid Telegram session payload." }, { status: 400 });
  }

  try {
    const payload = decodeTelegramLoginToken(body.data.token);
    const existing = await getTelegramSession(payload.telegramHash);

    if (!existing?.walletAddress) {
      return NextResponse.json({ error: "Link a wallet before updating the Telegram session." }, { status: 409 });
    }

    const sessionWallet = existing.walletAddress;
    const linkedWallet = sessionWallet.toLowerCase();

    if (body.data.walletAddress && body.data.walletAddress.toLowerCase() !== linkedWallet) {
      return NextResponse.json({ error: "Telegram session wallet does not match the connected wallet." }, { status: 403 });
    }

    const profileConfig = profilePackageConfig();
    const nextSession: {
      profileId?: string;
      plan?: "pro" | "max";
    } = {};

    if (body.data.profileId) {
      if (!body.data.profileCreateDigest || !profileConfig.packageId) {
        return NextResponse.json({ error: "Profile create transaction proof is required." }, { status: 400 });
      }

      await verifyDeepPilotProfileCreated({
        packageId: profileConfig.packageId,
        digest: body.data.profileCreateDigest,
        profileId: body.data.profileId,
        owner: sessionWallet,
        telegramHash: payload.telegramHash
      });
      nextSession.profileId = body.data.profileId;
    }

    if (body.data.plan) {
      const profileId = body.data.profileId ?? existing.profileId;

      if (!body.data.planDigest || !profileConfig.packageId || !profileId) {
        return NextResponse.json({ error: "Plan subscription transaction proof is required." }, { status: 400 });
      }

      await verifyDeepPilotPlanChanged({
        packageId: profileConfig.packageId,
        digest: body.data.planDigest,
        profileId,
        owner: sessionWallet,
        plan: body.data.plan
      });
      nextSession.plan = body.data.plan;
    }

    const session = await upsertTelegramSession({
      telegramHash: payload.telegramHash,
      chatId: payload.chatId,
      walletAddress: sessionWallet,
      profileId: nextSession.profileId,
      plan: nextSession.plan,
      memoryNamespace: `telegram:${payload.telegramHash.slice(0, 16)}`
    });

    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Telegram session update failed."
    }, { status: 400 });
  }
}
