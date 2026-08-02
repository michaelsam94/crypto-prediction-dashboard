import { fetchFullHistory, closedOnly } from "../server/market/binance";
import { TRACKED_SYMBOLS } from "../shared/market";
import { writeFileSync } from "fs";
for (const s of TRACKED_SYMBOLS) {
  const c = closedOnly(await fetchFullHistory(s));
  writeFileSync(`/home/ubuntu/candle-cache/${s}.json`, JSON.stringify(c));
  console.log(s, c.length);
}
