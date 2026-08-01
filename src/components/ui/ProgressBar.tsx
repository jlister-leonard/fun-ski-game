"use client";

import { cn } from "@/lib/cn";

export interface ProgressBarProps {
  /** 0–1. Values above 1 are drawn as a full bar plus an over-target marker. */
  value: number;
  /**
   * What the bar is measuring, for assistive tech. Required — none of the five
   * hand-rolled progress bars in the app had one, which made every single one
   * of them invisible without sight.
   */
  label: string;
  /** Spoken instead of a bare percentage: "128 of 165 g". */
  valueText?: string;
  /** Any `var(--c-*)`. Defaults to the accent. */
  color?: string;
  /** `null` for a bar whose completion is unknown (an import in flight). */
  indeterminate?: boolean;
  className?: string;
}

/**
 * A linear progress bar.
 *
 * Two of the existing copies were byte-identical; a third was the superset and
 * already did the accessible bit properly. This is that superset, with
 * `role="progressbar"` and `aria-valuenow` added — the attribute that lets
 * VoiceOver read a percentage instead of skipping the element entirely.
 *
 * Over 100% the bar fills and adds a hairline marker in the surface colour. It
 * never turns red and never shortens: per docs/kg/specs/design-system.md §2.5,
 * exceeding a nutrition target is information, not a verdict.
 */
export function ProgressBar({
  value,
  label,
  valueText,
  color = "var(--c-accent)",
  indeterminate = false,
  className,
}: ProgressBarProps) {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const over = Number.isFinite(value) && value > 1;
  const pct = Math.round(clamped * 100);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : pct}
      aria-valuetext={valueText}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-surface-2",
        className
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          "duration-[var(--duration-slow)] ease-[var(--ease-out-ios)]",
          indeterminate && "w-1/3 animate-pulse"
        )}
        style={{
          width: indeterminate ? undefined : `${clamped * 100}%`,
          background: color,
        }}
      />
      {over && (
        <span
          aria-hidden
          className="absolute inset-y-0 right-[3px] w-[2px] rounded-full bg-[var(--c-surface-2)]"
        />
      )}
    </div>
  );
}
