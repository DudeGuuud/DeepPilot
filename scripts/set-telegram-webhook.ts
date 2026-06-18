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
    allowed_updates: ["message", "callback_query"]
  })
});
const payload = await response.json();

if (!response.ok || !payload.ok) {
  console.error(payload);
  process.exit(1);
}

const commandsResponse = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    commands: [
      { command: "start", description: "Start DeepPilot and show shortcuts" },
      { command: "login", description: "Connect your Sui wallet" },
      { command: "ideas", description: "Show prompt examples" },
      { command: "profile", description: "Show profile, plan, and quota" },
      { command: "markets", description: "Show active BTC Predict markets" },
      { command: "news", description: "Summarize BTC news and risks" },
      { command: "trade", description: "Create a single trade review" },
      { command: "strategy", description: "Create a multi-leg strategy review" },
      { command: "quota", description: "Show daily AI quota" },
      { command: "plans", description: "Show Standard, Pro, and Max plans" },
      { command: "help", description: "Show all commands" }
    ]
  })
});
const commandsPayload = await commandsResponse.json();

if (!commandsResponse.ok || !commandsPayload.ok) {
  console.error(commandsPayload);
  process.exit(1);
}

console.log(`Telegram webhook set: ${webhookUrl}`);
console.log("Telegram command menu set.");

export {};
