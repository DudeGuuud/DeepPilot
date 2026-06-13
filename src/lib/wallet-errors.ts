export function explainWalletExecutionError(error: unknown) {
  const message = extractErrorMessage(error);

  if (/incorrect password/i.test(message)) {
    return "Slush rejected signing with \"Incorrect password\" before broadcasting the transaction. Lock and unlock Slush directly, disconnect and reconnect DeepPilot, confirm the selected account/network, then retry. If it repeats, restart or update the extension.";
  }

  return message || "Wallet execution failed.";
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
