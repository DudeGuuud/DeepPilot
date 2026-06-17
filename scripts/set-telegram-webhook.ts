const appBaseUrl = process.env.APP_BASE_URL?.trim();
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

if (!appBaseUrl || !token || !secret) {
  console.error("Missing APP_BASE_URL, TELEGRAM_BOT_TOKEN, or TELEGRAM_WEBHOOK_SECRET.");
  process.exit(1);
}

const webhookUrl = `${appBaseUrl.replace(/\/$/, "")}/api/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message"]
  })
});
const payload = await response.json();

if (!response.ok || !payload.ok) {
  console.error(payload);
  process.exit(1);
}

console.log(`Telegram webhook set: ${webhookUrl}`);

export {};
