import type { Kline } from "./binance";
import { atr, bollinger, ema, macd, roc, rsi, sma, stochastic } from "./indicators";

/**
 * Ordered feature names. The order is part of the model contract: serialized
 * models store this list so a stale model is never fed a mismatched vector.
 */
export const FEATURE_NAMES = [
  // Momentum / oscillators
  "rsi14",
  "rsi14_delta",
  "rsi7",
  "stoch14",
  // MACD family
  "macd_norm",
  "macd_signal_norm",
  "macd_hist_norm",
  "macd_hist_delta",
  // Bollinger
  "bb_percent_b",
  "bb_width",
  "bb_width_delta",
  // EMA structure
  "close_ema9_ratio",
  "close_ema21_ratio",
  "close_ema50_ratio",
  "ema9_ema21_ratio",
  "ema21_ema50_ratio",
  // Volume
  "volume_delta",
  "volume_ratio_sma20",
  "taker_buy_ratio",
  "taker_buy_ratio_delta",
  // Candle geometry
  "body_ratio",
  "upper_wick_ratio",
  "lower_wick_ratio",
  "close_position_in_range",
  // Returns / volatility
  "return_1",
  "return_2",
  "return_3",
  "roc6",
  "atr_norm",
  "range_norm",
  // Sequence context
  "consecutive_direction",
  "up_ratio_last6",
  // Session context (4h buckets repeat 6x per UTC day)
  "utc_slot_sin",
  "utc_slot_cos",
  // BTC market context — altcoin 4H direction is strongly conditioned on BTC
  "btc_return_1",
  "btc_return_3",
  "btc_return_6",
  "btc_realized_vol20",
  "btc_body_pct",
  "btc_ema21_distance",

  // Non-price context. Funding is the only one of these the campaign has ever
  // validated as a standalone edge; Fear & Greed is included to be measured,
  // not because it is expected to help.
  "funding_bps",
  "funding_bps_mean24h",
  "funding_bps_delta",
  "fng_centred",
  "fng_delta_1d",
  "fng_vs_ma7",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export type FeatureRow = {
  /** UTC open time of the candle these features describe (the basis candle). */
  openTime: number;
  values: number[];
};

/**
 * BTC market-context block keyed by UTC candle open time. Supplied by the
 * caller so the pair-level pipeline stays a pure function of its inputs.
 */
export type MarketContext = Map<number, number[]>;

/** Number of values in the BTC context block. */
export const CONTEXT_FEATURE_COUNT = 6;

/** Funding (3) + Fear & Greed (3). Open interest is excluded: see altdata.ts. */
export const EXTRA_FEATURE_COUNT = 6;

/** Per-bar non-price features, keyed by candle openTime. */
export type ExtraContext = Map<number, number[]>;

/**
 * Derive the BTC context block for every candle in a BTC series.
 * Values are all backward-looking as of that candle's close.
 */
export function buildMarketContext(btcCandles: Kline[]): MarketContext {
  const ctx: MarketContext = new Map();
  const closes = btcCandles.map(c => c.close);
  const ema21 = ema(closes, 21);

  for (let i = 25; i < btcCandles.length; i++) {
    const c = btcCandles[i];
    const ret = (a: number, b: number) =>
      closes[b] === 0 ? 0 : ((closes[a] - closes[b]) / closes[b]) * 100;

    let volSum = 0;
    const window = Math.min(20, i);
    for (let k = i - window + 1; k <= i; k++) {
      volSum += Math.abs((btcCandles[k].close - btcCandles[k].open) / btcCandles[k].open);
    }

    const emaVal = ema21[i];
    ctx.set(c.openTime, [
      ret(i, i - 1),
      ret(i, i - 3),
      ret(i, i - 6),
      (volSum / window) * 100,
      ((c.close - c.open) / c.open) * 100,
      emaVal ? (c.close / emaVal - 1) * 100 : 0,
    ]);
  }
  return ctx;
}

/** Neutral fallback used when BTC data is missing for a timestamp. */
const NEUTRAL_CONTEXT = new Array(CONTEXT_FEATURE_COUNT).fill(0) as number[];

/**
 * Neutral fill when a bar has no funding/F&G data. Zero is the correct neutral
 * here because every one of these features is expressed as a deviation.
 */
const NEUTRAL_EXTRA = new Array(EXTRA_FEATURE_COUNT).fill(0) as number[];

function safeDiv(a: number, b: number, fallback = 0): number {
  return b === 0 || !Number.isFinite(b) ? fallback : a / b;
}

function clean(x: number | null | undefined, fallback = 0): number {
  if (x === null || x === undefined || !Number.isFinite(x)) return fallback;
  return x;
}

/**
 * Build the feature matrix for a chronological candle series.
 *
 * Row `i` uses ONLY information available at the close of candle `i`, which is
 * exactly the information available when predicting candle `i + 1`. No forward
 * values are ever referenced, so the matrix is leakage-free by construction.
 */
export function buildFeatureMatrix(
  candles: Kline[],
  context?: MarketContext,
  extras?: ExtraContext,
): FeatureRow[] {
  const n = candles.length;
  if (n === 0) return [];

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);
  const volumes = candles.map(c => c.volume);

  const rsi14 = rsi(closes, 14);
  const rsi7 = rsi(closes, 7);
  const stoch = stochastic(highs, lows, closes, 14);
  const { macd: macdLine, signal: macdSignal, histogram: macdHist } = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const volSma20 = sma(volumes, 20);
  const atr14 = atr(highs, lows, closes, 14);
  const roc6 = roc(closes, 6);

  const rows: FeatureRow[] = [];

  // Warmup: EMA50 + Bollinger + MACD signal all need history. 60 bars is safe.
  const warmup = 60;

  for (let i = warmup; i < n; i++) {
    const c = candles[i];
    const price = c.close;

    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    const prevVol = volumes[i - 1];
    const takerBuyRatio = safeDiv(c.takerBuyBase, c.volume, 0.5);
    const prevTakerBuyRatio = safeDiv(candles[i - 1].takerBuyBase, candles[i - 1].volume, 0.5);

    // Consecutive same-direction streak, capped at +/-5.
    let streak = 0;
    const dirOf = (k: number) => (closes[k] >= opens[k] ? 1 : -1);
    const currentDir = dirOf(i);
    for (let k = i; k >= 0 && k > i - 6; k--) {
      if (dirOf(k) === currentDir) streak++;
      else break;
    }
    const consecutiveDirection = currentDir * Math.min(streak, 5);

    let ups = 0;
    for (let k = i - 5; k <= i; k++) if (closes[k] >= opens[k]) ups++;
    const upRatio6 = ups / 6;

    // 4h slot index 0..5 within the UTC day, encoded cyclically.
    const slot = Math.floor((c.openTime % 86_400_000) / 14_400_000);
    const slotAngle = (2 * Math.PI * slot) / 6;

    const atrNorm = safeDiv(clean(atr14[i]), price);

    const values: number[] = [
      clean(rsi14[i], 50) / 100,
      (clean(rsi14[i], 50) - clean(rsi14[i - 1], 50)) / 100,
      clean(rsi7[i], 50) / 100,
      clean(stoch[i], 50) / 100,

      safeDiv(clean(macdLine[i]), price) * 100,
      safeDiv(clean(macdSignal[i]), price) * 100,
      safeDiv(clean(macdHist[i]), price) * 100,
      safeDiv(clean(macdHist[i]) - clean(macdHist[i - 1]), price) * 100,

      clean(bb.percentB[i], 0.5),
      clean(bb.width[i]),
      clean(bb.width[i]) - clean(bb.width[i - 1]),

      safeDiv(price, clean(ema9[i], price), 1) - 1,
      safeDiv(price, clean(ema21[i], price), 1) - 1,
      safeDiv(price, clean(ema50[i], price), 1) - 1,
      safeDiv(clean(ema9[i], price), clean(ema21[i], price), 1) - 1,
      safeDiv(clean(ema21[i], price), clean(ema50[i], price), 1) - 1,

      safeDiv(c.volume - prevVol, prevVol),
      safeDiv(c.volume, clean(volSma20[i], c.volume), 1),
      takerBuyRatio,
      takerBuyRatio - prevTakerBuyRatio,

      safeDiv(body, range),
      safeDiv(upperWick, range),
      safeDiv(lowerWick, range),
      safeDiv(c.close - c.low, range, 0.5),

      safeDiv(closes[i] - closes[i - 1], closes[i - 1]) * 100,
      safeDiv(closes[i - 1] - closes[i - 2], closes[i - 2]) * 100,
      safeDiv(closes[i - 2] - closes[i - 3], closes[i - 3]) * 100,
      clean(roc6[i]),
      atrNorm * 100,
      safeDiv(range, price) * 100,

      consecutiveDirection,
      upRatio6,

      Math.sin(slotAngle),
      Math.cos(slotAngle),
    ];

    const ctxValues = context?.get(c.openTime) ?? NEUTRAL_CONTEXT;
    values.push(...ctxValues);

    const extraValues = extras?.get(c.openTime) ?? NEUTRAL_EXTRA;
    values.push(...extraValues);

    rows.push({ openTime: c.openTime, values: values.map(v => (Number.isFinite(v) ? v : 0)) });
  }

  return rows;
}

/**
 * Label for row `i`: did the NEXT candle close above its open?
 * Returns `null` when the next candle does not exist yet.
 */
export function buildLabels(candles: Kline[], rows: FeatureRow[]): (number | null)[] {
  const indexByOpenTime = new Map<number, number>();
  candles.forEach((c, i) => indexByOpenTime.set(c.openTime, i));

  return rows.map(row => {
    const i = indexByOpenTime.get(row.openTime);
    if (i === undefined) return null;
    const next = candles[i + 1];
    if (!next) return null;
    return next.close >= next.open ? 1 : 0;
  });
}
