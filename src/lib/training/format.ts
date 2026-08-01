/**
 * @file Display formatting for logged work.
 *
 * The one rule from `AGENTS.md`: storage stays SI — kilograms and metres — and
 * conversion happens here, at the display boundary, via `@/lib/units`. The
 * second rule, from `training-methodology.md` §1.1: what a number *means*
 * depends on the exercise's `rep_unit`, and that is never inferred.
 */

import { formatDistance, formatLoad, type UnitSystem } from '../units';
import type { LoggedSet, RepUnit, RomEntry } from './types';

/**
 * Format a count in its own unit.
 *
 * This is the function that stops the app rendering "1800 reps" for a Zone 2
 * ride. Seconds become minutes past 90 s, because "30:00" is how anyone reads a
 * half-hour effort; metres become yards for a US user, matching `formatDistance`.
 *
 * @param value the count, in `unit`
 * @param unit the exercise's `rep_unit`
 * @param system the user's display preference
 * @returns a short label, e.g. `12 reps`, `45s`, `30:00`, `55 yd`, `20 steps`
 */
export function formatCount(
  value: number,
  unit: RepUnit,
  system: UnitSystem,
): string {
  switch (unit) {
    case 'reps':
      return `${round(value)} ${round(value) === 1 ? 'rep' : 'reps'}`;
    case 'seconds':
      return formatDuration(value);
    case 'meters':
      return formatDistance(value, system).text;
    case 'steps':
      return `${round(value)} ${round(value) === 1 ? 'step' : 'steps'}`;
  }
}

/**
 * The bare number a keypad edits, without its unit.
 *
 * Seconds stay seconds here even when {@link formatCount} would render minutes:
 * typing `1800` is unambiguous, typing `30:00` on a numeric pad is not.
 *
 * @param value the count
 * @param unit the exercise's `rep_unit`
 * @param system the user's display preference
 * @returns the value in the units the pad edits
 */
export function countForEditing(
  value: number,
  unit: RepUnit,
  system: UnitSystem,
): number {
  if (unit === 'meters' && system === 'imperial') return Math.round(value * 1.0936133);
  return round(value);
}

/**
 * Convert a keypad entry back to storage units.
 *
 * @param entered what the user typed
 * @param unit the exercise's `rep_unit`
 * @param system the user's display preference
 * @returns the value to store — metres for `meters`, otherwise unchanged
 */
export function countFromEditing(
  entered: number,
  unit: RepUnit,
  system: UnitSystem,
): number {
  if (unit === 'meters' && system === 'imperial') return entered / 1.0936133;
  return entered;
}

/** The label a keypad shows next to the count field. */
export function countUnitLabel(unit: RepUnit, system: UnitSystem): string {
  switch (unit) {
    case 'reps':
      return 'reps';
    case 'seconds':
      return 'sec';
    case 'meters':
      return system === 'metric' ? 'm' : 'yd';
    case 'steps':
      return 'steps';
  }
}

/** Whether a keypad for this unit should accept a decimal point. */
export function countAllowsDecimal(unit: RepUnit): boolean {
  return unit === 'meters';
}

/**
 * `mm:ss` past 90 seconds, plain seconds below it.
 *
 * @param seconds the duration
 * @returns e.g. `45s` or `30:00`
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * A whole performed set, as one line.
 *
 * Bodyweight movements omit the load entirely rather than printing "0 lb", and
 * `rom_tracked` movements lead with the depth, because that is the number that
 * changed.
 *
 * @param set the performed set
 * @param system the user's display preference
 * @returns e.g. `185 lb × 8 · 2 RIR`, `30:00 · Z2`, `Depth 4 in × 6 reps`
 */
export function formatSet(set: LoggedSet, system: UnitSystem): string {
  const parts: string[] = [];
  if (set.rom) parts.push(`Depth ${formatRom(set.rom)}`);
  if (set.weightKg > 0) parts.push(formatLoad(set.weightKg, system).text);
  parts.push(formatCount(set.unitValue, set.repUnit, system));

  const head = parts.join(' × ');
  const effort = formatEffort(set.effortKind, set.effort);
  return effort ? `${head} · ${effort}` : head;
}

/**
 * Effort as the user recorded it.
 *
 * @param kind how effort was recorded
 * @param value the number, or `null`
 * @returns e.g. `2 RIR`, `8 RPE`, or an empty string
 */
export function formatEffort(kind: LoggedSet['effortKind'], value: number | null): string {
  if (value === null || kind === 'none') return '';
  return kind === 'rir' ? `${round(value)} RIR` : `${round(value)} RPE`;
}

/**
 * A ROM measurement.
 *
 * The unit is stored as part of the datum, so it is printed as stored — these
 * are not SI quantities awaiting conversion.
 *
 * @param rom the measurement
 * @returns e.g. `4 in`, `32 deg`
 */
export function formatRom(rom: RomEntry): string {
  const value = Math.round(rom.value * 10) / 10;
  return `${value} ${rom.unit}`.trim();
}

/** Human-readable muscle name — the frozen vocabulary is snake_case. */
export function muscleLabel(muscle: string): string {
  return muscle
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Human-readable label for one of the nine trainer regions. */
export function regionLabel(region: string): string {
  switch (region) {
    case 'mid_back':
      return 'Mid-back';
    case 'quads_sled':
      return 'Quads / sled';
    case 'calves_lower_leg':
      return 'Calves & lower leg';
    default:
      return muscleLabel(region);
  }
}

/** Round for display without printing `12.0`. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
