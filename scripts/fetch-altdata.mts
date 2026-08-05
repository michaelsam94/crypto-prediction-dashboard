/**
 * Pull the non-price series into the database.
 *
 *   tsx scripts/fetch-altdata.mts
 *
 * Funding and Fear & Greed backfill their full history. Open interest can only
 * ever fetch the trailing ~30 days (Binance limit), so this is meant to run on a
 * schedule and accumulate forward.
 */
import "dotenv/config";
import { fetchFearGreed, fetchFundingHistory, fetchOpenInterest } from "../server/market/altdata";
import { upsertFearGreed, upsertFundingRates, upsertOpenInterest } from "../server/db";
import { TRACKED_SYMBOLS } from "../shared/market";

console.log("=== Fear & Greed ===");
const fng = await fetchFearGreed();
const fngWritten = await upsertFearGreed(
  fng.map(p => ({ day: p.day, value: p.value, classification: p.classification })),
);
console.log(
  `  ${fngWritten} daily readings` +
    (fng.length > 0
      ? `  ${new Date(fng[0].day).toISOString().slice(0, 10)} → ${new Date(
          fng[fng.length - 1].day,
        )
          .toISOString()
          .slice(0, 10)}`
      : ""),
);

console.log("\n=== Funding rates (full history) ===");
for (const symbol of TRACKED_SYMBOLS) {
  const rows = await fetchFundingHistory(symbol);
  const written = await upsertFundingRates(
    rows.map(r => ({
      symbol,
      fundingTime: r.fundingTime,
      fundingRate: r.fundingRate,
      markPrice: r.markPrice,
    })),
  );
  const first = rows.length > 0 ? new Date(rows[0].fundingTime).toISOString().slice(0, 10) : "—";
  console.log(`  ${symbol.padEnd(14)} ${String(written).padStart(6)} settlements from ${first}`);
}

console.log("\n=== Open interest (trailing 30 days only — Binance limit) ===");
for (const symbol of TRACKED_SYMBOLS) {
  const rows = await fetchOpenInterest(symbol);
  const written = await upsertOpenInterest(
    rows.map(r => ({
      symbol,
      ts: r.ts,
      openInterest: r.openInterest,
      openInterestValue: r.openInterestValue,
    })),
  );
  const first = rows.length > 0 ? new Date(rows[0].ts).toISOString().slice(0, 10) : "—";
  console.log(`  ${symbol.padEnd(14)} ${String(written).padStart(6)} snapshots from ${first}`);
}

console.log("\ndone");
process.exit(0);
