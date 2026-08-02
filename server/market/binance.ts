import { CANDLE_MS, INTERVAL } from "@shared/market";

/** Binance USDⓈ-M Futures REST base URL. */
export const FAPI_BASE = "https://fapi.binance.com";

export type Kline = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  takerBuyBase: number;
};

type RawKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote asset volume
  number, // number of trades
  string, // taker buy base volume
  string, // taker buy quote volume
  string, // ignore
];

function toKline(raw: RawKline): Kline {
  return {
    openTime: raw[0],
    closeTime: raw[6],
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    quoteVolume: Number(raw[7]),
    trades: Number(raw[8]),
    takerBuyBase: Number(raw[9]),
  };
}

async function fapiFetch(path: string, params: Record<string, string | number>): Promise<unknown> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${FAPI_BASE}${path}?${qs}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "crypto-4h-dashboard/1.0" },
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`Binance ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      }
      return await res.json();
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error(`Binance request failed for ${path}: ${String(lastError)}`);
}

/**
 * Fetch 4H klines for a symbol. Binance returns candles whose openTime is
 * already aligned to UTC 4h boundaries. The final element may be the currently
 * forming (unclosed) candle, so callers must filter by close time.
 */
export async function fetchKlines(
  symbol: string,
  options: { startTime?: number; endTime?: number; limit?: number } = {},
): Promise<Kline[]> {
  const params: Record<string, string | number> = {
    symbol,
    interval: INTERVAL,
    limit: options.limit ?? 1500,
  };
  if (options.startTime !== undefined) params.startTime = options.startTime;
  if (options.endTime !== undefined) params.endTime = options.endTime;

  const data = (await fapiFetch("/fapi/v1/klines", params)) as RawKline[];
  return data.map(toKline);
}

/** Walk the full available history for a symbol, paging forward from listing. */
export async function fetchFullHistory(symbol: string, maxCandles = 6000): Promise<Kline[]> {
  const out: Kline[] = [];
  let startTime = 0;

  while (out.length < maxCandles) {
    const batch = await fetchKlines(symbol, { startTime, limit: 1500 });
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 1500) break;
    startTime = batch[batch.length - 1].openTime + 1;
  }

  // Deduplicate defensively and keep chronological order.
  const byTime = new Map<number, Kline>();
  for (const k of out) byTime.set(k.openTime, k);
  return Array.from(byTime.values()).sort((a, b) => a.openTime - b.openTime);
}

/** Only candles that have fully closed as of `now`. */
export function closedOnly(klines: Kline[], now = Date.now()): Kline[] {
  return klines.filter(k => k.openTime + CANDLE_MS <= now);
}

export type Ticker = { symbol: string; price: number };

/** Latest mark/last prices for the given symbols. */
export async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const data = (await fapiFetch("/fapi/v1/ticker/price", {})) as Array<{
    symbol: string;
    price: string;
  }>;
  const wanted = new Set(symbols);
  const out: Record<string, number> = {};
  for (const row of data) {
    if (wanted.has(row.symbol)) out[row.symbol] = Number(row.price);
  }
  return out;
}

/** 24h rolling stats used for the price change display. */
export async function fetch24hStats(
  symbols: string[],
): Promise<Record<string, { lastPrice: number; priceChangePercent: number; quoteVolume: number }>> {
  const data = (await fapiFetch("/fapi/v1/ticker/24hr", {})) as Array<{
    symbol: string;
    lastPrice: string;
    priceChangePercent: string;
    quoteVolume: string;
  }>;
  const wanted = new Set(symbols);
  const out: Record<string, { lastPrice: number; priceChangePercent: number; quoteVolume: number }> = {};
  for (const row of data) {
    if (wanted.has(row.symbol)) {
      out[row.symbol] = {
        lastPrice: Number(row.lastPrice),
        priceChangePercent: Number(row.priceChangePercent),
        quoteVolume: Number(row.quoteVolume),
      };
    }
  }
  return out;
}
