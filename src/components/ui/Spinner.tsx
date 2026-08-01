"use client";

import { cn } from "@/lib/cn";

export interface SpinnerProps {
  /** Pixel diameter. Defaults to 16 — the size that fits inside a button. */
  size?: number;
  /** Announced to assistive tech. Pass `null` for a purely decorative spinner
   *  sitting inside a control that already announces its own busy state. */
  label?: string | null;
  className?: string;
}

/**
 * The single loading indicator.
 *
 * A ring with one quarter cut out, drawn in `currentColor` so it inherits from
 * whatever it sits in. Under `prefers-reduced-motion` the global rule in
 * globals.css collapses the spin to a stationary ring — still visibly a
 * "waiting" mark, just not a rotating one.
 */
export function Spinner({ size = 16, label = "Loading", className }: SpinnerProps) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, borderWidth: Math.max(2, size / 8) }}
      className={cn(
        "inline-block shrink-0 animate-spin rounded-full",
        "border-current border-r-transparent opacity-90",
        className
      )}
    />
  );
}
