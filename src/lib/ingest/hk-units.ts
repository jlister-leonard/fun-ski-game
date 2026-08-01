/**
 * @file Unit normalisation for Apple Health imports.
 *
 * ## The rule this file exists to enforce
 *
 * > 🚨 **Do not hard-code canonical units.** The exported `unit=` attribute is
 * > locale- and settings-dependent. — `integration-apple-health.md` §3.6
 *
 * Verified in real exports: distance as `km` *or* `mi`; height as `cm`; energy
 * as **`Cal`** *or* `kcal`; VO2 max as `mL/min·kg`; blood glucose carrying a
 * molar-mass annotation, `unit="mmol&lt;180.1558800000541&gt;/L"`. A parser
 * that assumes kilometres because the developer's phone is metric will be
 * wrong by a factor of 1.609 for a US user — which is precisely our user.
 *
 * So: every conversion here is keyed by **(dimension, unit string)**, the unit
 * string comes off the record, and an unrecognised pair returns `null` rather
 * than a number. A wrong conversion is worse than a missing value, because a
 * missing value looks missing and a wrong one looks like data.
 */

/**
 * Reduce a unit string to a comparable token.
 *
 * Handles the three things real exports do to a unit:
 * - case and spacing vary (`mL/min·kg` vs `ml/(kg*min)`)
 * - blood glucose carries a molar-mass annotation in angle brackets
 * - the middle dot, the multiplication sign and `*` all mean "times"
 *
 * @param raw the `unit=` attribute value
 * @returns a lower-case token with annotations and separators flattened
 */
export function unitToken(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    // `mmol<180.1558800000541>/L` — the annotation is a molar mass, not a unit.
    .replace(/<[^>]*>/g, '')
    .replace(/[·×∗]/g, '*')
    .replace(/[()\s]/g, '')
    .toLowerCase();
}

/** A conversion table: normalised unit token → multiplier into the SI unit. */
type Factors = Readonly<Record<string, number>>;

/** → kilocalories. Apple writes `Cal` for what everyone else calls `kcal`. */
const ENERGY_KCAL: Factors = {
  kcal: 1,
  cal: 1, // Apple's `Cal`; a true gram-calorie never appears in HealthKit.
  kj: 0.2390057361,
  j: 0.0002390057361,
};

/** → metres. */
const LENGTH_M: Factors = {
  m: 1,
  km: 1000,
  cm: 0.01,
  mm: 0.001,
  mi: 1609.344,
  ft: 0.3048,
  yd: 0.9144,
  in: 0.0254,
};

/** → kilograms. */
const MASS_KG: Factors = {
  kg: 1,
  g: 0.001,
  lb: 0.45359237,
  oz: 0.028349523125,
  st: 6.35029318,
};

/** → minutes. */
const DURATION_MIN: Factors = {
  min: 1,
  mins: 1,
  s: 1 / 60,
  sec: 1 / 60,
  secs: 1 / 60,
  ms: 1 / 60_000,
  hr: 60,
  h: 60,
  hour: 60,
  hours: 60,
  day: 1440,
};

/** → millilitres. */
const VOLUME_ML: Factors = {
  ml: 1,
  l: 1000,
  floz_us: 29.5735295625,
  floz: 29.5735295625,
  'fl_oz': 29.5735295625,
  cup_us: 236.5882365,
  pt_us: 473.176473,
};

/** → milliseconds. HRV SDNN is reported in `ms`, occasionally in `s`. */
const TIME_MS: Factors = { ms: 1, s: 1000, sec: 1000 };

/** → counts per minute. */
const RATE_PER_MIN: Factors = {
  'count/min': 1,
  count_min: 1,
  bpm: 1,
  'count/s': 60,
};

/** → mL/(kg·min). Every spelling of VO2 max means the same thing. */
const VO2: Factors = {
  'ml/kg*min': 1,
  'ml/min*kg': 1,
  'ml/kg/min': 1,
  'ml/min/kg': 1,
  'ml/(kg*min)': 1,
};

/** Convert against one table, returning `null` for an unknown unit. */
function convert(value: number, unit: string, table: Factors): number | null {
  const factor = table[unitToken(unit)];
  return factor === undefined ? null : value * factor;
}

/** Energy in any exported unit → kilocalories. */
export const toKcal = (v: number, u: string): number | null => convert(v, u, ENERGY_KCAL);
/** Distance in any exported unit → metres. */
export const toMetres = (v: number, u: string): number | null => convert(v, u, LENGTH_M);
/** Mass in any exported unit → kilograms. */
export const toKilograms = (v: number, u: string): number | null => convert(v, u, MASS_KG);
/** Duration in any exported unit → minutes. */
export const toMinutes = (v: number, u: string): number | null => convert(v, u, DURATION_MIN);
/** Volume in any exported unit → millilitres. */
export const toMillilitres = (v: number, u: string): number | null => convert(v, u, VOLUME_ML);
/** A time interval → milliseconds. */
export const toMilliseconds = (v: number, u: string): number | null => convert(v, u, TIME_MS);
/** A rate → counts per minute. */
export const toPerMinute = (v: number, u: string): number | null => convert(v, u, RATE_PER_MIN);
/** Aerobic capacity → mL/(kg·min). */
export const toVo2 = (v: number, u: string): number | null => convert(v, u, VO2);

/**
 * A percentage → 0–100.
 *
 * HealthKit's `%` unit is genuinely ambiguous in the wild: blood oxygen is
 * exported as `0.98 %` by some sources and `98 %` by others, and body fat does
 * the same. Rather than trust the unit, this reads the *magnitude*: a
 * saturation or body-fat fraction below 1.5 is a fraction, above it is already
 * a percentage. The one case this gets wrong — a genuine 1.2 % body fat — is
 * not a body composition that exists.
 *
 * @param value the raw number
 * @returns the value on a 0–100 scale
 */
export function toPercent(value: number): number {
  return value <= 1.5 ? value * 100 : value;
}
