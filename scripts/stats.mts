/** Print stored data volumes and measured rolling accuracy per pair. */
import "dotenv/config";
import { getCandleCount, getModelSummaries, getPredictions } from "../server/db";
import { computeAccuracy } from "../server/routers/market";
import { ACCURACY_WINDOW, TRACKED_SYMBOLS } from "../shared/market";
import { CONTEXT_SYMBOL } from "../server/market/pipeline";

console.log("Candles stored:");
for (const symbol of [...TRACKED_SYMBOLS, CONTEXT_SYMBOL]) {
  console.log(`  ${symbol.padEnd(14)} ${await getCandleCount(symbol)}`);
}

const models = await getModelSummaries();
const modelBySymbol = new Map(models.map(m => [m.symbol, m]));

console.log(`\nRolling accuracy over last ${ACCURACY_WINDOW} resolved predictions:`);
console.log(
  "  pair           gate   gatedWin   n     allWin    n     valGated  trainRows",
);
for (const symbol of TRACKED_SYMBOLS) {
  const rows = await getPredictions(symbol, ACCURACY_WINDOW * 3);
  const model = modelBySymbol.get(symbol);
  const threshold = model?.confidenceThreshold ?? 0.5;
  const acc = computeAccuracy(rows, threshold);
  const pct = (v: number | null) => (v === null ? "   —  " : `${(v * 100).toFixed(1)}%`);
  console.log(
    `  ${symbol.padEnd(14)} ${threshold.toFixed(2)}   ${pct(acc.winRate).padStart(7)}  ${String(acc.resolved).padStart(3)}   ${pct(acc.allSignalWinRate).padStart(7)}  ${String(acc.allSignalResolved).padStart(3)}   ${pct(model?.highConfidenceAccuracy ?? null).padStart(7)}   ${model?.trainSamples ?? 0}`,
  );
}

process.exit(0);
