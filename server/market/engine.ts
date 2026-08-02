import type { Kline } from "./binance";
import {
  buildFeatureMatrix,
  buildLabels,
  FEATURE_NAMES,
  type FeatureRow,
  type MarketContext,
} from "./features";
import { gbmPredictProba, trainGbm, type GbmModel, type TrainOptions } from "./gbm";

/** Hyperparameters used for every pair. Deliberately shallow to limit overfit. */
export const DEFAULT_TRAIN_OPTIONS: TrainOptions = {
  trees: 140,
  depth: 3,
  learningRate: 0.05,
  minSamplesLeaf: 25,
  subsample: 0.8,
  featureFraction: 0.7,
  bins: 24,
  l2: 2,
};

/**
 * Per-pair hyperparameters chosen from an offline walk-forward search
 * (see `docs/model-research.md`). Each pair uses the configuration with the
 * best validated gated accuracy at acceptable coverage; pairs absent from this
 * map fall back to `DEFAULT_TRAIN_OPTIONS`.
 */
export const SYMBOL_TRAIN_OPTIONS: Record<string, TrainOptions> = {
  WLDUSDC: { trees: 300, depth: 2, learningRate: 0.03, minSamplesLeaf: 50, subsample: 0.7, featureFraction: 0.5, bins: 20, l2: 6 },
  WIFUSDC: { trees: 200, depth: 2, learningRate: 0.04, minSamplesLeaf: 40, subsample: 0.75, featureFraction: 0.6, bins: 20, l2: 4 },
  "1000BONKUSDC": { trees: 200, depth: 2, learningRate: 0.04, minSamplesLeaf: 40, subsample: 0.75, featureFraction: 0.6, bins: 20, l2: 4 },
  UNIUSDC: { trees: 140, depth: 3, learningRate: 0.05, minSamplesLeaf: 25, subsample: 0.8, featureFraction: 0.7, bins: 24, l2: 2 },
  SUIUSDC: { trees: 250, depth: 3, learningRate: 0.03, minSamplesLeaf: 40, subsample: 0.75, featureFraction: 0.6, bins: 24, l2: 5 },
  DOGEUSDC: { trees: 300, depth: 2, learningRate: 0.03, minSamplesLeaf: 50, subsample: 0.7, featureFraction: 0.5, bins: 20, l2: 6 },
};

/** Resolve the training configuration for a symbol. */
export function trainOptionsFor(symbol: string): TrainOptions {
  return SYMBOL_TRAIN_OPTIONS[symbol] ?? DEFAULT_TRAIN_OPTIONS;
}

/** Candidate confidence gates evaluated during validation. */
const THRESHOLD_GRID = [0.5, 0.52, 0.54, 0.56, 0.58, 0.6, 0.62, 0.64, 0.66, 0.68, 0.7];

/**
 * Minimum share of candles that must still produce an actionable signal.
 * Below this the dashboard would go silent for days at a time, so gates that
 * look great on a handful of bars are rejected as statistically fragile.
 */
const MIN_COVERAGE = 0.18;
const MIN_GATED_SAMPLES = 60;

export type Dataset = {
  rows: FeatureRow[];
  X: number[][];
  y: number[];
};

/**
 * Assemble a supervised dataset: features from candle i, label from candle i+1.
 * Rows whose label is unknown (the newest candle) are dropped.
 */
export function buildDataset(candles: Kline[], context?: MarketContext): Dataset {
  const rows = buildFeatureMatrix(candles, context);
  const labels = buildLabels(candles, rows);
  const keptRows: FeatureRow[] = [];
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const label = labels[i];
    if (label === null) continue;
    keptRows.push(rows[i]);
    X.push(rows[i].values);
    y.push(label);
  }
  return { rows: keptRows, X, y };
}

export type ThresholdPoint = {
  threshold: number;
  accuracy: number;
  coverage: number;
  count: number;
};

export type ValidationResult = {
  /** Accuracy across every out-of-sample bar, no confidence filtering. */
  overallAccuracy: number;
  /** Accuracy restricted to bars that clear the chosen gate. */
  highConfidenceAccuracy: number;
  /** Share of bars that clear the chosen gate. */
  coverage: number;
  chosenThreshold: number;
  samples: number;
  curve: ThresholdPoint[];
};

type OosPoint = { prob: number; label: number };

function evaluateThresholds(points: OosPoint[]): ThresholdPoint[] {
  return THRESHOLD_GRID.map(threshold => {
    let correct = 0;
    let count = 0;
    for (const p of points) {
      const confidence = Math.max(p.prob, 1 - p.prob);
      if (confidence < threshold) continue;
      count++;
      const predicted = p.prob >= 0.5 ? 1 : 0;
      if (predicted === p.label) correct++;
    }
    return {
      threshold,
      accuracy: count === 0 ? 0 : correct / count,
      coverage: points.length === 0 ? 0 : count / points.length,
      count,
    };
  });
}

/** Pick the gate with the best validated accuracy subject to coverage guards. */
export function selectThreshold(curve: ThresholdPoint[]): ThresholdPoint {
  if (curve.length === 0) {
    return { threshold: 0.5, accuracy: 0, coverage: 0, count: 0 };
  }
  const viable = curve.filter(c => c.coverage >= MIN_COVERAGE && c.count >= MIN_GATED_SAMPLES);
  const pool = viable.length > 0 ? viable : curve;
  return pool.reduce((best, c) => (c.accuracy > best.accuracy ? c : best), pool[0]);
}

/**
 * Walk-forward (expanding window) validation. The model is retrained at each
 * fold boundary using only past data, then scored on the following block, which
 * mirrors exactly how the live scheduler uses the model.
 */
export function walkForwardValidate(
  dataset: Dataset,
  options: TrainOptions = DEFAULT_TRAIN_OPTIONS,
  folds = 5,
): ValidationResult {
  const n = dataset.X.length;
  const empty: ValidationResult = {
    overallAccuracy: 0,
    highConfidenceAccuracy: 0,
    coverage: 0,
    chosenThreshold: 0.5,
    samples: 0,
    curve: [],
  };
  if (n < 400) return empty;

  const initialTrain = Math.floor(n * 0.5);
  const blockSize = Math.max(40, Math.floor((n - initialTrain) / folds));
  const points: OosPoint[] = [];

  for (let start = initialTrain; start < n; start += blockSize) {
    const end = Math.min(start + blockSize, n);
    const trainX = dataset.X.slice(0, start);
    const trainY = dataset.y.slice(0, start);
    if (trainX.length < 200) continue;

    const model = trainGbm(trainX, trainY, { ...options, seed: 1000 + start });
    for (let i = start; i < end; i++) {
      points.push({ prob: gbmPredictProba(model, dataset.X[i]), label: dataset.y[i] });
    }
  }

  if (points.length === 0) return empty;

  const curve = evaluateThresholds(points);
  const chosen = selectThreshold(curve);

  return {
    overallAccuracy: curve[0]?.accuracy ?? 0,
    highConfidenceAccuracy: chosen.accuracy,
    coverage: chosen.coverage,
    chosenThreshold: chosen.threshold,
    samples: points.length,
    curve,
  };
}

export type TrainedModel = {
  model: GbmModel;
  validation: ValidationResult;
  trainSamples: number;
  trainedThroughOpenTime: number;
  featureNames: readonly string[];
  modelVersion: string;
};

/** Train the production model on all labelled rows, after walk-forward validation. */
export function trainForSymbol(
  candles: Kline[],
  context?: MarketContext,
  options: TrainOptions = DEFAULT_TRAIN_OPTIONS,
): TrainedModel | null {
  const dataset = buildDataset(candles, context);
  if (dataset.X.length < 300) return null;

  const validation = walkForwardValidate(dataset, options);
  const model = trainGbm(dataset.X, dataset.y, { ...options, seed: 20260101 });
  const lastRow = dataset.rows[dataset.rows.length - 1];

  return {
    model,
    validation,
    trainSamples: dataset.X.length,
    trainedThroughOpenTime: lastRow.openTime,
    featureNames: FEATURE_NAMES,
    modelVersion: `gbm${FEATURE_NAMES.length}-${new Date().toISOString().slice(0, 10)}`,
  };
}

export type SignalDirection = "LONG" | "SHORT";

export type PredictionOutput = {
  direction: SignalDirection;
  /** Probability of the predicted direction, in [0.5, 1]. */
  confidence: number;
  /** Raw probability that the next candle closes above its open. */
  probUp: number;
  /**
   * True when confidence clears the pair's validated gate. When false the UI
   * shows the call as NEUTRAL / stand-aside rather than an actionable signal.
   */
  passesGate: boolean;
  /** UTC open time of the candle whose close produced these features. */
  basisOpenTime: number;
  basisClose: number;
  features: Record<string, number>;
};

/**
 * Predict the direction of the candle immediately following the last closed
 * candle in `candles`. Callers must pass closed candles only.
 */
export function predictNextCandle(
  model: GbmModel,
  candles: Kline[],
  confidenceThreshold = 0.5,
  context?: MarketContext,
): PredictionOutput | null {
  const rows = buildFeatureMatrix(candles, context);
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  if (latest.values.length !== model.featureCount) return null;

  const basis = candles[candles.length - 1];
  if (basis.openTime !== latest.openTime) return null;

  const probUp = gbmPredictProba(model, latest.values);
  const confidence = Math.max(probUp, 1 - probUp);

  const features: Record<string, number> = {};
  FEATURE_NAMES.forEach((name, i) => {
    features[name] = Number((latest.values[i] ?? 0).toFixed(6));
  });

  return {
    direction: probUp >= 0.5 ? "LONG" : "SHORT",
    confidence,
    probUp,
    passesGate: confidence >= confidenceThreshold,
    basisOpenTime: latest.openTime,
    basisClose: basis.close,
    features,
  };
}

export type ReplayedPrediction = {
  targetOpenTime: number;
  basisOpenTime: number;
  basisClose: number;
  direction: SignalDirection;
  confidence: number;
  probUp: number;
  label: number;
};

/**
 * Replay historical predictions walk-forward so the accuracy tracker starts
 * with a real, out-of-sample track record instead of an empty table. Every
 * prediction for bar i comes from a model trained only on bars < i.
 */
export function generateHistoricalPredictions(
  candles: Kline[],
  count: number,
  context?: MarketContext,
  options: TrainOptions = DEFAULT_TRAIN_OPTIONS,
): ReplayedPrediction[] {
  const dataset = buildDataset(candles, context);
  const n = dataset.X.length;
  if (n < 350) return [];

  const start = Math.max(300, n - count);
  const out: ReplayedPrediction[] = [];
  const openTimeToIndex = new Map<number, number>();
  candles.forEach((c, i) => openTimeToIndex.set(c.openTime, i));

  // Retrain every `refit` bars to keep the replay affordable while staying honest.
  const refit = 25;
  let model: GbmModel | null = null;

  for (let i = start; i < n; i++) {
    if (model === null || (i - start) % refit === 0) {
      model = trainGbm(dataset.X.slice(0, i), dataset.y.slice(0, i), {
        ...options,
        seed: 7000 + i,
      });
    }
    const probUp = gbmPredictProba(model, dataset.X[i]);
    const basisOpenTime = dataset.rows[i].openTime;
    const basisIndex = openTimeToIndex.get(basisOpenTime);
    if (basisIndex === undefined) continue;
    const basis = candles[basisIndex];
    const target = candles[basisIndex + 1];
    if (!target) continue;

    out.push({
      targetOpenTime: target.openTime,
      basisOpenTime,
      basisClose: basis.close,
      direction: probUp >= 0.5 ? "LONG" : "SHORT",
      confidence: Math.max(probUp, 1 - probUp),
      probUp,
      label: dataset.y[i],
    });
  }

  return out;
}
