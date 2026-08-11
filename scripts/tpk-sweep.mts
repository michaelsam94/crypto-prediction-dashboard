/**
 * Take-profit sweep, month by month.
 *
 * The question this answers: is a far take-profit genuinely better, or did it
 * just win the one month it was picked in?
 *
 * Each month is run as an INDEPENDENT $25 account. Compounding across months
 * would let a lucky early month scale every later one, which is exactly how a
 * single good period disguises itself as a trend.
 *
 *   tsx scripts/tpk-sweep.mts [SYMBOLS] [strategy] [blendWeight] [stakePct]
 *   tsx scripts/tpk-sweep.mts 1000BONKUSDC,DOGEUSDC blend 0.6 25
 */
import "dotenv/config";
import {
  MAINTENANCE_MARGIN_RATE,
  MIN_NOTIONAL,
  applyStrategy,
  atrPercentByOpenTime,
  applyTrailingGates,
  runBacktest,
  taScoreByOpenTime,
  type ScoredSignal,
  type Strategy,
} from "../server/market/backtest";
import { getCandles, getModelSummaries, getPredictionsInRange } from "../server/db";
import { TRACKED_SYMBOLS } from "../shared/market";
import type { Kline } from "../server/market/binance";

const symbols = (process.argv[2] ?? "1000BONKUSDC,DOGEUSDC").split(",").map(s => s.trim());
const strategy = (process.argv[3] ?? "blend") as Strategy;
const blendWeight = Number(process.argv[4] ?? 0.6);
const stakePct = Number(process.argv[5] ?? 25);

const TP_KS = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0];
const START = 25;
const SL_K = 0.5;
const MAX_TOTAL = 60;

const models = await getModelSummaries();
const gates = new Map(models.map(m => [m.symbol, m.confidenceThreshold ?? 0.5]));

// Load once; the sweep only changes bracket geometry, not the data.
const seriesBySymbol = new Map<string, Kline[]>();
const atrBySymbol = new Map<string, Map<number, number>>();
const scored: ScoredSignal[] = [];
let minT = Infinity;
let maxT = -Infinity;

for (const symbol of symbols) {
  const candles = (await getCandles(symbol)) as unknown as Kline[];
  if (candles.length === 0) {
    console.log(`${symbol}: no candles, skipped`);
    continue;
  }
  seriesBySymbol.set(symbol, candles);
  atrBySymbol.set(symbol, atrPercentByOpenTime(candles));
  const ta = taScoreByOpenTime(candles);
  const rows = await getPredictionsInRange(symbol, 0, Number.MAX_SAFE_INTEGER);
  for (const r of rows) {
    scored.push({
      symbol,
      targetOpenTime: r.targetOpenTime,
      basisOpenTime: r.basisOpenTime,
      probUp: r.probUp,
      ta: ta.get(r.basisOpenTime) ?? null,
      mlGate: gates.get(symbol) ?? 0.5,
    });
    minT = Math.min(minT, r.targetOpenTime);
    maxT = Math.max(maxT, r.targetOpenTime);
  }
}

const all = applyStrategy(scored, strategy, blendWeight);
const gated = applyTrailingGates(scored, all);

// Month buckets over the covered span.
const months: Array<{ label: string; from: number; to: number }> = [];
const cursor = new Date(minT);
cursor.setUTCDate(1);
cursor.setUTCHours(0, 0, 0, 0);
while (cursor.getTime() <= maxT) {
  const from = cursor.getTime();
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  months.push({
    label: `${next.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`.replace(
      /^\d{4}/,
      String(cursor.getUTCFullYear()),
    ),
    from,
    to: next.getTime() - 1,
  });
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
}

console.log(`pairs      ${symbols.join(", ")}`);
console.log(`strategy   ${strategy}${strategy === "blend" ? ` (ML ${blendWeight})` : ""}`);
console.log(`sizing     $${START} at 5x, stake ${stakePct}%, cap ${MAX_TOTAL}%, SL ${SL_K}xATR`);
console.log(`exits      hold to TP/SL (no flatten)`);
console.log(`gated      ${gated.length} of ${all.length} signals`);
console.log(`months     ${months.length} (${months[0]?.label} → ${months[months.length - 1]?.label})\n`);

function runSlice(rows: typeof gated, from: number, to: number, tpK: number) {
  const slice = rows.filter(s => s.targetOpenTime >= from && s.targetOpenTime <= to);
  if (slice.length === 0) return null;
  return runBacktest(slice, seriesBySymbol, atrBySymbol, {
    startBalance: START,
    leverage: 5,
    tpK,
    slK: SL_K,
    stakePct,
    maxTotalPct: MAX_TOTAL,
    flattenOnClose: false,
    minNotional: MIN_NOTIONAL,
    maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
    topUpAmount: 0,
    topUpPeriod: "monthly",
    bracketMode: "atr",
  });
}

// Matrix: monthly return % per TP_K.
const monthly = new Map<number, Array<{ label: string; ret: number | null }>>();
for (const tpK of TP_KS) {
  const row: Array<{ label: string; ret: number | null }> = [];
  for (const m of months) {
    const r = runSlice(gated, m.from, m.to, tpK);
    row.push({ label: m.label, ret: r ? r.returnPct : null });
  }
  monthly.set(tpK, row);
}

console.log("=".repeat(30 + TP_KS.length * 9));
console.log("MONTHLY RETURN % — each month an independent $25 account (GATED)");
console.log("=".repeat(30 + TP_KS.length * 9));
console.log("month".padEnd(10) + TP_KS.map(k => `TP ${k}`.padStart(9)).join(""));
for (let i = 0; i < months.length; i++) {
  let line = months[i].label.padEnd(10);
  for (const tpK of TP_KS) {
    const v = monthly.get(tpK)![i].ret;
    line += (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}`).padStart(9);
  }
  console.log(line);
}

console.log("\n" + "=".repeat(30 + TP_KS.length * 9));
console.log("SUMMARY");
console.log("=".repeat(30 + TP_KS.length * 9));
const labels = ["positive months", "median month %", "mean month %", "worst month %"];
const stats = new Map<number, number[]>();
for (const tpK of TP_KS) {
  const vals = monthly.get(tpK)!.map(x => x.ret).filter((v): v is number => v !== null);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : 0;
  stats.set(tpK, [
    vals.filter(v => v > 0).length,
    median,
    vals.reduce((a, b) => a + b, 0) / (vals.length || 1),
    sorted[0] ?? 0,
  ]);
}
for (let r = 0; r < labels.length; r++) {
  let line = labels[r].padEnd(18);
  for (const tpK of TP_KS) {
    const v = stats.get(tpK)![r];
    line += (r === 0 ? `${v}/${months.length}` : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`).padStart(9);
  }
  console.log(line);
}

// Whole-period compounding, for drawdown — the number monthly resets hide.
console.log("\n" + "=".repeat(30 + TP_KS.length * 9));
console.log("FULL PERIOD, COMPOUNDED (the drawdown monthly resets hide)");
console.log("=".repeat(30 + TP_KS.length * 9));
console.log(
  "TP_K".padEnd(8) +
    "end $".padStart(12) +
    "return".padStart(12) +
    "maxDD %".padStart(10) +
    "trades".padStart(9) +
    "win %".padStart(9),
);
for (const tpK of TP_KS) {
  const r = runSlice(gated, minT, maxT, tpK);
  if (!r) continue;
  console.log(
    String(tpK).padEnd(8) +
      r.endBalance.toFixed(2).padStart(12) +
      `${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(0)}%`.padStart(12) +
      r.maxDrawdownPct.toFixed(1).padStart(10) +
      String(r.trades).padStart(9) +
      r.winRatePct.toFixed(1).padStart(9),
  );
}

process.exit(0);
