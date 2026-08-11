import { describe, expect, it } from "vitest";
import { CANDLE_MS } from "@shared/market";
import { FEATURE_NAMES } from "./features";
import {
  DEFAULT_COSTS,
  MAINTENANCE_MARGIN_RATE,
  SLIPPAGE,
  TAKER_FEE,
  adverseTrigger,
  applyStrategy,
  bracketPct,
  applyTrailingGates,
  entryCostRate,
  exitCostRate,
  fundingCostRate,
  isLiquidated,
  liquidationPrice,
  runBacktest,
  stopFillPrice,
  taScoreFromFeatures,
  topUpPeriodKey,
  type BacktestInput,
  type CostModel,
  type ScoredSignal,
  type SignalRow,
} from "./backtest";
import type { Kline } from "./binance";

const T0 = Date.UTC(2024, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

const bar = (
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Kline => ({
  openTime,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1_000,
  closeTime: openTime + CANDLE_MS - 1,
  quoteVolume: 100_000,
  trades: 100,
  takerBuyBase: 500,
});

const signal = (
  overrides: Partial<SignalRow> & Pick<SignalRow, "targetOpenTime">,
): SignalRow => ({
  symbol: "TESTUSDC",
  basisOpenTime: overrides.targetOpenTime - CANDLE_MS,
  direction: "LONG",
  confidence: 0.9,
  gate: 0.5,
  ...overrides,
});

const cfg = (over: Partial<BacktestInput> = {}): BacktestInput => ({
  startBalance: 1_000,
  leverage: 1,
  tpK: 1,
  slK: 1,
  stakePct: 100,
  maxTotalPct: 100,
  flattenOnClose: false,
  // Defaults chosen so the venue constraints stay OUT of the way unless a test
  // is specifically about them: no order floor, and 1x leverage puts the
  // liquidation price at zero.
  minNotional: 0,
  maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
  topUpAmount: 0,
  topUpPeriod: "monthly",
  bracketMode: "atr",
  ...over,
});

/** One pair, ATR fixed at 1% of close so bracket maths stays readable. */
const atrMap = (times: number[], pct = 1) =>
  new Map([["TESTUSDC", new Map(times.map(t => [t, pct]))]]);

const FREE: CostModel = {
  takerFee: 0,
  slippage: 0,
  makerFee: 0,
  fundingPer8h: 0,
  entryIsMaker: false,
};

/**
 * Real rates but crossing the spread on entry. Stated explicitly rather than
 * leaning on DEFAULT_COSTS, so these assertions keep describing taker-entry
 * behaviour no matter which way the default points.
 */
const TAKER_ENTRY: CostModel = { ...DEFAULT_COSTS, entryIsMaker: false };

describe("cost model", () => {
  it("defaults to a maker entry, matching the live post-only rig", () => {
    expect(DEFAULT_COSTS.entryIsMaker).toBe(true);
    expect(entryCostRate(DEFAULT_COSTS)).toBe(0);
  });

  it("charges entry as a taker fill when the entry crosses the spread", () => {
    expect(entryCostRate(TAKER_ENTRY)).toBeCloseTo(TAKER_FEE + SLIPPAGE, 12);
  });

  it("charges a maker entry the maker rate and no slippage", () => {
    // Binance's USDC promotion is genuinely 0% maker, so a FILLED maker entry
    // is free. What this setting cannot model is the entries that never fill.
    const maker = entryCostRate({ ...DEFAULT_COSTS, entryIsMaker: true });
    expect(maker).toBe(DEFAULT_COSTS.makerFee);
    expect(maker).toBe(0);
  });

  it("keeps stop exits taker-priced regardless of how entry filled", () => {
    // A stop is a market order however you got in.
    const makerEntry: CostModel = { ...DEFAULT_COSTS, entryIsMaker: true };
    expect(exitCostRate(makerEntry, "SL")).toBeCloseTo(TAKER_FEE + SLIPPAGE, 12);
    expect(exitCostRate(makerEntry, "TP")).toBe(0);
  });

  it("charges a take-profit exit as a maker fill and a stop as a taker fill", () => {
    expect(exitCostRate(DEFAULT_COSTS, "TP")).toBeCloseTo(0, 10);
    expect(exitCostRate(DEFAULT_COSTS, "SL")).toBeCloseTo(TAKER_FEE + SLIPPAGE, 12);
    expect(exitCostRate(DEFAULT_COSTS, "CLOSE")).toBeCloseTo(TAKER_FEE + SLIPPAGE, 12);
  });

  it("accrues funding pro-rata: a 4H bar is half an 8h settlement", () => {
    expect(fundingCostRate(DEFAULT_COSTS, 1)).toBeCloseTo(0.0001 * 0.5, 12);
    expect(fundingCostRate(DEFAULT_COSTS, 4)).toBeCloseTo(0.0001 * 2, 12);
    expect(fundingCostRate(DEFAULT_COSTS, 0)).toBe(0);
  });

  it("still charges a taker-entry winner, which the old model did not", () => {
    // TP exit: maker fee is zero, but a taker entry and funding are not.
    const winner = entryCostRate(TAKER_ENTRY) + exitCostRate(TAKER_ENTRY, "TP");
    expect(winner).toBeGreaterThan(0);
  });

  it("leaves a maker-entry winner costing nothing but funding", () => {
    // The old model's implicit assumption, now explicit and switchable: a
    // maker entry into a take-profit exit is entirely free of fees.
    const maker: CostModel = { ...DEFAULT_COSTS, entryIsMaker: true };
    expect(entryCostRate(maker) + exitCostRate(maker, "TP")).toBe(0);
    expect(fundingCostRate(maker, 1)).toBeGreaterThan(0);
  });
});

describe("stopFillPrice", () => {
  it("fills a long stop at the open when the bar gaps below it", () => {
    expect(stopFillPrice(1, 99, 95)).toBe(95);
  });

  it("fills a long stop at the stop when the bar opens above it", () => {
    expect(stopFillPrice(1, 99, 100)).toBe(99);
  });

  it("fills a short stop at the open when the bar gaps above it", () => {
    expect(stopFillPrice(-1, 101, 105)).toBe(105);
  });

  it("fills a short stop at the stop when the bar opens below it", () => {
    expect(stopFillPrice(-1, 101, 100)).toBe(101);
  });
});

describe("runBacktest costs", () => {
  const series = (bars: Kline[]) => new Map([["TESTUSDC", bars]]);

  it("charges entry, exit and funding, and reports each", () => {
    // Entry 100, TP at +1% = 101, hit on the entry bar. Taker entry, so the
    // entry fee is visible; under a maker entry a TP winner pays only funding.
    const bars = [bar(T0, 100, 101.5, 99.9, 101)];
    const r = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      atrMap([T0 - CANDLE_MS]),
      cfg(),
      TAKER_ENTRY,
    );

    expect(r.trades).toBe(1);
    expect(r.grossPnl).toBeCloseTo(10, 6); // 1% of 1,000 notional
    expect(r.feesPaid).toBeCloseTo(1_000 * (TAKER_FEE + SLIPPAGE), 6); // entry taker; TP is maker
    expect(r.fundingPaid).toBeCloseTo(1_000 * 0.0001 * 0.5, 8);
    expect(r.endBalance).toBeCloseTo(1_000 + r.grossPnl - r.feesPaid - r.fundingPaid, 6);
  });

  it("books a gapped stop at the gap, not at the stop price", () => {
    // Entry 100, stop at 99. Next bar opens at 95 — straight through.
    const bars = [
      bar(T0, 100, 100.5, 99.5, 100.2),
      bar(T0 + CANDLE_MS, 95, 95.5, 94, 94.5),
    ];
    const gapped = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      atrMap([T0 - CANDLE_MS]),
      cfg(),
      FREE,
    );

    // Filled at 95 => -5%, not at 99 => -1%.
    expect(gapped.grossPnl).toBeCloseTo(-50, 6);
    expect(gapped.endBalance).toBeCloseTo(950, 6);
  });

  it("does not gap-adjust the entry bar, where entry is the open itself", () => {
    // Entry 100 at the open, stop 99 touched in the same bar's low.
    const bars = [bar(T0, 100, 100.4, 98, 98.5)];
    const r = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      atrMap([T0 - CANDLE_MS]),
      cfg(),
      FREE,
    );
    expect(r.grossPnl).toBeCloseTo(-10, 6); // exactly -1%, the stop
  });

  it("funding scales with how long a position is held", () => {
    // A position that never touches either bracket, held to the hold cap.
    const flat = Array.from({ length: 6 }, (_, i) =>
      bar(T0 + i * CANDLE_MS, 100, 100.2, 99.8, 100),
    );
    const held = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(flat),
      atrMap([T0 - CANDLE_MS]),
      cfg({ tpK: 10, slK: 10 }),
      DEFAULT_COSTS,
    );
    const oneBar = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series([flat[0]]),
      atrMap([T0 - CANDLE_MS]),
      cfg({ tpK: 10, slK: 10 }),
      DEFAULT_COSTS,
    );
    expect(held.fundingPaid).toBeGreaterThan(oneBar.fundingPaid);
  });

  it("makes a zero-edge strategy lose money once costs are charged", () => {
    // Price goes exactly nowhere; only costs move the balance.
    const flat = Array.from({ length: 10 }, (_, i) =>
      bar(T0 + i * CANDLE_MS, 100, 100.1, 99.9, 100),
    );
    const signals = flat.map(b => signal({ targetOpenTime: b.openTime }));
    const r = runBacktest(
      signals,
      series(flat),
      atrMap(flat.map(b => b.openTime - CANDLE_MS)),
      cfg({ flattenOnClose: true }),
      DEFAULT_COSTS,
    );
    expect(r.trades).toBe(10);
    expect(r.endBalance).toBeLessThan(1_000);
  });
});

describe("taScoreFromFeatures", () => {
  const at = (over: Partial<Record<string, number>>) => {
    const v = new Array(FEATURE_NAMES.length).fill(0);
    const set = (name: string, value: number) => {
      v[(FEATURE_NAMES as readonly string[]).indexOf(name)] = value;
    };
    // Neutral baseline: RSI 50, mid-band, no trend, flat MACD.
    set("rsi14", 0.5);
    set("bb_percent_b", 0.5);
    set("ema9_ema21_ratio", 0);
    set("macd_hist_norm", 0);
    for (const [k, val] of Object.entries(over)) set(k, val as number);
    return v;
  };

  it("scores a fully neutral bar at zero", () => {
    expect(taScoreFromFeatures(at({}))).toBeCloseTo(0, 10);
  });

  it("lets RSI move the score — it used to be pinned at -1", () => {
    const low = taScoreFromFeatures(at({ rsi14: 0.3 }));
    const mid = taScoreFromFeatures(at({ rsi14: 0.5 }));
    const high = taScoreFromFeatures(at({ rsi14: 0.7 }));
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("treats RSI 50 as neutral rather than maximally bearish", () => {
    // The regression: (0.5 - 50) / 25 clipped to -1, dragging every bar down.
    expect(taScoreFromFeatures(at({ rsi14: 0.5 }))).toBeCloseTo(0, 10);
  });

  it("lets MACD move the score — it used to be pinned at +1", () => {
    const neg = taScoreFromFeatures(at({ macd_hist_norm: -0.5 }));
    const flat = taScoreFromFeatures(at({ macd_hist_norm: 0 }));
    const pos = taScoreFromFeatures(at({ macd_hist_norm: 0.5 }));
    expect(neg).toBeLessThan(flat);
    expect(flat).toBeLessThan(pos);
  });

  it("does not saturate MACD at a typical histogram", () => {
    // p50 of macd_hist_norm is ~0.04 and p75 ~0.47; these must not clip.
    const small = taScoreFromFeatures(at({ macd_hist_norm: 0.04 }));
    const mid = taScoreFromFeatures(at({ macd_hist_norm: 0.47 }));
    expect(small).not.toBeCloseTo(mid, 6);
  });

  it("keeps every vote weighted equally", () => {
    // One vote at full scale moves the composite by exactly 1/4.
    expect(taScoreFromFeatures(at({ bb_percent_b: 1 }))).toBeCloseTo(0.25, 10);
    expect(taScoreFromFeatures(at({ rsi14: 0.75 }))).toBeCloseTo(0.25, 10);
    expect(taScoreFromFeatures(at({ macd_hist_norm: 1 }))).toBeCloseTo(0.25, 10);
  });

  it("stays within [-1, 1] under extreme inputs", () => {
    const hot = taScoreFromFeatures(
      at({ rsi14: 5, bb_percent_b: 9, ema9_ema21_ratio: 9, macd_hist_norm: 9 }),
    );
    const cold = taScoreFromFeatures(
      at({ rsi14: -5, bb_percent_b: -9, ema9_ema21_ratio: -9, macd_hist_norm: -9 }),
    );
    expect(hot).toBeCloseTo(1, 10);
    expect(cold).toBeCloseTo(-1, 10);
  });
});

describe("bracket mode", () => {
  const series = (bars: Kline[]) => new Map([["TESTUSDC", bars]]);

  it("reads tpK/slK as ATR multiples under atr mode", () => {
    expect(bracketPct("atr", 1.5, 2)).toBeCloseTo(3, 10);
    expect(bracketPct("atr", 0.5, 2)).toBeCloseTo(1, 10);
  });

  it("reads tpK/slK as plain percentages under fixed mode", () => {
    expect(bracketPct("fixed", 1.5, 2)).toBe(1.5);
    expect(bracketPct("fixed", 1.5, 7)).toBe(1.5);
  });

  it("makes fixed brackets independent of the bar's volatility", () => {
    // Same 2% favourable move, two very different ATRs. Under fixed mode a 1%
    // target is hit in both; under atr mode 1xATR is 1% in one and 5% in the
    // other, so only the calm bar reaches it.
    const bars = [bar(T0, 100, 102.5, 99.9, 102)];
    const run = (mode: "atr" | "fixed", atr: number) =>
      runBacktest(
        [signal({ targetOpenTime: T0 })],
        series(bars),
        new Map([["TESTUSDC", new Map([[T0 - CANDLE_MS, atr]])]]),
        cfg({ tpK: 1, slK: 1, bracketMode: mode, flattenOnClose: true }),
        FREE,
      );

    expect(run("fixed", 1).grossPnl).toBeCloseTo(run("fixed", 5).grossPnl, 10);
    expect(run("atr", 1).grossPnl).not.toBeCloseTo(run("atr", 5).grossPnl, 6);
  });

  it("hits a 1% fixed target regardless of a wild ATR", () => {
    const bars = [bar(T0, 100, 101.5, 99.9, 101)];
    const r = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      new Map([["TESTUSDC", new Map([[T0 - CANDLE_MS, 9]])]]), // ATR 9%
      cfg({ tpK: 1, slK: 1, bracketMode: "fixed", flattenOnClose: false }),
      FREE,
    );
    expect(r.trades).toBe(1);
    expect(r.grossPnl).toBeCloseTo(10, 6); // exactly +1% of 1,000 notional
  });

  it("still requires ATR in fixed mode so both modes trade the same bars", () => {
    // No ATR for the signal bar: the trade must be skipped either way, or the
    // two modes would be measured on different populations.
    const bars = [bar(T0, 100, 101.5, 99.9, 101)];
    for (const mode of ["atr", "fixed"] as const) {
      const r = runBacktest(
        [signal({ targetOpenTime: T0 })],
        series(bars),
        new Map([["TESTUSDC", new Map<number, number>()]]),
        cfg({ bracketMode: mode }),
        FREE,
      );
      expect(r.trades).toBe(0);
    }
  });
});

describe("periodic top-ups", () => {
  const series = (bars: Kline[]) => new Map([["TESTUSDC", bars]]);
  /** Flat market: nothing moves, so every balance change is a deposit. */
  const flat = (n: number, stepMs = CANDLE_MS) =>
    Array.from({ length: n }, (_, i) => bar(T0 + i * stepMs, 100, 100, 100, 100));

  it("adds nothing when the amount is zero", () => {
    const bars = flat(200, DAY_MS);
    const r = runBacktest([], series(bars), atrMap([]), cfg({ topUpAmount: 0 }), FREE);
    expect(r.deposited).toBe(0);
    expect(r.endBalance).toBe(1_000);
  });

  it("credits once per day when set to daily", () => {
    // 10 days of bars; the first day seeds the counter, so 9 credits.
    const bars = flat(10, DAY_MS);
    const r = runBacktest([], series(bars), atrMap([]),
      cfg({ topUpAmount: 100, topUpPeriod: "daily" }), FREE);
    expect(r.deposited).toBe(900);
    expect(r.endBalance).toBe(1_900);
  });

  it("does not credit on the very first bar", () => {
    const bars = flat(1, DAY_MS);
    const r = runBacktest([], series(bars), atrMap([]),
      cfg({ topUpAmount: 100, topUpPeriod: "daily" }), FREE);
    expect(r.deposited).toBe(0);
  });

  it("credits less often as the period lengthens", () => {
    const bars = flat(400, DAY_MS); // ~13 months
    const counts = (["daily", "weekly", "monthly", "yearly"] as const).map(
      p => runBacktest([], series(bars), atrMap([]),
        cfg({ topUpAmount: 1, topUpPeriod: p }), FREE).deposited,
    );
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[2]);
    expect(counts[2]).toBeGreaterThan(counts[3]);
    expect(counts[3]).toBeGreaterThanOrEqual(1); // crosses a year boundary
  });

  it("reports profit net of deposits rather than counting them as gains", () => {
    const bars = flat(10, DAY_MS);
    const r = runBacktest([], series(bars), atrMap([]),
      cfg({ topUpAmount: 100, topUpPeriod: "daily" }), FREE);
    // Balance tripled, but the strategy earned nothing.
    expect(r.endBalance).toBe(1_900);
    expect(r.netProfit).toBe(0);
    expect(r.returnPct).toBe(0);
  });

  it("reduces to the plain return when there are no top-ups", () => {
    const bars = [bar(T0, 100, 101.5, 99.9, 101)];
    const r = runBacktest([signal({ targetOpenTime: T0 })], series(bars),
      atrMap([T0 - CANDLE_MS]), cfg(), FREE);
    expect(r.deposited).toBe(0);
    expect(r.returnPct).toBeCloseTo((r.endBalance / 1_000 - 1) * 100, 10);
  });

  it("does not let deposits paper over a drawdown", () => {
    // Every bar loses; without lifting the peak, incoming cash would keep
    // restoring the high-water mark and report a far shallower drawdown.
    const losing = Array.from({ length: 30 }, (_, i) =>
      bar(T0 + i * DAY_MS, 100, 100.2, 98, 98.5),
    );
    const signals = losing.map(b => signal({ targetOpenTime: b.openTime }));
    const opts = { stakePct: 20, flattenOnClose: true, minNotional: 0 };
    const withTopUps = runBacktest(signals, series(losing),
      atrMap(losing.map(b => b.openTime - CANDLE_MS)),
      cfg({ ...opts, topUpAmount: 200, topUpPeriod: "daily" }), FREE);
    const without = runBacktest(signals, series(losing),
      atrMap(losing.map(b => b.openTime - CANDLE_MS)),
      cfg({ ...opts, topUpAmount: 0 }), FREE);

    expect(withTopUps.deposited).toBeGreaterThan(0);
    expect(withTopUps.netProfit).toBeLessThan(0);
    // The funded run must still register a real drawdown, not a flattered one.
    expect(withTopUps.maxDrawdown).toBeGreaterThan(without.maxDrawdown);
  });
});

describe("topUpPeriodKey", () => {
  it("advances once per calendar unit and never goes backwards", () => {
    const jan = Date.UTC(2025, 0, 15);
    expect(topUpPeriodKey(jan, "monthly")).toBe(
      topUpPeriodKey(Date.UTC(2025, 0, 28), "monthly"),
    );
    expect(topUpPeriodKey(Date.UTC(2025, 1, 1), "monthly")).toBe(
      topUpPeriodKey(jan, "monthly") + 1,
    );
    expect(topUpPeriodKey(Date.UTC(2026, 0, 1), "yearly")).toBe(
      topUpPeriodKey(jan, "yearly") + 1,
    );
    expect(topUpPeriodKey(jan + DAY_MS, "daily")).toBe(
      topUpPeriodKey(jan, "daily") + 1,
    );
  });
});

describe("liquidation geometry", () => {
  it("puts a 5x long liquidation just under a 20% adverse move", () => {
    const px = liquidationPrice(1, 100, 5, 0.005);
    expect(px).toBeCloseTo(80.5, 6); // 1 - 1/5 + 0.005
  });

  it("puts a 5x short liquidation just over a 20% adverse move", () => {
    expect(liquidationPrice(-1, 100, 5, 0.005)).toBeCloseTo(119.5, 6);
  });

  it("moves liquidation further away as leverage falls", () => {
    expect(liquidationPrice(1, 100, 2, 0.005)).toBeCloseTo(50.5, 6);
    expect(liquidationPrice(1, 100, 20, 0.005)).toBeCloseTo(95.5, 6);
  });

  it("triggers on the stop when the stop is nearer, which is the normal case", () => {
    // Long, entry 100: stop at 99, liquidation at 80.5. Stop is reached first.
    expect(adverseTrigger(1, 99, 80.5)).toBe(99);
    expect(isLiquidated(1, 99, 80.5)).toBe(false);
  });

  it("triggers on the liquidation when the stop is set wider than it", () => {
    // A 3xATR stop on a violent pair can sit outside the liquidation distance;
    // the exchange closes the position before the stop is ever reached.
    expect(adverseTrigger(1, 70, 80.5)).toBe(80.5);
    expect(isLiquidated(1, 80.5, 80.5)).toBe(true);
  });
});

describe("runBacktest liquidation", () => {
  const series = (bars: Kline[]) => new Map([["TESTUSDC", bars]]);

  it("caps a catastrophic gap at the margin instead of booking more", () => {
    // 5x long, entry 100, stop 99. Next bar opens at 40 — a 60% gap. Uncapped
    // that is -300% of margin; isolated margin can only lose 100%.
    const bars = [
      bar(T0, 100, 100.5, 99.5, 100.2),
      bar(T0 + CANDLE_MS, 40, 45, 38, 42),
    ];
    const r = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      atrMap([T0 - CANDLE_MS]),
      cfg({ leverage: 5, stakePct: 20 }), // margin = 200, notional = 1,000
      FREE,
    );

    expect(r.liquidations).toBe(1);
    expect(r.worstTrade).toBeCloseTo(-200, 6); // exactly the margin, not -600
    expect(r.endBalance).toBeCloseTo(800, 6);
  });

  it("does not liquidate an ordinary stop-out", () => {
    const bars = [bar(T0, 100, 100.4, 98, 98.5)];
    const r = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      atrMap([T0 - CANDLE_MS]),
      cfg({ leverage: 5, stakePct: 20 }),
      FREE,
    );
    expect(r.trades).toBe(1);
    expect(r.liquidations).toBe(0);
  });

  it("closes at the liquidation price when the stop sits outside it", () => {
    // slK 30 x 1% ATR = a 30% stop, but 5x liquidates at 19.5%.
    const bars = [bar(T0, 100, 100.5, 75, 78)];
    const r = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      atrMap([T0 - CANDLE_MS]),
      cfg({ leverage: 5, stakePct: 20, slK: 30 }),
      FREE,
    );
    expect(r.liquidations).toBe(1);
    expect(r.worstTrade).toBeCloseTo(-195, 6); // 19.5% of 1,000 notional
  });

  it("never lets a single trade cost more than its margin", () => {
    const bars = [
      bar(T0, 100, 100.5, 99.5, 100.2),
      bar(T0 + CANDLE_MS, 1, 2, 0.5, 1),
    ];
    const r = runBacktest(
      [signal({ targetOpenTime: T0 })],
      series(bars),
      atrMap([T0 - CANDLE_MS]),
      cfg({ leverage: 10, stakePct: 50 }),
      DEFAULT_COSTS,
    );
    expect(r.worstTrade).toBeGreaterThanOrEqual(-500);
    expect(r.endBalance).toBeGreaterThanOrEqual(500);
  });
});

describe("minimum notional", () => {
  const series = (bars: Kline[]) => new Map([["TESTUSDC", bars]]);

  it("skips signals whose order would be under the venue floor", () => {
    const bars = Array.from({ length: 5 }, (_, i) =>
      bar(T0 + i * CANDLE_MS, 100, 101.5, 99.9, 101),
    );
    const signals = bars.map(b => signal({ targetOpenTime: b.openTime }));
    // Balance 25, stake 15%, 5x => 25 * 0.15 * 5 = $18.75 notional. Clears $5,
    // but not a $25 floor.
    const placed = runBacktest(
      signals,
      series(bars),
      atrMap(bars.map(b => b.openTime - CANDLE_MS)),
      cfg({ startBalance: 25, stakePct: 15, leverage: 5, minNotional: 5, flattenOnClose: true }),
      FREE,
    );
    const blocked = runBacktest(
      signals,
      series(bars),
      atrMap(bars.map(b => b.openTime - CANDLE_MS)),
      cfg({ startBalance: 25, stakePct: 15, leverage: 5, minNotional: 25, flattenOnClose: true }),
      FREE,
    );

    expect(placed.trades).toBe(5);
    expect(placed.skippedUndersized).toBe(0);
    expect(blocked.trades).toBe(0);
    expect(blocked.skippedUndersized).toBe(5);
    expect(blocked.endBalance).toBe(25);
  });

  it("stops the account trading once a drawdown shrinks the stake below the floor", () => {
    // Every bar is a loser. Stake is a share of a falling balance, so the order
    // shrinks with the account: at 5x on the full balance a 1% stop costs 5% a
    // time, and once the balance is under $1 the $5 order floor is unreachable.
    const bars = Array.from({ length: 200 }, (_, i) =>
      bar(T0 + i * CANDLE_MS, 100, 100.2, 98, 98.5),
    );
    const signals = bars.map(b => signal({ targetOpenTime: b.openTime }));
    const r = runBacktest(
      signals,
      series(bars),
      atrMap(bars.map(b => b.openTime - CANDLE_MS)),
      cfg({ startBalance: 25, stakePct: 100, leverage: 5, minNotional: 5, flattenOnClose: true }),
      DEFAULT_COSTS,
    );

    expect(r.skippedUndersized).toBeGreaterThan(0);
    expect(r.trades).toBeLessThan(200);
    expect(r.trades + r.skippedUndersized).toBe(200);
    expect(r.endBalance).toBeGreaterThan(0); // quiet, not wiped out
    expect(r.endBalance).toBeLessThan(1); // and too small to place another order
  });
});

describe("applyTrailingGates", () => {
  const scoredRow = (t: number, probUp: number): ScoredSignal => ({
    symbol: "TESTUSDC",
    targetOpenTime: t,
    basisOpenTime: t - CANDLE_MS,
    probUp,
    ta: 0,
    mlGate: 0.6,
  });

  it("trades nothing until the warmup is satisfied", () => {
    const scored = Array.from({ length: 10 }, (_, i) =>
      scoredRow(T0 + i * CANDLE_MS, 0.9),
    );
    const all = applyStrategy(scored, "ml", 1);
    expect(applyTrailingGates(scored, all, { warmupSignals: 50 })).toHaveLength(0);
    expect(applyTrailingGates(scored, all, { warmupSignals: 5 }).length).toBeGreaterThan(0);
  });

  it("cannot see the future: a late confidence spike does not admit early bars", () => {
    // 60 dull bars, then 40 extremely confident ones. A full-sample percentile
    // would set a high bar from the start and reject the dull ones outright;
    // a trailing fit judges the dull ones only against other dull ones.
    const dull = Array.from({ length: 60 }, (_, i) => scoredRow(T0 + i * CANDLE_MS, 0.61));
    const sharp = Array.from({ length: 40 }, (_, i) =>
      scoredRow(T0 + (60 + i) * CANDLE_MS, 0.99),
    );
    const scored = [...dull, ...sharp];
    const all = applyStrategy(scored, "ml", 1);
    const gated = applyTrailingGates(scored, all, { warmupSignals: 10 });

    const earlyAdmitted = gated.filter(s => s.targetOpenTime < T0 + 60 * CANDLE_MS);
    expect(earlyAdmitted.length).toBeGreaterThan(0);
  });

  it("is unaffected by signals appended after the ones it judged", () => {
    // The decisive property: extending the sample must not retroactively change
    // which earlier bars were admitted.
    const base = Array.from({ length: 80 }, (_, i) =>
      scoredRow(T0 + i * CANDLE_MS, 0.55 + (i % 7) * 0.05),
    );
    const extra = Array.from({ length: 80 }, (_, i) =>
      scoredRow(T0 + (80 + i) * CANDLE_MS, 0.99),
    );

    const short = applyTrailingGates(base, applyStrategy(base, "ml", 1), {
      warmupSignals: 20,
    });
    const long = applyTrailingGates(
      [...base, ...extra],
      applyStrategy([...base, ...extra], "ml", 1),
      { warmupSignals: 20 },
    );
    const longEarly = long
      .filter(s => s.targetOpenTime < T0 + 80 * CANDLE_MS)
      .map(s => s.targetOpenTime);

    expect(longEarly).toEqual(short.map(s => s.targetOpenTime));
  });

  it("accepts signals in any input order, judging them chronologically", () => {
    const scored = Array.from({ length: 40 }, (_, i) =>
      scoredRow(T0 + i * CANDLE_MS, 0.5 + (i % 9) * 0.05),
    );
    const inOrder = applyTrailingGates(scored, applyStrategy(scored, "ml", 1), {
      warmupSignals: 10,
    }).map(s => s.targetOpenTime);

    const shuffled = [...scored].reverse();
    const outOfOrder = applyTrailingGates(shuffled, applyStrategy(shuffled, "ml", 1), {
      warmupSignals: 10,
    }).map(s => s.targetOpenTime);

    expect(outOfOrder.sort()).toEqual(inOrder.sort());
  });

  it("keeps pairs independent, so a listing date cannot leak across symbols", () => {
    const early = Array.from({ length: 40 }, (_, i) => ({
      ...scoredRow(T0 + i * CANDLE_MS, 0.9),
      symbol: "OLDUSDC",
    }));
    const late = Array.from({ length: 5 }, (_, i) => ({
      ...scoredRow(T0 + (100 + i) * CANDLE_MS, 0.9),
      symbol: "NEWUSDC",
    }));
    const scored = [...early, ...late];
    const gated = applyTrailingGates(scored, applyStrategy(scored, "ml", 1), {
      warmupSignals: 20,
    });

    // NEWUSDC has only 5 signals of its own; the older pair's history must not
    // count towards its warmup.
    expect(gated.some(s => s.symbol === "NEWUSDC")).toBe(false);
    expect(gated.some(s => s.symbol === "OLDUSDC")).toBe(true);
  });
});
