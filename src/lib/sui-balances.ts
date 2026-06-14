export const SUI_COIN_TYPE = "0x2::sui::SUI";

const NORMALIZED_SUI_COIN_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

type BalanceClient = {
  getBalance(input: { owner: string; coinType?: string }): Promise<unknown>;
  listBalances?(input: { owner: string }): Promise<unknown>;
};

export async function readSuiBalanceRaw(client: BalanceClient, owner: string) {
  const balance = await client.getBalance({
    owner,
    coinType: SUI_COIN_TYPE
  });
  const raw = readCoinBalanceRaw(balance);

  if (raw > 0n) {
    return raw;
  }

  const listed = await client.listBalances?.({ owner });
  const listedRaw = readListedSuiBalanceRaw(listed);

  return listedRaw ?? raw;
}

export function readCoinBalanceRaw(value: unknown): bigint {
  if (!isRecord(value)) {
    return 0n;
  }

  const direct = readAmountFromKeys(value, ["totalBalance", "coinBalance"]);

  if (direct !== null) {
    return direct;
  }

  if (isRecord(value.balance)) {
    return readCoinBalanceRaw(value.balance);
  }

  return readAmountFromKeys(value, ["balance", "addressBalance"]) ?? 0n;
}

function readListedSuiBalanceRaw(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.balances)) {
    return null;
  }

  for (const balance of value.balances) {
    if (!isRecord(balance) || !isSuiCoinType(balance.coinType)) {
      continue;
    }

    return readCoinBalanceRaw(balance);
  }

  return null;
}

function readAmountFromKeys(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const amount = parseRawAmount(value[key]);

    if (amount !== null) {
      return amount;
    }
  }

  return null;
}

function parseRawAmount(value: unknown) {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }

  return null;
}

function isSuiCoinType(value: unknown) {
  if (typeof value !== "string") {
    return false;
  }

  return value === SUI_COIN_TYPE || value === NORMALIZED_SUI_COIN_TYPE || value.endsWith("::sui::SUI");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
