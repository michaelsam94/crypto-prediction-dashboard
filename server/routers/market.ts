import {
  ACCURACY_WINDOW,
  CANDLE_MS,
  DEFAULT_BLEND_WEIGHT,
  TARGET_ACCURACY_MAX,
  TARGET_ACCURACY_MIN,
  TRACKED_SYMBOLS,
  currentCandleOpen,
  lastClosedCandleOpen,
  nextCandleCloseAt,
} from "@shared/market";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  getCandles,
  getLatestPredictionPerSymbol,
  getModelSummaries,
  getPredictionRange,
  getPredictions,
  getPredictionsInRange,
  getBacktestSymbols,
  getRecentJobRuns,
} from "../db";
import { fetch24hStats, type Kline } from "../market/binance";
import {
  DEFAULT_GATE_WARMUP,
  FUNDING_PER_8H,
  MAINTENANCE_MARGIN_RATE,
  MAKER_FEE,
  MIN_NOTIONAL,
  SLIPPAGE,
  TAKER_FEE,
  applyStrategy,
  applyTrailingGates,
  atrPercentByOpenTime,
  runBacktest,
  taScoreByOpenTime,
  type CostModel,
  type ScoredSignal,
} from "../market/backtest";
import { runScreener } from "../market/screener";
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
        // 300 rather than the 40 the sparkline needs: the TA composite runs off
        // the same feature matrix the backtest uses and needs indicator warmup.
        candles: await getCandles(symbol, 300),
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

        // The blended call — what the live rig and the backtest actually trade.
        // Built through applyStrategy so the home page cannot drift from them:
        // showing the ML-only direction here was why the dashboard read SHORT
        // while the bot went LONG on the same bar.
        const ta = prediction
          ? (taScoreByOpenTime(candles as unknown as Kline[]).get(prediction.basisOpenTime) ??
            null)
          : null;
        const blended =
          prediction && ta !== null
            ? applyStrategy(
                [
                  {
                    symbol,
                    targetOpenTime: prediction.targetOpenTime,
                    basisOpenTime: prediction.basisOpenTime,
                    probUp: prediction.probUp,
                    ta,
                    mlGate: threshold,
                  },
                ],
                "blend",
                DEFAULT_BLEND_WEIGHT,
              )[0] ?? null
            : null;

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
          /**
           * The traded call: 0.6 x ML + 0.4 x TA. `ml` is the same probability
           * the `prediction` block reports, restated on [-1, +1] so the two
           * components can be compared side by side.
           */
          blend: blended
            ? {
                direction: blended.direction,
                score: blended.score,
                confidence: blended.confidence,
                ml: 2 * prediction!.probUp - 1,
                ta,
                weight: DEFAULT_BLEND_WEIGHT,
                agreesWithMl: blended.direction === prediction!.direction,
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
          // Only the tail is drawn; the rest was warmup for the TA composite.
          candles: candles.slice(-40).map(c => ({
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

  /** Every pair that has stored walk-forward predictions to replay. */
  backtestSymbols: publicProcedure.input(z.object({}).optional()).query(async () => {
    const rows = await getBacktestSymbols();
    return {
      symbols: rows,
      tracked: TRACKED_SYMBOLS.slice(),
    };
  }),

  /** Bounds for the backtest date picker: the span that actually has signals. */
  backtestRange: publicProcedure.input(z.object({}).optional()).query(async () => {
    const range = await getPredictionRange();
    return range ?? { min: null, max: null };
  }),

  /**
   * The current bar's signal per symbol, for an external execution rig.
   *
   * This exists so the live trader and the backtest cannot disagree about what
   * a signal IS. Both call `applyStrategy` on the same stored walk-forward
   * prediction and the same frozen TA composite, so "blend 0.6/0.4" means one
   * thing across both systems rather than two models wearing the same label.
   * The bracket basis (ATR% of the signal bar) is returned for the same reason.
   *
   * Freshness is the caller's to enforce and is made impossible to miss:
   * `currentBar` is the bar forming right now, and every signal carries
   * `ageBars`. A consumer placing orders MUST require `ageBars === 0` — the 4H
   * cycle writes predictions at :01 past the bar, so a rig that decides at the
   * open will race it and see the previous bar unless it checks.
   */
  liveSignals: publicProcedure
    .input(
      z.object({
        strategy: z.enum(["ml", "ta", "blend"]).default("blend"),
        blendWeight: z.number().min(0).max(1).default(0.6),
        symbols: z.array(z.string().min(3).max(32)).min(1).optional(),
      }),
    )
    .query(async ({ input }) => {
      const now = Date.now();
      const currentBar = currentCandleOpen(now);
      const requested = input.symbols ?? TRACKED_SYMBOLS.slice();

      const models = await getModelSummaries();
      const gates = new Map(models.map(m => [m.symbol, m.confidenceThreshold ?? 0.5]));

      const scored: ScoredSignal[] = [];
      const atrBySymbol = new Map<string, number | null>();
      /** Why a requested symbol produced no signal, so the caller can log it. */
      const missing: Array<{ symbol: string; reason: string }> = [];

      for (const symbol of requested) {
        const [rows, candles] = await Promise.all([
          getPredictions(symbol, 1),
          getCandles(symbol),
        ]);
        const latest = rows[0];
        if (!latest) {
          missing.push({ symbol, reason: "no stored prediction" });
          continue;
        }
        if (candles.length === 0) {
          missing.push({ symbol, reason: "no candles" });
          continue;
        }
        const series = candles as unknown as Kline[];
        const ta = taScoreByOpenTime(series).get(latest.basisOpenTime) ?? null;
        if (ta === null && input.strategy !== "ml") {
          missing.push({ symbol, reason: "TA composite unavailable for the signal bar" });
          continue;
        }
        atrBySymbol.set(
          symbol,
          atrPercentByOpenTime(series).get(latest.basisOpenTime) ?? null,
        );
        scored.push({
          symbol,
          targetOpenTime: latest.targetOpenTime,
          basisOpenTime: latest.basisOpenTime,
          probUp: latest.probUp,
          ta,
          mlGate: gates.get(symbol) ?? 0.5,
        });
      }

      // The same call the backtest makes — that identity is the whole point.
      const applied = applyStrategy(scored, input.strategy, input.blendWeight);
      const probBySymbol = new Map(scored.map(s => [s.symbol, s]));

      const signals = applied.map(s => {
        const raw = probBySymbol.get(s.symbol);
        const ageBars = Math.round((currentBar - s.targetOpenTime) / CANDLE_MS);
        return {
          symbol: s.symbol,
          targetOpenTime: s.targetOpenTime,
          basisOpenTime: s.basisOpenTime,
          direction: s.direction,
          score: s.score,
          confidence: s.confidence,
          probUp: raw?.probUp ?? null,
          ta: raw?.ta ?? null,
          /** ATR% of the signal bar — multiply by tpK/slK for the brackets. */
          atrPct: atrBySymbol.get(s.symbol) ?? null,
          gate: s.gate,
          passesGate: s.confidence >= s.gate,
          ageBars,
          /** True only when this signal is for the bar forming right now. */
          fresh: ageBars === 0,
        };
      });
      signals.sort((a, b) => a.symbol.localeCompare(b.symbol));

      return {
        serverTime: now,
        currentBar,
        candleMs: CANDLE_MS,
        strategy: input.strategy,
        blendWeight: input.blendWeight,
        signals,
        missing,
      };
    }),

  /**
   * Account simulation over the stored walk-forward predictions, run twice:
   * once over every signal, once over only those clearing their pair's gate.
   */
  backtest: publicProcedure
    .input(
      z.object({
        startBalance: z.number().min(1).max(1_000_000).default(25),
        leverage: z.number().min(1).max(50).default(5),
        from: z.number(),
        to: z.number(),
        tpK: z.number().min(0.1).max(10).default(1.0),
        slK: z.number().min(0.1).max(10).default(0.5),
        strategy: z.enum(["ml", "ta", "blend"]).default("ml"),
        blendWeight: z.number().min(0).max(1).default(0.6),
        stakePct: z.number().min(0.1).max(100).default(15),
        maxTotalPct: z.number().min(1).max(100).default(60),
        flattenOnClose: z.boolean().default(true),
        symbols: z.array(z.string().min(3).max(32)).min(1).optional(),
        // Cost model. Defaults are the live USDC tier plus Binance's baseline
        // funding; raising them is how you find out whether an edge is real.
        takerFee: z.number().min(0).max(0.01).default(TAKER_FEE),
        slippage: z.number().min(0).max(0.01).default(SLIPPAGE),
        makerFee: z.number().min(0).max(0.01).default(MAKER_FEE),
        fundingPer8h: z.number().min(0).max(0.01).default(FUNDING_PER_8H),
        entryIsMaker: z.boolean().default(true),
        gateWarmup: z.number().int().min(0).max(5000).default(DEFAULT_GATE_WARMUP),
        minNotional: z.number().min(0).max(10_000).default(MIN_NOTIONAL),
        maintenanceMarginRate: z.number().min(0).max(0.5).default(MAINTENANCE_MARGIN_RATE),
        topUpAmount: z.number().min(0).max(1_000_000).default(0),
        topUpPeriod: z.enum(["daily", "weekly", "monthly", "yearly"]).default("monthly"),
        bracketMode: z.enum(["atr", "fixed"]).default("atr"),
      }),
    )
    .query(async ({ input }) => {
      if (input.to < input.from) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "`to` is before `from`." });
      }

      const models = await getModelSummaries();
      const gates = new Map(models.map(m => [m.symbol, m.confidenceThreshold ?? 0.5]));

      const seriesBySymbol = new Map<string, Kline[]>();
      const atrBySymbol = new Map<string, Map<number, number>>();
      const scored: ScoredSignal[] = [];

      // Only symbols that actually have predictions can be replayed; silently
      // dropping unknown ones beats returning an empty, unexplained result.
      //
      // The default is EVERY pair with stored predictions, not the tracked
      // list. Defaulting to a hand-picked subset builds the survivorship in
      // before a single trade is simulated: those pairs were chosen because
      // they had already validated well on this same history.
      const available = new Set((await getBacktestSymbols()).map(r => r.symbol));
      const requested = input.symbols ?? Array.from(available).sort();
      const chosen = requested.filter(s => available.has(s));
      if (chosen.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "None of the requested pairs have stored predictions. " +
            `Available: ${Array.from(available).sort().join(", ") || "none"}`,
        });
      }
      /**
       * When each pair actually existed. A pair listed in 2024 contributes
       * nothing to a window starting in 2021, and reporting one span for the
       * whole portfolio hides that — it reads as though every pair traded the
       * full history when most of them had not been listed yet.
       */
      const coverage: Array<{
        symbol: string;
        signals: number;
        firstSignal: number | null;
        lastSignal: number | null;
      }> = [];

      for (const symbol of chosen) {
        const [candles, rows] = await Promise.all([
          getCandles(symbol),
          getPredictionsInRange(symbol, input.from, input.to),
        ]);
        if (candles.length === 0) continue;

        const series = candles as unknown as Kline[];
        // ATR and the TA composite need the full series; both are read by openTime.
        atrBySymbol.set(symbol, atrPercentByOpenTime(series));
        seriesBySymbol.set(symbol, series);
        const taBySymbol = taScoreByOpenTime(series);

        const gate = gates.get(symbol) ?? 0.5;
        let first: number | null = null;
        let last: number | null = null;
        for (const r of rows) {
          if (first === null || r.targetOpenTime < first) first = r.targetOpenTime;
          if (last === null || r.targetOpenTime > last) last = r.targetOpenTime;
          scored.push({
            symbol,
            targetOpenTime: r.targetOpenTime,
            basisOpenTime: r.basisOpenTime,
            probUp: r.probUp,
            ta: taBySymbol.get(r.basisOpenTime) ?? null,
            mlGate: gate,
          });
        }
        coverage.push({ symbol, signals: rows.length, firstSignal: first, lastSignal: last });
      }
      coverage.sort((a, b) => (a.firstSignal ?? 0) - (b.firstSignal ?? 0));

      const cfg = {
        startBalance: input.startBalance,
        leverage: input.leverage,
        tpK: input.tpK,
        slK: input.slK,
        stakePct: input.stakePct,
        maxTotalPct: input.maxTotalPct,
        flattenOnClose: input.flattenOnClose,
        minNotional: input.minNotional,
        maintenanceMarginRate: input.maintenanceMarginRate,
        topUpAmount: input.topUpAmount,
        topUpPeriod: input.topUpPeriod,
        bracketMode: input.bracketMode,
      };

      const costs: CostModel = {
        takerFee: input.takerFee,
        slippage: input.slippage,
        makerFee: input.makerFee,
        fundingPer8h: input.fundingPer8h,
        entryIsMaker: input.entryIsMaker,
      };

      const all = applyStrategy(scored, input.strategy, input.blendWeight);
      const gated = applyTrailingGates(scored, all, { warmupSignals: input.gateWarmup });

      return {
        params: {
          ...cfg,
          from: input.from,
          to: input.to,
          strategy: input.strategy,
          blendWeight: input.blendWeight,
          flattenOnClose: input.flattenOnClose,
          symbols: chosen,
          costs,
          gateWarmup: input.gateWarmup,
        },
        coverage,
        signalCount: all.length,
        gatedCount: gated.length,
        all: runBacktest(all, seriesBySymbol, atrBySymbol, cfg, costs),
        gated: runBacktest(gated, seriesBySymbol, atrBySymbol, cfg, costs),
      };
    }),

  /**
   * Perpetuals ranked by liquidity and calm. Volatility is measured only for
   * the most liquid slice plus the tracked pairs — see screener.ts for why.
   */
  screener: publicProcedure
    .input(
      z
        .object({
          minVolumeUsd: z.number().min(0).default(50_000_000),
          maxRealisedVolPct: z.number().min(0).max(1000).default(80),
          quote: z.enum(["ALL", "USDT", "USDC"]).default("ALL"),
          measuredOnly: z.boolean().default(true),
          limit: z.number().min(1).max(200).default(60),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const opts = {
        minVolumeUsd: input?.minVolumeUsd ?? 50_000_000,
        maxRealisedVolPct: input?.maxRealisedVolPct ?? 80,
        quote: input?.quote ?? "ALL",
        measuredOnly: input?.measuredOnly ?? true,
        limit: input?.limit ?? 60,
      };
      const { rows, generatedAt, measuredCount, universeCount } =
        await runScreener(TRACKED_SYMBOLS);

      const filtered = rows.filter(r => {
        if (r.quoteVolume24h < opts.minVolumeUsd) return false;
        if (opts.quote !== "ALL" && r.quoteAsset !== opts.quote) return false;
        if (opts.measuredOnly && !r.measured) return false;
        if (r.realisedVolPct !== null && r.realisedVolPct > opts.maxRealisedVolPct) return false;
        return true;
      });

      // Rank by liquidity per unit of volatility, which is the actual thing
      // being asked for; unmeasured rows fall back to raw volume.
      filtered.sort((a, b) => (b.volumePerVol ?? 0) - (a.volumePerVol ?? 0));

      return {
        generatedAt,
        universeCount,
        measuredCount,
        matched: filtered.length,
        rows: filtered.slice(0, opts.limit),
      };
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
