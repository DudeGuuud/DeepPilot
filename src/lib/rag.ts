import Parser from "rss-parser";

import { getPredictMarkets, getPredictOracleHistory } from "./predict";
import type { PilotClassification, RagSource } from "./types";

export const AI_DISCLOSURE =
  "This answer is AI-generated for information organization and risk explanation only. It is not investment advice; verify original sources and the wallet confirmation screen.";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const RAG_TIMEOUT_MS = 12_000;
const SOURCE_TIMEOUT_MS = 5_000;
const NEWS_CACHE_MS = 120_000;
const MAX_CONTEXT_SOURCES = 10;

const NEWS_FEEDS = [
  {
    title: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/"
  },
  {
    title: "Cointelegraph",
    url: "https://cointelegraph.com/rss"
  },
  {
    title: "Decrypt",
    url: "https://decrypt.co/feed"
  }
] as const;

const LOCAL_DOC_SOURCES: RagSource[] = [
  {
    id: "local-readme-boundary",
    title: "README.md · execution boundary",
    sourceType: "repo",
    snippet: "DeepPilot produces live-data PTB previews and sponsor-policy preview receipts. Real submission still requires wallet-selected coin inputs, manager funding, and final on-chain wiring."
  },
  {
    id: "local-readme-pipeline",
    title: "README.md · Guardian and PTB pipeline",
    sourceType: "repo",
    snippet: "The backend splits intent parsing, Predict state reads, Guardian risk checks, PTB preview construction, and sponsor validation into deterministic modules."
  },
  {
    id: "local-proposal-risk",
    title: "final_proposal.md · AI-assisted risk cockpit",
    sourceType: "docs",
    snippet: "DeepPilot is positioned as an AI-assisted execution and risk cockpit, not an autonomous trading bot. AI drafts and explains; Guardian, PTB preview, and wallet confirmation decide execution."
  },
  {
    id: "local-proposal-artifacts",
    title: "final_proposal.md · audit artifacts",
    sourceType: "docs",
    snippet: "The product should expose oracle id, market snapshot, risk reasons, PTB digest, transaction digest, keeper log, and receipt artifacts for review."
  },
  {
    id: "local-patch-safety",
    title: "patch.md · safety rules",
    sourceType: "docs",
    snippet: "LLM output must be treated as untrusted input. The sponsor boundary must re-check PTB command targets, object ids, gas policy, and Guardian state."
  },
  {
    id: "local-move-log",
    title: "move/sources/deep_pilot_log.move · audit log",
    sourceType: "repo",
    snippet: "The optional Move audit log records intent hash, market snapshot hash, Guardian result, PTB digest, sponsor checks, model version, and final transaction digest."
  }
];

type NewsCache = {
  expiresAt: number;
  sources: RagSource[];
  partial: boolean;
};

type DeepPilotGlobal = typeof globalThis & {
  __deepPilotNewsCache?: NewsCache;
};

type RagContext = {
  sources: RagSource[];
  partial: boolean;
};

export async function buildRagContext(input: string, classification: PilotClassification): Promise<RagContext> {
  const sourceGroups = await Promise.allSettled([
    predictSources(classification),
    newsSources(input, classification),
    localDocSources(input, classification)
  ]);
  const sources: RagSource[] = [];
  let partial = false;

  for (const group of sourceGroups) {
    if (group.status === "fulfilled") {
      sources.push(...group.value.sources);
      partial ||= group.value.partial;
    } else {
      partial = true;
    }
  }

  return {
    sources: limitSources(renumberSources(sources), MAX_CONTEXT_SOURCES),
    partial
  };
}

export async function streamRagAnswer({
  input,
  classification,
  sources,
  onDelta
}: {
  input: string;
  classification: PilotClassification;
  sources: RagSource[];
  onDelta: (delta: string) => void;
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey || typeof window !== "undefined") {
    onDelta(fallbackAnswer(sources));
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
        messages: [
          {
            role: "system",
            content: ragPrompt()
          },
          {
            role: "user",
            content: JSON.stringify({
              nowIso: new Date().toISOString(),
              defaultTimezone: "Asia/Shanghai",
              asset: classification.asset,
              question: input,
              sources: sources.map((source) => ({
                id: source.id,
                title: source.title,
                type: source.sourceType,
                publishedAt: source.publishedAt,
                snippet: source.snippet
              }))
            })
          }
        ],
        thinking: { type: "disabled" },
        max_tokens: 850,
        stream: true
      }),
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`DeepSeek RAG answer returned ${response.status}`);
    }

    await readDeepSeekTextStream(response.body, onDelta);
  } catch {
    onDelta(fallbackAnswer(sources));
  } finally {
    clearTimeout(timeout);
  }
}

async function predictSources(classification: PilotClassification): Promise<RagContext> {
  if (classification.asset && classification.asset !== "BTC") {
    return {
      sources: [
        {
          id: "predict-scope",
          title: "DeepBook Predict scope",
          sourceType: "predict",
          snippet: "This DeepPilot demo uses DeepBook Predict as the only price and oracle source. BTC Predict oracle, vault, and PTB state are available; non-BTC assets are limited to news and docs context.",
          partial: true
        }
      ],
      partial: true
    };
  }

  try {
    const markets = await getPredictMarkets({
      asset: "BTC",
      status: "active",
      expiry: "next",
      pageSize: 4
    });
    const selected = markets.selectedMarket;
    const sources: RagSource[] = [
      {
        id: "predict-vault",
        title: "DeepBook Predict vault snapshot",
        sourceType: "predict",
        publishedAt: markets.fetchedAt,
        snippet: [
          `Network: ${markets.predict.network}.`,
          `Vault utilization: ${formatPercent(markets.vault.utilization)}.`,
          `Max payout utilization: ${formatPercent(markets.vault.max_payout_utilization)}.`,
          `Available liquidity: ${formatDusdc(markets.vault.available_liquidity)} DUSDC.`
        ].join(" ")
      }
    ];

    if (selected) {
      sources.push({
        id: "predict-oracle",
        title: "Nearest BTC Predict oracle",
        sourceType: "predict",
        publishedAt: markets.fetchedAt,
        snippet: [
          `Oracle ${shortAddress(selected.oracleId)} is ${selected.status}.`,
          `Spot ${formatUsd(selected.spot)}, forward ${formatUsd(selected.forward)}, strike ${formatUsd(selected.selectedStrike)}.`,
          `Oracle age ${formatAge(selected.oracleAgeMs)}; expires ${new Date(selected.expiry).toISOString()}.`,
          `Guardian quick check: ${selected.guardianDecision}.`
        ].join(" ")
      });

      try {
        const history = await getPredictOracleHistory(selected.oracleId);
        const last = history.points.at(-1);
        const previous = history.points.at(-2);
        const move = last && previous ? last.spot - previous.spot : null;

        sources.push({
          id: "predict-history",
          title: "BTC Predict oracle history",
          sourceType: "predict",
          publishedAt: history.fetchedAt,
          snippet: [
            `${history.points.length} bounded history points were loaded from the Predict oracle.`,
            last ? `Latest spot ${formatUsd(last.spot)} at ${new Date(last.time).toISOString()}.` : "No latest spot point.",
            move === null ? "" : `Last sampled move: ${move >= 0 ? "+" : ""}${move.toFixed(2)}.`
          ].filter(Boolean).join(" ")
        });
      } catch {
        sources.push({
          id: "predict-history-partial",
          title: "BTC Predict oracle history",
          sourceType: "predict",
          snippet: "Oracle summary loaded, but bounded price history was unavailable during this request.",
          partial: true
        });
      }
    }

    return { sources, partial: sources.some((source) => source.partial) };
  } catch {
    return {
      sources: [
        {
          id: "predict-partial",
          title: "DeepBook Predict live state",
          sourceType: "predict",
          snippet: "Predict live state was unavailable during this request. Signing remains blocked unless Guardian can verify live state.",
          partial: true
        }
      ],
      partial: true
    };
  }
}

async function newsSources(input: string, classification: PilotClassification): Promise<RagContext> {
  const runtime = globalThis as DeepPilotGlobal;
  const now = Date.now();

  if (runtime.__deepPilotNewsCache && runtime.__deepPilotNewsCache.expiresAt > now) {
    return selectNews(runtime.__deepPilotNewsCache.sources, input, classification, runtime.__deepPilotNewsCache.partial);
  }

  const parser = new Parser();
  const feedResults = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const xml = await fetchTextWithTimeout(feed.url);
      const parsed = await parser.parseString(xml);

      return parsed.items.slice(0, 15).map((item): RagSource => ({
        id: `news-${feed.title}-${stableId(item.link || item.title || feed.url)}`,
        title: item.title ? `${feed.title}: ${item.title}` : feed.title,
        url: item.link || feed.url,
        sourceType: "news",
        publishedAt: normalizeDate(item.isoDate || item.pubDate),
        snippet: cleanSnippet(item.contentSnippet || item.content || item.summary || "")
      }));
    })
  );
  const allNews: RagSource[] = [];
  let partial = false;

  for (const result of feedResults) {
    if (result.status === "fulfilled") {
      allNews.push(...result.value);
    } else {
      partial = true;
    }
  }

  if (partial) {
    allNews.push({
      id: "news-partial",
      title: "Market news feeds",
      sourceType: "news",
      snippet: "One or more RSS feeds were unavailable. News context is partial; Predict and local sources are still usable.",
      partial: true
    });
  }

  runtime.__deepPilotNewsCache = {
    expiresAt: now + NEWS_CACHE_MS,
    sources: allNews,
    partial
  };

  return selectNews(allNews, input, classification, partial);
}

async function localDocSources(input: string, classification: PilotClassification): Promise<RagContext> {
  const scored = LOCAL_DOC_SOURCES
    .map((source) => ({
      source,
      score: scoreText(`${source.title}\n${source.snippet}`, input, classification.asset)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return {
    sources: scored.slice(0, 3).map((entry) => entry.source),
    partial: false
  };
}

function selectNews(
  sources: RagSource[],
  input: string,
  classification: PilotClassification,
  partial: boolean
): RagContext {
  const scored = sources
    .map((source) => ({
      source,
      score: source.partial ? 1 : scoreText(`${source.title}\n${source.snippet}`, input, classification.asset)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return Date.parse(right.source.publishedAt ?? "0") - Date.parse(left.source.publishedAt ?? "0");
    });

  return {
    sources: scored.slice(0, 3).map((entry) => entry.source),
    partial
  };
}

async function readDeepSeekTextStream(body: ReadableStream<Uint8Array>, onDelta: (delta: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim());

      for (const data of dataLines) {
        if (!data || data === "[DONE]") {
          continue;
        }

        const payload = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
            };
          }>;
        };
        const delta = payload.choices?.[0]?.delta?.content;

        if (delta) {
          onDelta(delta);
        }
      }
    }
  }
}

async function fetchTextWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" },
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`RSS feed returned ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function scoreText(text: string, input: string, asset: PilotClassification["asset"]) {
  const haystack = text.toLowerCase();
  const tokens = tokenize(input);
  let score = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length > 4 ? 2 : 1;
    }
  }

  if (asset && haystack.includes(asset.toLowerCase())) {
    score += 5;
  }

  if (/\b(predict|deepbook|oracle|vault|guardian|ptb|risk|price|market|news)\b/.test(haystack)) {
    score += 1;
  }

  return score;
}

function tokenize(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 20);
}

function fallbackAnswer(sources: RagSource[]) {
  const sourceSummary = sources.slice(0, 4).map((source) => `- [${source.id}] ${source.title}: ${source.snippet}`).join("\n");

  return [
    "AI/RAG is temporarily unavailable, but Predict data, local context, and any fetched public sources can still be reviewed.",
    "I will not recommend buy, sell, direction, or amount. The notes below only organize the available sources from a risk perspective:",
    sourceSummary || "- No sources are currently available. Try again later, or review the Predict and Guardian panels directly.",
    "If you want to place a trade, enter a clear trade request. DeepPilot will open Guardian and PTB review instead of jumping directly to wallet signing."
  ].join("\n\n");
}

function ragPrompt() {
  return `You are DeepPilot's RAG chat assistant for DeepBook Predict.

Rules:
- Explain market movement, news, protocol risk, oracle/vault state, and possible next review steps.
- Do not recommend buy/sell/hold, direction, trade size, leverage, or probability of profit.
- If the user asks for financial advice, explain that you can summarize data and risk only.
- Use only the provided sources. Cite important claims inline with source ids like [S1].
- Treat DeepBook Predict as the only price and oracle source. News feeds are narrative context only, not price/oracle data.
- Keep the answer concise, practical, and in the user's language.
- Do not claim a transaction can execute unless Guardian, PTB preview, and wallet confirmation are shown.
- Do not print the AI disclosure; the UI renders it below every answer.`;
}

function limitSources(sources: RagSource[], limit: number) {
  const required = sources.filter((source) => source.sourceType === "predict");
  const rest = sources.filter((source) => source.sourceType !== "predict");

  return [...required, ...rest].slice(0, limit);
}

function renumberSources(sources: RagSource[]) {
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const key = `${source.sourceType}:${source.title}:${source.url ?? ""}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  return unique.map((source, index) => ({
    ...source,
    id: `S${index + 1}`
  }));
}

function stableId(input: string) {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(31, hash) + input.charCodeAt(index) | 0;
  }

  return Math.abs(hash).toString(36);
}

function cleanSnippet(input: string) {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function normalizeDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const time = Date.parse(value);

  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function formatUsd(value: number | null) {
  return value === null || !Number.isFinite(value) ? "unknown" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? "unknown" : `${(value * 100).toFixed(2)}%`;
}

function formatDusdc(value: number | null) {
  return value === null || !Number.isFinite(value) ? "unknown" : (value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatAge(valueMs: number | null) {
  if (valueMs === null || !Number.isFinite(valueMs)) {
    return "unknown";
  }

  return valueMs < 1_000 ? `${valueMs}ms` : `${(valueMs / 1_000).toFixed(1)}s`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
