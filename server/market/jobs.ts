import { TRACKED_SYMBOLS } from "@shared/market";
import {
  finishJobRun,
  getModel,
  startJobRun,
  upsertFearGreed,
  upsertFundingRates,
  upsertOpenInterest,
} from "../db";
import { fetchFearGreed, fetchFundingHistory, fetchOpenInterest } from "./altdata";
import {
  loadMarketContext,
  predictSymbol,
  resolveOutcomes,
  seedHistory,
  syncAllSymbols,
  trainSymbol,
} from "./pipeline";

/** Retrain a model when its stored copy is older than this. */
const RETRAIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CycleSummary = {
  synced: Record<string, number>;
  resolved: number;
  wins: number;
  trained: string[];
  predictions: Array<{ symbol: string; direction?: string; confidence?: number; passesGate?: boolean; reason?: string }>;
  durationMs: number;
};

/**
 * The main 4H cycle, run just after each UTC candle close:
 * sync candles, resolve the prediction that just matured, retrain stale models,
 * then publish a prediction for the candle that just opened.
 *
 * Every step is idempotent, so a retried invocation is harmless.
 */
export async function runCycle(options: { force?: boolean } = {}): Promise<CycleSummary> {
  const started = Date.now();
  const synced = await syncAllSymbols();
  const { resolved, wins } = await resolveOutcomes();

  const context = await loadMarketContext();
  const trained: string[] = [];

  for (const symbol of TRACKED_SYMBOLS) {
    const existing = await getModel(symbol);
    const age = existing ? Date.now() - new Date(existing.trainedAt).getTime() : Infinity;
    if (options.force || !existing || age > RETRAIN_MAX_AGE_MS) {
      const result = await trainSymbol(symbol, context);
      if (result.trained) trained.push(symbol);
    }
  }

  const predictions = [];
  for (const symbol of TRACKED_SYMBOLS) {
    const result = await predictSymbol(symbol, context);
    predictions.push({
      symbol,
      direction: result.direction,
      confidence: result.confidence,
      passesGate: result.passesGate,
      reason: result.reason,
    });
  }

  return { synced, resolved, wins, trained, predictions, durationMs: Date.now() - started };
}

/** Wrap a job so every run is recorded in `job_runs` for the status strip. */
export async function withJobLog<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const id = await startJobRun(job);
  try {
    const result = await fn();
    await finishJobRun(id, "success", JSON.stringify(result));
    return result;
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    await finishJobRun(id, "error", message);
    throw error;
  }
}

/** Retrain every model unconditionally — used by the daily retrain schedule. */
export async function runRetrainAll(): Promise<Array<{ symbol: string; trained: boolean; gatedAccuracy?: number }>> {
  const context = await loadMarketContext();
  const out = [];
  for (const symbol of TRACKED_SYMBOLS) {
    const result = await trainSymbol(symbol, context);
    out.push({ symbol, trained: result.trained, gatedAccuracy: result.gatedAccuracy });
  }
  return out;
}

/**
 * One-time (or repair) bootstrap: backfill candles, train every pair, replay a
 * walk-forward track record, then publish the current prediction.
 */
export async function runBootstrap(replayCount = 100): Promise<{
  synced: Record<string, number>;
  trained: Array<{ symbol: string; trained: boolean; gatedAccuracy?: number; threshold?: number }>;
  seeded: Array<{ symbol: string; seeded: number }>;
  predictions: Array<{ symbol: string; direction?: string; confidence?: number }>;
}> {
  const synced = await syncAllSymbols();
  const context = await loadMarketContext();

  const trained = [];
  for (const symbol of TRACKED_SYMBOLS) {
    const result = await trainSymbol(symbol, context);
    trained.push({
      symbol,
      trained: result.trained,
      gatedAccuracy: result.gatedAccuracy,
      threshold: result.threshold,
    });
  }

  const seeded = [];
  for (const symbol of TRACKED_SYMBOLS) {
    seeded.push(await seedHistory(symbol, replayCount, context));
  }

  const predictions = [];
  for (const symbol of TRACKED_SYMBOLS) {
    const result = await predictSymbol(symbol, context);
    predictions.push({ symbol, direction: result.direction, confidence: result.confidence });
  }

  return { synced, trained, seeded, predictions };
}

export type AltDataSummary = {
  fearGreed: number;
  funding: Record<string, number>;
  openInterest: Record<string, number>;
  oiWindowDays: number | null;
};

/**
 * Refresh the non-price series.
 *
 * The reason this needs a SCHEDULE rather than a one-off backfill is open
 * interest: Binance's `openInterestHist` only serves the trailing 30 days, so
 * history exists only if it is collected as it happens. Miss a month and that
 * month is gone permanently. Funding and Fear & Greed are re-fetched too — both
 * are cheap and idempotent, and keeping them current means the feature set can
 * be switched on later without a backfill.
 */
export async function runAltDataSync(): Promise<AltDataSummary> {
  const fng = await fetchFearGreed();
  const fearGreedWritten = await upsertFearGreed(
    fng.map(p => ({ day: p.day, value: p.value, classification: p.classification })),
  );

  const funding: Record<string, number> = {};
  const openInterestCounts: Record<string, number> = {};
  let oldestOi: number | null = null;
  let newestOi: number | null = null;

  for (const symbol of TRACKED_SYMBOLS) {
    const rates = await fetchFundingHistory(symbol);
    funding[symbol] = await upsertFundingRates(
      rates.map(r => ({
        symbol,
        fundingTime: r.fundingTime,
        fundingRate: r.fundingRate,
        markPrice: r.markPrice,
      })),
    );

    const oi = await fetchOpenInterest(symbol);
    openInterestCounts[symbol] = await upsertOpenInterest(
      oi.map(r => ({
        symbol,
        ts: r.ts,
        openInterest: r.openInterest,
        openInterestValue: r.openInterestValue,
      })),
    );
    if (oi.length > 0) {
      oldestOi = oldestOi === null ? oi[0].ts : Math.min(oldestOi, oi[0].ts);
      newestOi = newestOi === null ? oi[oi.length - 1].ts : Math.max(newestOi, oi[oi.length - 1].ts);
    }
  }

  return {
    fearGreed: fearGreedWritten,
    funding,
    openInterest: openInterestCounts,
    oiWindowDays:
      oldestOi !== null && newestOi !== null
        ? Math.round((newestOi - oldestOi) / 86_400_000)
        : null,
  };
}
