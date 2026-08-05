import { PredictionCard, type PairData } from "@/components/PredictionCard";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCountdown } from "@/hooks/useCountdown";
import { formatCountdown, formatRate } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { ACCURACY_WINDOW, TARGET_ACCURACY_MAX, TARGET_ACCURACY_MIN, formatUtc } from "@shared/market";
import { AlertTriangle, Clock, FlaskConical, ListFilter, Radio, TrendingUp } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

/**
 * Module-level constant so the query input keeps a stable reference across
 * renders; an inline `{}` would create a new object each render and retrigger
 * the query endlessly.
 */
const EMPTY_INPUT = {} as const;

/** Aggregate win rate across pairs, weighted by resolved signal count. */
function aggregateWinRate(pairs: PairData[]): { rate: number | null; resolved: number } {
  let wins = 0;
  let total = 0;
  for (const p of pairs) {
    wins += p.accuracy.wins;
    total += p.accuracy.wins + p.accuracy.losses;
  }
  return { rate: total > 0 ? wins / total : null, resolved: total };
}

export default function Dashboard() {
  // Live price + signal state. Refetches every 30s; the underlying model only
  // changes at 4H boundaries, but price and countdown should feel live.
  // Pass an empty object as input: these procedures declare an optional object
  // schema, and an explicit stable input keeps the query key well-formed.
  const overview = trpc.market.overview.useQuery(EMPTY_INPUT, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const clock = trpc.market.clock.useQuery(EMPTY_INPUT, {
    refetchInterval: 60_000,
    retry: 1,
  });

  // `isPending` covers the initial fetch; `isLoading` alone can stay true in
  // ways that hide a settled error, leaving skeletons up indefinitely.
  const overviewPending = overview.isPending && !overview.data;
  const remaining = useCountdown(clock.data?.nextCloseAt);

  const pairs = (overview.data?.pairs ?? []) as PairData[];
  const aggregate = aggregateWinRate(pairs);
  const signalCount = pairs.filter(p => p.prediction?.passesGate).length;

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container flex h-14 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--primary)]/15 text-[var(--primary)]">
              <TrendingUp size={17} strokeWidth={2.5} />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-bold tracking-tight">4H Signal Terminal</h1>
              <p className="text-[10px] text-muted-foreground">
                Binance Futures USDC · UTC
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Link href="/screener">
              <Button variant="outline" size="sm" className="gap-1.5">
                <ListFilter size={13} />
                <span className="hidden sm:inline">Screener</span>
              </Button>
            </Link>
            <Link href="/backtest">
              <Button variant="outline" size="sm" className="gap-1.5">
                <FlaskConical size={13} />
                <span className="hidden sm:inline">Backtest</span>
              </Button>
            </Link>
            <div className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
              <Radio size={12} className="animate-signal-pulse text-[var(--long)]" />
              <span>Live</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex cursor-help items-center gap-2 rounded-md border border-border bg-[var(--panel)] px-2.5 py-1">
                  <Clock size={13} className="text-[var(--primary)]" />
                  <span className="tnum text-sm font-semibold">{formatCountdown(remaining)}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                Time until the current 4H candle closes at{" "}
                {clock.data ? formatUtc(clock.data.nextCloseAt) : "—"}. Predictions refresh at
                00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 UTC.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        {/* Summary strip */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="ML gate cleared"
            value={overviewPending ? null : `${signalCount} / ${pairs.length}`}
            hint="Pairs whose ML confidence clears their validated gate. The cards show the blended call, which is what is traded — the gate applies to the ML half only."
          />
          <StatTile
            label={`Win rate · last ${ACCURACY_WINDOW}`}
            value={overviewPending ? null : formatRate(aggregate.rate)}
            hint={`Across ${aggregate.resolved} resolved gated signals on all pairs`}
            accent={
              aggregate.rate === null
                ? undefined
                : aggregate.rate >= TARGET_ACCURACY_MIN
                  ? "var(--long)"
                  : aggregate.rate >= 0.5
                    ? "var(--primary)"
                    : "var(--short)"
            }
          />
          <StatTile
            label="Target band"
            value={`${formatRate(TARGET_ACCURACY_MIN, 0)}–${formatRate(TARGET_ACCURACY_MAX, 0)}`}
            hint="Your stated accuracy goal, shown for reference against measured results"
          />
          <StatTile
            label="Last candle close"
            value={clock.data ? formatUtc(clock.data.lastClosedCandleOpen + 4 * 3600_000) : null}
            hint="Most recent closed 4H candle used as model input"
            mono
          />
        </section>

        {/* Honest accuracy disclosure */}
        <section className="flex items-start gap-3 rounded-lg border border-[var(--primary)]/25 bg-[var(--primary)]/[0.06] p-3.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--primary)]" />
          <div className="space-y-1 text-[12px] leading-relaxed text-muted-foreground">
            <p className="font-semibold text-foreground">
              Measured accuracy, not promised accuracy
            </p>
            <p>
              Every win rate on this page is computed from resolved predictions where the model
              committed before the candle opened. Walk-forward validation on full history puts
              honest out-of-sample accuracy at roughly 52–60% on gated signals depending on the
              pair, below the 65–70% target band shown above. Signals below a pair&apos;s
              confidence gate are labelled NEUTRAL rather than forced into a call.
            </p>
          </div>
        </section>

        {/* Pair grid */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Next candle forecast
            </h2>
            {overview.data && (
              <Badge variant="outline" className="tnum text-[10px] font-normal">
                updated {new Date(overview.data.generatedAt).toUTCString().slice(17, 25)} UTC
              </Badge>
            )}
          </div>

          {overviewPending ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[340px] rounded-xl" />
              ))}
            </div>
          ) : overview.error ? (
            <div className="rounded-lg border border-[var(--short)]/30 bg-[var(--short-muted)] p-4 text-sm text-[var(--short)]">
              Failed to load market data: {overview.error.message}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {pairs.map(pair => (
                <PredictionCard
                  key={pair.symbol}
                  pair={pair}
                  targetMin={TARGET_ACCURACY_MIN}
                  targetMax={TARGET_ACCURACY_MAX}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  accent,
  mono,
}: {
  label: string;
  value: string | null;
  hint: string;
  accent?: string;
  mono?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-help rounded-lg border border-border bg-[var(--panel)] px-3.5 py-3">
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            {label}
          </p>
          {value === null ? (
            <Skeleton className="mt-1.5 h-6 w-20" />
          ) : (
            <p
              className={`tnum mt-1 font-semibold ${mono ? "text-[13px]" : "text-lg"}`}
              style={accent ? { color: accent } : undefined}>
              {value}
            </p>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px] text-xs">{hint}</TooltipContent>
    </Tooltip>
  );
}
