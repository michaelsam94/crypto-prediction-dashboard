import {
  ACCURACY_WINDOW,
  CANDLE_MS,
  TARGET_ACCURACY_MAX,
  TARGET_ACCURACY_MIN,
  TRACKED_SYMBOLS,
  currentCandleOpen,
  lastClosedCandleOpen,
  nextCandleCloseAt,
} from "@shared/market";
import { z } from "zod";
import {
  getCandles,
  getLatestPredictionPerSymbol,
  getModelSummaries,
  getPredictions,
  getRecentJobRuns,
} from "../db";
import { fetch24hStats } from "../market/binance";
import { publicProcedure, router } from "../_core/trpc";

const symbolSchema = z.enum(TRACKED_SYMBOLS);

export type AccuracyStats = {
  /** Win rate over resolved, gate-passing signals in the rolling window. */
  winRate: number | null;
  wins: number;
  losses: number;
  /** Resolved signals counted in the window (excludes flat candles). */
  resolved: number;
  /** Win rate over every resolved prediction regardless of the gate. */
  allSignalWinRate: number | null;
  allSignalResolved: number;
};

type PredictionRow = Awaited<ReturnType<typeof getPredictions>>[number];

/**
 * Compute rolling accuracy over the last `window` resolved predictions.
 * `threshold` isolates actionable (gate-passing) signals from stand-aside calls.
 */
export function computeAccuracy(
  rows: PredictionRow[],
  threshold: number,
  window = ACCURACY_WINDOW,
): AccuracyStats {
  const resolvedRows = rows.filter(r => r.outcome === "win" || r.outcome === "loss");

  const gated = resolvedRows.filter(r => r.confidence >= threshold).slice(0, window);
  const wins = gated.filter(r => r.outcome === "win").length;
  const losses = gated.length - wins;

  const all = resolvedRows.slice(0, window);
  const allWins = all.filter(r => r.outcome === "win").length;

  return {
    winRate: gated.length > 0 ? wins / gated.length : null,
    wins,
    losses,
    resolved: gated.length,
    allSignalWinRate: all.length > 0 ? allWins / all.length : null,
    allSignalResolved: all.length,
  };
}

export const marketRouter = router({
  /**
   * Static config the dashboard needs on first paint.
   *
   * These "no-argument" procedures declare an optional object input rather than
   * relying on an absent input. The React Query client serializes an omitted
   * input in a way that a strict void schema rejects, so an optional object is
   * the shape that works consistently from both the hooks and direct calls.
   */
  config: publicProcedure.input(z.object({}).optional()).query(() => ({
    symbols: TRACKED_SYMBOLS,
    candleMs: CANDLE_MS,
    accuracyWindow: ACCURACY_WINDOW,
    targetAccuracyMin: TARGET_ACCURACY_MIN,
    targetAccuracyMax: TARGET_ACCURACY_MAX,
  })),

  /** Clock state so the UI can count down to the next UTC 4H close. */
  clock: publicProcedure.input(z.object({}).optional()).query(() => {
    const now = Date.now();
    return {
      now,
      currentCandleOpen: currentCandleOpen(now),
      lastClosedCandleOpen: lastClosedCandleOpen(now),
      nextCloseAt: nextCandleCloseAt(now),
      msUntilClose: nextCandleCloseAt(now) - now,
    };
  }),

  /**
   * Everything the dashboard grid needs: live price, latest signal, rolling
   * accuracy, model metadata, and a recent candle window per pair.
   */
  overview: publicProcedure.input(z.object({}).optional()).query(async () => {
    const symbols = TRACKED_SYMBOLS.slice();

    const [latestPredictions, modelSummaries, stats] = await Promise.all([
      getLatestPredictionPerSymbol(symbols),
      getModelSummaries(),
      fetch24hStats(symbols).catch(() => ({}) as Record<string, never>),
    ]);

    const predictionBySymbol = new Map(latestPredictions.map(p => [p.symbol, p]));
    const modelBySymbol = new Map(modelSummaries.map(m => [m.symbol, m]));

    // Fetch each pair's history and candles concurrently. Running these in
    // parallel keeps the whole payload within a single round trip; the queries
    // are independent so there is no ordering requirement.
    const perPair = await Promise.all(
      symbols.map(async symbol => ({
        symbol,
        // The rolling window needs `ACCURACY_WINDOW` *resolved* gated rows, but
        // fetching 3x the window was dominating request time. 2x is enough to
        // fill the window in practice while roughly halving the row scan.
        history: await getPredictions(symbol, ACCURACY_WINDOW * 2),
        candles: await getCandles(symbol, 40),
      })),
    );
    const dataBySymbol = new Map(perPair.map(p => [p.symbol, p]));

    const pairs = symbols.map(symbol => {
      const { history = [], candles = [] } = dataBySymbol.get(symbol) ?? {};

        const model = modelBySymbol.get(symbol);
        const threshold = model?.confidenceThreshold ?? 0.5;
        const prediction = predictionBySymbol.get(symbol) ?? null;
        const live = (stats as Record<string, { lastPrice: number; priceChangePercent: number; quoteVolume: number }>)[symbol];
        const lastCandle = candles[candles.length - 1];

        return {
          symbol,
          price: live?.lastPrice ?? lastCandle?.close ?? null,
          change24hPct: live?.priceChangePercent ?? null,
          quoteVolume24h: live?.quoteVolume ?? null,
          prediction: prediction
            ? {
                direction: prediction.direction,
                confidence: prediction.confidence,
                probUp: prediction.probUp,
                targetOpenTime: prediction.targetOpenTime,
                basisOpenTime: prediction.basisOpenTime,
                basisClose: prediction.basisClose,
                outcome: prediction.outcome,
                createdAt: prediction.createdAt,
                passesGate: prediction.confidence >= threshold,
              }
            : null,
          accuracy: computeAccuracy(history, threshold),
          model: model
            ? {
                algorithm: model.algorithm,
                modelVersion: model.modelVersion,
                trainSamples: model.trainSamples,
                validationAccuracy: model.validationAccuracy,
                highConfidenceAccuracy: model.highConfidenceAccuracy,
                confidenceThreshold: model.confidenceThreshold,
                trainedAt: model.trainedAt,
                trainedThroughOpenTime: model.trainedThroughOpenTime,
              }
            : null,
          candles: candles.map(c => ({
            openTime: c.openTime,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })),
        };
    });

    return { pairs, generatedAt: Date.now() };
  }),

  /** Full prediction log for one pair, used by the detail view. */
  history: publicProcedure
    .input(z.object({ symbol: symbolSchema, limit: z.number().min(1).max(300).default(120) }))
    .query(async ({ input }) => {
      const [rows, models] = await Promise.all([
        getPredictions(input.symbol, input.limit),
        getModelSummaries(),
      ]);
      const model = models.find(m => m.symbol === input.symbol);
      const threshold = model?.confidenceThreshold ?? 0.5;
      return {
        symbol: input.symbol,
        threshold,
        accuracy: computeAccuracy(rows, threshold),
        rows: rows.map(r => ({
          id: r.id,
          targetOpenTime: r.targetOpenTime,
          direction: r.direction,
          confidence: r.confidence,
          outcome: r.outcome,
          basisClose: r.basisClose,
          resolvedClose: r.resolvedClose,
          realizedChangePct: r.realizedChangePct,
          passesGate: r.confidence >= threshold,
        })),
      };
    }),

  /** Candle series for the detail chart. */
  candles: publicProcedure
    .input(z.object({ symbol: symbolSchema, limit: z.number().min(20).max(500).default(120) }))
    .query(async ({ input }) => {
      const rows = await getCandles(input.symbol, input.limit);
      return rows.map(c => ({
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
    }),

  /** Pipeline health for the status strip. */
  jobs: publicProcedure.input(z.object({}).optional()).query(async () => {
    const runs = await getRecentJobRuns(12);
    return runs.map(r => ({
      id: r.id,
      job: r.job,
      status: r.status,
      detail: r.detail,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    }));
  }),
});
