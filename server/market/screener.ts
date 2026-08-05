/**
 * Perpetual-futures screener: liquid pairs that are not violently volatile.
 *
 * "Good volume, low volatility" is two rankings pulling in opposite directions
 * on crypto — the quietest perps are usually the thinnest. So this reports both
 * raw measures AND their ratio, and never collapses them into a single opaque
 * score without showing the parts.
 *
 * Cost control: `/fapi/v1/ticker/24hr` returns every symbol in ONE request, so
 * the volume ranking is cheap. Realised volatility needs klines per symbol, so
 * it is computed only for the top `DEPTH` names by volume, and the whole result
 * is cached — a full sweep of ~500 symbols per page load would be abusive and
 * far too slow.
 */
import { fetchKlines } from "./binance";

const FAPI = "https://fapi.binance.com";
const CACHE_MS = 15 * 60 * 1000;
/** How many of the most liquid symbols get a real volatility measurement. */
const DEPTH = 60;
/** 4H bars used for realised volatility (~30 days). */
const VOL_BARS = 180;
const BARS_PER_YEAR = 6 * 365;

export type ScreenerRow = {
  symbol: string;
  quoteAsset: string;
  /** 24h notional traded, USD. */
  quoteVolume24h: number;
  lastPrice: number;
  priceChange24hPct: number;
  /** (high-low)/vwap over 24h — a same-request volatility proxy. */
  range24hPct: number;
  /** Annualised realised volatility from 4H log returns, %. Null if unmeasured. */
  realisedVolPct: number | null;
  /** Mean |open→close| per 4H bar, %. Null if unmeasured. */
  meanBarMovePct: number | null;
  /** Volume per unit of volatility — higher is a better liquidity/calm trade-off. */
  volumePerVol: number | null;
  /** Already has a trained model on this dashboard. */
  tracked: boolean;
  measured: boolean;
};

type Raw24h = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
};

type ExchangeSymbol = {
  symbol: string;
  contractType: string;
  status: string;
  quoteAsset: string;
};

let cache: { at: number; rows: ScreenerRow[] } | null = null;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "crypto-4h-dashboard/1.0" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Annualised realised volatility and mean bar move from 4H closes. */
function volatilityOf(closes: number[], opens: number[]): {
  realisedVolPct: number | null;
  meanBarMovePct: number | null;
} {
  if (closes.length < 30) return { realisedVolPct: null, meanBarMovePct: null };

  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 30) return { realisedVolPct: null, meanBarMovePct: null };

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const realised = Math.sqrt(variance) * Math.sqrt(BARS_PER_YEAR) * 100;

  let moveSum = 0;
  let n = 0;
  for (let i = 0; i < closes.length; i++) {
    if (opens[i] > 0) {
      moveSum += Math.abs(closes[i] - opens[i]) / opens[i];
      n++;
    }
  }

  return {
    realisedVolPct: Number.isFinite(realised) ? realised : null,
    meanBarMovePct: n > 0 ? (moveSum / n) * 100 : null,
  };
}

export async function runScreener(trackedSymbols: readonly string[]): Promise<{
  rows: ScreenerRow[];
  generatedAt: number;
  measuredCount: number;
  universeCount: number;
}> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return {
      rows: cache.rows,
      generatedAt: cache.at,
      measuredCount: cache.rows.filter(r => r.measured).length,
      universeCount: cache.rows.length,
    };
  }

  const [info, tickers] = await Promise.all([
    getJson(`${FAPI}/fapi/v1/exchangeInfo`) as Promise<{ symbols: ExchangeSymbol[] }>,
    getJson(`${FAPI}/fapi/v1/ticker/24hr`) as Promise<Raw24h[]>,
  ]);

  // Perpetuals only, and only ones actually trading. Dated futures and delisted
  // contracts would otherwise pollute the volume ranking.
  const perps = new Map(
    info.symbols
      .filter(s => s.contractType === "PERPETUAL" && s.status === "TRADING")
      .map(s => [s.symbol, s]),
  );

  const base: ScreenerRow[] = [];
  for (const t of tickers) {
    const meta = perps.get(t.symbol);
    if (!meta) continue;
    const vwap = Number(t.weightedAvgPrice);
    const high = Number(t.highPrice);
    const low = Number(t.lowPrice);
    const volume = Number(t.quoteVolume);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    base.push({
      symbol: t.symbol,
      quoteAsset: meta.quoteAsset,
      quoteVolume24h: volume,
      lastPrice: Number(t.lastPrice),
      priceChange24hPct: Number(t.priceChangePercent),
      range24hPct: vwap > 0 && Number.isFinite(high) && Number.isFinite(low)
        ? ((high - low) / vwap) * 100
        : 0,
      realisedVolPct: null,
      meanBarMovePct: null,
      volumePerVol: null,
      tracked: trackedSymbols.includes(t.symbol),
      measured: false,
    });
  }

  base.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);

  // Measure the most liquid names, plus anything already tracked so the six
  // live pairs always carry real numbers even if they fall out of the top slice.
  const toMeasure = new Set(base.slice(0, DEPTH).map(r => r.symbol));
  for (const s of trackedSymbols) toMeasure.add(s);

  const bySymbol = new Map(base.map(r => [r.symbol, r]));
  const targets = Array.from(toMeasure).filter(s => bySymbol.has(s));

  // Sequential in small batches: this is a background-ish call and hammering
  // the kline endpoint with 60 parallel requests invites a rate-limit ban.
  const BATCH = 6;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async symbol => {
        try {
          const klines = await fetchKlines(symbol, { limit: VOL_BARS });
          const row = bySymbol.get(symbol);
          if (!row || klines.length === 0) return;
          const v = volatilityOf(
            klines.map(k => k.close),
            klines.map(k => k.open),
          );
          row.realisedVolPct = v.realisedVolPct;
          row.meanBarMovePct = v.meanBarMovePct;
          row.volumePerVol =
            v.realisedVolPct && v.realisedVolPct > 0
              ? row.quoteVolume24h / v.realisedVolPct
              : null;
          row.measured = v.realisedVolPct !== null;
        } catch {
          // A single symbol failing must not sink the whole screen.
        }
      }),
    );
  }

  cache = { at: Date.now(), rows: base };
  return {
    rows: base,
    generatedAt: cache.at,
    measuredCount: base.filter(r => r.measured).length,
    universeCount: base.length,
  };
}
