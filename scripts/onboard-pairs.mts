/**
 * Make additional Binance perpetuals backtestable.
 *
 *   tsx scripts/onboard-pairs.mts [count] [replayBars]
 *   tsx scripts/onboard-pairs.mts --symbols BTCUSDT,ETHUSDT
 *
 * Each pair needs three things before the backtest can replay it:
 *   1. candle history downloaded and stored
 *   2. a trained model (so a confidence gate exists)
 *   3. a walk-forward prediction replay, retrained every 25 bars
 *
 * Step 3 dominates: it trains ~replayBars/25 models per pair. That is why this
 * cannot simply be run for all ~573 perpetuals — see the cost note printed at
 * startup. Pairs are processed in descending 24h volume so the most useful ones
 * land first and the list is usable long before the run finishes.
 *
 * Safe to re-run and safe to interrupt: every step upserts, and a pair that is
 * already complete is skipped.
 */
import "dotenv/config";
import { backfillSymbol, loadMarketContext, seedHistory, trainSymbol } from "../server/market/pipeline";
import { getCandleCount, getBacktestSymbols } from "../server/db";
import { runScreener } from "../server/market/screener";
import { TRACKED_SYMBOLS } from "../shared/market";

const args = process.argv.slice(2);
const explicit = args.includes("--symbols")
  ? (args[args.indexOf("--symbols") + 1] ?? "").split(",").map(s => s.trim()).filter(Boolean)
  : null;
const count = explicit ? explicit.length : Number(args[0] ?? 40);
const replayBars = Number(args[1] ?? 3000);

/** A pair with fewer bars than this cannot support a walk-forward replay. */
const MIN_CANDLES = 800;

async function pickSymbols(): Promise<string[]> {
  if (explicit) return explicit;
  const { rows } = await runScreener(TRACKED_SYMBOLS);
  // Most liquid first. Volume is the only filter here: volatility is a strategy
  // question, and excluding on it now would silently bias what can be tested.
  return rows
    .filter(r => r.quoteVolume24h > 0)
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .map(r => r.symbol)
    .slice(0, count);
}

const symbols = await pickSymbols();
const done = new Set((await getBacktestSymbols()).map(r => r.symbol));

console.log(`Onboarding ${symbols.length} pairs, ${replayBars} replayed bars each.`);
console.log(`Roughly ${Math.round(replayBars / 25)} model fits per pair — expect several`);
console.log(`minutes each. Already complete: ${[...done].length}\n`);

const context = await loadMarketContext();
let ok = 0;
let skipped = 0;
let failed = 0;

for (const [i, symbol] of symbols.entries()) {
  const prefix = `[${i + 1}/${symbols.length}] ${symbol.padEnd(16)}`;
  if (done.has(symbol)) {
    console.log(`${prefix} already onboarded, skipping`);
    skipped++;
    continue;
  }

  const started = Date.now();
  try {
    const stored = await backfillSymbol(symbol);
    const total = await getCandleCount(symbol);
    if (total < MIN_CANDLES) {
      console.log(`${prefix} only ${total} candles (<${MIN_CANDLES}), skipping`);
      skipped++;
      continue;
    }

    const trained = await trainSymbol(symbol, context);
    if (!trained.trained) {
      console.log(`${prefix} model would not train, skipping`);
      skipped++;
      continue;
    }

    const seeded = await seedHistory(symbol, replayBars, context);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(
      `${prefix} ${String(stored).padStart(5)} new candles, ${String(total).padStart(5)} total, ` +
        `gate ${trained.threshold ?? "—"}, ` +
        `acc ${trained.gatedAccuracy !== undefined ? (trained.gatedAccuracy * 100).toFixed(1) + "%" : "—"}, ` +
        `${seeded.seeded} predictions  (${mins}m)`,
    );
    ok++;
  } catch (error) {
    console.log(`${prefix} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

console.log(`\ndone — ${ok} onboarded, ${skipped} skipped, ${failed} failed`);
process.exit(0);
