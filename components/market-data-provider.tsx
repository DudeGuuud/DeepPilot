"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import type { MarketDiscoveryResult, MarketRiskLevel } from "@/src/lib/types";

export type MarketStatusFilter = "active" | "settled" | "all";
export type MarketExpiryFilter = "all" | "next" | "today" | "this_week";
export type MarketRiskFilter = MarketRiskLevel | "all";

export type MarketDiscoveryQuery = {
  status: MarketStatusFilter;
  asset: "BTC";
  expiry: MarketExpiryFilter;
  risk: MarketRiskFilter;
  page: number;
  pageSize: number;
  selectedOracleId?: string | null;
};

type MarketCacheRecord = {
  payload: MarketDiscoveryResult | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

type MarketDataContextValue = {
  records: Record<string, MarketCacheRecord>;
  ttlMs: number;
  loadMarketDiscovery: (query: MarketDiscoveryQuery, options?: { force?: boolean }) => Promise<MarketDiscoveryResult | null>;
};

const MARKET_DISCOVERY_TTL_MS = 20_000;
const MarketDataContext = createContext<MarketDataContextValue | null>(null);

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<Record<string, MarketCacheRecord>>({});
  const recordsRef = useRef(records);
  const inFlightRef = useRef(new Map<string, Promise<MarketDiscoveryResult | null>>());

  const patchRecord = useCallback((key: string, patch: (current?: MarketCacheRecord) => MarketCacheRecord) => {
    setRecords((currentRecords) => {
      const nextRecords = {
        ...currentRecords,
        [key]: patch(currentRecords[key])
      };
      recordsRef.current = nextRecords;

      return nextRecords;
    });
  }, []);

  const loadMarketDiscovery = useCallback(
    async (query: MarketDiscoveryQuery, options?: { force?: boolean }) => {
      const key = marketQueryKey(query);
      const cached = recordsRef.current[key];
      const now = Date.now();

      // Predict index data moves quickly, but discovery should not poll per render.
      if (!options?.force && cached?.payload && cached.updatedAt && now - cached.updatedAt < MARKET_DISCOVERY_TTL_MS) {
        return cached.payload;
      }

      const inFlight = inFlightRef.current.get(key);

      if (inFlight) {
        return inFlight;
      }

      patchRecord(key, (current) => ({
        payload: current?.payload ?? null,
        loading: true,
        error: null,
        updatedAt: current?.updatedAt ?? null
      }));

      const request = fetch(`/api/markets?${marketQueryParams(query).toString()}`)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error("Market discovery failed.");
          }

          return (await response.json()) as MarketDiscoveryResult;
        })
        .then((payload) => {
          patchRecord(key, () => ({
            payload,
            loading: false,
            error: null,
            updatedAt: Date.now()
          }));

          return payload;
        })
        .catch((error) => {
          patchRecord(key, (current) => ({
            payload: current?.payload ?? null,
            loading: false,
            error: error instanceof Error ? error.message : "Market discovery failed.",
            updatedAt: current?.updatedAt ?? null
          }));

          return null;
        })
        .finally(() => {
          inFlightRef.current.delete(key);
        });

      inFlightRef.current.set(key, request);

      return request;
    },
    [patchRecord]
  );

  const value = useMemo(
    () => ({
      records,
      ttlMs: MARKET_DISCOVERY_TTL_MS,
      loadMarketDiscovery
    }),
    [loadMarketDiscovery, records]
  );

  return <MarketDataContext.Provider value={value}>{children}</MarketDataContext.Provider>;
}

export function useMarketDiscovery(query: MarketDiscoveryQuery) {
  const context = useContext(MarketDataContext);

  if (!context) {
    throw new Error("useMarketDiscovery must be used inside MarketDataProvider.");
  }

  const { loadMarketDiscovery, records, ttlMs } = context;
  const stableQuery = useMemo(
    () => ({
      status: query.status,
      asset: query.asset,
      expiry: query.expiry,
      risk: query.risk,
      page: query.page,
      pageSize: query.pageSize,
      selectedOracleId: query.selectedOracleId
    }),
    [query.asset, query.expiry, query.page, query.pageSize, query.risk, query.selectedOracleId, query.status]
  );
  const key = useMemo(() => marketQueryKey(stableQuery), [stableQuery]);
  const record = records[key] ?? emptyRecord;

  useEffect(() => {
    void loadMarketDiscovery(stableQuery);
  }, [key, loadMarketDiscovery, stableQuery]);

  const refresh = useCallback(() => {
    void loadMarketDiscovery(stableQuery, { force: true });
  }, [loadMarketDiscovery, stableQuery]);

  return {
    detail: record.payload,
    loading: record.loading,
    error: record.error,
    updatedAt: record.updatedAt,
    stale: record.updatedAt ? Date.now() - record.updatedAt >= ttlMs : true,
    ttlMs,
    refresh
  };
}

const emptyRecord: MarketCacheRecord = {
  payload: null,
  loading: true,
  error: null,
  updatedAt: null
};

function marketQueryKey(query: MarketDiscoveryQuery) {
  return marketQueryParams(query).toString();
}

function marketQueryParams(query: MarketDiscoveryQuery) {
  const params = new URLSearchParams({
    status: query.status,
    asset: query.asset,
    expiry: query.expiry,
    risk: query.risk,
    page: String(query.page),
    pageSize: String(query.pageSize)
  });

  if (query.selectedOracleId) {
    params.set("selectedOracleId", query.selectedOracleId);
  }

  return params;
}
