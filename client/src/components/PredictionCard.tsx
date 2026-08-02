import { AccuracyMeter } from "@/components/AccuracyMeter";
import { MiniCandles } from "@/components/MiniCandles";
import { SignalBadge, type SignalState } from "@/components/SignalBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  baseAsset,
  formatCompactUsd,
  formatPrice,
  formatRate,
  formatSignedPercent,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { SYMBOL_LABELS, formatUtc } from "@shared/market";
import { Activity, Info } from "lucide-react";
import { Link } from "wouter";

export type PairData = {
  symbol: string;
  price: number | null;
  change24hPct: number | null;
  quoteVolume24h: number | null;
  prediction: {
    direction: "LONG" | "SHORT";
    confidence: number;
    probUp: number;
    targetOpenTime: number;
    basisOpenTime: number;
    basisClose: number;
    outcome: string;
    passesGate: boolean;
  } | null;
  accuracy: {
    winRate: number | null;
    wins: number;
    losses: number;
    resolved: number;
    allSignalWinRate: number | null;
    allSignalResolved: number;
  };
  model: {
    algorithm: string;
    modelVersion: string;
    trainSamples: number;
    validationAccuracy: number | null;
    highConfidenceAccuracy: number | null;
    confidenceThreshold: number;
    trainedAt: Date | string;
    trainedThroughOpenTime: number | null;
  } | null;
  candles: Array<{
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
};

export function PredictionCard({
  pair,
  targetMin,
  targetMax,
}: {
  pair: PairData;
  targetMin: number;
  targetMax: number;
}) {
  const prediction = pair.prediction;

  // A call below the model's validated confidence gate is surfaced as NEUTRAL:
  // the model has an opinion but not enough conviction to act on.
  const state: SignalState = !prediction
    ? "NEUTRAL"
    : prediction.passesGate
      ? prediction.direction
      : "NEUTRAL";

  const accent =
    state === "LONG" ? "var(--long)" : state === "SHORT" ? "var(--short)" : "var(--neutral-signal)";

  const change = pair.change24hPct;
  const changeColor =
    change === null ? "text-muted-foreground" : change >= 0 ? "text-[var(--long)]" : "text-[var(--short)]";

  return (
    <div
      className="group relative overflow-hidden rounded-xl border border-border bg-[var(--panel)] transition-colors duration-200 hover:border-border/80"
      style={{ boxShadow: "0 1px 2px oklch(0 0 0 / 25%)" }}>
      {/* Left accent rail encodes the signal without relying on text alone. */}
      <div
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: accent, opacity: state === "NEUTRAL" ? 0.35 : 0.9 }}
        aria-hidden
      />

      <div className="space-y-4 p-4 pl-5">
        {/* Header: pair identity + price */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/pair/${pair.symbol}`}
              className="block truncate text-base font-bold tracking-tight text-foreground hover:text-[var(--primary)]">
              {baseAsset(pair.symbol)}
              <span className="ml-1 text-xs font-medium text-muted-foreground">/USDC</span>
            </Link>
            <p className="truncate text-[11px] text-muted-foreground">
              {SYMBOL_LABELS[pair.symbol] ?? pair.symbol} · PERP
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="tnum text-base font-semibold text-foreground">
              {formatPrice(pair.price)}
            </p>
            <p className={cn("tnum text-[11px] font-medium", changeColor)}>
              {formatSignedPercent(change)}
              <span className="ml-1 text-muted-foreground">24h</span>
            </p>
          </div>
        </div>

        {/* Signal block */}
        <div className="rounded-lg border border-border/60 bg-[var(--panel-raised)]/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <SignalBadge state={state} size="md" />
            <div className="text-right">
              <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Confidence
              </p>
              <p className="tnum text-sm font-semibold" style={{ color: accent }}>
                {prediction ? formatRate(prediction.confidence) : "—"}
              </p>
            </div>
          </div>

          {prediction && !prediction.passesGate && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
              <Info size={12} className="mt-px shrink-0" />
              <span>
                Raw lean {prediction.direction} at {formatRate(prediction.confidence)}, below this
                pair&apos;s {formatRate(pair.model?.confidenceThreshold ?? 0.5, 0)} gate — stand aside.
              </span>
            </p>
          )}

          <div className="mt-2.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Predicting candle</span>
            <span className="tnum">
              {prediction ? formatUtc(prediction.targetOpenTime) : "—"}
            </span>
          </div>
        </div>

        {/* Mini candlestick chart */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              4H · last {pair.candles.length}
            </span>
            <span className="tnum text-[10px] text-muted-foreground">
              {formatCompactUsd(pair.quoteVolume24h)} vol
            </span>
          </div>
          <MiniCandles candles={pair.candles} height={64} />
        </div>

        {/* Rolling accuracy */}
        <AccuracyMeter
          winRate={pair.accuracy.winRate}
          resolved={pair.accuracy.resolved}
          targetMin={targetMin}
          targetMax={targetMax}
        />

        {/* Model footer */}
        <div className="flex items-center justify-between border-t border-border/60 pt-2.5 text-[10px] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-help items-center gap-1">
                <Activity size={11} />
                <span className="tnum">
                  val {formatRate(pair.model?.highConfidenceAccuracy ?? null, 0)}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              Walk-forward out-of-sample accuracy measured at training time on gated signals.
              Trained on {pair.model?.trainSamples?.toLocaleString() ?? "—"} candles. Unfiltered
              accuracy: {formatRate(pair.model?.validationAccuracy ?? null, 1)}.
            </TooltipContent>
          </Tooltip>

          <Link
            href={`/pair/${pair.symbol}`}
            className="font-medium text-muted-foreground hover:text-[var(--primary)]">
            History →
          </Link>
        </div>
      </div>
    </div>
  );
}
