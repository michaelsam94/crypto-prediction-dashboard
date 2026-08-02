import { describe, expect, it } from "vitest";
import type { Kline } from "./binance";
import {
  CONTEXT_FEATURE_COUNT,
  FEATURE_NAMES,
  buildFeatureMatrix,
  buildLabels,
  buildMarketContext,
} from "./features";

const CANDLE_MS = 4 * 60 * 60 * 1000;

/**
 * Synthetic 4H series with deterministic drift plus an oscillation, so every
 * indicator has enough variation to produce finite values.
 */
function makeSeries(count: number, startOpen = 0): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 0.35 + Math.sin(i / 4) * 2.5;
    const open = base;
    const close = base + Math.cos(i / 3) * 1.2;
    const high = Math.max(open, close) + 0.6;
    const low = Math.min(open, close) - 0.6;
    const volume = 1000 + (i % 9) * 55;
    out.push({
      openTime: startOpen + i * CANDLE_MS,
      closeTime: startOpen + (i + 1) * CANDLE_MS - 1,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: volume * close,
      trades: 500 + i,
      takerBuyBase: volume * 0.5,
    });
  }
  return out;
}

describe("buildFeatureMatrix", () => {
  const candles = makeSeries(200);
  const rows = buildFeatureMatrix(candles);

  it("emits one vector per usable candle after the indicator warmup", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(candles.length);
  });

  it("emits vectors matching the declared feature contract length", () => {
    for (const row of rows) {
      expect(row.values).toHaveLength(FEATURE_NAMES.length);
    }
  });

  it("produces only finite numbers", () => {
    for (const row of rows) {
      for (const v of row.values) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("aligns each row to a real UTC 4H candle open time", () => {
    const openTimes = new Set(candles.map(c => c.openTime));
    for (const row of rows) {
      expect(openTimes.has(row.openTime)).toBe(true);
      expect(row.openTime % CANDLE_MS).toBe(0);
    }
  });

  it("keeps rows in ascending time order", () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].openTime).toBeGreaterThan(rows[i - 1].openTime);
    }
  });

  it("zero-fills the BTC context block when no context is supplied", () => {
    const row = rows[rows.length - 1];
    const contextSlice = row.values.slice(FEATURE_NAMES.length - CONTEXT_FEATURE_COUNT);
    expect(contextSlice).toHaveLength(CONTEXT_FEATURE_COUNT);
    for (const v of contextSlice) expect(v).toBe(0);
  });

  it("fills the BTC context block when context is supplied", () => {
    const btc = makeSeries(200);
    const context = buildMarketContext(btc);
    const withCtx = buildFeatureMatrix(candles, context);
    const row = withCtx[withCtx.length - 1];
    const contextSlice = row.values.slice(FEATURE_NAMES.length - CONTEXT_FEATURE_COUNT);
    expect(contextSlice.some(v => v !== 0)).toBe(true);
  });
});

describe("buildLabels", () => {
  const candles = makeSeries(160);
  const rows = buildFeatureMatrix(candles);
  const labels = buildLabels(candles, rows);

  it("returns one label slot per feature row", () => {
    expect(labels).toHaveLength(rows.length);
  });

  it("labels 1 when the following candle closes above its open", () => {
    const byOpenTime = new Map(candles.map(c => [c.openTime, c]));
    labels.forEach((label, i) => {
      if (label === null) return;
      const next = byOpenTime.get(rows[i].openTime + CANDLE_MS);
      expect(next).toBeDefined();
      expect(label).toBe(next!.close >= next!.open ? 1 : 0);
    });
  });

  it("leaves the final row unlabelled because its target candle has not closed", () => {
    expect(labels[labels.length - 1]).toBeNull();
  });
});
