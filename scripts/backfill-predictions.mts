/**
 * Extend the stored walk-forward prediction history so the backtest date range
 * covers real history instead of the ~16 days the bootstrap seeds.
 *
 * `seedHistory` upserts, so re-running is safe and never drops existing rows.
 * Every prediction still comes from a model trained only on earlier bars, which
 * is the whole point — the backtest must stay out-of-sample.
 *
 *   tsx scripts/backfill-predictions.mts [countPerPair]
 */
import "dotenv/config";
import { loadMarketContext, seedHistory } from "../server/market/pipeline";
import { TRACKED_SYMBOLS } from "../shared/market";

const count = Number(process.argv[2] ?? 10000);

console.log(`Backfilling up to ${count} walk-forward predictions per pair...`);
const context = await loadMarketContext();

for (const symbol of TRACKED_SYMBOLS) {
  const started = Date.now();
  const r = await seedHistory(symbol, count, context);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`  ${symbol.padEnd(14)} ${String(r.seeded).padStart(6)} predictions  (${secs}s)`);
}

console.log("done");
process.exit(0);
