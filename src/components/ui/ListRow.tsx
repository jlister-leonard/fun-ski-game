"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { haptic } from "./haptics";

export interface ListRowProps {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned value, e.g. "182 kcal" or "4 × 8". */
  value?: ReactNode;
  trailing?: ReactNode;
  /** Renders a chevron and makes the whole row a button. */
  onPress?: () => void;
  /** Visually de-emphasises without disabling. */
  muted?: boolean;
  className?: string;
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-4 w-4 shrink-0 text-ink-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * A single row in a list — the most-repeated element in the app.
 *
 * Rows are full-bleed and rely on the parent for dividers, so a list reads as
 * one surface rather than a stack of cards.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  value,
  trailing,
  onPress,
  muted = false,
  className,
}: ListRowProps) {
  const content = (
    <>
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1 text-left">
        <div
          className={cn(
            "text-base truncate",
            muted ? "text-ink-2" : "text-ink"
          )}
        >
          {title}
        </div>
        {subtitle && (
          <div className="text-sm text-ink-2 truncate mt-0.5">{subtitle}</div>
        )}
      </div>
      {value !== undefined && (
        <div className="shrink-0 text-base text-ink-2 tnum">{value}</div>
      )}
      {trailing}
      {onPress && !trailing && <Chevron />}
    </>
  );

  const classes = cn(
    "flex w-full items-center gap-3 px-4 py-3 tap",
    onPress &&
      "transition-colors duration-[var(--duration-fast)] active:bg-surface-2",
    className
  );

  if (onPress) {
    return (
      <button
        type="button"
        onClick={() => {
          haptic("light");
          onPress();
        }}
        className={classes}
      >
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}

/** Groups rows onto one surface with hairline dividers between them. */
export function ListGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-surface border border-line rounded-[var(--radius-lg)] overflow-hidden",
        "divide-y divide-[var(--c-border)]",
        className
      )}
    >
      {children}
    </div>
  );
}
