/**
 * Do funding rate and Fear & Greed earn a place in the feature set?
 *
 * Runs the model's own walk-forward validation twice per pair over identical
 * bars — once with the six new non-price features populated, once with them
 * zeroed — and compares. Same folds, same seeds, same hyperparameters, so the
 * only difference is the information available.
 *
 * Reported per pair: overall accuracy, gated accuracy, and the margin over the
 * COST-ADJUSTED break-even, because an accuracy gain that lands on bars with
 * smaller moves is worth less than nothing.
 *
 * Read-only. Trains in memory and writes nothing.
 */
import "dotenv/config";
import { buildDataset, trainOptionsFor, walkForwardValidate } from "../server/market/engine";
import { buildMarketContext, type ExtraContext } from "../server/market/features";
import { fearGreedFeaturesByOpenTime, fundingFeaturesByOpenTime } from "../server/market/altdata";
import { getCandles, getFearGreed, getFundingRates } from "../server/db";
import { CONTEXT_SYMBOL } from "../server/market/pipeline";
import { TRACKED_SYMBOLS } from "../shared/market";
import type { Kline } from "../server/market/binance";

const COSTS = [0.0004, 0.0008];

const btc = (await getCandles(CONTEXT_SYMBOL)) as unknown as Kline[];
const context = buildMarketContext(btc);
const fng = await getFearGreed();

type Row = {
  symbol: string;
  withOverall: number;
  withoutOverall: number;
  withGated: number;
  withoutGated: number;
  meanMove: number;
  bars: number;
};
const rows: Row[] = [];

for (const symbol of TRACKED_SYMBOLS) {
  const candles = (await getCandles(symbol)) as unknown as Kline[];
  if (candles.length < 500) {
    console.log(`${symbol}: only ${candles.length} candles, skipped`);
    continue;
  }

  const funding = await getFundingRates(symbol);
  const openTimes = candles.map(c => c.openTime);
  const fundingMap = fundingFeaturesByOpenTime(
    openTimes,
    funding.map(f => ({
      fundingTime: f.fundingTime,
      fundingRate: f.fundingRate,
      markPrice: f.markPrice,
    })),
  );
  const fngMap = fearGreedFeaturesByOpenTime(
    openTimes,
    fng.map(f => ({ day: f.day, value: f.value, classification: f.classification })),
  );

  // Only bars where BOTH new sources are present can be a fair test; a bar with
  // neutral fill is identical in the two arms and would dilute the comparison.
  let covered = 0;
  const extras: ExtraContext = new Map();
  for (const t of openTimes) {
    const f = fundingMap.get(t);
    const g = fngMap.get(t);
    if (!f || !g) continue;
    extras.set(t, [...f, ...g]);
    covered++;
  }

  const options = trainOptionsFor(symbol);
  const withNew = walkForwardValidate(buildDataset(candles, context, extras), options);
  const without = walkForwardValidate(buildDataset(candles, context), options);

  let moveSum = 0;
  for (const c of candles) moveSum += Math.abs(c.close - c.open) / c.open;

  rows.push({
    symbol,
    withOverall: withNew.overallAccuracy,
    withoutOverall: without.overallAccuracy,
    withGated: withNew.highConfidenceAccuracy,
    withoutGated: without.highConfidenceAccuracy,
    meanMove: moveSum / candles.length,
    bars: candles.length,
  });

  console.log(
    `${symbol.padEnd(14)} coverage ${((covered / openTimes.length) * 100).toFixed(1)}%  ` +
      `overall ${(without.overallAccuracy * 100).toFixed(2)} → ${(
        withNew.overallAccuracy * 100
      ).toFixed(2)}  ` +
      `gated ${(without.highConfidenceAccuracy * 100).toFixed(2)} → ${(
        withNew.highConfidenceAccuracy * 100
      ).toFixed(2)}`,
  );
}

console.log(`\n${"=".repeat(78)}`);
console.log("GATED ACCURACY  (without → with funding + Fear & Greed)");
console.log("=".repeat(78));
console.log(`${"pair".padEnd(14)}${"without".padStart(10)}${"with".padStart(10)}${"delta".padStart(9)}`);
let better = 0;
for (const r of rows) {
  const d = (r.withGated - r.withoutGated) * 100;
  if (d > 0) better++;
  console.log(
    r.symbol.padEnd(14) +
      `${(r.withoutGated * 100).toFixed(2)}`.padStart(10) +
      `${(r.withGated * 100).toFixed(2)}`.padStart(10) +
      `${d >= 0 ? "+" : ""}${d.toFixed(2)}`.padStart(9),
  );
}
const meanDelta = rows.reduce((a, r) => a + (r.withGated - r.withoutGated) * 100, 0) / rows.length;
console.log("-".repeat(78));
console.log(`mean delta ${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(2)} pp   improved ${better}/${rows.length} pairs`);

for (const cost of COSTS) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`MARGIN OVER BREAK-EVEN at ${(cost * 100).toFixed(2)}% cost`);
  console.log("=".repeat(78));
  console.log(`${"pair".padEnd(14)}${"breakeven".padStart(11)}${"without".padStart(10)}${"with".padStart(10)}${"delta".padStart(9)}`);
  let wSum = 0;
  let woSum = 0;
  for (const r of rows) {
    const be = 0.5 + cost / (2 * r.meanMove);
    const mWith = (r.withGated - be) * 100;
    const mWithout = (r.withoutGated - be) * 100;
    wSum += mWith;
    woSum += mWithout;
    console.log(
      r.symbol.padEnd(14) +
        `${(be * 100).toFixed(2)}`.padStart(11) +
        `${mWithout >= 0 ? "+" : ""}${mWithout.toFixed(2)}`.padStart(10) +
        `${mWith >= 0 ? "+" : ""}${mWith.toFixed(2)}`.padStart(10) +
        `${mWith - mWithout >= 0 ? "+" : ""}${(mWith - mWithout).toFixed(2)}`.padStart(9),
    );
  }
  console.log("-".repeat(78));
  console.log(
    `mean margin  without ${(woSum / rows.length).toFixed(2)} pp   with ${(wSum / rows.length).toFixed(2)} pp`,
  );
}

process.exit(0);
