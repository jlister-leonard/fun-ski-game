/**
 * @file The Recovery screen's pure layer: vault rows in, `ReadinessInput` out.
 *
 * Nothing here renders and nothing here touches the database. It exists so the
 * three awkward jobs the screen has — turning timeseries into baselines,
 * turning a check-in into a vault record and back, and deciding what the app is
 * *not* allowed to claim — are all in one readable place rather than smeared
 * through components.
 *
 * The algorithm itself lives in `@/lib/algorithms/readiness` and is not
 * duplicated, wrapped or second-guessed here. This module only feeds it.
 *
 * ## The rule that shapes this file
 *
 * `assessReadiness` **requires** `subjectiveSoreness` and `subjectiveEnergy`.
 * There is no default for either, deliberately: with 3/3 substituted in, an app
 * with no data at all reports a confident `normal` band. So
 * {@link buildReadinessInput} returns `null` when there is no check-in for the
 * day, and the screen renders no score rather than a fabricated one.
 */

import {
  READINESS_LIMITS,
  consecutiveDaysAbove,
  consecutiveDaysBelow,
  summarizeMetricBaseline,
  type DailyReading,
  type ReadinessInput,
  type SubjectiveScale,
} from '@/lib/algorithms';
import type { NewRecord } from '@/lib/db/repos';
import type {
  Activity,
  ReadinessRecord,
  ReadinessTrainingDecision,
  ReadinessSymptomFlags,
  SleepRecord,
} from '@/lib/db/types';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Nights of sleep debt the readiness model asks about, per §8.2.
 */
export const SLEEP_DEBT_WINDOW_NIGHTS = 7;

/**
 * Hours the debt is measured against.
 *
 * §8.2 says "below the user's own target" and the vault has nowhere to store
 * one yet, so this is the midpoint of the 7–9 h range the sleep sub-score is
 * built around. It is a *stated* assumption, printed next to the number on
 * screen — not a silent one.
 */
export const SLEEP_TARGET_HOURS = 8;

/**
 * Nights of data required before a debt figure is passed to the model.
 *
 * Below this the sum is not a week's debt, it is a fragment of one, and
 * understating debt is the direction that hands out a `+1` the data cannot
 * support. Under the threshold the field is omitted entirely.
 */
export const SLEEP_DEBT_MIN_NIGHTS = 3;

/** Days of metric history the screen reads. Comfortably over the 60-day window. */
export const HISTORY_DAYS = 90;

/** Nights and readings drawn in the trend charts. */
export const CHART_DAYS = 21;

/* ------------------------------------------------------------------ */
/* Check-in                                                            */
/* ------------------------------------------------------------------ */

/** §8.5 rule 7's red flags. Any one of them suppresses programming. */
export type SymptomFlags = ReadinessSymptomFlags;

/** A day's subjective inputs, as the user entered them. */
export interface RecoveryCheckIn {
  /** `YYYY-MM-DD`, local. */
  dateKey: string;
  /** 1 = none, 5 = severe. */
  soreness: SubjectiveScale;
  /** 1 = wrecked, 5 = great. */
  energy: SubjectiveScale;
  /** 1 = terrible, 5 = excellent, or `null` when not answered. */
  sleepQuality: SubjectiveScale | null;
  painFlag: boolean;
  illnessFlag: boolean;
  symptoms: SymptomFlags;
}

/** No symptoms reported. */
export const NO_SYMPTOMS: SymptomFlags = Object.freeze({
  chestPain: false,
  dizzinessOrFainting: false,
  shortnessOfBreath: false,
  unexplainedWeightChange: false,
  painAtRest: false,
});

/** A blank check-in for a given day. Nothing is pre-answered. */
export function emptyCheckIn(dateKey: string): RecoveryCheckIn {
  return {
    dateKey,
    soreness: 3,
    energy: 3,
    sleepQuality: null,
    painFlag: false,
    illnessFlag: false,
    symptoms: { ...NO_SYMPTOMS },
  };
}

/** True when any red flag is set. */
export function hasSymptom(symptoms: SymptomFlags): boolean {
  return Object.values(symptoms).some(Boolean);
}

/** Human labels for the red-flag questions. Neutral wording, no triage. */
export const SYMPTOM_LABELS: Record<keyof SymptomFlags, string> = {
  chestPain: 'Chest pain, at any intensity',
  dizzinessOrFainting: 'Dizziness or fainting',
  shortnessOfBreath: 'Shortness of breath',
  unexplainedWeightChange: 'Weight change you cannot account for',
  painAtRest: 'Pain that is there at rest, not only under load',
};

function toScale(value: number | null | undefined): SubjectiveScale | null {
  if (value == null) return null;
  const n = Math.round(value);
  return n >= 1 && n <= 5 ? (n as SubjectiveScale) : null;
}

/**
 * Turn a check-in into the vault row that stores it.
 *
 * @param checkIn the day's subjective inputs
 * @param scored the scored contributions, id → 0–100, for the stored breakdown
 * @param percent the readiness percentage, or `null` when nothing was scored
 * @param loadMultiplier `1 + volumeDelta`, or `null` when no adjustment applied
 * @returns a record ready for `readiness.upsertBySourceKey`
 */
export function encodeCheckIn(
  checkIn: RecoveryCheckIn,
  scored: Record<string, number>,
  percent: number,
  loadMultiplier: number | null,
  trainingDecision: ReadinessTrainingDecision,
): NewRecord<ReadinessRecord> {
  return {
    dateKey: checkIn.dateKey,
    source: 'derived',
    sourceKey: checkInSourceKey(checkIn.dateKey),
    score: percent,
    contributors: { ...scored },
    subjective: {
      soreness: checkIn.soreness,
      energy: checkIn.energy,
      motivation: null,
      stress: null,
      sleepQuality: checkIn.sleepQuality,
      painFlag: checkIn.painFlag,
      illnessFlag: checkIn.illnessFlag,
      symptoms: { ...checkIn.symptoms },
    },
    loadMultiplier,
    trainingDecision,
    note: null,
  };
}

/** The deterministic natural key for a day's check-in, so re-saving updates. */
export function checkInSourceKey(dateKey: string): string {
  return `derived:checkin:${dateKey}`;
}

/**
 * Read a check-in back out of a stored record.
 *
 * @param record a `readinessRecords` row
 * @returns the check-in, or `null` when the row is a vendor score rather than
 *   one of ours (an Oura readiness row has no subjective inputs to recover)
 */
export function decodeCheckIn(record: ReadinessRecord): RecoveryCheckIn | null {
  const soreness = toScale(record.subjective?.soreness);
  const energy = toScale(record.subjective?.energy);
  if (soreness === null || energy === null) return null;

  return {
    dateKey: record.dateKey,
    soreness,
    energy,
    sleepQuality: toScale(record.subjective?.sleepQuality),
    painFlag: record.subjective?.painFlag ?? false,
    illnessFlag: record.subjective?.illnessFlag ?? false,
    symptoms: { ...NO_SYMPTOMS, ...record.subjective?.symptoms },
  };
}

/** The scored readiness contributions. Subjective inputs live separately. */
export function readContributions(record: ReadinessRecord): Record<string, number> {
  return { ...record.contributors };
}

/**
 * True when this record represents a readiness-driven reduction.
 *
 * Used to count §8.5 rule 2's consecutive-reduction run. A stored
 * `loadMultiplier` below 1 is the only durable evidence that a past session was
 * trimmed, so that is what the run is counted from.
 */
export function wasReduced(record: ReadinessRecord): boolean {
  return record.loadMultiplier !== null && record.loadMultiplier < 1;
}

/**
 * Count the run of consecutive reduced days ending immediately before a day.
 *
 * Strictly *before*: today's own assessment cannot be an input to itself. A
 * calendar gap ends the run — a day with no check-in is not a reduced day.
 *
 * @param records readiness rows, any order
 * @param todayKey the day being assessed
 * @returns the number of consecutive prior days that were trimmed
 */
export function countPriorReductions(
  records: readonly ReadinessRecord[],
  todayKey: string,
): number {
  const byDay = new Map<string, ReadinessRecord>();
  for (const r of records) {
    if (r.dateKey >= todayKey) continue;
    const existing = byDay.get(r.dateKey);
    if (!existing || r.source === 'derived') byDay.set(r.dateKey, r);
  }

  let cursor = shiftDateKey(todayKey, -1);
  let run = 0;
  for (;;) {
    const record = byDay.get(cursor);
    if (!record || !wasReduced(record)) return run;
    run++;
    cursor = shiftDateKey(cursor, -1);
  }
}

/**
 * Shift a `YYYY-MM-DD` by whole days.
 *
 * Local-noon arithmetic, so a DST transition cannot land the result on the
 * previous day.
 */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d + days, 12);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/* ------------------------------------------------------------------ */
/* Baselines                                                           */
/* ------------------------------------------------------------------ */

/** A metric, its own rolling baseline, and how far off today's reading sits. */
export interface BaselineView {
  /** Readings in the window, ascending. */
  series: readonly DailyReading[];
  /** Rolling mean, excluding the newest reading from its own baseline. */
  mean: number | null;
  /** Rolling sample SD, or `null` with fewer than two readings. */
  sd: number | null;
  /** Readings behind the baseline. **This is what §8.5 rule 3 gates on.** */
  days: number;
  /** Days still needed before the metric may contribute anything. */
  daysRemaining: number;
  /** The newest reading, baseline or not. */
  latest: DailyReading | null;
  /** True once the baseline is complete. */
  ready: boolean;
  /** Consecutive recent readings outside the usual range. */
  runDays: number;
  /** Consecutive readings at or above the moderate-elevation threshold. */
  moderateRunDays?: number;
  /** Today's deviation in SD, or `null` when it cannot be computed. */
  z: number | null;
}

function emptyView(): BaselineView {
  return {
    series: [],
    mean: null,
    sd: null,
    days: 0,
    daysRemaining: READINESS_LIMITS.baselineDays,
    latest: null,
    ready: false,
    runDays: 0,
    z: null,
  };
}

function baseView(series: readonly DailyReading[]): BaselineView {
  if (series.length === 0) return emptyView();
  const { mean, sd, days, latest } = summarizeMetricBaseline(series);
  return {
    series,
    mean,
    sd,
    days,
    daysRemaining: Math.max(0, READINESS_LIMITS.baselineDays - days),
    latest,
    ready: days >= READINESS_LIMITS.baselineDays,
    runDays: 0,
    z: null,
  };
}

/**
 * HRV against its own baseline.
 *
 * `runDays` counts consecutive readings below `mean − SD`, which is the
 * suppression run `hrvScore` damps a one-off dip against.
 *
 * @param series one reading per day, ascending
 */
export function hrvView(series: readonly DailyReading[]): BaselineView {
  const view = baseView(series);
  if (view.mean === null || view.sd === null || view.latest === null) return view;
  const sd = Math.max(view.sd, 1);
  return {
    ...view,
    runDays: consecutiveDaysBelow(series, view.mean - sd),
    z: (view.latest.value - view.mean) / sd,
  };
}

/** Consecutive readings more than 2 SD below baseline — §8.5 rule 7's trigger. */
export function hrvDaysBelow2Sd(view: BaselineView): number {
  if (view.mean === null || view.sd === null) return 0;
  return consecutiveDaysBelow(view.series, view.mean - 2 * Math.max(view.sd, 1));
}

/**
 * Resting heart rate against its own baseline.
 *
 * `runDays` counts consecutive readings more than
 * {@link READINESS_LIMITS.referral.rhrAboveBaselineBpm} bpm above the mean,
 * which is the run both `rhrScore` and rule 7 read.
 *
 * @param series one reading per day, ascending
 */
export function rhrView(series: readonly DailyReading[]): BaselineView {
  const view = baseView(series);
  if (view.mean === null || view.latest === null) return view;
  return {
    ...view,
    runDays: consecutiveDaysAbove(
      series,
      view.mean + READINESS_LIMITS.referral.rhrAboveBaselineBpm,
    ),
    // A second, lower run counter. The referral threshold above is deliberately
    // high; scoring needs to know about a sustained *moderate* elevation too,
    // which is the pattern that precedes it.
    moderateRunDays: consecutiveDaysAbove(
      series,
      view.mean + READINESS_LIMITS.rhrModerateBpm,
    ),
    z: view.sd !== null && view.sd > 0 ? (view.latest.value - view.mean) / view.sd : null,
  };
}

/* ------------------------------------------------------------------ */
/* Sleep                                                               */
/* ------------------------------------------------------------------ */

/** Sleep debt over the recent window, with the sample size it rests on. */
export interface SleepDebt {
  /** Hours below target, summed over nights with data. Never negative. */
  hours: number;
  /** Nights that actually had a reading. */
  nights: number;
  /** The target the debt was measured against. */
  targetHours: number;
  /** False when there were too few nights for the figure to mean anything. */
  usable: boolean;
}

/**
 * Sleep debt across the last {@link SLEEP_DEBT_WINDOW_NIGHTS} nights.
 *
 * Only nights *with data* count. A night with no reading contributes nothing
 * rather than a full target's worth of debt — the app cannot tell "did not
 * sleep" from "wore no watch", and guessing the first would invent a deficit.
 *
 * @param nights sleep records, any order
 * @param todayKey the wake day the window ends on
 */
export function sleepDebt(nights: readonly SleepRecord[], todayKey: string): SleepDebt {
  const from = shiftDateKey(todayKey, -(SLEEP_DEBT_WINDOW_NIGHTS - 1));
  const window = nights.filter((n) => n.dateKey >= from && n.dateKey <= todayKey);
  const hours = window.reduce(
    (sum, n) => sum + Math.max(0, SLEEP_TARGET_HOURS - n.asleepMin / 60),
    0,
  );
  return {
    hours,
    nights: window.length,
    targetHours: SLEEP_TARGET_HOURS,
    usable: window.length >= SLEEP_DEBT_MIN_NIGHTS,
  };
}

/** True when a night carries a usable stage breakdown. */
export function hasStages(night: SleepRecord): boolean {
  const { deepMin, remMin, lightMin, awakeMin } = night.stages;
  return [deepMin, remMin, lightMin, awakeMin].some((v) => v !== null && v > 0);
}

/* ------------------------------------------------------------------ */
/* Assembling the model input                                          */
/* ------------------------------------------------------------------ */

/** Everything the screen has read out of the vault for the day. */
export interface RecoverySnapshot {
  todayKey: string;
  /** HRV readings, ascending. Apple Health supplies SDNN — see the note below. */
  hrv: readonly DailyReading[];
  rhr: readonly DailyReading[];
  nights: readonly SleepRecord[];
  activities: readonly Activity[];
  /** Past readiness rows, for the consecutive-reduction count. */
  history: readonly ReadinessRecord[];
  checkIn: RecoveryCheckIn | null;
}

/** The assembled input, plus the working the screen shows alongside it. */
export interface ReadinessBuild {
  input: ReadinessInput;
  hrv: BaselineView;
  rhr: BaselineView;
  /** Last night, or `null` when nothing was recorded. */
  lastNight: SleepRecord | null;
  debt: SleepDebt;
  priorReductions: number;
}

/**
 * Assemble the day's {@link ReadinessInput}, or decline to.
 *
 * Returns `null` with no check-in, because there is no honest way to fill in
 * the two required subjective fields. That `null` is what makes the empty state
 * possible: the screen has nothing to score, so it scores nothing.
 *
 * Every optional field is either a real reading or absent. Nothing is imputed,
 * defaulted to a population value, or zero-filled — `assessReadiness` excludes
 * an absent input from the denominator, which is the behaviour §8.5 rule 3
 * requires and which a zero would quietly destroy.
 *
 * @param snapshot what was read out of the vault
 * @returns the input and its working, or `null` when there is no check-in
 */
export function buildReadinessInput(snapshot: RecoverySnapshot): ReadinessBuild | null {
  const { checkIn, todayKey } = snapshot;
  if (!checkIn) return null;

  const hrv = hrvView(snapshot.hrv);
  const rhr = rhrView(snapshot.rhr);
  const debt = sleepDebt(snapshot.nights, todayKey);
  const lastNight =
    snapshot.nights.find((n) => n.dateKey === todayKey) ??
    [...snapshot.nights].sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1))[0] ??
    null;
  const lastNightIsToday = lastNight?.dateKey === todayKey;
  const priorReductions = countPriorReductions(snapshot.history, todayKey);

  const input: ReadinessInput = {
    hrvToday: hrv.latest?.value ?? null,
    hrvBaseline: hrv.mean,
    hrvSD: hrv.sd,
    hrvBaselineDays: hrv.days,
    hrvSuppressedDays: hrv.runDays,
    hrvBelow2SdDays: hrvDaysBelow2Sd(hrv),

    rhrToday: rhr.latest?.value ?? null,
    rhrBaseline: rhr.mean,
    rhrBaselineDays: rhr.days,
    rhrElevatedDays: rhr.runDays,
    rhrModeratelyElevatedDays: rhr.moderateRunDays ?? rhr.runDays,

    // Only *last night* may score the day. An older night is shown on the
    // screen as history but never fed in as though it were this morning.
    sleepHours: lastNightIsToday && lastNight ? lastNight.asleepMin / 60 : null,
    sleepDebt7d: debt.usable ? debt.hours : null,
    sleepQuality: checkIn.sleepQuality,

    subjectiveSoreness: checkIn.soreness,
    subjectiveEnergy: checkIn.energy,
    // No stored notion of "how the last session went" exists yet, so this stays
    // absent and `assessReadiness` excludes it with its own explanation. A
    // guessed 'flat' would be a fabricated zero in the denominator.
    sessionPerfLastTime: null,

    painFlag: checkIn.painFlag,
    illnessFlag: checkIn.illnessFlag,
    consecutiveReductions: priorReductions,
    symptoms: checkIn.symptoms,
  };

  return { input, hrv, rhr, lastNight, debt, priorReductions };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Minutes as "7 h 12 m". Hours and minutes are the same in both systems. */
export function formatSleepDuration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/** Seconds as "48 min" or "1 h 12 m". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : formatSleepDuration(minutes);
}

/** A `YYYY-MM-DD` as "Sat 25 Jul". */
export function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** "Today", "Yesterday", or the day label. */
export function formatRelativeDay(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return 'Today';
  if (dateKey === shiftDateKey(todayKey, -1)) return 'Yesterday';
  return formatDayLabel(dateKey);
}

/**
 * The last `days` calendar days ending at `todayKey`, ascending.
 *
 * Charts are drawn over this rather than over the days that have data, so a
 * gap in the readings renders as a gap rather than being closed up. A closed-up
 * chart shows a continuous series that never happened.
 */
export function dayRange(todayKey: string, days: number): string[] {
  const out: string[] = [];
  for (let k = days - 1; k >= 0; k--) out.push(shiftDateKey(todayKey, -k));
  return out;
}

/** Midday local, so a date lands unambiguously inside its own day on an axis. */
export function xOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

/** Activity type as a readable name: `open_water_swim` → "Open water swim". */
export function formatActivityType(activityType: string): string {
  const words = activityType.replace(/_/g, ' ').trim();
  return words.length === 0 ? 'Activity' : words[0].toUpperCase() + words.slice(1);
}
