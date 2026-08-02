/** The six Binance Futures USDC-margined perpetual pairs tracked by this dashboard. */
export const TRACKED_SYMBOLS = [
  "WLDUSDC",
  "WIFUSDC",
  "1000BONKUSDC",
  "UNIUSDC",
  "SUIUSDC",
  "DOGEUSDC",
] as const;

export type TrackedSymbol = (typeof TRACKED_SYMBOLS)[number];

/** Human-friendly base asset label per symbol. */
export const SYMBOL_LABELS: Record<string, string> = {
  WLDUSDC: "Worldcoin",
  WIFUSDC: "dogwifhat",
  "1000BONKUSDC": "Bonk (1000x)",
  UNIUSDC: "Uniswap",
  SUIUSDC: "Sui",
  DOGEUSDC: "Dogecoin",
};

export const INTERVAL = "4h" as const;

/** 4 hours in milliseconds — the candle period. */
export const CANDLE_MS = 4 * 60 * 60 * 1000;

/** Accuracy band the dashboard targets, expressed as fractions. */
export const TARGET_ACCURACY_MIN = 0.65;
export const TARGET_ACCURACY_MAX = 0.7;

/** Rolling window used for the live accuracy tracker. */
export const ACCURACY_WINDOW = 50;

/**
 * UTC open time of the candle that contains `ts`.
 * 4h candles on Binance start at 00:00 UTC, so flooring the epoch by CANDLE_MS
 * yields exactly 00/04/08/12/16/20 UTC boundaries.
 */
export function floorToCandle(ts: number): number {
  return Math.floor(ts / CANDLE_MS) * CANDLE_MS;
}

/** Open time of the most recent *closed* candle at time `ts`. */
export function lastClosedCandleOpen(ts: number = Date.now()): number {
  return floorToCandle(ts) - CANDLE_MS;
}

/** Open time of the candle currently forming at time `ts` (the prediction target). */
export function currentCandleOpen(ts: number = Date.now()): number {
  return floorToCandle(ts);
}

/** Epoch ms at which the currently forming candle closes. */
export function nextCandleCloseAt(ts: number = Date.now()): number {
  return floorToCandle(ts) + CANDLE_MS;
}

/** Format an epoch ms value as `YYYY-MM-DD HH:mm UTC`. */
export function formatUtc(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}

/** Format an epoch ms value as `HH:mm UTC`. */
export function formatUtcTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
