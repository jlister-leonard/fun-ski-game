"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { haptic } from "./haptics";

export interface ChipProps {
  children: ReactNode;
  /** Present = the chip is selectable and reports `aria-pressed`. */
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A small rounded selectable — portion sizes, quick amounts, "warm-up".
 *
 * Three near-identical versions existed (PortionSheet, LogChangeSheet,
 * SetEntrySheet), differing only in whether they had a border. They now share
 * one: a bordered pill that fills with `--c-accent-quiet` when chosen. The
 * border is not decoration — an unselected chip with no border and no fill has
 * nothing but its text to say it is tappable.
 *
 * Selection is `aria-pressed`, not `aria-selected`: chips are independent
 * toggles inside a scrolling row, not options in a listbox.
 */
export function Chip({ children, selected, onPress, disabled, className }: ChipProps) {
  const interactive = typeof onPress === "function";
  const classes = cn(
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border px-3.5",
    "h-9 text-sm whitespace-nowrap",
    interactive &&
      "tap-target-y transition-[background-color,color,border-color,transform] active:scale-[0.96] duration-[var(--duration-fast)] ease-[var(--ease-out-ios)]",
    selected
      ? "border-transparent bg-accent-quiet font-medium text-accent"
      : "border-line bg-surface text-ink-2",
    disabled && "pointer-events-none opacity-40",
    className
  );

  if (!interactive) return <span className={classes}>{children}</span>;

  return (
    <button
      type="button"
      aria-pressed={selected ?? false}
      disabled={disabled}
      onClick={() => {
        haptic("selection");
        onPress();
      }}
      className={classes}
    >
      {children}
    </button>
  );
}

/** A horizontally scrolling row of chips that never widens the page. */
export function ChipRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("scroll-x scroll-touch -mx-4 px-4", className)}>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}
