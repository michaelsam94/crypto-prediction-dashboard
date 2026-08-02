import { describe, expect, it } from "vitest";
import type { Kline } from "./binance";
import {
  buildDataset,
  predictNextCandle,
  selectThreshold,
  trainForSymbol,
  trainOptionsFor,
} from "./engine";
import { TRACKED_SYMBOLS } from "@shared/market";

const CANDLE_MS = 4 * 60 * 60 * 1000;

/** Learnable synthetic series: direction depends on the prior candle's sign. */
function makeLearnableSeries(count: number): Kline[] {
  const out: Kline[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const up = Math.sin(i / 2) > 0;
    const open = price;
    const close = up ? open * 1.01 : open * 0.99;
    price = close;
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.996;
    const volume = 900 + (i % 11) * 40;
    out.push({
      openTime: i * CANDLE_MS,
      closeTime: (i + 1) * CANDLE_MS - 1,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: volume * close,
      trades: 400 + i,
      takerBuyBase: volume * (up ? 0.6 : 0.4),
    });
  }
  return out;
}

describe("trainOptionsFor", () => {
  it("returns options for every tracked symbol", () => {
    for (const symbol of TRACKED_SYMBOLS) {
      const opts = trainOptionsFor(symbol);
      expect(opts.trees).toBeGreaterThan(0);
      expect(opts.learningRate).toBeGreaterThan(0);
      expect(opts.depth).toBeGreaterThan(0);
    }
  });

  it("falls back to defaults for unknown symbols", () => {
    expect(trainOptionsFor("NOTREAL")).toBeDefined();
  });
});

describe("selectThreshold", () => {
  it("returns a neutral gate for an empty curve", () => {
    expect(selectThreshold([])).toMatchObject({ threshold: 0.5, count: 0 });
  });

  it("prefers the most accurate gate that still has coverage", () => {
    const chosen = selectThreshold([
      { threshold: 0.5, accuracy: 0.52, coverage: 1, count: 500 },
      { threshold: 0.56, accuracy: 0.58, coverage: 0.4, count: 200 },
      { threshold: 0.62, accuracy: 0.61, coverage: 0.25, count: 120 },
    ]);
    expect(chosen.threshold).toBeCloseTo(0.62, 6);
  });

  it("ignores gates whose sample count is too small to trust", () => {
    const chosen = selectThreshold([
      { threshold: 0.5, accuracy: 0.54, coverage: 1, count: 800 },
      { threshold: 0.9, accuracy: 0.99, coverage: 0.002, count: 2 },
    ]);
    expect(chosen.threshold).toBeCloseTo(0.5, 6);
  });
});

describe("buildDataset", () => {
  it("pairs every feature vector with a resolved label", () => {
    const dataset = buildDataset(makeLearnableSeries(220));
    expect(dataset.X.length).toBe(dataset.y.length);
    expect(dataset.X.length).toBe(dataset.rows.length);
    expect(dataset.X.length).toBeGreaterThan(0);
    for (const label of dataset.y) {
      expect(label === 0 || label === 1).toBe(true);
    }
  });
});

describe("predictNextCandle", () => {
  // buildDataset requires at least 300 labelled rows before training proceeds,
  // and the indicator warmup consumes roughly the first 50 candles.
  const candles = makeLearnableSeries(420);
  const trained = trainForSymbol(candles, undefined, trainOptionsFor("UNIUSDC"));

  it("trains a model on a learnable series", () => {
    expect(trained).not.toBeNull();
    expect(trained!.model.featureCount).toBeGreaterThan(0);
  });

  it("returns LONG or SHORT with confidence in [0.5, 1]", () => {
    const out = predictNextCandle(trained!.model, candles, trained!.confidenceThreshold);
    expect(out).not.toBeNull();
    expect(["LONG", "SHORT"]).toContain(out!.direction);
    expect(out!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(out!.confidence).toBeLessThanOrEqual(1);
  });

  it("derives direction from probUp consistently", () => {
    const out = predictNextCandle(trained!.model, candles, trained!.confidenceThreshold)!;
    expect(out.direction).toBe(out.probUp >= 0.5 ? "LONG" : "SHORT");
    expect(out.confidence).toBeCloseTo(Math.max(out.probUp, 1 - out.probUp), 10);
  });

  it("bases the prediction on the last closed candle", () => {
    const out = predictNextCandle(trained!.model, candles, trained!.confidenceThreshold)!;
    const last = candles[candles.length - 1];
    expect(out.basisOpenTime).toBe(last.openTime);
    expect(out.basisClose).toBe(last.close);
  });

  it("sets passesGate strictly by comparing confidence to the gate", () => {
    const lenient = predictNextCandle(trained!.model, candles, 0)!;
    expect(lenient.passesGate).toBe(true);

    const impossible = predictNextCandle(trained!.model, candles, 1.01)!;
    expect(impossible.passesGate).toBe(false);
  });

  it("returns null when there is not enough history for the feature warmup", () => {
    const out = predictNextCandle(trained!.model, makeLearnableSeries(10), 0.5);
    expect(out).toBeNull();
  });
});
