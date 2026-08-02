import { describe, expect, it } from "vitest";
import { bollinger, ema, macd, rsi, sma, stddev } from "./indicators";

/** Deterministic ramp used to check monotonic behaviour of trend indicators. */
const ramp = Array.from({ length: 60 }, (_, i) => 100 + i);

describe("sma", () => {
  it("averages the trailing window", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[2]).toBeCloseTo(2, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it("leaves the warmup region null", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
  });
});

describe("ema", () => {
  it("tracks a constant series exactly", () => {
    const out = ema(new Array(30).fill(50), 10);
    expect(out[29]).toBeCloseTo(50, 8);
  });

  it("lags behind a rising series", () => {
    const out = ema(ramp, 10);
    const last = out[ramp.length - 1];
    expect(last).not.toBeNull();
    expect(last!).toBeLessThan(ramp[ramp.length - 1]);
  });
});

describe("stddev", () => {
  it("is zero for a flat series", () => {
    const out = stddev(new Array(30).fill(7), 20);
    expect(out[29]).toBeCloseTo(0, 10);
  });
});

describe("rsi", () => {
  it("saturates near 100 for an uninterrupted uptrend", () => {
    const out = rsi(ramp, 14);
    expect(out[ramp.length - 1]!).toBeGreaterThan(95);
  });

  it("saturates near 0 for an uninterrupted downtrend", () => {
    const out = rsi(ramp.slice().reverse(), 14);
    expect(out[ramp.length - 1]!).toBeLessThan(5);
  });

  it("stays within 0-100 on noisy input", () => {
    const noisy = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    for (const v of rsi(noisy, 14)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("macd", () => {
  it("produces a positive line in a sustained uptrend", () => {
    const { macd: macdLine, signal, histogram } = macd(ramp, 12, 26, 9);
    const i = ramp.length - 1;
    expect(macdLine[i]!).toBeGreaterThan(0);
    expect(signal[i]).not.toBeNull();
    expect(histogram[i]).not.toBeNull();
  });

  it("keeps histogram equal to line minus signal", () => {
    const { macd: macdLine, signal, histogram } = macd(ramp, 12, 26, 9);
    const i = ramp.length - 1;
    expect(histogram[i]!).toBeCloseTo(macdLine[i]! - signal[i]!, 10);
  });
});

describe("bollinger", () => {
  it("collapses to zero width on a flat series", () => {
    const { width } = bollinger(new Array(40).fill(10), 20, 2);
    expect(width[39]!).toBeCloseTo(0, 10);
  });

  it("reports percentB inside the band for mid-range prices", () => {
    const series = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 3);
    const { percentB } = bollinger(series, 20, 2);
    const p = percentB[series.length - 1];
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThanOrEqual(0);
    expect(p!).toBeLessThanOrEqual(1);
  });
});
