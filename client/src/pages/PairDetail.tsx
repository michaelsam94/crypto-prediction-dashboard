import { AccuracyMeter } from "@/components/AccuracyMeter";
import { MiniCandles } from "@/components/MiniCandles";
import { SignalBadge, type SignalState } from "@/components/SignalBadge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { baseAsset, formatPrice, formatRate, formatSignedPercent } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  ACCURACY_WINDOW,
  SYMBOL_LABELS,
  TARGET_ACCURACY_MAX,
  TARGET_ACCURACY_MIN,
  TRACKED_SYMBOLS,
  formatUtc,
  type TrackedSymbol,
} from "@shared/market";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "wouter";

function isTracked(value: string): value is TrackedSymbol {
  return (TRACKED_SYMBOLS as readonly string[]).includes(value);
}

export default function PairDetail() {
  const params = useParams<{ symbol: string }>();
  const raw = params.symbol ?? "";
  const valid = isTracked(raw);
  const symbol = valid ? raw : TRACKED_SYMBOLS[0];

  const history = trpc.market.history.useQuery(
    { symbol, limit: 150 },
    { enabled: valid, refetchInterval: 60_000 },
  );
  const candles = trpc.market.candles.useQuery(
    { symbol, limit: 120 },
    { enabled: valid, refetchInterval: 60_000 },
  );

  if (!valid) {
    return (
      <div className="container py-10">
        <p className="text-sm text-muted-foreground">
          Unknown pair &quot;{raw}&quot;.{" "}
          <Link href="/" className="text-[var(--primary)] hover:underline">
            Back to dashboard
          </Link>
        </p>
      </div>
    );
  }

  const rows = history.data?.rows ?? [];
  const gatedRows = rows.filter(r => r.passesGate);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <ArrowLeft size={15} />
            Dashboard
          </Link>
          <div className="h-5 w-px bg-border" />
          <div className="leading-tight">
            <h1 className="text-sm font-bold">
              {baseAsset(symbol)}
              <span className="text-muted-foreground">/USDC</span>
            </h1>
            <p className="text-[10px] text-muted-foreground">
              {SYMBOL_LABELS[symbol]} · 4H · UTC
            </p>
          </div>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        {/* Candle chart */}
        <section className="rounded-xl border border-border bg-[var(--panel)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Price · last {candles.data?.length ?? 0} candles
            </h2>
            {candles.data && candles.data.length > 0 && (
              <span className="tnum text-sm font-semibold">
                {formatPrice(candles.data[candles.data.length - 1].close)}
              </span>
            )}
          </div>
          {candles.isLoading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : (
            <MiniCandles candles={candles.data ?? []} height={220} />
          )}
        </section>

        {/* Accuracy panels */}
        <section className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-[var(--panel)] p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Gated signals · last {ACCURACY_WINDOW}
            </p>
            <AccuracyMeter
              winRate={history.data?.accuracy.winRate ?? null}
              resolved={history.data?.accuracy.resolved ?? 0}
              targetMin={TARGET_ACCURACY_MIN}
              targetMax={TARGET_ACCURACY_MAX}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Only predictions whose confidence cleared the{" "}
              {formatRate(history.data?.threshold ?? 0.5, 0)} gate for this pair are counted. These
              are the calls the dashboard presents as actionable.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-[var(--panel)] p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              All signals · last {ACCURACY_WINDOW}
            </p>
            <AccuracyMeter
              winRate={history.data?.accuracy.allSignalWinRate ?? null}
              resolved={history.data?.accuracy.allSignalResolved ?? 0}
              targetMin={TARGET_ACCURACY_MIN}
              targetMax={TARGET_ACCURACY_MAX}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Every prediction regardless of confidence, including the NEUTRAL calls. This is the
              unfiltered skill of the model and sits close to a coin flip, which is why gating
              matters.
            </p>
          </div>
        </section>

        {/* Prediction log */}
        <section className="rounded-xl border border-border bg-[var(--panel)]">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Prediction log
            </h2>
            <Badge variant="outline" className="text-[10px] font-normal">
              {gatedRows.length} gated of {rows.length}
            </Badge>
          </div>

          {history.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No predictions recorded yet for this pair.
            </p>
          ) : (
            <div className="max-h-[520px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-[var(--panel)]">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-[10px] uppercase tracking-wider">
                      Candle (UTC)
                    </TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider">Signal</TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-wider">
                      Conf
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-wider">
                      Move
                    </TableHead>
                    <TableHead className="text-right text-[10px] uppercase tracking-wider">
                      Result
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => {
                    const state: SignalState = row.passesGate ? row.direction : "NEUTRAL";
                    const outcomeColor =
                      row.outcome === "win"
                        ? "text-[var(--long)]"
                        : row.outcome === "loss"
                          ? "text-[var(--short)]"
                          : "text-muted-foreground";
                    return (
                      <TableRow key={row.id} className="border-border/50">
                        <TableCell className="tnum whitespace-nowrap text-[11px] text-muted-foreground">
                          {formatUtc(row.targetOpenTime)}
                        </TableCell>
                        <TableCell>
                          <SignalBadge state={state} size="sm" />
                        </TableCell>
                        <TableCell className="tnum text-right text-[11px]">
                          {formatRate(row.confidence)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "tnum text-right text-[11px]",
                            row.realizedChangePct === null
                              ? "text-muted-foreground"
                              : row.realizedChangePct >= 0
                                ? "text-[var(--long)]"
                                : "text-[var(--short)]",
                          )}>
                          {formatSignedPercent(row.realizedChangePct)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right text-[11px] font-semibold uppercase",
                            outcomeColor,
                          )}>
                          {row.outcome}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
