import { NextResponse } from "next/server";

import { telegramWebhookSecret } from "@/src/lib/deep-pilot-config";
import { redisDelete, redisSet, redisSetIfAbsent } from "@/src/lib/redis-store";
import { handleTelegramUpdate } from "@/src/lib/telegram-bot";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const expected = telegramWebhookSecret();

  if (!expected) {
    return NextResponse.json({ error: "Telegram webhook secret is not configured." }, { status: 503 });
  }

  if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return NextResponse.json({ error: "Invalid Telegram webhook secret." }, { status: 401 });
  }

  const update = await request.json();
  const updateId = getTelegramUpdateId(update);
  const idempotencyKey = updateId === null ? null : `telegram:update:${updateId}`;

  if (idempotencyKey) {
    const started = await redisSetIfAbsent(idempotencyKey, "processing", 10 * 60);

    if (!started) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  try {
    await handleTelegramUpdate(update);
    if (idempotencyKey) {
      await redisSet(idempotencyKey, "processed", 60 * 60 * 24);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (idempotencyKey) {
      await redisDelete(idempotencyKey);
    }

    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Telegram webhook failed."
    }, { status: 500 });
  }
}

function getTelegramUpdateId(update: unknown) {
  if (!update || typeof update !== "object" || !("update_id" in update)) {
    return null;
  }

  const value = (update as { update_id?: unknown }).update_id;

  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}
