import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { formatUtc } from "@shared/market";
import { AlertTriangle, ArrowLeft, CalendarDays, Play, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link } from "wouter";

const EMPTY_INPUT = {} as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type Strategy = "ml" | "ta" | "blend";
type TopUpPeriod = "daily" | "weekly" | "monthly" | "yearly";

const TOP_UP_PERIODS: TopUpPeriod[] = ["daily", "weekly", "monthly", "yearly"];

const STRATEGIES: Array<{ id: Strategy; label: string; hint: string }> = [
  { id: "ml", label: "Pure ML", hint: "GBM probability only" },
  { id: "ta", label: "Pure TA", hint: "EMA · RSI · MACD · Bollinger" },
  { id: "blend", label: "Blend", hint: "weighted mix of both" },
];

type Result = {
  endBalance: number;
  returnPct: number;
  trades: number;
  wins: number;
  winRatePct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  ruined: boolean;
  bestTrade: number;
  worstTrade: number;
  liquidations: number;
  skippedUndersized: number;
  deposited: number;
  netProfit: number;
  grossPnl: number;
  feesPaid: number;
  fundingPaid: number;
  curve: Array<{ t: number; equity: number }>;
};

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function toDateInput(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One results column — all signals or gated signals. */
function ResultCard({
  title,
  subtitle,
  result,
  accent,
}: {
  title: string;
  subtitle: string;
  result: Result | undefined;
  accent: string;
}) {
  if (!result) {
    return (
      <div className="rounded-lg border border-border bg-card p-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-4 h-10 w-40" />
        <Skeleton className="mt-4 h-24 w-full" />
      </div>
    );
  }

  const up = result.returnPct >= 0;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight" style={{ color: accent }}>
            {title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {result.ruined && (
          <Badge variant="destructive" className="shrink-0 gap-1">
            <AlertTriangle className="h-3 w-3" />
            wiped out
          </Badge>
        )}
      </div>

      {/*
        With deposits running, the headline balance is not a result — most of it
        may simply be money that was paid in. Return is stated against every
        dollar contributed, and the deposit total sits right next to the balance
        so the two are never read apart.
      */}
      <div className="mt-4 flex items-baseline gap-3">
        <span className="font-mono text-3xl font-semibold tabular-nums">
          {money(result.endBalance)}
        </span>
        <span
          className={`flex items-center gap-1 font-mono text-sm tabular-nums ${
            up ? "text-[var(--long)]" : "text-[var(--short)]"
          }`}>
          {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          {pct(result.returnPct)}
        </span>
      </div>

      {result.deposited > 0 && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded border border-border/50 bg-[var(--panel-raised)]/40 px-2.5 py-1.5 text-[11px]">
          <span className="text-muted-foreground">
            Deposited{" "}
            <span className="font-mono tabular-nums text-foreground">
              {money(result.deposited)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Strategy P&amp;L{" "}
            <span
              className="font-mono tabular-nums"
              style={{
                color: result.netProfit >= 0 ? "var(--long)" : "var(--short)",
              }}>
              {money(result.netProfit)}
            </span>
          </span>
          <span className="text-muted-foreground">
            return is on total capital in, not time-weighted
          </span>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
        <div className="flex justify-between border-b border-border/50 pb-1.5">
          <dt className="text-muted-foreground">Max drawdown</dt>
          <dd className="font-mono tabular-nums text-[var(--short)]">
            {money(result.maxDrawdown)}
          </dd>
        </div>
        <div className="flex justify-between border-b border-border/50 pb-1.5">
          <dt className="text-muted-foreground">Max DD %</dt>
          <dd className="font-mono tabular-nums text-[var(--short)]">
            {result.maxDrawdownPct.toFixed(1)}%
          </dd>
        </div>
        <div className="flex justify-between border-b border-border/50 pb-1.5">
          <dt className="text-muted-foreground">Trades</dt>
          <dd className="font-mono tabular-nums">{result.trades.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between border-b border-border/50 pb-1.5">
          <dt className="text-muted-foreground">Win rate</dt>
          <dd className="font-mono tabular-nums">{result.winRatePct.toFixed(1)}%</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Best trade</dt>
          <dd className="font-mono tabular-nums text-[var(--long)]">
            {money(result.bestTrade)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Worst trade</dt>
          <dd className="font-mono tabular-nums text-[var(--short)]">
            {money(result.worstTrade)}
          </dd>
        </div>
        <div className="flex justify-between border-t border-border/50 pt-1.5">
          <dt className="text-muted-foreground">Liquidated</dt>
          <dd
            className={`font-mono tabular-nums ${
              result.liquidations > 0 ? "text-[var(--short)]" : ""
            }`}>
            {result.liquidations.toLocaleString()}
          </dd>
        </div>
        <div className="flex justify-between border-t border-border/50 pt-1.5">
          <dt className="text-muted-foreground">Below min size</dt>
          <dd
            className={`font-mono tabular-nums ${
              result.skippedUndersized > 0 ? "text-[var(--warning,var(--muted-foreground))]" : ""
            }`}>
            {result.skippedUndersized.toLocaleString()}
          </dd>
        </div>
      </dl>

      {/*
        The cost ledger. A strategy whose gross edge is barely larger than its
        costs is not an edge — it is a rounding error with leverage on it, and
        that is exactly what a headline return hides.
      */}
      <div className="mt-4 border-t border-border/50 pt-3">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>Cost ledger</span>
          <span className="font-mono tabular-nums normal-case tracking-normal">
            {costShare(result)} of gross
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-x-4 text-xs">
          <div>
            <dt className="text-muted-foreground">Gross</dt>
            <dd
              className={`font-mono tabular-nums ${
                result.grossPnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"
              }`}>
              {money(result.grossPnl)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Fees</dt>
            <dd className="font-mono tabular-nums text-[var(--short)]">
              −{money(result.feesPaid)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Funding</dt>
            <dd className="font-mono tabular-nums text-[var(--short)]">
              −{money(result.fundingPaid)}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/** Costs as a share of gross P&L — the number that says whether an edge survives. */
function costShare(result: Result): string {
  const costs = result.feesPaid + result.fundingPaid;
  if (result.grossPnl <= 0) return costs > 0 ? "gross is negative" : "—";
  return `${((costs / result.grossPnl) * 100).toFixed(0)}%`;
}

export default function Backtest() {
  const range = trpc.market.backtestRange.useQuery(EMPTY_INPUT, { retry: 1 });
  const universe = trpc.market.backtestSymbols.useQuery(EMPTY_INPUT, { retry: 1 });
  const available = universe.data?.symbols ?? [];

  const [startBalance, setStartBalance] = useState("25");
  const [leverage, setLeverage] = useState("5");
  const [tpK, setTpK] = useState("1.0");
  const [slK, setSlK] = useState("0.5");
  const [strategy, setStrategy] = useState<Strategy>("ml");
  const [blendWeight, setBlendWeight] = useState("0.6");
  const [stakePct, setStakePct] = useState("15");
  const [maxTotalPct, setMaxTotalPct] = useState("60");
  const [flattenOnClose, setFlattenOnClose] = useState(true);
  const [entryIsMaker, setEntryIsMaker] = useState(true);
  // Cost model, in basis points for the inputs — traders think in bps, and a
  // percentage field invites a factor-of-100 error on a number this sensitive.
  const [takerFeeBps, setTakerFeeBps] = useState("4");
  const [slippageBps, setSlippageBps] = useState("2");
  const [fundingBps, setFundingBps] = useState("1");
  const [gateWarmup, setGateWarmup] = useState("200");
  const [minNotional, setMinNotional] = useState("5");
  const [topUpAmount, setTopUpAmount] = useState("0");
  const [topUpPeriod, setTopUpPeriod] = useState<TopUpPeriod>("monthly");
  const [mmrBps, setMmrBps] = useState("50");
  // Empty means "all available", resolved at submit time — the list arrives
  // asynchronously and may be far larger than the six tracked pairs.
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [from, setFrom] = useState<Date | undefined>();
  const [to, setTo] = useState<Date | undefined>();
  const [submitted, setSubmitted] = useState<{
    startBalance: number;
    leverage: number;
    from: number;
    to: number;
    tpK: number;
    slK: number;
    strategy: Strategy;
    blendWeight: number;
    stakePct: number;
    maxTotalPct: number;
    flattenOnClose: boolean;
    entryIsMaker: boolean;
    symbols: string[];
    takerFee: number;
    slippage: number;
    fundingPer8h: number;
    gateWarmup: number;
    minNotional: number;
    maintenanceMarginRate: number;
    topUpAmount: number;
    topUpPeriod: TopUpPeriod;
  } | null>(null);

  // Default the picker to the full span that actually has stored signals.
  const bounds = range.data;
  const effFrom = from ?? (bounds?.min ? new Date(bounds.min) : undefined);
  const effTo = to ?? (bounds?.max ? new Date(bounds.max) : undefined);

  const backtest = trpc.market.backtest.useQuery(submitted!, {
    enabled: submitted !== null,
    retry: 1,
  });

  const chartData = useMemo(() => {
    const a = backtest.data?.all.curve ?? [];
    const g = backtest.data?.gated.curve ?? [];
    if (a.length === 0 && g.length === 0) return [];
    const gatedByT = new Map(g.map(p => [p.t, p.equity]));
    // The gated curve is a subset of bars; carry its last value forward so the
    // two lines stay comparable instead of showing phantom gaps.
    let lastGated = backtest.data?.params.startBalance ?? 0;
    return a.map(p => {
      if (gatedByT.has(p.t)) lastGated = gatedByT.get(p.t)!;
      return { t: p.t, all: p.equity, gated: lastGated };
    });
  }, [backtest.data]);

  const effSymbols = symbols ?? available.map(a => a.symbol);
  const canRun =
    effSymbols.length > 0 &&
    effFrom !== undefined &&
    effTo !== undefined &&
    Number(startBalance) > 0 &&
    Number(leverage) >= 1;

  function run() {
    if (!effFrom || !effTo) return;
    setSubmitted({
      startBalance: Number(startBalance),
      leverage: Number(leverage),
      // Cover the whole selected end day.
      from: Date.UTC(effFrom.getFullYear(), effFrom.getMonth(), effFrom.getDate()),
      to: Date.UTC(effTo.getFullYear(), effTo.getMonth(), effTo.getDate()) + DAY_MS - 1,
      tpK: Number(tpK),
      slK: Number(slK),
      strategy,
      blendWeight: Number(blendWeight),
      stakePct: Number(stakePct),
      maxTotalPct: Number(maxTotalPct),
      flattenOnClose,
      entryIsMaker,
      symbols: effSymbols,
      takerFee: Number(takerFeeBps) / 10_000,
      slippage: Number(slippageBps) / 10_000,
      fundingPer8h: Number(fundingBps) / 10_000,
      gateWarmup: Number(gateWarmup),
      minNotional: Number(minNotional),
      maintenanceMarginRate: Number(mmrBps) / 10_000,
      topUpAmount: Number(topUpAmount),
      topUpPeriod,
    });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Button>
          </Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-sm font-semibold tracking-tight">Strategy Backtest</h1>
          <Badge variant="outline" className="ml-auto font-mono text-[10px]">
            walk-forward · out-of-sample
          </Badge>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        {/* Controls */}
        <section className="rounded-lg border border-border bg-card p-5">
          {/* Strategy selector */}
          <div className="mb-5">
            <Label className="text-xs">Signal source</Label>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {STRATEGIES.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStrategy(s.id)}
                  className={`rounded-md border px-3 py-2 text-left transition-colors ${
                    strategy === s.id
                      ? "border-[var(--primary)] bg-[var(--primary)]/10"
                      : "border-border bg-[var(--panel)] hover:border-[var(--primary)]/40"
                  }`}>
                  <span
                    className={`block text-xs font-semibold ${
                      strategy === s.id ? "text-[var(--primary)]" : "text-foreground"
                    }`}>
                    {s.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">{s.hint}</span>
                </button>
              ))}
              {strategy === "blend" && (
                <div className="ml-1 space-y-1.5">
                  <Label htmlFor="w" className="text-[10px]">
                    ML weight (rest is TA)
                  </Label>
                  <Input
                    id="w"
                    inputMode="decimal"
                    value={blendWeight}
                    onChange={e => setBlendWeight(e.target.value)}
                    className="h-9 w-24 font-mono"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Pairs. Any symbol with stored walk-forward predictions can be
              replayed; the list grows as pairs are onboarded. */}
          <div className="mb-5">
            <div className="flex flex-wrap items-center gap-3">
              <Label className="text-xs">
                Pairs{" "}
                <span className="text-muted-foreground">
                  ({effSymbols.length} of {available.length} selected)
                </span>
              </Label>
              <button
                type="button"
                onClick={() => setSymbols(available.map(a => a.symbol))}
                className="text-[10px] text-muted-foreground underline-offset-2 hover:underline">
                select all
              </button>
              <button
                type="button"
                onClick={() => setSymbols([])}
                className="text-[10px] text-muted-foreground underline-offset-2 hover:underline">
                clear
              </button>
              <button
                type="button"
                onClick={() => setSymbols(universe.data?.tracked ?? [])}
                className="text-[10px] text-muted-foreground underline-offset-2 hover:underline">
                live 6 only
              </button>
            </div>
            <div className="mt-1.5 flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {universe.isPending && <Skeleton className="h-8 w-full" />}
              {available.map(a => {
                const on = effSymbols.includes(a.symbol);
                return (
                  <button
                    key={a.symbol}
                    type="button"
                    title={`${a.predictions.toLocaleString()} predictions`}
                    onClick={() =>
                      setSymbols(
                        on
                          ? effSymbols.filter(x => x !== a.symbol)
                          : [...effSymbols, a.symbol],
                      )
                    }
                    className={`rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors ${
                      on
                        ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                        : "border-border bg-[var(--panel)] text-muted-foreground hover:border-[var(--primary)]/40"
                    }`}>
                    {a.symbol}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="bal" className="text-xs">
                Starting balance (USD)
              </Label>
              <Input
                id="bal"
                inputMode="decimal"
                value={startBalance}
                onChange={e => setStartBalance(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lev" className="text-xs">
                Leverage
              </Label>
              <Input
                id="lev"
                inputMode="decimal"
                value={leverage}
                onChange={e => setLeverage(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tp" className="text-xs">
                Take profit (× ATR)
              </Label>
              <Input
                id="tp"
                inputMode="decimal"
                value={tpK}
                onChange={e => setTpK(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sl" className="text-xs">
                Stop loss (× ATR)
              </Label>
              <Input
                id="sl"
                inputMode="decimal"
                value={slK}
                onChange={e => setSlK(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stake" className="text-xs">
                Stake per trade (% of balance)
              </Label>
              <Input
                id="stake"
                inputMode="decimal"
                value={stakePct}
                onChange={e => setStakePct(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cap" className="text-xs">
                Max deployed per bar (%)
              </Label>
              <Input
                id="cap"
                inputMode="decimal"
                value={maxTotalPct}
                onChange={e => setMaxTotalPct(e.target.value)}
                className="font-mono"
              />
            </div>
          </div>

          {/*
            Costs are inputs, not constants. The fastest way to find out whether
            a result is an edge or an artefact is to raise them and watch what
            happens: a real edge degrades, an artefact evaporates.
          */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="taker" className="text-xs">
                Taker fee (bps)
              </Label>
              <Input
                id="taker"
                inputMode="decimal"
                value={takerFeeBps}
                onChange={e => setTakerFeeBps(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="slip" className="text-xs">
                Slippage (bps)
              </Label>
              <Input
                id="slip"
                inputMode="decimal"
                value={slippageBps}
                onChange={e => setSlippageBps(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="funding" className="text-xs">
                Funding per 8h (bps)
              </Label>
              <Input
                id="funding"
                inputMode="decimal"
                value={fundingBps}
                onChange={e => setFundingBps(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="warmup" className="text-xs">
                Gate warmup (signals)
              </Label>
              <Input
                id="warmup"
                inputMode="numeric"
                value={gateWarmup}
                onChange={e => setGateWarmup(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="minnotional" className="text-xs">
                Min order notional ($)
              </Label>
              <Input
                id="minnotional"
                inputMode="decimal"
                value={minNotional}
                onChange={e => setMinNotional(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="topup" className="text-xs">
                Periodic top-up ($)
              </Label>
              <Input
                id="topup"
                inputMode="decimal"
                value={topUpAmount}
                onChange={e => setTopUpAmount(e.target.value)}
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">0 = no deposits</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="topupperiod" className="text-xs">
                Top-up frequency
              </Label>
              <Select
                value={topUpPeriod}
                onValueChange={v => setTopUpPeriod(v as TopUpPeriod)}
                disabled={Number(topUpAmount) <= 0}>
                <SelectTrigger id="topupperiod" className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOP_UP_PERIODS.map(p => (
                    <SelectItem key={p} value={p} className="font-mono">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mmr" className="text-xs">
                Maintenance margin (bps)
              </Label>
              <Input
                id="mmr"
                inputMode="decimal"
                value={mmrBps}
                onChange={e => setMmrBps(e.target.value)}
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                Liquidation at{" "}
                <span className="font-mono">
                  {(100 * (1 / Math.max(1, Number(leverage)) - Number(mmrBps) / 10_000)).toFixed(1)}
                  %
                </span>{" "}
                adverse
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">From</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-[170px] justify-start gap-2 font-mono">
                    <CalendarDays className="h-4 w-4 shrink-0 opacity-60" />
                    {effFrom ? toDateInput(effFrom.getTime()) : "—"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={effFrom}
                    onSelect={setFrom}
                    defaultMonth={effFrom}
                    disabled={d =>
                      (bounds?.min ? d.getTime() < bounds.min - DAY_MS : false) ||
                      (bounds?.max ? d.getTime() > bounds.max : false)
                    }
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">To</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-[170px] justify-start gap-2 font-mono">
                    <CalendarDays className="h-4 w-4 shrink-0 opacity-60" />
                    {effTo ? toDateInput(effTo.getTime()) : "—"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={effTo}
                    onSelect={setTo}
                    defaultMonth={effTo}
                    disabled={d =>
                      (bounds?.min ? d.getTime() < bounds.min - DAY_MS : false) ||
                      (bounds?.max ? d.getTime() > bounds.max : false)
                    }
                  />
                </PopoverContent>
              </Popover>
            </div>

            <label className="flex cursor-pointer select-none items-center gap-2 rounded-md border border-border bg-[var(--panel)] px-3 py-2">
              <input
                type="checkbox"
                checked={flattenOnClose}
                onChange={e => setFlattenOnClose(e.target.checked)}
                className="h-4 w-4 accent-[var(--primary)]"
              />
              <span className="text-xs">
                <span className="font-medium">Flat on candle close</span>
                <span className="ml-1.5 text-muted-foreground">
                  {flattenOnClose ? "exit each bar" : "hold until TP/SL"}
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer select-none items-center gap-2 rounded-md border border-border bg-[var(--panel)] px-3 py-2">
              <input
                type="checkbox"
                checked={entryIsMaker}
                onChange={e => setEntryIsMaker(e.target.checked)}
                className="h-4 w-4 accent-[var(--primary)]"
              />
              <span className="text-xs">
                <span className="font-medium">Maker entry</span>
                <span className="ml-1.5 text-muted-foreground">
                  {entryIsMaker ? "free fill, assumed always filled" : "crosses the spread"}
                </span>
              </span>
            </label>

            <Button onClick={run} disabled={!canRun || backtest.isFetching} className="gap-2">
              <Play className="h-4 w-4" />
              {backtest.isFetching ? "Running…" : "Run backtest"}
            </Button>

            {bounds?.min && bounds?.max && (
              <p className="text-xs text-muted-foreground">
                Signals available {toDateInput(bounds.min)} → {toDateInput(bounds.max)}
              </p>
            )}
          </div>
        </section>

        {backtest.error && (
          <div className="rounded-lg border border-[var(--short)]/40 bg-[var(--short)]/10 p-4 text-sm text-[var(--short)]">
            {backtest.error.message}
          </div>
        )}

        {/* Results */}
        {submitted && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="font-mono">
                {STRATEGIES.find(s => s.id === submitted.strategy)?.label}
                {submitted.strategy === "blend" &&
                  ` · ${submitted.blendWeight.toFixed(2)} ML / ${(
                    1 - submitted.blendWeight
                  ).toFixed(2)} TA`}
              </Badge>
              <span>
                ${submitted.startBalance} at {submitted.leverage}× · TP {submitted.tpK}×ATR / SL{" "}
                {submitted.slK}×ATR · stake {submitted.stakePct}% (cap {submitted.maxTotalPct}%) ·{" "}
                {submitted.flattenOnClose ? "flat on close" : "hold until TP/SL"} ·{" "}
                {submitted.symbols.length} pair{submitted.symbols.length === 1 ? "" : "s"} ·{" "}
                {(submitted.takerFee * 10_000).toFixed(0)}bps taker +{" "}
                {(submitted.slippage * 10_000).toFixed(0)}bps slip +{" "}
                {(submitted.fundingPer8h * 10_000).toFixed(0)}bps funding/8h · min $
                {submitted.minNotional} · liq at{" "}
                {(100 * (1 / submitted.leverage - submitted.maintenanceMarginRate)).toFixed(1)}%
                {submitted.topUpAmount > 0
                  ? ` · +$${submitted.topUpAmount} ${submitted.topUpPeriod}`
                  : ""}
              </span>
            </div>

            <section className="grid gap-4 md:grid-cols-2">
              <ResultCard
                title="ALL SIGNALS"
                subtitle={`Every prediction, gate ignored · ${
                  backtest.data?.signalCount.toLocaleString() ?? "—"
                } signals`}
                result={backtest.data?.all}
                accent="var(--muted-foreground)"
              />
              <ResultCard
                title="GATED SIGNALS"
                subtitle={`Trailing-fitted gate, warmup ${submitted.gateWarmup} · ${
                  backtest.data?.gatedCount.toLocaleString() ?? "—"
                } signals`}
                result={backtest.data?.gated}
                accent="var(--primary)"
              />
            </section>

            {/*
              Per-pair coverage. Without this the window reads as though every
              pair traded the whole span, when a pair listed in 2024 simply did
              not exist for most of it.
            */}
            {backtest.data && backtest.data.coverage.length > 0 && (
              <section className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-sm font-semibold tracking-tight">Pair coverage</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  When each pair actually had signals. Pairs that list late cannot contribute to
                  the early curve — the headline window is the union, not what any one pair saw.
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[420px] text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="pb-2 font-normal">Pair</th>
                        <th className="pb-2 font-normal">First signal</th>
                        <th className="pb-2 font-normal">Last signal</th>
                        <th className="pb-2 text-right font-normal">Signals</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {backtest.data.coverage.map(c => (
                        <tr key={c.symbol} className="border-t border-border/50">
                          <td className="py-1.5">{c.symbol}</td>
                          <td className="py-1.5">
                            {c.firstSignal === null ? "—" : toDateInput(c.firstSignal)}
                          </td>
                          <td className="py-1.5">
                            {c.lastSignal === null ? "—" : toDateInput(c.lastSignal)}
                          </td>
                          <td className="py-1.5 text-right">{c.signals.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {chartData.length > 1 && (
              <section className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-sm font-semibold tracking-tight">Equity curve</h3>
                <div className="mt-4 h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis
                        dataKey="t"
                        tickFormatter={v => toDateInput(v)}
                        stroke="var(--muted-foreground)"
                        fontSize={11}
                        minTickGap={40}
                      />
                      <YAxis
                        stroke="var(--muted-foreground)"
                        fontSize={11}
                        tickFormatter={v => `$${Math.round(v)}`}
                        width={60}
                      />
                      <RTooltip
                        contentStyle={{
                          background: "var(--card)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        labelFormatter={v => formatUtc(Number(v))}
                        formatter={(v: number) => money(v)}
                      />
                      <Line
                        type="monotone"
                        dataKey="all"
                        name="All signals"
                        stroke="var(--muted-foreground)"
                        dot={false}
                        strokeWidth={1.5}
                      />
                      <Line
                        type="monotone"
                        dataKey="gated"
                        name="Gated signals"
                        stroke="var(--primary)"
                        dot={false}
                        strokeWidth={1.5}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>
            )}
          </>
        )}

        {/* Assumptions — the numbers above mean nothing without these. */}
        <section className="rounded-lg border border-border bg-card/50 p-5 text-xs leading-relaxed text-muted-foreground">
          <h3 className="mb-2 text-sm font-semibold tracking-tight text-foreground">
            How this is calculated
          </h3>
          <ul className="list-disc space-y-1.5 pl-4">
            <li>
              Every signal is <strong className="text-foreground">out-of-sample</strong>: each
              prediction came from a model trained only on bars before it, refit every 25 bars.
            </li>
            <li>
              <strong className="text-foreground">Pure TA</strong> is a frozen, equally weighted
              composite of EMA9-vs-EMA21, RSI(14), the MACD histogram and Bollinger %B — never
              fitted, so it cannot borrow hindsight from the bars it is scored on.{" "}
              <strong className="text-foreground">Blend</strong> mixes it with the model score at
              the weight you choose.
            </li>
            <li>
              Gates are <strong className="text-foreground">coverage-matched</strong>. Each
              pair&apos;s confidence gate was fitted on ML probabilities, so reusing that number on
              a TA score would compare selectivities rather than strategies. Instead the gated
              column always takes the same top share of bars the ML gate admits, measured on
              whichever strategy is selected.
            </li>
            <li>
              Entry at the target candle&apos;s open. Take profit at{" "}
              <strong className="text-foreground">{tpK}× ATR</strong> and stop at{" "}
              <strong className="text-foreground">{slK}× ATR</strong>, measured from the signal
              bar&apos;s ATR(14) — the same geometry the live trading rig uses.
            </li>
            <li>
              With <strong className="text-foreground">flat on candle close</strong> on, a position
              exits at the close of its own bar unless the target or stop is hit first — what the
              live rig does. Switched off, it is held across bars until the target or stop is
              touched, and its margin stays{" "}
              <strong className="text-foreground">locked</strong> meanwhile, so a slow trade blocks
              new signals. Holding therefore changes which trades get taken, not just how they end.
              One position per pair at a time; equity is marked to market each bar so drawdown
              includes open risk.
            </li>
            <li>
              Only 4H OHLC is stored, so when a bar touches{" "}
              <strong className="text-foreground">both</strong> the target and the stop, we cannot
              tell which came first and{" "}
              <strong className="text-foreground">charge the stop</strong>. That is deliberately
              pessimistic.
            </li>
            <li>
              <strong className="text-foreground">Entry is charged as a taker fill</strong> by
              default — taker fee plus slippage. Binance&apos;s USDC-margined promotion really is 0%
              maker, so this is not a claim about the fee schedule: it is a claim about{" "}
              <em>fills</em>. A resting limit at the bar&apos;s open only fills when price comes back
              to it, which is disproportionately the bars where the signal was wrong; the winners
              that ran away never fill at all. Assuming a guaranteed maker fill therefore books a
              free option. Tick <strong className="text-foreground">Maker entry</strong> to price
              entry at the maker rate instead — 4H OHLC cannot say which entries would truly have
              filled, so the gap between the two settings is the honest width of that uncertainty.
            </li>
            <li>
              <strong className="text-foreground">Funding accrues on every bar held</strong>, charged
              pro-rata against the 8h rate to longs and shorts alike. Real funding settles at
              00/08/16 UTC; charging both sides is conservative for a directionally mixed strategy.
            </li>
            <li>
              A stop fills at the{" "}
              <strong className="text-foreground">worse of the stop price and the bar&apos;s open</strong>
              , so a bar that gaps through the stop costs what it really would. A take-profit still
              fills at its own limit, because a limit order cannot fill better than its limit. The
              asymmetry is the point.
            </li>
            <li>
              The gate is fitted on a{" "}
              <strong className="text-foreground">trailing window</strong> — both the coverage share
              and the confidence threshold come only from signals before the bar being judged, after
              a warmup of {gateWarmup} signals per pair. A single full-sample percentile, which is
              what this used to do, lets a 2021 bar be judged against 2026 conviction.
            </li>
            <li>
              Positions are <strong className="text-foreground">isolated margin</strong>: a loss is
              capped at the margin behind it, and anything that would run past that is booked as a{" "}
              <strong className="text-foreground">liquidation</strong>. At {leverage}× with a{" "}
              {mmrBps}bps maintenance rate the exchange closes you out on a{" "}
              {(100 * (1 / Math.max(1, Number(leverage)) - Number(mmrBps) / 10_000)).toFixed(1)}%
              adverse move — normally outside the stop, so this bites on gaps and on stops set wider
              than the liquidation distance, where the exchange gets there first.
            </li>
            <li>
              Orders below the venue&apos;s{" "}
              <strong className="text-foreground">minimum notional</strong> (${minNotional} on
              Binance Futures) are not placed. On a small account this is the constraint that
              actually binds: stake is a percentage of balance, so after a drawdown the order shrinks
              until the exchange refuses it and the account cannot trade its way back. Note that
              per-symbol lot-size steps are not modelled, so this is still the optimistic reading.
            </li>
            <li>
              Every pair with stored predictions is included by default, and{" "}
              <strong className="text-foreground">pair coverage</strong> is reported above. Picking
              the handful of pairs that already validated well on this history is survivorship
              applied before the first simulated trade.
            </li>
            <li>
              Sizing mirrors the live rig: a fixed{" "}
              <strong className="text-foreground">percentage of the balance</strong> as margin per
              trade, capped per bar, funding the highest-conviction signals first and skipping the
              rest. The defaults (15% per trade, 60% cap) are roughly what the live bot runs. This
              matters enormously — deploying the whole balance every bar at leverage sits far past
              the Kelly optimum and compounds a positive edge straight into ruin.
            </li>
            <li>
              Past out-of-sample results are not a forecast. Walk-forward validation puts honest
              accuracy at roughly 52–60% on gated signals, which is a thin edge that real slippage
              can erase.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
