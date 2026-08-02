import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight, MinusCircle } from "lucide-react";

export type SignalState = "LONG" | "SHORT" | "NEUTRAL";

/**
 * Direction chip. LONG is always green and SHORT always red; a call that failed
 * the model's confidence gate is rendered as NEUTRAL so the user can see the
 * model chose to stand aside rather than being shown a weak signal as if it
 * were actionable.
 */
export function SignalBadge({
  state,
  size = "md",
  className,
}: {
  state: SignalState;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = {
    sm: "text-[11px] px-2 py-0.5 gap-1",
    md: "text-sm px-2.5 py-1 gap-1.5",
    lg: "text-base px-3 py-1.5 gap-2",
  } as const;

  const iconSizes = { sm: 12, md: 14, lg: 18 } as const;

  const styles: Record<SignalState, string> = {
    LONG: "bg-[var(--long-muted)] text-[var(--long)] border-[var(--long)]/35",
    SHORT: "bg-[var(--short-muted)] text-[var(--short)] border-[var(--short)]/35",
    NEUTRAL: "bg-muted text-[var(--neutral-signal)] border-border",
  };

  const Icon = state === "LONG" ? ArrowUpRight : state === "SHORT" ? ArrowDownRight : MinusCircle;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border font-semibold uppercase tracking-wider",
        sizes[size],
        styles[state],
        className,
      )}>
      <Icon size={iconSizes[size]} strokeWidth={2.5} />
      {state}
    </span>
  );
}
