/**
 * Self-hosted job runner.
 *
 * On the Manus platform the 4H cycle and the daily retrain arrive as POSTs to
 * `/api/scheduled/*`, which are gated on the platform's cron identity. Off
 * platform there is no such identity, so systemd timers invoke the job
 * functions directly instead:
 *
 *   tsx scripts/run-jobs.mts cycle
 *   tsx scripts/run-jobs.mts retrain
 *   tsx scripts/run-jobs.mts altdata
 */
import "dotenv/config";
import { runAltDataSync, runCycle, runRetrainAll, withJobLog } from "../server/market/jobs";

const job = process.argv[2];

if (job !== "cycle" && job !== "retrain" && job !== "altdata") {
  console.error(`Usage: run-jobs.mts <cycle|retrain|altdata> (got ${job ?? "nothing"})`);
  process.exit(2);
}

const stamp = new Date().toISOString();

try {
  if (job === "cycle") {
    const summary = await withJobLog("candle-cycle", () => runCycle());
    console.log(`[${stamp}] candle-cycle ok`, JSON.stringify(summary));
  } else if (job === "altdata") {
    const summary = await withJobLog("altdata-sync", () => runAltDataSync());
    console.log(`[${stamp}] altdata-sync ok`, JSON.stringify(summary));
  } else {
    const results = await withJobLog("retrain-all", () => runRetrainAll());
    console.log(`[${stamp}] retrain-all ok`, JSON.stringify(results));
  }
  process.exit(0);
} catch (error) {
  console.error(`[${stamp}] ${job} failed:`, error);
  process.exit(1);
}
