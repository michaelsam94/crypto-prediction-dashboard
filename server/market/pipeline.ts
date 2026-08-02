import {
  ACCURACY_WINDOW,
  CANDLE_MS,
  TRACKED_SYMBOLS,
  lastClosedCandleOpen,
} from "@shared/market";
import type { InsertCandle, InsertPrediction } from "../../drizzle/schema";
import {
  deletePredictions,
  getCandleCount,
  getCandles,
  getLatestCandleOpenTime,
  getModel,
  getPendingPredictions,
  resolvePrediction,
  upsertCandles,
  upsertModel,
  upsertPredictions,
} from "../db";
import { closedOnly, fetchFullHistory, fetchKlines, type Kline } from "./binance";
import {
  generateHistoricalPredictions,
  predictNextCandle,
  trainForSymbol,
  trainOptionsFor,
} from "./engine";
import { buildMarketContext, FEATURE_NAMES, type MarketContext } from "./features";
import type { GbmModel } from "./gbm";

/** BTC perpetual supplies the market-context feature block. */
export const CONTEXT_SYMBOL = "BTCUSDT";

/** All symbols that need candle data stored: the six tracked pairs plus BTC. */
export const ALL_DATA_SYMBOLS = [...TRACKED_SYMBOLS, CONTEXT_SYMBOL];

function toInsertCandles(symbol: string, klines: Kline[]): InsertCandle[] {
  return klines.map(k => ({
    symbol,
    openTime: k.openTime,
    closeTime: k.closeTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    quoteVolume: k.quoteVolume,
    trades: k.trades,
    takerBuyBase: k.takerBuyBase,
  }));
}

function rowsToKlines(rows: Awaited<ReturnType<typeof getCandles>>): Kline[] {
  return rows.map(r => ({
    openTime: r.openTime,
    closeTime: r.closeTime,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    quoteVolume: r.quoteVolume,
    trades: r.trades,
    takerBuyBase: r.takerBuyBase,
  }));
}

/**
 * Backfill the full available history for a symbol. Safe to re-run: candles are
 * upserted on (symbol, openTime).
 */
export async function backfillSymbol(symbol: string): Promise<number> {
  const history = closedOnly(await fetchFullHistory(symbol));
  return upsertCandles(toInsertCandles(symbol, history));
}

/**
 * Incrementally sync the newest closed candles for a symbol. Fetches a small
 * window when history already exists, or falls back to a full backfill.
 */
export async function syncSymbol(symbol: string): Promise<{ fetched: number; upserted: number }> {
  const latest = await getLatestCandleOpenTime(symbol);
  const count = await getCandleCount(symbol);

  if (latest === null || count < 400) {
    const upserted = await backfillSymbol(symbol);
    return { fetched: upserted, upserted };
  }

  // Re-fetch from a few candles back so any late-revised candle is corrected.
  const startTime = latest - CANDLE_MS * 5;
  const fresh = closedOnly(await fetchKlines(symbol, { startTime, limit: 200 }));
  const upserted = await upsertCandles(toInsertCandles(symbol, fresh));
  return { fetched: fresh.length, upserted };
}

/** Sync every data symbol sequentially to stay friendly to Binance rate limits. */
export async function syncAllSymbols(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const symbol of ALL_DATA_SYMBOLS) {
    const { upserted } = await syncSymbol(symbol);
    out[symbol] = upserted;
  }
  return out;
}

/** Load the BTC context map from stored candles. */
export async function loadMarketContext(): Promise<MarketContext> {
  const rows = await getCandles(CONTEXT_SYMBOL);
  return buildMarketContext(rowsToKlines(rows));
}

export async function loadSymbolCandles(symbol: string, limit?: number): Promise<Kline[]> {
  return rowsToKlines(await getCandles(symbol, limit));
}

export type TrainResult = {
  symbol: string;
  trained: boolean
  trainSamples?: number;
  validationAccuracy?: number;
  gatedAccuracy?: number;
  threshold?: number;
  reason?: string;
};

/** Train and persist the model for one symbol. */
export async function trainSymbol(symbol: string, context?: MarketContext): Promise<TrainResult> {
  const ctx = context ?? (await loadMarketContext());
  const candles = await loadSymbolCandles(symbol);
  if (candles.length < 400) {
    return { symbol, trained: false, reason: `only ${candles.length} candles stored` };
  }

  const trained = trainForSymbol(candles, ctx, trainOptionsFor(symbol));
  if (!trained) {
    return { symbol, trained: false, reason: "insufficient labelled rows" };
  }

  await upsertModel({
    symbol,
    algorithm: "gradient_boosting",
    modelVersion: trained.modelVersion,
    payload: JSON.stringify(trained.model),
    trainSamples: trained.trainSamples,
    validationAccuracy: trained.validation.overallAccuracy,
    highConfidenceAccuracy: trained.validation.highConfidenceAccuracy,
    confidenceThreshold: trained.validation.chosenThreshold,
    featureNames: JSON.stringify(FEATURE_NAMES),
    trainedThroughOpenTime: trained.trainedThroughOpenTime,
  });

  return {
    symbol,
    trained: true,
    trainSamples: trained.trainSamples,
    validationAccuracy: trained.validation.overallAccuracy,
    gatedAccuracy: trained.validation.highConfidenceAccuracy,
    threshold: trained.validation.chosenThreshold,
  };
}

function parseModel(payload: string): GbmModel | null {
  try {
    const parsed = JSON.parse(payload) as GbmModel;
    return parsed && parsed.kind === "gbm" ? parsed : null;
  } catch {
    return null;
  }
}

export type PredictResult = {
  symbol: string;
  created: boolean;
  direction?: "LONG" | "SHORT";
  confidence?: number;
  passesGate?: boolean;
  targetOpenTime?: number;
  reason?: string;
};

/**
 * Produce and store the prediction for the candle currently forming, based on
 * the last closed candle. Idempotent per (symbol, targetOpenTime).
 */
export async function predictSymbol(
  symbol: string,
  context?: MarketContext,
): Promise<PredictResult> {
  const modelRow = await getModel(symbol);
  if (!modelRow) return { symbol, created: false, reason: "no trained model" };

  const model = parseModel(modelRow.payload);
  if (!model) return { symbol, created: false, reason: "model payload unreadable" };

  const ctx = context ?? (await loadMarketContext());
  // 400 candles is ample for the 60-bar warmup plus indicator lookbacks.
  const candles = await loadSymbolCandles(symbol, 400);
  if (candles.length < 100) return { symbol, created: false, reason: "not enough candles" };

  const output = predictNextCandle(model, candles, modelRow.confidenceThreshold, ctx);
  if (!output) return { symbol, created: false, reason: "feature/model mismatch" };

  const targetOpenTime = output.basisOpenTime + CANDLE_MS;

  const row: InsertPrediction = {
    symbol,
    targetOpenTime,
    basisOpenTime: output.basisOpenTime,
    direction: output.direction,
    confidence: output.confidence,
    probUp: output.probUp,
    basisClose: output.basisClose,
    outcome: "pending",
    modelVersion: modelRow.modelVersion,
    features: JSON.stringify(output.features),
  };
  await upsertPredictions([row]);

  return {
    symbol,
    created: true,
    direction: output.direction,
    confidence: output.confidence,
    passesGate: output.passesGate,
    targetOpenTime,
  };
}

/**
 * Resolve pending predictions whose target candle has closed. A prediction is a
 * win when the realized direction matches; a candle that closes exactly at its
 * open is recorded as `flat` and excluded from win-rate maths.
 */
export async function resolveOutcomes(): Promise<{ resolved: number; wins: number }> {
  const pending = await getPendingPredictions(1000);
  if (pending.length === 0) return { resolved: 0, wins: 0 };

  const cutoff = lastClosedCandleOpen();
  const bySymbol = new Map<string, typeof pending>();
  for (const p of pending) {
    if (p.targetOpenTime > cutoff) continue;
    const list = bySymbol.get(p.symbol) ?? [];
    list.push(p);
    bySymbol.set(p.symbol, list);
  }

  let resolved = 0;
  let wins = 0;

  for (const [symbol, items] of Array.from(bySymbol.entries())) {
    const candles = await loadSymbolCandles(symbol);
    const byOpenTime = new Map(candles.map(c => [c.openTime, c]));

    for (const p of items) {
      const candle = byOpenTime.get(p.targetOpenTime);
      if (!candle) continue;

      const changePct = ((candle.close - candle.open) / candle.open) * 100;
      let outcome: "win" | "loss" | "flat";
      if (candle.close === candle.open) outcome = "flat";
      else if (p.direction === "LONG") outcome = candle.close > candle.open ? "win" : "loss";
      else outcome = candle.close < candle.open ? "win" : "loss";

      await resolvePrediction(p.id, outcome, candle.close, changePct);
      resolved++;
      if (outcome === "win") wins++;
    }
  }

  return { resolved, wins };
}

/**
 * Seed a real out-of-sample track record by replaying walk-forward predictions
 * over recent history, then resolving them against actual candles. This gives
 * the rolling accuracy tracker genuine data on day one — every replayed call
 * came from a model that had not seen the candle it was predicting.
 */
export async function seedHistory(
  symbol: string,
  count = ACCURACY_WINDOW * 2,
  context?: MarketContext,
): Promise<{ symbol: string; seeded: number }> {
  const ctx = context ?? (await loadMarketContext());
  const candles = await loadSymbolCandles(symbol);
  if (candles.length < 400) return { symbol, seeded: 0 };

  const replay = generateHistoricalPredictions(candles, count, ctx, trainOptionsFor(symbol));
  if (replay.length === 0) return { symbol, seeded: 0 };

  const modelRow = await getModel(symbol);
  const byOpenTime = new Map(candles.map(c => [c.openTime, c]));

  const rows: InsertPrediction[] = replay.map(r => {
    const target = byOpenTime.get(r.targetOpenTime);
    const changePct = target ? ((target.close - target.open) / target.open) * 100 : null;
    let outcome: "pending" | "win" | "loss" | "flat" = "pending";
    if (target) {
      if (target.close === target.open) outcome = "flat";
      else if (r.direction === "LONG") outcome = target.close > target.open ? "win" : "loss";
      else outcome = target.close < target.open ? "win" : "loss";
    }
    return {
      symbol,
      targetOpenTime: r.targetOpenTime,
      basisOpenTime: r.basisOpenTime,
      direction: r.direction,
      confidence: r.confidence,
      probUp: r.probUp,
      basisClose: r.basisClose,
      outcome,
      resolvedClose: target?.close ?? null,
      realizedChangePct: changePct,
      modelVersion: modelRow?.modelVersion ?? "replay",
      resolvedAt: target ? new Date() : null,
    };
  });

  await upsertPredictions(rows);
  return { symbol, seeded: rows.length };
}

/** Wipe and regenerate a symbol's prediction history. */
export async function resetAndSeed(symbol: string, count = ACCURACY_WINDOW * 2) {
  await deletePredictions(symbol);
  return seedHistory(symbol, count);
}
