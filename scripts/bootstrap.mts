/**
 * One-shot bootstrap: backfill candles from Binance Futures, train a model per
 * pair, replay a walk-forward track record, and publish the current signal.
 * Run from the sandbox: `npx tsx scripts/bootstrap.mts`
 */
import "dotenv/config";
import { runBootstrap } from "../server/market/jobs";

const replayCount = Number(process.argv[2] ?? 100);

console.log(`Bootstrapping with ${replayCount} replayed predictions per pair...`);
const result = await runBootstrap(replayCount);

console.log("\nCandles upserted:");
for (const [symbol, count] of Object.entries(result.synced)) {
  console.log(`  ${symbol.padEnd(14)} ${count}`);
}

console.log("\nModels trained:");
for (const t of result.trained) {
  console.log(
    `  ${t.symbol.padEnd(14)} trained=${t.trained}`,
    t.gatedAccuracy !== undefined ? `gatedAcc=${(t.gatedAccuracy * 100).toFixed(1)}%` : "",
    t.threshold !== undefined ? `gate=${t.threshold}` : "",
  );
}

console.log("\nHistory replayed:");
for (const s of result.seeded) {
  console.log(`  ${s.symbol.padEnd(14)} ${s.seeded} predictions`);
}

console.log("\nCurrent signals:");
for (const p of result.predictions) {
  console.log(
    `  ${p.symbol.padEnd(14)} ${p.direction ?? "-"}`,
    p.confidence !== undefined ? `${(p.confidence * 100).toFixed(1)}%` : "",
  );
}

process.exit(0);
