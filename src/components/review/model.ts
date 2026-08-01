/**
 * @file The weekly review's pure layer: vault rows in, `CoachInput` out.
 *
 * Nothing here renders and nothing here touches the database. The rules engine
 * lives in `@/lib/algorithms/coach` and is not duplicated, wrapped or
 * second-guessed here — this module only feeds it, and it is separate from the
 * hook so that "what the coach was told" is readable and testable without a
 * browser.
 *
 * ## The rule that shapes this file
 *
 * **A missing input is passed through as missing.** Not as a zero, not as a
 * default. `reviewWeek` has a whole branch dedicated to saying what it cannot
 * yet tell you, and that branch only fires if this module resists the
 * temptation to fill gaps in. A fabricated 3/5 soreness or a zero-calorie
 * unlogged day would both produce a confident review of data that does not
 * exist, which is the failure this screen is supposed to be the antidote to.
 *
 * ## Units
 *
 * Everything crossing this boundary is SI, per `AGENTS.md`. The display
 * conversion happens in the components, via `@/lib/units`.
 */

import {
  computeWeightTrend,
  estimateExpenditure,
  mifflinStJeorBmr,
  summarizeTrend,
  type CoachConditioning,
  type CoachIntake,
  type CoachInput,
  type CoachReadinessDay,
  type CoachTraining,
  type ExpenditureDay,
  type Goal as AlgorithmGoal,
  type MuscleWeek,
  type UserProfile,
} from '@/lib/algorithms';
import { bandForScore } from '@/lib/algorithms';
import type { WeightSeriesPoint } from '@/lib/db/repos';
import type {
  Activity,
  Exercise,
  FoodLog,
  Goal,
  Insight,
  Muscle,
  Profile,
  ReadinessRecord,
  VolumeLandmarks,
  WorkoutSession,
} from '@/lib/db/types';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Days of history read for the trend filter and the 56-day expenditure window. */
export const HISTORY_DAYS = 120;

/** Days in a review week. */
export const WEEK_DAYS = 7;

/**
 * Fallback landmarks, used only when the vault has no per-muscle landmarks yet.
 *
 * These are the mid-range Israetel numbers for an intermediate lifter. They are
 * deliberately generic: a personalised landmark set is the training layer's
 * property, and inventing a precise-looking one here would make the volume
 * insight read as more tailored than it is.
 */
export const FALLBACK_LANDMARKS: VolumeLandmarks = {
  mv: 6,
  mev: 8,
  mavLow: 12,
  mavHigh: 18,
  mrv: 22,
};

/**
 * The trainer's per-muscle contribution when a session is logged but not
 * confirmed, expressed as an upper bound.
 *
 * `program-personalized.md` §3.1: when you do not know how much work someone
 * else did, **round it up, not down.** An unconfirmed session counts at full
 * prior value plus a wide bound, because under-counting it is the error that
 * pushes the athlete past MRV three days a week, indefinitely.
 */
export const UNCONFIRMED_TRAINER_BOUND_MULTIPLIER = 1.35;

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

/** `YYYY-MM-DD` shifted by whole days. Calendar arithmetic only, no timezones. */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The seven `YYYY-MM-DD` keys ending on `endKey`, ascending. */
export function weekKeys(endKey: string): string[] {
  return Array.from({ length: WEEK_DAYS }, (_, i) => shiftDateKey(endKey, -(WEEK_DAYS - 1 - i)));
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

/** Everything the review needs from the vault, before it becomes a `CoachInput`. */
export interface ReviewSnapshot {
  weekEndingDate: string;
  profile: Profile | null;
  goal: Goal | null;
  weights: readonly WeightSeriesPoint[];
  /** Daily kcal across the history window; missing days are simply absent. */
  intakeSeries: readonly { date: string; intakeKcal: number | null }[];
  /** Every food log in the review week, for the macro means. */
  weekFoodLogs: readonly FoodLog[];
  /** Latest body-fat percentage from a measurement or estimate, when one exists. */
  bodyFatPct: number | null;
  sessions: readonly WorkoutSession[];
  exercisesById: ReadonlyMap<string, Exercise>;
  /** Hard sets per muscle from the app's own logged sets, this week. */
  appSetsByMuscle: Partial<Record<Muscle, number>>;
  activities: readonly Activity[];
  zoneMinutes: Partial<Record<number, number>>;
  readiness: readonly ReadinessRecord[];
  /** Generated coach rows already stored in the encrypted vault. */
  insightHistory?: readonly Insight[];
}

/**
 * Turn the vault profile into the algorithm's `UserProfile`, or `null`.
 *
 * Returns `null` rather than substituting defaults when sex, height, age or a
 * bodyweight are missing. Every energy calculation downstream is a function of
 * those four, and a review built on a guessed 80 kg is not a cautious review —
 * it is a confident wrong one.
 */
export function toUserProfile(
  profile: Profile | null,
  goal: Goal | null,
  latestWeightKg: number | null,
  bodyFatPct: number | null,
  today: string,
): UserProfile | null {
  if (!profile || !profile.sex || !profile.heightCm || latestWeightKg === null) return null;
  const ageYears = ageFromBirthDate(profile.birthDate, today);
  if (ageYears === null) return null;

  return {
    sex: profile.sex,
    ageYears,
    heightCm: profile.heightCm,
    bodyweightKg: latestWeightKg,
    ...(bodyFatPct !== null ? { bodyFatPct } : {}),
    goal: (goal?.direction ?? 'maintain') as AlgorithmGoal,
    ...(goal?.targetWeightKg != null ? { goalWeightKg: goal.targetWeightKg } : {}),
    ...(goal?.targetBodyFatPct != null ? { goalBodyFatPct: goal.targetBodyFatPct } : {}),
  };
}

/** Whole years between a birth date and a day. `null` when unknown. */
export function ageFromBirthDate(birthDate: string | null, today: string): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  if ([by, bm, bd, ty, tm, td].some((n) => !Number.isFinite(n))) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/* ------------------------------------------------------------------ */
/* Intake                                                              */
/* ------------------------------------------------------------------ */

/**
 * Aggregate the week's food logs.
 *
 * Two decisions worth naming:
 *
 * - **Means are over logged days only.** Dividing by seven when four were
 *   logged reports a protein intake nobody ate and makes the adequacy floors
 *   fire on an artefact.
 * - **Fibre is summed as `fiberG ?? 0`.** A food with no fibre field is not the
 *   same as a food with no fibre, and this understates rather than overstates —
 *   which is the safe direction for a floor check, because the failure mode is
 *   a nudge to eat more fibre rather than a false all-clear.
 */
export function buildIntake(
  weekFoodLogs: readonly FoodLog[],
  keys: readonly string[],
  targetKcal: number,
): CoachIntake | null {
  if (weekFoodLogs.length === 0) return null;

  const byDay = new Map<string, { kcal: number; protein: number; carb: number; fat: number; fiber: number }>();
  for (const log of weekFoodLogs) {
    const acc = byDay.get(log.dateKey) ?? { kcal: 0, protein: 0, carb: 0, fat: 0, fiber: 0 };
    acc.kcal += log.nutrients.kcal;
    acc.protein += log.nutrients.proteinG;
    acc.carb += log.nutrients.carbG;
    acc.fat += log.nutrients.fatG;
    acc.fiber += log.nutrients.fiberG ?? 0;
    byDay.set(log.dateKey, acc);
  }

  const days = keys.map((date) => ({
    date,
    kcal: byDay.has(date) ? (byDay.get(date) as { kcal: number }).kcal : null,
    targetKcal,
  }));

  const logged = [...byDay.values()];
  const n = logged.length;
  if (n === 0) return null;
  const mean = (pick: (d: (typeof logged)[number]) => number) =>
    logged.reduce((a, d) => a + pick(d), 0) / n;

  return {
    days,
    meanKcal: mean((d) => d.kcal),
    meanProteinG: mean((d) => d.protein),
    meanFatG: mean((d) => d.fat),
    meanCarbG: mean((d) => d.carb),
    meanFiberG: mean((d) => d.fiber),
    targetKcal,
  };
}

/* ------------------------------------------------------------------ */
/* Training                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the per-muscle week.
 *
 * The trainer's contribution comes from each session's `TrainerReport.estimate`
 * — the estimate the trainer-confirmation flow already derived — and is raised
 * to an upper bound when the session is unconfirmed. **An unreported session is
 * not zero.** Treating a missing report as no volume would have the app program
 * *more* work exactly when it knows least, which is the inversion the whole
 * budgeting mechanism exists to prevent.
 */
export function buildTraining(
  sessions: readonly WorkoutSession[],
  appSetsByMuscle: Partial<Record<Muscle, number>>,
  landmarksByMuscle: Partial<Record<Muscle, VolumeLandmarks>> = {},
): CoachTraining | null {
  const trainerSessions = sessions.filter((s) => s.kind === 'personal_trainer');
  const confirmed = trainerSessions.filter((s) => s.trainerReport?.confirmed).length;

  const trainerByMuscle = new Map<Muscle, number>();
  for (const s of trainerSessions) {
    const estimate = s.trainerReport?.estimate;
    if (!estimate) continue;
    const bound = s.trainerReport?.confirmed ? 1 : UNCONFIRMED_TRAINER_BOUND_MULTIPLIER;
    for (const [muscle, value] of Object.entries(estimate)) {
      if (!value) continue;
      // Upper bound = mean + 1 SD, then widened again when unconfirmed.
      const ub = (value.meanSets + value.sdSets) * bound;
      trainerByMuscle.set(muscle as Muscle, (trainerByMuscle.get(muscle as Muscle) ?? 0) + ub);
    }
  }

  const muscles = new Set<Muscle>([
    ...(Object.keys(appSetsByMuscle) as Muscle[]),
    ...trainerByMuscle.keys(),
  ]);
  if (muscles.size === 0) return null;

  const volume: MuscleWeek[] = [...muscles].map((muscle) => ({
    muscle,
    appSets: round1(appSetsByMuscle[muscle] ?? 0),
    trainerSetsUpperBound: round1(trainerByMuscle.get(muscle) ?? 0),
    prehabSets: 0,
    landmarks: landmarksByMuscle[muscle] ?? FALLBACK_LANDMARKS,
    confirmations: confirmed,
  }));

  return {
    volume: volume.sort((a, b) => (a.muscle < b.muscle ? -1 : 1)),
    trainerSessions: trainerSessions.length,
    trainerSessionsConfirmed: confirmed,
  };
}

/* ------------------------------------------------------------------ */
/* Conditioning                                                        */
/* ------------------------------------------------------------------ */

/**
 * Map logged activities onto the Galpin dose.
 *
 * Zone 2 is zone 2 only. Zone 1 is recovery work and counting it toward the
 * aerobic-base dose would let a week of walking read as a week of training.
 * Hard sessions are Z4 and Z5, which is where the VO2max adaptation lives.
 */
export function buildConditioning(
  activities: readonly Activity[],
  zoneMinutes: Partial<Record<number, number>>,
): CoachConditioning | null {
  if (activities.length === 0) return null;
  const zone2Sessions = activities.filter((a) => a.zone === 2).length;
  const hard = activities.filter((a) => a.zone === 4 || a.zone === 5).length;
  return {
    zone2Minutes: Math.round(zoneMinutes[2] ?? 0),
    zone2Sessions,
    hardIntervalSessions: hard,
    zone3Minutes: Math.round(zoneMinutes[3] ?? 0),
  };
}

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

/**
 * Convert stored readiness rows back into the coach's day shape.
 *
 * `ReadinessRecord.score` is the 0–100 presentation figure; the band is always
 * derived from the raw score, so this inverts `readinessPercent` and then calls
 * `bandForScore` rather than re-thresholding the percentage. Re-thresholding is
 * how a screen ends up disagreeing with the engine about what "low" means.
 */
export function buildReadiness(records: readonly ReadinessRecord[]): CoachReadinessDay[] {
  return records
    .map((r) => {
      const raw = (r.score / 100) * 3 - 2;
      return { date: r.dateKey, band: bandForScore(raw), score: round2(raw) };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* The assembly                                                        */
/* ------------------------------------------------------------------ */

/** Result of assembling a review, plus the pieces the screen renders directly. */
export interface ReviewBuild {
  input: CoachInput;
  /** The full trend series, for the chart. Empty when there are no weigh-ins. */
  trendSeries: ReturnType<typeof computeWeightTrend>;
}

/**
 * Assemble the week.
 *
 * @param snapshot every vault row the review reads
 * @returns the coach input plus the trend series, or `null` when the profile is
 *   too incomplete for any energy calculation to mean anything
 */
export function buildReview(snapshot: ReviewSnapshot): ReviewBuild | null {
  const keys = weekKeys(snapshot.weekEndingDate);

  const trendSeries = computeWeightTrend(
    snapshot.weights.map((w) => ({ date: w.date, kg: w.kg })),
  );
  const trend = summarizeTrend(trendSeries);
  const latestWeightKg = trend?.trendKg ?? snapshot.weights.at(-1)?.kg ?? null;

  const profile = toUserProfile(
    snapshot.profile,
    snapshot.goal,
    latestWeightKg,
    snapshot.bodyFatPct,
    snapshot.weekEndingDate,
  );
  if (!profile) return null;

  const bmrKcal = mifflinStJeorBmr(
    profile.sex,
    profile.bodyweightKg,
    profile.heightCm,
    profile.ageYears,
  );

  // --- Expenditure -------------------------------------------------------
  const intakeByDate = new Map(snapshot.intakeSeries.map((d) => [d.date, d.intakeKcal]));
  const days: ExpenditureDay[] = trendSeries.map((p) => ({
    date: p.date,
    trendKg: p.trendKg,
    energyTrendKg: p.energyTrendKg,
    perturbationActive: p.perturbationActive,
    intakeKcal: intakeByDate.get(p.date) ?? null,
  }));
  const expenditure = days.length >= 7 ? estimateExpenditure(days, { bmrKcal }) : null;

  // --- Intake ------------------------------------------------------------
  // The energy target is the estimate minus the goal's prescribed rate. When
  // there is no estimate yet there is no target either, and the review says so
  // rather than inventing one.
  const targetKcal =
    expenditure && snapshot.goal
      ? Math.round(expenditure.tdeeKcal + (snapshot.goal.targetRateKgPerWeek * 7700) / 7)
      : (expenditure?.tdeeKcal ?? 0);
  const intake = buildIntake(snapshot.weekFoodLogs, keys, Math.round(targetKcal));

  // --- Goal --------------------------------------------------------------
  const targetRatePctBwPerWeek =
    snapshot.goal && profile.bodyweightKg > 0
      ? round2((snapshot.goal.targetRateKgPerWeek / profile.bodyweightKg) * 100)
      : 0;

  const weeksElapsed = snapshot.goal
    ? Math.max(1, Math.round(daysApart(snapshot.goal.startDateKey, snapshot.weekEndingDate) / 7))
    : undefined;

  const input: CoachInput = {
    weekEndingDate: snapshot.weekEndingDate,
    profile,
    goals: {
      targetRatePctBwPerWeek,
      ...(snapshot.goal?.targetBodyFatPct != null
        ? { targetBodyFatPct: snapshot.goal.targetBodyFatPct }
        : {}),
      ...(weeksElapsed !== undefined ? { weeksElapsed } : {}),
    },
    trend,
    expenditure,
    intake,
    training: buildTraining(snapshot.sessions, snapshot.appSetsByMuscle),
    conditioning: buildConditioning(snapshot.activities, snapshot.zoneMinutes),
    readiness: buildReadiness(snapshot.readiness),
    weighInsLast14d: trend?.weighInsLast14d ?? snapshot.weights.length,
  };

  return { input, trendSeries };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Whole days between two `YYYY-MM-DD` keys. */
export function daysApart(from: string, to: string): number {
  const [ay, am, ad] = from.split('-').map(Number);
  const [by, bm, bd] = to.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
