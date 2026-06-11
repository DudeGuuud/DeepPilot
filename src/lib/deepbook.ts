import { deepbook } from "@mysten/deepbook-v3";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import type { DeepBookQuote, ParsedIntent } from "./types";

const DEVNET_GRPC_URL = "https://fullnode.devnet.sui.io:443";
const DEMO_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000dee";

export function createDeepBookClientPreview(address = DEMO_ADDRESS) {
  const client = new SuiGrpcClient({
    network: "devnet",
    baseUrl: DEVNET_GRPC_URL
  }).$extend(
    deepbook({
      address,
      name: "deepbook"
    })
  );

  return {
    network: client.network,
    transport: "SuiGrpcClient",
    extension: "client.$extend(deepbook(...))"
  };
}

export function getDeepBookQuote(intent: ParsedIntent): DeepBookQuote | null {
  if (intent.status !== "ready" || intent.action === "stablecoin_transfer") {
    return null;
  }

  const midPrice = 3.24;
  const spreadBps = intent.action === "deepbook_limit_order" ? 6 : 8;
  const bestBid = roundPrice(midPrice * (1 - spreadBps / 20_000));
  const bestAsk = roundPrice(midPrice * (1 + spreadBps / 20_000));
  const amount = Number(intent.amount);
  const orderSizeUsd = intent.amountType === "quote" ? amount : amount * midPrice;
  const visibleDepthUsd = 52_000;
  const sizeVsDepth = orderSizeUsd / visibleDepthUsd;
  const estimatedSlippageBps = Math.max(2, Math.round(sizeVsDepth * 10_000 + spreadBps / 2));
  const quoteAgeMs = orderSizeUsd > 10_000 ? 28_000 : 12_000;
  const quoteQuantityIn = intent.amountType === "quote" ? amount : amount * midPrice;
  const baseQuantityOut =
    intent.side === "buy"
      ? quoteQuantityIn / bestAsk * (1 - estimatedSlippageBps / 10_000)
      : amount;

  return {
    pair: `${intent.baseToken}/${intent.quoteToken}`,
    poolKey: `${intent.baseToken}_${intent.quoteToken}`,
    source: "mock_deepbook_v3_ready",
    baseToken: intent.baseToken,
    quoteToken: intent.quoteToken,
    midPrice,
    bestBid,
    bestAsk,
    spreadBps,
    estimatedSlippageBps,
    visibleDepthUsd,
    orderSizeUsd,
    quoteAgeMs,
    baseQuantityOut,
    quoteQuantityIn,
    bids: makeLevels(bestBid, false),
    asks: makeLevels(bestAsk, true),
    deepbookExtension: "@mysten/deepbook-v3 deepbook() client extension over SuiGrpcClient"
  };
}

function makeLevels(start: number, isAsk: boolean) {
  let total = 0;

  return [0, 1, 2, 3, 4].map((index) => {
    const size = [840, 1260, 1840, 2320, 3180][index];
    total += size;

    return {
      price: roundPrice(start * (1 + (isAsk ? index : -index) * 0.0012)),
      size,
      total
    };
  });
}

function roundPrice(value: number) {
  return Number(value.toFixed(4));
}

