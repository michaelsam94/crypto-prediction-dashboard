/**
 * Account simulator over the stored walk-forward predictions.
 *
 * Every prediction replayed into the database came from a model trained only on
 * bars strictly before it (see `generateHistoricalPredictions`), so the equity
 * curves below are out-of-sample rather than a fitted backtest.
 *
 * Bracket geometry mirrors the live trading rig: TP at `tpK x ATR%`, SL at
 * `slK x ATR%`, both measured off the ATR of the bar the signal was formed on,
 * with the live defaults TP 1.0 / SL 0.5 (a 2:1 bracket).
 *
 * Honest limits, surfaced in the UI rather than buried here:
 *  - Only 4H OHLC is stored, so when a bar touches BOTH the take-profit and the
 *    stop we cannot know which came first. We charge the STOP. That is the
 *    pessimistic reading and it keeps the curve from flattering itself.
 *  - Entry defaults to a taker fill. Binance's USDC promotion genuinely is 0%
 *    maker, so this is not about the fee schedule: a resting limit at the bar
 *    open only fills when price returns to it, so assuming it always fills
 *    quietly grants a free option on the bars that ran away. `entryIsMaker`
 *    switches between the two readings; the gap between them is wider than the
 *    edge being measured, which is the finding, not a rounding detail.
 *  - A stop is filled at the WORSE of the stop price and the bar's open, so a
 *    bar that gaps through the stop costs what it would really cost. A resting
 *    take-profit limit still fills at its own price, because a limit order
 *    cannot fill better than its limit. The asymmetry is deliberate.
 *  - Funding accrues on every bar a position is held, charged pro-rata against
 *    the 8h rate. Real funding lands at 00/08/16 UTC; pro-rata is the smooth
 *    approximation and is charged to longs and shorts alike, which is
 *    conservative for a strategy that is directionally mixed.
 *  - Positions are ISOLATED margin: a loss is capped at the margin behind it,
 *    and anything that would run past that is booked as a liquidation. Without
 *    this a gapping bar can book a loss larger than the collateral that existed,
 *    which flatters recoveries the account never got to attempt.
 *  - Orders under the venue's minimum notional are not placed at all. On a $25
 *    account this is the constraint that actually bites: the stake shrinks with
 *    the balance until the exchange stops accepting the order.
 */
import { CANDLE_MS } from "@shared/market";
import { atr } from "./indicators";
import { FEATURE_NAMES, buildFeatureMatrix } from "./features";
import type { Kline } from "./binance";

export const TAKER_FEE = 0.0004;
/**
 * Slippage on a taker fill, as a fraction of notional.
 *
 * 10bps, not the 2bps this used to assume. Measured over 56 real stop-outs on
 * the live account: the fill came in a mean 10.28bps and a median 3.06bps worse
 * than the trigger, with a long tail (one gap filled 209bps past it). A
 * STOP_MARKET becomes a market order the moment it triggers, so slipping past
 * the stop is what it is designed to do, not an execution fault.
 *
 * The correction is not cosmetic. On the best-performing bracket it moved costs
 * from 81% to 98% of gross — the difference between a strategy that pays for
 * its own trading and one that does not.
 */
export const SLIPPAGE = 0.001;
export const MAKER_FEE = 0;
/** Binance's baseline perp funding rate per 8h settlement. */
export const FUNDING_PER_8H = 0.0001;

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
/** Share of one funding settlement that a single candle is exposed to. */
const FUNDING_PER_BAR_FACTOR = CANDLE_MS / EIGHT_HOURS_MS;

/**
 * What a round trip actually costs. Every field is a fraction of NOTIONAL, not
 * of margin, so leverage multiplies them exactly the way it multiplies P&L.
 */
export type CostModel = {
  /** Charged on entry and on any stop or bar-close exit. */
  takerFee: number;
  /** Charged alongside every taker fill, on entry and on taker exits. */
  slippage: number;
  /** Charged on a take-profit fill, which rests on the book as a maker order. */
  makerFee: number;
  /** Funding per 8h settlement, accrued pro-rata for each bar held. */
  fundingPer8h: number;
  /**
   * Whether entry is assumed to rest on the book as a maker order.
   *
   * This is a FILL assumption, not a fee one. Binance's USDC-margined
   * promotion really is 0% maker, so a filled maker entry really is free — but
   * a resting limit at the bar's open only fills when price comes back to it,
   * which is disproportionately the bars where the signal was wrong. The
   * winners that ran away never fill. Assuming a guaranteed maker fill at the
   * open therefore books a free option: no fee, no slippage, no missed trades.
   *
   * 4H OHLC cannot tell us which entries would truly have filled, so this is
   * exposed as a switch rather than decided here. The difference between the
   * two settings is the honest width of that uncertainty, and on a thin edge it
   * is wider than the edge.
   */
  entryIsMaker: boolean;
};

/**
 * Default to a maker entry, because that is what the live rig does: it posts a
 * post-only limit at the bar open and cancels it after 30 minutes. Measured on
 * the live account, 35 of 38 such entries filled — a 92.1% fill rate.
 *
 * Note what this default cannot express: it assumes 100%. The truth is 92%, and
 * the missing 8% are not random — a post-only entry fails exactly when price
 * runs away from it, which skews the misses toward the bars the signal got
 * right. So this is the optimistic end of a narrow band, not a neutral choice.
 */
export const DEFAULT_COSTS: CostModel = {
  takerFee: TAKER_FEE,
  slippage: SLIPPAGE,
  makerFee: MAKER_FEE,
  fundingPer8h: FUNDING_PER_8H,
  entryIsMaker: true,
};

/**
 * A maker entry pays the maker rate and, by construction, no slippage — a limit
 * order fills at its limit or not at all. A taker entry crosses the spread.
 */
export const entryCostRate = (costs: CostModel) =>
  costs.entryIsMaker ? costs.makerFee : costs.takerFee + costs.slippage;

/** Exit is a maker fill only when the resting take-profit is what closed it. */
export const exitCostRate = (costs: CostModel, reason: ExitReason) =>
  reason === "TP" ? costs.makerFee : costs.takerFee + costs.slippage;

export type ExitReason = "TP" | "SL" | "CLOSE" | "LIQ";

/** Funding owed on `bars` candles of exposure, as a fraction of notional. */
export const fundingCostRate = (costs: CostModel, bars: number) =>
  costs.fundingPer8h * FUNDING_PER_BAR_FACTOR * Math.max(0, bars);

/**
 * Where a stop actually fills. A stop is a market order once touched, so a bar
 * that OPENS beyond the stop fills at that open, not at the stop price. Taking
 * the worse of the two is the difference between modelling a gap and being
 * gifted one.
 */
export const stopFillPrice = (dir: 1 | -1, stopPx: number, open: number) =>
  dir === 1 ? Math.min(stopPx, open) : Math.max(stopPx, open);

/**
 * Whichever adverse level price reaches first — the stop, or the liquidation.
 *
 * Normally the stop is nearer and the liquidation never comes into it. Widen
 * the stop past the liquidation distance, though, and the exchange closes the
 * position before the stop ever triggers, which is a failure mode a stop-only
 * simulator reports as a merely bad trade rather than a dead one.
 */
export const adverseTrigger = (dir: 1 | -1, stopPx: number, liqPx: number) =>
  dir === 1 ? Math.max(stopPx, liqPx) : Math.min(stopPx, liqPx);

/** True once the fill is at or beyond the liquidation price. */
export const isLiquidated = (dir: 1 | -1, fillPx: number, liqPx: number) =>
  dir === 1 ? fillPx <= liqPx : fillPx >= liqPx;

export type Strategy = "ml" | "ta" | "blend";

export type BacktestInput = {
  startBalance: number;
  leverage: number;
  tpK: number;
  slK: number;
  /** Margin per trade, as a percentage of current balance. */
  stakePct: number;
  /** Ceiling on total margin deployed in any one bar, as a percentage of balance. */
  maxTotalPct: number;
  /**
   * true  — close at the bar's own close unless TP/SL hit first (live behaviour).
   * false — hold across bars until TP or SL is touched.
   */
  flattenOnClose: boolean;
  /**
   * Smallest order the venue will accept, in quote currency. A signal whose
   * margin x leverage lands under this cannot be placed at all. Binance
   * Futures sits at $5.
   */
  minNotional: number;
  /**
   * Maintenance margin rate, as a fraction of notional. Binance's lowest tier
   * is 0.4-0.5% on most perps. Sets how far price can travel before the
   * position is liquidated.
   */
  maintenanceMarginRate: number;
  /** Cash added to the account each `topUpPeriod`. 0 disables top-ups. */
  topUpAmount: number;
  /** How often `topUpAmount` is credited. */
  topUpPeriod: TopUpPeriod;
  /**
   * How `tpK` and `slK` are read.
   *
   * "atr"   — multiples of the signal bar's ATR%, so a bracket means the same
   *           thing on a calm major and a violent memecoin.
   * "fixed" — plain percentages of the entry price, identical on every pair
   *           and in every regime.
   */
  bracketMode: BracketMode;
};

export type BracketMode = "atr" | "fixed";

/**
 * Bracket distance as a percentage of entry.
 *
 * The only place the two modes differ: under "atr" the multiple scales with the
 * bar's measured range, under "fixed" it is the percentage itself.
 */
export const bracketPct = (mode: BracketMode, k: number, atrPct: number) =>
  mode === "fixed" ? k : k * atrPct;

export type TopUpPeriod = "daily" | "weekly" | "monthly" | "yearly";

export const TOP_UP_PERIODS: readonly TopUpPeriod[] = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket a timestamp into its top-up period. A change of key between bars is
 * what triggers a credit, so the exact epoch of the boundary does not matter —
 * only that it advances once per period and never goes backwards.
 */
export function topUpPeriodKey(t: number, period: TopUpPeriod): number {
  const d = new Date(t);
  switch (period) {
    case "daily":
      return Math.floor(t / DAY_MS);
    case "weekly":
      return Math.floor(t / (7 * DAY_MS));
    case "monthly":
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    case "yearly":
      return d.getUTCFullYear();
  }
}

/** Binance Futures' floor on order size, in quote currency. */
export const MIN_NOTIONAL = 5;
/** Lowest-tier maintenance margin rate on most Binance perps. */
export const MAINTENANCE_MARGIN_RATE = 0.005;

/**
 * Price at which an isolated-margin position is liquidated.
 *
 * The position dies when its margin has been eaten down to the maintenance
 * requirement: `1/L + move <= mmr`. At 5x with a 0.5% maintenance rate that is
 * a 19.5% adverse move — far outside a 0.5xATR stop on a normal bar, which is
 * exactly why this only ever bites on gaps and on deliberately wide stops.
 */
export const liquidationPrice = (
  dir: 1 | -1,
  entry: number,
  leverage: number,
  maintenanceMarginRate: number,
) => entry * (1 + dir * (maintenanceMarginRate - 1 / leverage));

export type SignalRow = {
  symbol: string;
  targetOpenTime: number;
  basisOpenTime: number;
  direction: "LONG" | "SHORT";
  confidence: number;
  gate: number;
};

/** Raw ingredients for a signal, before a strategy turns them into a call. */
export type ScoredSignal = {
  symbol: string;
  targetOpenTime: number;
  basisOpenTime: number;
  /** Model probability that the next candle closes up. */
  probUp: number;
  /** Frozen TA composite in [-1, +1]; null when indicators are unavailable. */
  ta: number | null;
  /** The pair's ML confidence gate, as fitted during validation. */
  mlGate: number;
};

const featureIndex = (name: string) => {
  const i = (FEATURE_NAMES as readonly string[]).indexOf(name);
  if (i < 0) throw new Error(`feature ${name} missing`);
  return i;
};

const I_EMA_CROSS = featureIndex("ema9_ema21_ratio");
const I_RSI = featureIndex("rsi14");
const I_MACD_HIST = featureIndex("macd_hist_norm");
const I_BB = featureIndex("bb_percent_b");

const clip = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * Classic TA composite in [-1, +1]: four equally weighted votes — trend
 * (EMA9 vs EMA21), momentum (RSI centred), MACD histogram, and position inside
 * the Bollinger band.
 *
 * Deliberately NOT fitted. The scalings below exist to keep each vote inside
 * its range, not to improve returns — no weight here was chosen by looking at
 * P&L, which is how honest-looking backtests get manufactured. It reads the
 * same leakage-free feature matrix the model uses.
 *
 * Two of the four used to be dead, measured over 28,462 bars:
 *
 *   momentum  read `(v - 50) / 25`, but the stored `rsi14` feature is RSI/100 —
 *             a value in [0, 1]. Subtracting 50 pinned it to -1 on EVERY bar.
 *   macdVote  read `v * 10`, but `macd_hist_norm` is already histogram/price
 *             x100. The extra decade saturated it to +1 on EVERY bar.
 *
 * The two constants cancelled, so the "four-vote" composite was really
 * (trend + bbVote) / 4 and neither RSI nor MACD influenced a single signal.
 * Scales are now set so each vote spans its range instead of pinning: RSI
 * saturates on 3.8% of bars, MACD on 17.9%, trend on 35.5%, Bollinger on ~6%.
 */
export function taScoreFromFeatures(values: number[]): number {
  const trend = clip(values[I_EMA_CROSS] * 50);
  // (v - 0.5) * 4 is (RSI - 50) / 25 restated for the 0-1 feature scale.
  const momentum = clip((values[I_RSI] - 0.5) * 4);
  const macdVote = clip(values[I_MACD_HIST]);
  const bbVote = clip((values[I_BB] - 0.5) * 2);
  return (trend + momentum + macdVote + bbVote) / 4;
}

/** TA composite for every candle, keyed by openTime. */
export function taScoreByOpenTime(candles: Kline[]): Map<number, number> {
  const out = new Map<number, number>();
  if (candles.length === 0) return out;
  // Context features are not read by the composite, so BTC context is not needed.
  for (const row of buildFeatureMatrix(candles)) {
    const score = taScoreFromFeatures(row.values);
    if (Number.isFinite(score)) out.set(row.openTime, score);
  }
  return out;
}

/**
 * Turn raw ingredients into directional calls under one strategy.
 *
 * Scores live on [-1, +1]; sign gives direction and magnitude gives conviction,
 * mapped to a probability-like confidence so a single gate scale works for all
 * three strategies.
 */
export function applyStrategy(
  scored: ScoredSignal[],
  strategy: Strategy,
  blendWeight: number,
): Array<SignalRow & { score: number }> {
  const out: Array<SignalRow & { score: number }> = [];
  for (const s of scored) {
    let score: number;
    if (strategy === "ml") {
      score = 2 * s.probUp - 1;
    } else if (strategy === "ta") {
      if (s.ta === null) continue;
      score = s.ta;
    } else {
      if (s.ta === null) continue;
      score = blendWeight * (2 * s.probUp - 1) + (1 - blendWeight) * s.ta;
    }
    score = clip(score);
    out.push({
      symbol: s.symbol,
      targetOpenTime: s.targetOpenTime,
      basisOpenTime: s.basisOpenTime,
      direction: score >= 0 ? "LONG" : "SHORT",
      confidence: (Math.abs(score) + 1) / 2,
      gate: s.mlGate,
      score,
    });
  }
  return out;
}

/** Signals a pair must accumulate before any of them may be traded. */
export const DEFAULT_GATE_WARMUP = 200;

export type TrailingGateOptions = {
  /**
   * How many signals a pair must have produced before the gate is considered
   * fitted. Below this the sample is too thin for a percentile to mean
   * anything, so the pair sits out.
   */
  warmupSignals: number;
};

/** Insert into an ascending array, keeping it sorted. */
function insertSorted(sorted: number[], value: number): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, value);
}

/**
 * Coverage-matched gates, fitted on a trailing window.
 *
 * Each pair's gate was fitted against ML probabilities, so reusing that number
 * on a TA or blended score would compare different selectivities rather than
 * different strategies. Instead we keep the SHARE of bars the ML gate admits
 * and take that same top share of the chosen strategy's own conviction, so
 * "gated" always means "the most confident N% of bars for this strategy".
 *
 * The part that matters: both the share and the threshold are computed from
 * signals STRICTLY BEFORE the one being judged. The previous implementation
 * sorted every confidence in the whole window and took one percentile, which
 * meant the gate applied to a 2021 bar already knew what conviction looked like
 * in 2026 — a look-ahead sitting directly on the headline number. A trailing
 * fit is what the live rig could actually have known at the time.
 *
 * Signals are consumed in `targetOpenTime` order per pair, so the caller does
 * not have to pre-sort.
 */
export function applyTrailingGates(
  scored: ScoredSignal[],
  signals: Array<SignalRow & { score: number }>,
  options: TrailingGateOptions = { warmupSignals: DEFAULT_GATE_WARMUP },
): Array<SignalRow & { score: number }> {
  const key = (symbol: string, t: number) => `${symbol}@${t}`;

  // Did this bar clear the pair's fitted ML gate? Drives the coverage share.
  const mlPassed = new Map<string, boolean>();
  for (const s of scored) {
    mlPassed.set(key(s.symbol, s.targetOpenTime), Math.max(s.probUp, 1 - s.probUp) >= s.mlGate);
  }

  const bySymbol = new Map<string, Array<SignalRow & { score: number }>>();
  for (const s of signals) {
    const list = bySymbol.get(s.symbol);
    if (list) list.push(s);
    else bySymbol.set(s.symbol, [s]);
  }

  const out: Array<SignalRow & { score: number }> = [];
  bySymbol.forEach(rows => {
    const ordered = [...rows].sort((a, b) => a.targetOpenTime - b.targetOpenTime);
    const pastConfidence: number[] = []; // ascending
    let seen = 0;
    let passedMl = 0;

    for (const sig of ordered) {
      // Decide FIRST, using only what came before, then fold this bar in.
      if (seen >= options.warmupSignals && passedMl > 0) {
        const coverage = passedMl / seen;
        const take = Math.max(1, Math.round(coverage * pastConfidence.length));
        const idx = Math.max(0, pastConfidence.length - take);
        if (sig.confidence >= pastConfidence[idx]) out.push(sig);
      }

      insertSorted(pastConfidence, sig.confidence);
      seen++;
      if (mlPassed.get(key(sig.symbol, sig.targetOpenTime))) passedMl++;
    }
  });

  return out;
}

export type TradeResult = {
  symbol: string;
  targetOpenTime: number;
  direction: "LONG" | "SHORT";
  exitReason: ExitReason;
  /** Net of fees, slippage and funding. */
  pnl: number;
  /** Price move alone, before any cost. */
  gross: number;
  /** Entry + exit fees and slippage. */
  fees: number;
  /** Funding accrued over the bars held. */
  funding: number;
  margin: number;
};

export type BacktestResult = {
  startBalance: number;
  endBalance: number;
  /** Cash added by top-ups over the run. */
  deposited: number;
  /** endBalance - startBalance - deposited: what the strategy actually made. */
  netProfit: number;
  /**
   * Profit as a share of every dollar put in (start + top-ups).
   *
   * NOT time-weighted: a dollar added in the last month had far less time to
   * compound than one present from the start, so this understates the return on
   * early capital and flatters late capital. With no top-ups it reduces exactly
   * to the old endBalance/startBalance - 1.
   */
  returnPct: number;
  trades: number;
  wins: number;
  winRatePct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  ruined: boolean;
  ruinedAt: number | null;
  bestTrade: number;
  worstTrade: number;
  /** Trades closed by the exchange rather than by the bracket. */
  liquidations: number;
  /** Signals that could not be placed because the order was under the venue floor. */
  skippedUndersized: number;
  /** Sum of price-move P&L before costs. */
  grossPnl: number;
  /** Total fees and slippage charged, entry and exit. */
  feesPaid: number;
  /** Total funding charged across every bar held. */
  fundingPaid: number;
  curve: Array<{ t: number; equity: number }>;
};

/** ATR as a percentage of close, keyed by candle openTime. */
export function atrPercentByOpenTime(candles: Kline[]): Map<number, number> {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const series = atr(highs, lows, closes, 14);
  const out = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    const a = series[i];
    if (a === null || !Number.isFinite(a) || closes[i] === 0) continue;
    out.set(candles[i].openTime, (a / closes[i]) * 100);
  }
  return out;
}

/**
 * Resolve one trade inside its target candle.
 * Returns null when the bar or its ATR basis is missing.
 */
export function resolveTrade(
  signal: SignalRow,
  target: Kline,
  atrPct: number,
  margin: number,
  leverage: number,
  tpK: number,
  slK: number,
  costs: CostModel = DEFAULT_COSTS,
  maintenanceMarginRate: number = MAINTENANCE_MARGIN_RATE,
  bracketMode: BracketMode = "atr",
): TradeResult | null {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;

  const dir: 1 | -1 = signal.direction === "LONG" ? 1 : -1;
  const entry = target.open;
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const tpPct = bracketPct(bracketMode, tpK, atrPct);
  const slPct = bracketPct(bracketMode, slK, atrPct);
  const tpPx = entry * (1 + (dir * tpPct) / 100);
  const slPx = entry * (1 - (dir * slPct) / 100);
  const liqPx = liquidationPrice(dir, entry, leverage, maintenanceMarginRate);
  const trigger = adverseTrigger(dir, slPx, liqPx);

  const hitStop = dir === 1 ? target.low <= trigger : target.high >= trigger;
  const hitTp = dir === 1 ? target.high >= tpPx : target.low <= tpPx;

  // Both touched: 4H OHLC cannot order them, so charge the stop.
  let exitPx = target.close;
  let exitReason: ExitReason = "CLOSE";
  if (hitStop) {
    exitPx = stopFillPrice(dir, trigger, target.open);
    exitReason = isLiquidated(dir, exitPx, liqPx) ? "LIQ" : "SL";
  } else if (hitTp) {
    exitPx = tpPx;
    exitReason = "TP";
  }

  const notional = margin * leverage;
  const gross = dir * (exitPx / entry - 1) * notional;
  const fees = notional * (entryCostRate(costs) + exitCostRate(costs, exitReason));
  const funding = notional * fundingCostRate(costs, 1);
  // Isolated margin: the position cannot cost more than the margin behind it.
  const pnl = Math.max(gross - fees - funding, -margin);

  return {
    symbol: signal.symbol,
    targetOpenTime: signal.targetOpenTime,
    direction: signal.direction,
    exitReason,
    pnl,
    // Kept consistent with the clamp so the ledger still reconciles.
    gross: pnl + fees + funding,
    fees,
    funding,
    margin,
  };
}

/**
 * Walk the equity curve, holding positions for as long as the exit rule says.
 *
 * Two exit regimes:
 *
 *  flattenOnClose = true  — the live rig's behaviour. A position is closed at
 *    the close of its own bar unless the target or stop is touched first, so
 *    trades never overlap and margin is free again every bar.
 *
 *  flattenOnClose = false — the position is held across bars until the target
 *    or the stop is touched. Margin stays LOCKED while it is open, which is the
 *    part that is easy to get wrong: capital tied up in a slow trade cannot
 *    fund new signals, so holding changes which trades get taken, not just how
 *    they end. Only one position per symbol at a time.
 *
 * Equity is marked to market each bar (realised balance plus unrealised P&L on
 * open positions), so drawdown reflects open risk rather than only booked
 * losses. Sizing mirrors the live rig: a fixed percentage of balance as margin
 * per trade, capped per bar, highest conviction funded first.
 */
export function runBacktest(
  signals: SignalRow[],
  seriesBySymbol: Map<string, Kline[]>,
  atrBySymbol: Map<string, Map<number, number>>,
  input: BacktestInput,
  costs: CostModel = DEFAULT_COSTS,
): BacktestResult {
  /** Safety valve: abandon a position that never resolves and book it out. */
  const MAX_HOLD_BARS = 500;

  const byBar = new Map<number, SignalRow[]>();
  for (const s of signals) {
    const list = byBar.get(s.targetOpenTime);
    if (list) list.push(s);
    else byBar.set(s.targetOpenTime, [s]);
  }

  // Per-symbol lookup: candle by openTime, plus its ordinal for walking forward.
  const candleAt = new Map<string, Map<number, Kline>>();
  seriesBySymbol.forEach((series, symbol) => {
    candleAt.set(symbol, new Map(series.map(c => [c.openTime, c])));
  });

  type Position = {
    symbol: string;
    dir: 1 | -1;
    entry: number;
    tpPx: number;
    slPx: number;
    /** Price at which the exchange closes this position for us. */
    liqPx: number;
    /** Whichever of the stop and the liquidation price is reached first. */
    trigger: number;
    margin: number;
    notional: number;
    openedAt: number;
    barsHeld: number;
  };

  const open = new Map<string, Position>();
  let equity = input.startBalance;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let trades = 0;
  let wins = 0;
  let best = 0;
  let worst = 0;
  let grossPnl = 0;
  let feesPaid = 0;
  let fundingPaid = 0;
  let liquidations = 0;
  let skippedUndersized = 0;
  let ruinedAt: number | null = null;
  const curve: Array<{ t: number; equity: number }> = [];

  const settle = (p: Position, exitPx: number, reason: ExitReason) => {
    const raw = p.dir * (exitPx / p.entry - 1) * p.notional;
    // Entry is a taker fill and is charged as one; only a resting take-profit
    // exits as a maker. Funding covers the entry bar plus every bar held after.
    const fees = p.notional * (entryCostRate(costs) + exitCostRate(costs, reason));
    const funding = p.notional * fundingCostRate(costs, p.barsHeld + 1);
    // Isolated margin caps the damage at the margin behind the position. A loss
    // that would have run past it is a liquidation whether or not the price
    // path said so — the exchange would have closed it out first.
    const uncapped = raw - fees - funding;
    const pnl = Math.max(uncapped, -p.margin);
    const liquidated = reason === "LIQ" || uncapped < -p.margin;

    equity += pnl;
    grossPnl += pnl + fees + funding; // keep the ledger reconciling after the clamp
    feesPaid += fees;
    fundingPaid += funding;
    trades++;
    if (liquidated) liquidations++;
    if (pnl > 0) wins++;
    if (pnl > best) best = pnl;
    if (pnl < worst) worst = pnl;
  };

  // Every bar that could matter: any bar carrying a signal, plus every bar in
  // the covered span so open positions are still checked on quiet bars.
  //
  // Top-ups force the same widening even when positions flatten each bar. A
  // deposit is a calendar event, not a signal event — driving it off signal bars
  // alone would skip or mistime credits whenever signals are sparse.
  const barTimes = new Set<number>(Array.from(byBar.keys()));
  if (!input.flattenOnClose || input.topUpAmount > 0) {
    const first = barTimes.size > 0 ? Math.min(...Array.from(barTimes)) : -Infinity;
    seriesBySymbol.forEach(series => {
      for (const c of series) if (c.openTime >= first) barTimes.add(c.openTime);
    });
  }
  const timeline = Array.from(barTimes).sort((a, b) => a - b);

  let deposited = 0;
  // Seeded from the first bar so the run does not open with a free top-up on
  // top of the starting balance.
  let lastTopUpKey =
    timeline.length > 0 ? topUpPeriodKey(timeline[0], input.topUpPeriod) : 0;

  for (const t of timeline) {
    // Credit before the ruin check: an account that just received cash is not
    // ruined, which is the whole point of funding a strategy periodically.
    if (input.topUpAmount > 0) {
      const key = topUpPeriodKey(t, input.topUpPeriod);
      if (key !== lastTopUpKey) {
        lastTopUpKey = key;
        equity += input.topUpAmount;
        deposited += input.topUpAmount;
        // Deposits lift equity, so they must lift the drawdown reference too.
        // Without this a strategy bleeding out between top-ups looks like it is
        // merely flat, because fresh cash keeps restoring the peak.
        peak += input.topUpAmount;
      }
    }

    if (equity <= 0) {
      ruinedAt = ruinedAt ?? t;
      break;
    }

    // 1. Resolve positions already open, on this bar's range.
    open.forEach((p, symbol) => {
      if (t <= p.openedAt) return;
      const c = candleAt.get(symbol)?.get(t);
      if (!c) return;
      p.barsHeld++;
      const hitStop = p.dir === 1 ? c.low <= p.trigger : c.high >= p.trigger;
      const hitTp = p.dir === 1 ? c.high >= p.tpPx : c.low <= p.tpPx;
      if (hitStop) {
        // A bar that opens through the stop fills at that open, not at the stop.
        const fill = stopFillPrice(p.dir, p.trigger, c.open);
        settle(p, fill, isLiquidated(p.dir, fill, p.liqPx) ? "LIQ" : "SL");
        open.delete(symbol);
      } else if (hitTp) {
        settle(p, p.tpPx, "TP");
        open.delete(symbol);
      } else if (p.barsHeld >= MAX_HOLD_BARS) {
        settle(p, c.close, "CLOSE");
        open.delete(symbol);
      }
    });

    // 2. Open this bar's signals, highest conviction first.
    const bar = (byBar.get(t) ?? []).slice().sort((a, b) => b.confidence - a.confidence);
    let locked = 0;
    open.forEach(p => {
      locked += p.margin;
    });
    const perTrade = equity * (input.stakePct / 100);
    const ceiling = equity * (input.maxTotalPct / 100);
    const perTradeNotional = perTrade * input.leverage;

    for (const s of bar) {
      if (open.has(s.symbol)) continue; // one position per symbol
      if (locked + perTrade > ceiling) continue;
      // The venue will not accept an order this small. On a small account after
      // a drawdown this is what actually stops you trading your way back: the
      // stake shrinks with the balance until the exchange refuses the order.
      if (perTradeNotional < input.minNotional) {
        skippedUndersized++;
        continue;
      }
      const c = candleAt.get(s.symbol)?.get(s.targetOpenTime);
      // ATR is required even in "fixed" mode, where the brackets do not use it.
      // Dropping the requirement would let fixed mode trade bars that ATR mode
      // skips, and the two would no longer be comparable on the same history.
      const atrPct = atrBySymbol.get(s.symbol)?.get(s.basisOpenTime);
      if (!c || atrPct === undefined || !Number.isFinite(atrPct) || atrPct <= 0) continue;
      if (!Number.isFinite(c.open) || c.open <= 0) continue;

      const dir: 1 | -1 = s.direction === "LONG" ? 1 : -1;
      const entry = c.open;
      const tpPct = bracketPct(input.bracketMode, input.tpK, atrPct);
      const slPct = bracketPct(input.bracketMode, input.slK, atrPct);
      const tpPx = entry * (1 + (dir * tpPct) / 100);
      const slPx = entry * (1 - (dir * slPct) / 100);
      const liqPx = liquidationPrice(dir, entry, input.leverage, input.maintenanceMarginRate);
      const pos: Position = {
        symbol: s.symbol,
        dir,
        entry,
        tpPx,
        slPx,
        liqPx,
        trigger: adverseTrigger(dir, slPx, liqPx),
        margin: perTrade,
        notional: perTradeNotional,
        openedAt: t,
        barsHeld: 0,
      };

      // The entry bar itself can resolve the trade. Both touched -> charge the
      // stop, because 4H OHLC cannot order them. No gap adjustment here: entry
      // IS this bar's open, so there is no gap to be caught on the wrong side of.
      const hitStop = dir === 1 ? c.low <= pos.trigger : c.high >= pos.trigger;
      const hitTp = dir === 1 ? c.high >= tpPx : c.low <= tpPx;
      if (hitStop) {
        settle(pos, pos.trigger, isLiquidated(dir, pos.trigger, liqPx) ? "LIQ" : "SL");
      } else if (hitTp) {
        settle(pos, tpPx, "TP");
      } else if (input.flattenOnClose) {
        settle(pos, c.close, "CLOSE");
      } else {
        open.set(s.symbol, pos);
        locked += perTrade;
      }
    }

    // 3. Mark to market so drawdown reflects open risk too.
    let unrealised = 0;
    open.forEach((p, symbol) => {
      const c = candleAt.get(symbol)?.get(t);
      // Floored at the margin, same as a settled loss: an isolated position
      // cannot mark below the collateral standing behind it.
      if (c) unrealised += Math.max(p.dir * (c.close / p.entry - 1) * p.notional, -p.margin);
    });
    const marked = equity + unrealised;

    curve.push({ t, equity: marked });
    if (marked > peak) peak = marked;
    const dd = peak - marked;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
    if (marked <= 0) {
      ruinedAt = t;
      break;
    }
  }

  // Book out anything still open at the end of the window.
  open.forEach((p, symbol) => {
    const series = seriesBySymbol.get(symbol);
    const last = series && series.length > 0 ? series[series.length - 1] : null;
    if (last) settle(p, last.close, "CLOSE");
  });
  open.clear();

  const contributed = input.startBalance + deposited;
  const netProfit = equity - contributed;

  return {
    startBalance: input.startBalance,
    endBalance: equity,
    deposited,
    netProfit,
    returnPct: contributed > 0 ? (netProfit / contributed) * 100 : 0,
    trades,
    wins,
    winRatePct: trades > 0 ? (wins / trades) * 100 : 0,
    maxDrawdown,
    maxDrawdownPct,
    ruined: ruinedAt !== null,
    ruinedAt,
    bestTrade: best,
    worstTrade: worst,
    liquidations,
    skippedUndersized,
    grossPnl,
    feesPaid,
    fundingPaid,
    curve,
  };
}
