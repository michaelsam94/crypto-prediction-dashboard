/**
 * Non-price data sources: funding rate, open interest, Fear & Greed.
 *
 * History availability differs sharply and dictates how each is used:
 *
 *  funding rate  - full history from listing (8h settlements). Feature-grade.
 *  Fear & Greed  - daily from 2018-02-01. Feature-grade.
 *  open interest - Binance's `openInterestHist` serves only the trailing 30
 *                  DAYS. Against a multi-year model window that is ~97%
 *                  missing, so it is collected forward on a schedule and left
 *                  out of the feature matrix until it spans enough history.
 *                  Backfilling it is not possible from this endpoint.
 */
import { CANDLE_MS } from "@shared/market";

const FAPI = "https://fapi.binance.com";
const FNG_API = "https://api.alternative.me/fng/";

async function getJson(url: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "crypto-4h-dashboard/1.0" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error(`request failed for ${url}: ${String(lastError)}`);
}

export type FundingPoint = { fundingTime: number; fundingRate: number; markPrice: number | null };

/** Page through the full funding history for a symbol, oldest first. */
export async function fetchFundingHistory(symbol: string): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  // NOT 0: Binance ignores startTime=0 and returns the most recent 500 rows,
  // which silently truncates the history to its last ~166 days. An explicit
  // pre-listing timestamp makes it page forward from the beginning.
  let startTime = 1_514_764_800_000; // 2018-01-01

  // Binance caps this response at 500 rows however large `limit` is, so paging
  // must continue until a page comes back EMPTY — treating a short page as the
  // end silently truncates the history to its most recent ~5 months.
  for (let page = 0; page < 60; page++) {
    const url = `${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&limit=1000`;
    const rows = (await getJson(url)) as Array<{
      fundingTime: number;
      fundingRate: string;
      markPrice: string;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const mark = Number(r.markPrice);
      out.push({
        fundingTime: r.fundingTime,
        fundingRate: Number(r.fundingRate),
        markPrice: Number.isFinite(mark) ? mark : null,
      });
    }
    const next = rows[rows.length - 1].fundingTime + 1;
    if (next <= startTime) break; // no forward progress; stop rather than loop
    startTime = next;
  }

  const byTime = new Map(out.map(p => [p.fundingTime, p]));
  return Array.from(byTime.values()).sort((a, b) => a.fundingTime - b.fundingTime);
}

export type OpenInterestPoint = { ts: number; openInterest: number; openInterestValue: number };

/**
 * Trailing open-interest window at the candle period.
 * Returns at most ~30 days — that is the endpoint's hard limit, not a bug.
 */
export async function fetchOpenInterest(symbol: string): Promise<OpenInterestPoint[]> {
  const url = `${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=500`;
  const rows = (await getJson(url)) as Array<{
    timestamp: number;
    sumOpenInterest: string;
    sumOpenInterestValue: string;
  }>;
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => ({
      ts: r.timestamp,
      openInterest: Number(r.sumOpenInterest),
      openInterestValue: Number(r.sumOpenInterestValue),
    }))
    .filter(r => Number.isFinite(r.openInterest))
    .sort((a, b) => a.ts - b.ts);
}

export type FearGreedPoint = { day: number; value: number; classification: string | null };

/** Full daily Fear & Greed history, oldest first. */
export async function fetchFearGreed(): Promise<FearGreedPoint[]> {
  const data = (await getJson(`${FNG_API}?limit=0&format=json`)) as {
    data?: Array<{ timestamp: string; value: string; value_classification?: string }>;
  };
  const rows = data.data ?? [];
  return rows
    .map(r => {
      const seconds = Number(r.timestamp);
      const value = Number(r.value);
      return {
        // Normalise to UTC midnight so the join to 4H bars is exact.
        day: Math.floor((seconds * 1000) / 86_400_000) * 86_400_000,
        value,
        classification: r.value_classification ?? null,
      };
    })
    .filter(r => Number.isFinite(r.day) && Number.isFinite(r.value))
    .sort((a, b) => a.day - b.day);
}

/**
 * Step-join an 8h funding series onto 4H bars.
 *
 * A bar may only use funding that had already SETTLED before the bar opened,
 * otherwise the feature leaks information from inside the bar being predicted.
 * Returns, per bar openTime: [rate in bps, 24h mean in bps, change vs previous].
 */
export function fundingFeaturesByOpenTime(
  barOpenTimes: number[],
  funding: FundingPoint[],
): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  if (funding.length === 0) return out;

  const sorted = [...funding].sort((a, b) => a.fundingTime - b.fundingTime);
  let cursor = 0;
  const seen: number[] = [];

  for (const openTime of [...barOpenTimes].sort((a, b) => a - b)) {
    while (cursor < sorted.length && sorted[cursor].fundingTime <= openTime) {
      seen.push(sorted[cursor].fundingRate);
      cursor++;
    }
    if (seen.length === 0) continue;
    const bps = (r: number) => r * 10_000;
    const last = seen[seen.length - 1];
    const window = seen.slice(-3);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const prev = seen.length >= 2 ? seen[seen.length - 2] : last;
    out.set(openTime, [bps(last), bps(mean), bps(last - prev)]);
  }
  return out;
}

/**
 * Step-join the daily Fear & Greed series onto 4H bars.
 *
 * The index for day D is published during day D, so a bar may only use the
 * PREVIOUS day's reading. Returns, per bar openTime:
 * [centred value, 1-day change, distance from its 7-day mean], all scaled to
 * roughly [-1, 1].
 */
export function fearGreedFeaturesByOpenTime(
  barOpenTimes: number[],
  series: FearGreedPoint[],
): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  if (series.length === 0) return out;

  const sorted = [...series].sort((a, b) => a.day - b.day);
  const byDay = new Map(sorted.map((p, i) => [p.day, i]));

  for (const openTime of barOpenTimes) {
    const barDay = Math.floor(openTime / 86_400_000) * 86_400_000;
    const prevDay = barDay - 86_400_000;
    const idx = byDay.get(prevDay);
    if (idx === undefined) continue;
    const value = sorted[idx].value;
    const prev = idx >= 1 ? sorted[idx - 1].value : value;
    const window = sorted.slice(Math.max(0, idx - 6), idx + 1);
    const mean = window.reduce((a, b) => a + b.value, 0) / window.length;
    out.set(openTime, [(value - 50) / 50, (value - prev) / 50, (value - mean) / 50]);
  }
  return out;
}

/** Bar period, re-exported so callers do not reach into shared config. */
export const BAR_MS = CANDLE_MS;
