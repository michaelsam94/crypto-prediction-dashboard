import { describe, expect, it } from "vitest";
import {
  CANDLE_MS,
  SYMBOL_LABELS,
  TARGET_ACCURACY_MAX,
  TARGET_ACCURACY_MIN,
  TRACKED_SYMBOLS,
  currentCandleOpen,
  floorToCandle,
  formatUtc,
  formatUtcTime,
  lastClosedCandleOpen,
  nextCandleCloseAt,
} from "./market";

/** 2026-08-02 05:17:33 UTC — deliberately mid-candle. */
const MID_CANDLE = Date.UTC(2026, 7, 2, 5, 17, 33);

describe("tracked symbols", () => {
  it("covers exactly the six requested Binance Futures USDC pairs", () => {
    expect([...TRACKED_SYMBOLS]).toEqual([
      "WLDUSDC",
      "WIFUSDC",
      "1000BONKUSDC",
      "UNIUSDC",
      "SUIUSDC",
      "DOGEUSDC",
    ]);
  });

  it("has a display label for every symbol", () => {
    for (const symbol of TRACKED_SYMBOLS) {
      expect(SYMBOL_LABELS[symbol]).toBeTruthy();
    }
  });
});

describe("target band", () => {
  it("is the 65-70% range the user asked for", () => {
    expect(TARGET_ACCURACY_MIN).toBeCloseTo(0.65, 10);
    expect(TARGET_ACCURACY_MAX).toBeCloseTo(0.7, 10);
  });
});

describe("UTC candle alignment", () => {
  it("uses a 4 hour candle period", () => {
    expect(CANDLE_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("floors a mid-candle timestamp to its UTC 4H boundary", () => {
    expect(floorToCandle(MID_CANDLE)).toBe(Date.UTC(2026, 7, 2, 4, 0, 0));
  });

  it("only ever produces 00/04/08/12/16/20 UTC boundaries", () => {
    const allowed = new Set([0, 4, 8, 12, 16, 20]);
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 13, 59]) {
        const open = floorToCandle(Date.UTC(2026, 7, 2, h, m, 0));
        const d = new Date(open);
        expect(allowed.has(d.getUTCHours())).toBe(true);
        expect(d.getUTCMinutes()).toBe(0);
        expect(d.getUTCSeconds()).toBe(0);
      }
    }
  });

  it("is idempotent on an exact boundary", () => {
    const boundary = Date.UTC(2026, 7, 2, 8, 0, 0);
    expect(floorToCandle(boundary)).toBe(boundary);
  });

  it("treats the containing candle as the forming candle", () => {
    expect(currentCandleOpen(MID_CANDLE)).toBe(Date.UTC(2026, 7, 2, 4, 0, 0));
  });

  it("points lastClosedCandleOpen one period behind the forming candle", () => {
    expect(lastClosedCandleOpen(MID_CANDLE)).toBe(Date.UTC(2026, 7, 2, 0, 0, 0));
    expect(currentCandleOpen(MID_CANDLE) - lastClosedCandleOpen(MID_CANDLE)).toBe(CANDLE_MS);
  });

  it("computes the next close as the end of the forming candle", () => {
    expect(nextCandleCloseAt(MID_CANDLE)).toBe(Date.UTC(2026, 7, 2, 8, 0, 0));
    expect(nextCandleCloseAt(MID_CANDLE)).toBeGreaterThan(MID_CANDLE);
  });

  it("rolls the boundary across a UTC day change", () => {
    const lateNight = Date.UTC(2026, 7, 2, 23, 45, 0);
    expect(floorToCandle(lateNight)).toBe(Date.UTC(2026, 7, 2, 20, 0, 0));
    expect(nextCandleCloseAt(lateNight)).toBe(Date.UTC(2026, 7, 3, 0, 0, 0));
  });
});

describe("UTC formatting", () => {
  it("formats a full timestamp in UTC with an explicit suffix", () => {
    expect(formatUtc(Date.UTC(2026, 7, 2, 4, 0, 0))).toBe("2026-08-02 04:00 UTC");
  });

  it("zero-pads single digit components", () => {
    expect(formatUtc(Date.UTC(2026, 0, 5, 8, 7, 0))).toBe("2026-01-05 08:07 UTC");
  });

  it("formats time only in UTC", () => {
    expect(formatUtcTime(Date.UTC(2026, 7, 2, 20, 0, 0))).toBe("20:00 UTC");
  });
});

