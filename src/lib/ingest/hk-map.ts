/**
 * @file The mapping from source sample types onto the canonical metric
 * vocabulary (task graph node **I1**).
 *
 * `HealthMetricType` in `db/types.ts` is a closed enum of fifteen values, and
 * it is the *one* plaintext discriminator in the vault. Everything Apple can
 * export either lands on one of those fifteen, has a dedicated table
 * (`weightEntries`, `sleepRecords`, `activities`), or is **counted as unmapped
 * and reported in the import receipt**.
 *
 * That last clause is the honest bit. Apple exports well over a hundred sample
 * types; we model a fraction of them. A parser that silently discards the rest
 * leaves the user believing their whole export arrived. The receipt lists what
 * did not, by name and count, so "where is my blood pressure?" has an answer
 * on screen rather than in a console log.
 */

import type { HealthMetricType } from '../db/types';
import {
  toKcal,
  toMetres,
  toMilliseconds,
  toMillilitres,
  toMinutes,
  toPerMinute,
  toPercent,
  toVo2,
} from './hk-units';

/** The physical dimension a sample is measured in, before conversion. */
export type Dimension =
  | 'kcal'
  | 'metres'
  | 'minutes'
  | 'millilitres'
  | 'milliseconds'
  | 'per_minute'
  | 'vo2'
  | 'count'
  | 'percent';

/** How a day's worth of raw samples collapses into one stored value. */
export type Rollup = 'sum' | 'average' | 'latest' | 'max' | 'min';

/** Where one source sample type lands, and how it is folded into a day. */
export interface MetricSpec {
  type: HealthMetricType;
  rollup: Rollup;
  dimension: Dimension;
}

/**
 * Convert a raw `(value, unit)` pair into the SI unit the canonical metric is
 * defined in.
 *
 * @param dimension what kind of quantity this is
 * @param value the raw number off the record
 * @param unit the raw `unit=` attribute; **never assumed**
 * @returns the converted value, or `null` when the unit is not recognised
 */
export function convertDimension(
  dimension: Dimension,
  value: number,
  unit: string,
): number | null {
  switch (dimension) {
    case 'kcal':
      return toKcal(value, unit);
    case 'metres':
      return toMetres(value, unit);
    case 'minutes':
      return toMinutes(value, unit);
    case 'millilitres':
      return toMillilitres(value, unit);
    case 'milliseconds':
      return toMilliseconds(value, unit);
    case 'per_minute':
      return toPerMinute(value, unit);
    case 'vo2':
      return toVo2(value, unit);
    case 'percent':
      return toPercent(value);
    case 'count':
      // Dimensionless. `count` is the only unit HealthKit uses, and steps do
      // not become something else in another locale.
      return value;
  }
}

/**
 * HealthKit quantity/category identifiers → canonical metrics.
 *
 * Keyed by the identifier with its `HKQuantityTypeIdentifier` /
 * `HKCategoryTypeIdentifier` prefix stripped, because the two namespaces do
 * not collide and stripping makes the table readable.
 */
export const HK_METRICS: Readonly<Record<string, MetricSpec>> = {
  StepCount: { type: 'steps', rollup: 'sum', dimension: 'count' },
  ActiveEnergyBurned: { type: 'active_energy_kcal', rollup: 'sum', dimension: 'kcal' },
  BasalEnergyBurned: { type: 'basal_energy_kcal', rollup: 'sum', dimension: 'kcal' },
  RestingHeartRate: { type: 'resting_heart_rate', rollup: 'average', dimension: 'per_minute' },
  HeartRateVariabilitySDNN: { type: 'hrv_sdnn_ms', rollup: 'average', dimension: 'milliseconds' },
  RespiratoryRate: { type: 'respiratory_rate', rollup: 'average', dimension: 'per_minute' },
  VO2Max: { type: 'vo2max', rollup: 'latest', dimension: 'vo2' },
  OxygenSaturation: { type: 'blood_oxygen_pct', rollup: 'average', dimension: 'percent' },
  AppleExerciseTime: { type: 'exercise_minutes', rollup: 'sum', dimension: 'minutes' },
  DistanceWalkingRunning: {
    type: 'distance_walking_running_m',
    rollup: 'sum',
    dimension: 'metres',
  },
  FlightsClimbed: { type: 'flights_climbed', rollup: 'sum', dimension: 'count' },
  DietaryWater: { type: 'water_ml', rollup: 'sum', dimension: 'millilitres' },
};

/**
 * Health Auto Export metric names → canonical metrics.
 *
 * HAE uses its own snake_case vocabulary, **never** `HKQuantityTypeIdentifier*`
 * (`integration-apple-health.md` §4.6). Nutrition mostly drops the `dietary_`
 * prefix *except* for `dietary_energy` and `dietary_water`, and the enum
 * contains a genuine upstream typo (`monosaturated_fat`). This table is
 * therefore transcribed, not derived.
 */
export const HAE_METRICS: Readonly<Record<string, MetricSpec>> = {
  step_count: { type: 'steps', rollup: 'sum', dimension: 'count' },
  active_energy: { type: 'active_energy_kcal', rollup: 'sum', dimension: 'kcal' },
  basal_energy_burned: { type: 'basal_energy_kcal', rollup: 'sum', dimension: 'kcal' },
  resting_heart_rate: { type: 'resting_heart_rate', rollup: 'average', dimension: 'per_minute' },
  heart_rate_variability: { type: 'hrv_sdnn_ms', rollup: 'average', dimension: 'milliseconds' },
  respiratory_rate: { type: 'respiratory_rate', rollup: 'average', dimension: 'per_minute' },
  vo2_max: { type: 'vo2max', rollup: 'latest', dimension: 'vo2' },
  vo2max: { type: 'vo2max', rollup: 'latest', dimension: 'vo2' },
  blood_oxygen_saturation: { type: 'blood_oxygen_pct', rollup: 'average', dimension: 'percent' },
  apple_exercise_time: { type: 'exercise_minutes', rollup: 'sum', dimension: 'minutes' },
  apple_stand_hour: { type: 'stand_hours', rollup: 'sum', dimension: 'count' },
  walking_running_distance: {
    type: 'distance_walking_running_m',
    rollup: 'sum',
    dimension: 'metres',
  },
  flights_climbed: { type: 'flights_climbed', rollup: 'sum', dimension: 'count' },
  dietary_water: { type: 'water_ml', rollup: 'sum', dimension: 'millilitres' },
  mindful_minutes: { type: 'mindful_minutes', rollup: 'sum', dimension: 'minutes' },
};

// ---------------------------------------------------------------------------
// Sample types that do not become a HealthMetric
// ---------------------------------------------------------------------------

/** Body mass → a `weightEntries` row, not a metric. */
export const HK_BODY_MASS = 'BodyMass';
/** Body-fat percentage → merged onto the same day's weigh-in. */
export const HK_BODY_FAT = 'BodyFatPercentage';
/** Sleep segments → stitched into `sleepRecords`. */
export const HK_SLEEP = 'SleepAnalysis';
/** One stand hour → a count of 1, when the value says the user actually stood. */
export const HK_STAND_HOUR = 'AppleStandHour';
/** A mindfulness session → minutes, derived from the interval, not a value. */
export const HK_MINDFUL = 'MindfulSession';

/** The `value` string on an `AppleStandHour` sample that means "stood". */
export const STAND_HOUR_STOOD = 'HKCategoryValueAppleStandHourStood';

/**
 * Strip Apple's type prefix.
 *
 * @param identifier e.g. `HKQuantityTypeIdentifierStepCount`
 * @returns e.g. `StepCount`
 */
export function shortTypeName(identifier: string): string {
  return identifier
    .replace(/^HKQuantityTypeIdentifier/, '')
    .replace(/^HKCategoryTypeIdentifier/, '')
    .replace(/^HKDataTypeIdentifier/, '')
    .replace(/^HKCorrelationTypeIdentifier/, '');
}

/**
 * Which sleep stage a `HKCategoryValueSleepAnalysis*` value denotes.
 *
 * `inBed` overlaps the stage segments and must never be summed with them —
 * `integration-apple-health.md` §3.6. `asleepUnspecified` is the pre-iOS-16
 * bucket and is counted as light sleep, since that is what the old sensor
 * could actually distinguish.
 *
 * @param value the `value=` attribute of a sleep record
 * @returns the stage bucket, or `null` when unrecognised
 */
export function sleepStageOf(
  value: string | null | undefined,
): 'inBed' | 'deep' | 'rem' | 'light' | 'awake' | null {
  if (!value) return null;
  const v = value.replace(/^HKCategoryValueSleepAnalysis/, '');
  switch (v) {
    case 'InBed':
      return 'inBed';
    case 'AsleepDeep':
      return 'deep';
    case 'AsleepREM':
      return 'rem';
    case 'AsleepCore':
    case 'AsleepUnspecified':
    case 'Asleep':
      return 'light';
    case 'Awake':
      return 'awake';
    default:
      return null;
  }
}

/**
 * Normalise a workout activity type to `lower_snake_case`.
 *
 * @param raw e.g. `HKWorkoutActivityTypeTraditionalStrengthTraining`
 * @returns e.g. `traditional_strength_training`
 */
export function normalizeActivityType(raw: string | null | undefined): string {
  if (!raw) return 'other';
  const stripped = raw.replace(/^HKWorkoutActivityType/, '');
  return (
    stripped
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'other'
  );
}
