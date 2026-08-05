/**
 * Measurement: does blending a classic TA score with the ML probability beat
 * the ML model alone?
 *
 * Method mirrors `walkForwardValidate` exactly — expanding window, retrained at
 * each fold boundary, scored only on the following unseen block — so the ML-only
 * column here is directly comparable to the numbers the live models report.
 *
 * At every out-of-sample bar we record three scores:
 *   ML    : the GBM probability
 *   TA    : a frozen 4-component indicator composite (no fitting, no tuning)
 *   BLEND : w * (2p - 1) + (1 - w) * TA, mapped back to a probability
 *
 * TA-only (w = 0) and ML-only (w = 1) are included as controls, because a blend
 * that cannot beat both of its own ingredients is not worth shipping.
 *
 * Read-only against the live database. Writes nothing.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { buildDataset, trainOptionsFor, selectThreshold } from "../server/market/engine";
import { trainGbm, gbmPredictProba } from "../server/market/gbm";
import { FEATURE_NAMES, buildMarketContext } from "../server/market/features";
import { CONTEXT_SYMBOL } from "../server/market/pipeline";
import { TRACKED_SYMBOLS } from "../shared/market";
import type { Kline } from "../server/market/binance";

const BLEND_WEIGHTS = [0.0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0];
const THRESHOLD_GRID = [0.5, 0.52, 0.54, 0.56, 0.58, 0.6, 0.62, 0.64];
const MIN_COVERAGE = 0.05;
const MIN_GATED = 30;

const idx = (name: string) => {
  const i = (FEATURE_NAMES as readonly string[]).indexOf(name);
  if (i < 0) throw new Error(`feature ${name} not found`);
  return i;
};

const I_RSI = idx("rsi14");
const I_MACD_HIST = idx("macd_hist_norm");
const I_BB = idx("bb_percent_b");
const I_EMA_CROSS = idx("ema9_ema21_ratio");

const clip = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * Frozen TA composite in [-1, +1]. Four canonical, equally weighted votes:
 * trend (EMA9 vs EMA21), momentum (RSI centred), MACD histogram, and position
 * within the Bollinger band. Deliberately NOT tuned — any weighting fitted here
 * would be fitted on the same data we then evaluate on.
 */
function taScore(features: number[]): number {
  const trend = clip(features[I_EMA_CROSS] * 50);
  const momentum = clip((features[I_RSI] - 50) / 25);
  const macdVote = clip(features[I_MACD_HIST] * 10);
  const bbVote = clip((features[I_BB] - 0.5) * 2);
  return (trend + momentum + macdVote + bbVote) / 4;
}

type Point = { ml: number; ta: number; label: number };

function evaluate(points: Point[], weight: number) {
  const scored = points.map(p => {
    const blended = weight * (2 * p.ml - 1) + (1 - weight) * p.ta;
    return { prob: (clip(blended) + 1) / 2, label: p.label };
  });

  const curve = THRESHOLD_GRID.map(threshold => {
    let correct = 0;
    let count = 0;
    for (const s of scored) {
      const confidence = Math.max(s.prob, 1 - s.prob);
      if (confidence < threshold) continue;
      count++;
      if ((s.prob >= 0.5 ? 1 : 0) === s.label) correct++;
    }
    return {
      threshold,
      accuracy: count === 0 ? 0 : correct / count,
      coverage: scored.length === 0 ? 0 : count / scored.length,
      count,
    };
  });

  const viable = curve.filter(c => c.coverage >= MIN_COVERAGE && c.count >= MIN_GATED);
  const pool = viable.length > 0 ? viable : curve;
  const chosen = pool.reduce((best, c) => (c.accuracy > best.accuracy ? c : best), pool[0]);
  const overall = curve[0];
  return { chosen, overall };
}

async function loadCandles(conn: mysql.Connection, symbol: string): Promise<Kline[]> {
  const [rows] = await conn.execute(
    "select openTime, closeTime, open, high, low, close, volume, quoteVolume, trades, takerBuyBase from candles where symbol = ? order by openTime asc",
    [symbol],
  );
  return (rows as any[]).map(r => ({
    openTime: Number(r.openTime),
    closeTime: Number(r.closeTime),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    quoteVolume: Number(r.quoteVolume),
    trades: Number(r.trades),
    takerBuyBase: Number(r.takerBuyBase),
  }));
}

const conn = await mysql.createConnection(process.env.DATABASE_URL!);
const contextCandles = await loadCandles(conn, CONTEXT_SYMBOL);
const context = buildMarketContext(contextCandles);

type Row = { symbol: string; weight: number; acc: number; gate: number; cov: number; n: number; move: number };
const results: Row[] = [];

for (const symbol of TRACKED_SYMBOLS) {
  const candles = await loadCandles(conn, symbol);
  const dataset = buildDataset(candles, context);
  const n = dataset.X.length;
  if (n < 400) {
    console.log(`${symbol}: only ${n} rows, skipped`);
    continue;
  }

  const options = trainOptionsFor(symbol);
  const initialTrain = Math.floor(n * 0.5);
  const blockSize = Math.max(40, Math.floor((n - initialTrain) / 5));
  const points: Point[] = [];

  for (let start = initialTrain; start < n; start += blockSize) {
    const end = Math.min(start + blockSize, n);
    if (start < 200) continue;
    const model = trainGbm(dataset.X.slice(0, start), dataset.y.slice(0, start), {
      ...options,
      seed: 1000 + start,
    });
    for (let i = start; i < end; i++) {
      points.push({
        ml: gbmPredictProba(model, dataset.X[i]),
        ta: taScore(dataset.X[i]),
        label: dataset.y[i],
      });
    }
  }

  // Mean absolute bar move, for the break-even calculation.
  let moveSum = 0;
  for (const c of candles) moveSum += Math.abs(c.close - c.open) / c.open;
  const meanMove = moveSum / candles.length;

  for (const weight of BLEND_WEIGHTS) {
    const { chosen } = evaluate(points, weight);
    results.push({
      symbol,
      weight,
      acc: chosen.accuracy,
      gate: chosen.threshold,
      cov: chosen.coverage,
      n: chosen.count,
      move: meanMove,
    });
  }
  console.log(`${symbol}: ${points.length} out-of-sample bars evaluated`);
}

await conn.end();

for (const cost of [0.0004, 0.0008]) {
  console.log(`\n${"=".repeat(82)}`);
  console.log(`COST ${(cost * 100).toFixed(2)}%  —  gated accuracy vs break-even, by blend weight`);
  console.log("w=1.0 is ML-only (the live model). w=0.0 is TA-only. Between = blend.");
  console.log("=".repeat(82));
  console.log(
    "pair".padEnd(14) + BLEND_WEIGHTS.map(w => `w=${w.toFixed(1)}`.padStart(9)).join(""),
  );
  const totals = new Map<number, number[]>();
  for (const symbol of TRACKED_SYMBOLS) {
    const cells: string[] = [];
    for (const w of BLEND_WEIGHTS) {
      const r = results.find(x => x.symbol === symbol && x.weight === w);
      if (!r) {
        cells.push("—".padStart(9));
        continue;
      }
      const be = 0.5 + cost / (2 * r.move);
      const margin = (r.acc - be) * 100;
      if (!totals.has(w)) totals.set(w, []);
      totals.get(w)!.push(margin);
      cells.push(`${margin >= 0 ? "+" : ""}${margin.toFixed(2)}`.padStart(9));
    }
    console.log(symbol.padEnd(14) + cells.join(""));
  }
  console.log("-".repeat(82));
  const meanCells = BLEND_WEIGHTS.map(w => {
    const arr = totals.get(w) ?? [];
    const m = arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
    return `${m >= 0 ? "+" : ""}${m.toFixed(2)}`.padStart(9);
  });
  console.log("MEAN".padEnd(14) + meanCells.join(""));
  const winCells = BLEND_WEIGHTS.map(w => {
    const arr = totals.get(w) ?? [];
    return `${arr.filter(x => x > 0).length}/${arr.length}`.padStart(9);
  });
  console.log("PROFITABLE".padEnd(14) + winCells.join(""));
}

console.log("\nRaw gated accuracy (%) by blend weight:");
console.log("pair".padEnd(14) + BLEND_WEIGHTS.map(w => `w=${w.toFixed(1)}`.padStart(9)).join(""));
for (const symbol of TRACKED_SYMBOLS) {
  const cells = BLEND_WEIGHTS.map(w => {
    const r = results.find(x => x.symbol === symbol && x.weight === w);
    return r ? (r.acc * 100).toFixed(2).padStart(9) : "—".padStart(9);
  });
  console.log(symbol.padEnd(14) + cells.join(""));
}

process.exit(0);
