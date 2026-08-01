"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "accent" | "warn" | "quiet";

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /** Drops the pill and renders as an uppercase caption. */
  bare?: boolean;
  className?: string;
}

/**
 * A small non-interactive label — a unit, a status, a count.
 *
 * Seven of these existed with five different recipes, including two that were
 * byte-identical apart from the colour, and one place where the *same*
 * semantic ("unverified food") rendered as a pill on one screen and as bare
 * grey text on another.
 *
 * Deliberately no `danger` tone. The one thing a badge in this app must never
 * do is mark a nutrition value as bad — see the eating-disorder rule in
 * docs/kg/specs/design-system.md §2.5. A "danger" badge is one careless import
 * away from being used for exactly that, so it does not exist.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  accent: "bg-accent-quiet text-accent",
  warn: "bg-warn-quiet text-warn",
  quiet: "bg-transparent text-ink-3",
};

export function Badge({ children, tone = "neutral", bare = false, className }: BadgeProps) {
  if (bare) {
    return (
      <span
        className={cn(
          "text-2xs font-medium uppercase tracking-wide",
          tone === "accent" ? "text-accent" : tone === "warn" ? "text-warn" : "text-ink-3",
          className
        )}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5",
        "text-2xs font-medium uppercase tracking-wide",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * The numbered circle in an ordered instruction list.
 *
 * Copy-pasted character-for-character in three Settings screens. `aria-hidden`
 * because the surrounding `<ol>` already numbers itself for a screen reader,
 * and hearing "1. 1. Open the Health app" is worse than hearing it once.
 */
export function StepBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
        "bg-surface-2 text-2xs font-medium text-ink-2 tnum",
        className
      )}
    >
      {n}
    </span>
  );
}

/**
 * The uppercase section caption. One component already existed in
 * `recovery/atoms.tsx`; twenty sites re-inlined the same three classes anyway,
 * one of them at the wrong size.
 */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("text-2xs uppercase tracking-wide text-ink-3", className)}>
      {children}
    </span>
  );
}
