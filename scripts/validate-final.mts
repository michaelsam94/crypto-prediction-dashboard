import { readFileSync } from "fs";
import type { Kline } from "../server/market/binance";
import { buildMarketContext } from "../server/market/features";
import { buildDataset, walkForwardValidate } from "../server/market/engine";
import { TRACKED_SYMBOLS } from "../shared/market";

const load = (s: string): Kline[] => JSON.parse(readFileSync(`/home/ubuntu/candle-cache/${s}.json`, "utf8"));
const ctx = buildMarketContext(load("BTCUSDT"));

for (const s of TRACKED_SYMBOLS) {
  const candles = load(s);
  const ds = buildDataset(candles, ctx);
  const v = walkForwardValidate(ds);
  console.log(
    s.padEnd(13),
    `rows=${ds.X.length}`,
    `raw=${(v.overallAccuracy*100).toFixed(1)}%`,
    `gate=${v.chosenThreshold}`,
    `gated=${(v.highConfidenceAccuracy*100).toFixed(1)}%`,
    `cov=${(v.coverage*100).toFixed(0)}%`,
    `n=${v.samples}`,
  );
  console.log("   ", v.curve.map(c=>`${c.threshold}:${(c.accuracy*100).toFixed(0)}/${(c.coverage*100).toFixed(0)}`).join(" "));
}
