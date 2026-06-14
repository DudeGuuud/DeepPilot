export function explainWalletExecutionError(error: unknown) {
  const message = extractErrorMessage(error);

  if (/incorrect password/i.test(message)) {
    return "Slush rejected signing with \"Incorrect password\" before broadcasting the transaction. Lock and unlock Slush directly, disconnect and reconnect DeepPilot, confirm the selected account/network, then retry. If it repeats, restart or update the extension.";
  }

  if (/\[object Error\]/i.test(message) || /insufficient.*gas|gas.*insufficient|no valid gas|unable to select gas|No coins found/i.test(message)) {
    return "Need testnet SUI for gas. Keep some SUI in the connected wallet so Sui can auto-select gas coins and estimate the transaction budget.";
  }

  if (/InsufficientCoinBalance|insufficient.*coin|not enough.*DUSDC|balance/i.test(message) && /DUSDC|coin|balance/i.test(message)) {
    return "Trading Balance is insufficient. Add DUSDC to your PredictManager in Profile before opening this position.";
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
