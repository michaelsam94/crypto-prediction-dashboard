import { cn } from "@/lib/utils";
import { formatRate } from "@/lib/format";

/**
 * Rolling win-rate meter with the 65-70% target band marked on the track.
 *
 * The band is drawn as a reference region rather than a goal the bar is scaled
 * to, so a model performing at 54% visibly falls short of the target instead of
 * appearing to fill a bar. Honesty about the gap is the point of this control.
 */
export function AccuracyMeter({
  winRate,
  resolved,
  targetMin,
  targetMax,
  className,
}: {
  winRate: number | null;
  resolved: number;
  targetMin: number;
  targetMax: number;
  className?: string;
}) {
  const pct = winRate === null ? 0 : Math.min(Math.max(winRate, 0), 1) * 100;
  const bandStart = targetMin * 100;
  const bandWidth = (targetMax - targetMin) * 100;

  const inTarget = winRate !== null && winRate >= targetMin;
  const aboveCoinFlip = winRate !== null && winRate >= 0.5;

  const barColor = inTarget
    ? "var(--long)"
    : aboveCoinFlip
      ? "var(--primary)"
      : "var(--short)";

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Win rate
        </span>
        <span className="tnum text-sm font-semibold" style={{ color: barColor }}>
          {formatRate(winRate)}
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            n={resolved}
          </span>
        </span>
      </div>

      <div className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--panel-raised)]">
        {/* 50% coin-flip reference */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
        {/* Target band 65-70% */}
        <div
          className="absolute inset-y-0 border-x border-dashed border-[var(--primary)]/50 bg-[var(--primary)]/10"
          style={{ left: `${bandStart}%`, width: `${bandWidth}%` }}
          aria-hidden
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{
            width: `${pct}%`,
            backgroundColor: barColor,
            opacity: 0.85,
            transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
          }}
        />
      </div>
    </div>
  );
}

