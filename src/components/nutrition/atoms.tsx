'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * @file The small pieces every nutrition surface is built from.
 *
 * Two of them carry safety requirements rather than merely visual ones, and
 * both are here so the requirement is enforced in one place instead of being
 * re-remembered in every component:
 *
 * - **`EnergyValue`** is the only thing in the diary that renders a kilocalorie
 *   figure. When energy numbers are switched off it renders nothing at all —
 *   not a blurred number, not a placeholder, nothing. A component that formats
 *   kcal itself has bypassed the switch, and the test suite greps for that.
 *
 * - **`ProgressTrack`** has no "over" state. There is deliberately no red in
 *   the palette for exceeding a nutrition target (see the comment in
 *   `globals.css`), because colour-as-verdict is moralising by other means.
 *   Past 100% the bar simply fills and a hairline marks where the target sat.
 *   That is more information than a red bar carries, and none of the judgement.
 */

/** Digit-grouped, no decimals. Energy is never precise enough for one. */
export function formatKcal(kcal: number): string {
  return Math.round(kcal).toLocaleString('en-US');
}

/** Grams, rounded. Macros stay in grams in both unit systems — US labels use them. */
export function formatGrams(g: number): string {
  return `${Math.round(g)} g`;
}

export interface EnergyValueProps {
  kcal: number;
  /** When true this renders nothing. Threaded from `useNutritionPrefs()`. */
  hidden: boolean;
  className?: string;
  /** Rendered after the number when it is shown. */
  unit?: ReactNode;
}

/**
 * A kilocalorie figure, or nothing.
 *
 * The `hidden` prop is required rather than read from a context on purpose:
 * a component that forgets to pass it fails to compile, whereas a component
 * that forgets to consume a context silently leaks the number.
 */
export function EnergyValue({ kcal, hidden, className, unit = 'kcal' }: EnergyValueProps) {
  if (hidden) return null;
  return (
    <span className={cn('tnum', className)}>
      {formatKcal(kcal)}
      {unit ? <span className="text-ink-3 text-[0.75em] ml-1 font-normal">{unit}</span> : null}
    </span>
  );
}

export interface ProgressTrackProps {
  /** 0..1+, uncapped. Above 1 is not an error state. */
  fraction: number | null;
  /** CSS colour for the fill. Use a `--c-*` data colour, never `--c-danger`. */
  colour: string;
  /** Accessible description; the bar itself is decorative without it. */
  label: string;
  className?: string;
}

/**
 * A neutral progress track.
 *
 * `fraction === null` means "there is no floor to measure against" and renders
 * an empty track rather than a zeroed one — an important distinction when the
 * app does not yet have enough data to set a target.
 */
export function ProgressTrack({ fraction, colour, label, className }: ProgressTrackProps) {
  const filled = fraction === null ? 0 : Math.max(0, Math.min(fraction, 1));
  const over = fraction !== null && fraction > 1;

  return (
    <div
      className={cn('relative h-1.5 w-full rounded-full bg-surface-2 overflow-hidden', className)}
      role="img"
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width] duration-[var(--duration-base)] ease-[var(--ease-out-ios)]"
        style={{ width: `${filled * 100}%`, backgroundColor: colour }}
      />
      {over && (
        // Where the target sat, once intake has gone past it. A hairline, in
        // the text colour rather than a semantic one.
        <div
          aria-hidden
          className="absolute inset-y-0 w-px bg-[var(--c-bg)] opacity-70"
          style={{ left: `${(1 / (fraction as number)) * 100}%` }}
        />
      )}
    </div>
  );
}

export interface MacroRowProps {
  label: string;
  eaten: number;
  target: number | null;
  colour: string;
  /** Extra line under the numbers. */
  note?: ReactNode;
}

/**
 * One macronutrient: what has been eaten, and the target as a quiet reference.
 *
 * Note the ordering and the weight. The eaten figure is the large one; the
 * target is a small grey annotation. There is no third number, because the
 * third number would be "remaining" and this product does not compute it.
 */
export function MacroRow({ label, eaten, target, colour, note }: MacroRowProps) {
  const fraction = target && target > 0 ? eaten / target : null;

  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink-2">{label}</span>
        <span className="text-base text-ink tnum">
          {formatGrams(eaten)}
          {target !== null && (
            <span className="text-ink-3 text-sm font-normal ml-1.5">
              of {Math.round(target)} g
            </span>
          )}
        </span>
      </div>
      <ProgressTrack
        className="mt-1.5"
        fraction={fraction}
        colour={colour}
        label={`${label}: ${formatGrams(eaten)}${target ? ` of ${Math.round(target)} g` : ''}`}
      />
      {note && <div className="text-xs text-ink-3 mt-1.5">{note}</div>}
    </div>
  );
}

/** A quiet, non-semantic informational panel. Never `--c-danger`. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-sm text-ink-2 leading-relaxed', className)}>{children}</p>
  );
}
