/**
 * @file Weekly volume accounting — what got trained, and how much room is left.
 *
 * Two inputs, deliberately kept apart:
 *
 * - **Sets the app watched happen.** Logged by the user, exact, counted 1.0 for
 *   every primary muscle and 0.5 for every secondary (`training-methodology.md`
 *   §2.3). Warm-ups never count.
 * - **Sets the trainer did in a room the app was not in.** Estimated, with a
 *   sigma attached, and budgeted against its **upper** bound
 *   (`program-personalized.md` §3).
 *
 * Mixing those two into one number would be the mistake: it would let a
 * confident-looking total hide the fact that most of it is a guess. Every
 * function here keeps them separable, and the UI shows them as two stacked
 * segments for the same reason.
 *
 * Pure and zero-dependency.
 */

import type { Muscle, VolumeLandmarks } from '../db/types';
import type { LibraryExercise } from './types';

/**
 * Weekly hard-set landmarks for an intermediate trainee
 * (`training-methodology.md` §2.1).
 *
 * `[coach-specific opinion]` for every cell — these are the values RP publishes
 * and are **starting estimates the app is expected to personalize**, not truths.
 * Six of them (`adductors`, `abductors`, `obliques`, `neck`, `hip_flexors`,
 * `tibialis`) are extrapolated rather than published; {@link LOW_CONFIDENCE}
 * lists them so the UI can say so instead of implying precision.
 */
export const LANDMARKS: Readonly<Record<Muscle, VolumeLandmarks>> = {
  chest: { mv: 8, mev: 10, mavLow: 12, mavHigh: 20, mrv: 22 },
  front_delts: { mv: 0, mev: 0, mavLow: 6, mavHigh: 12, mrv: 12 },
  side_delts: { mv: 6, mev: 8, mavLow: 16, mavHigh: 22, mrv: 26 },
  rear_delts: { mv: 0, mev: 6, mavLow: 12, mavHigh: 20, mrv: 26 },
  lats: { mv: 6, mev: 10, mavLow: 14, mavHigh: 22, mrv: 25 },
  upper_back: { mv: 0, mev: 10, mavLow: 12, mavHigh: 20, mrv: 25 },
  traps: { mv: 0, mev: 0, mavLow: 12, mavHigh: 20, mrv: 26 },
  biceps: { mv: 5, mev: 8, mavLow: 14, mavHigh: 20, mrv: 26 },
  triceps: { mv: 4, mev: 6, mavLow: 10, mavHigh: 14, mrv: 18 },
  forearms: { mv: 2, mev: 2, mavLow: 10, mavHigh: 15, mrv: 20 },
  quads: { mv: 6, mev: 8, mavLow: 12, mavHigh: 18, mrv: 20 },
  hamstrings: { mv: 4, mev: 6, mavLow: 10, mavHigh: 16, mrv: 20 },
  glutes: { mv: 0, mev: 4, mavLow: 12, mavHigh: 16, mrv: 16 },
  adductors: { mv: 0, mev: 6, mavLow: 8, mavHigh: 12, mrv: 16 },
  abductors: { mv: 0, mev: 4, mavLow: 6, mavHigh: 12, mrv: 14 },
  calves: { mv: 6, mev: 8, mavLow: 12, mavHigh: 16, mrv: 20 },
  tibialis: { mv: 0, mev: 4, mavLow: 6, mavHigh: 12, mrv: 16 },
  spinal_erectors: { mv: 0, mev: 4, mavLow: 6, mavHigh: 10, mrv: 12 },
  abs: { mv: 0, mev: 0, mavLow: 16, mavHigh: 20, mrv: 25 },
  obliques: { mv: 0, mev: 0, mavLow: 8, mavHigh: 16, mrv: 20 },
  neck: { mv: 0, mev: 0, mavLow: 8, mavHigh: 12, mrv: 16 },
  hip_flexors: { mv: 0, mev: 0, mavLow: 4, mavHigh: 10, mrv: 12 },
};

/** Muscles whose landmarks are extrapolated rather than published (§12.3). */
export const LOW_CONFIDENCE: ReadonlySet<Muscle> = new Set<Muscle>([
  'adductors',
  'abductors',
  'obliques',
  'neck',
  'hip_flexors',
  'tibialis',
]);

/** Every muscle, in the frozen order from the methodology spec. */
export const ALL_MUSCLES = Object.keys(LANDMARKS) as Muscle[];

/**
 * Indirect volume weight (`training-methodology.md` §2.3).
 *
 * Stored as a constant because practitioners genuinely differ — some count 0
 * (direct only), some count 1.0. Direct-only counting systematically
 * over-prescribes arm and rear-delt volume in high-frequency programs.
 */
export const INDIRECT_SET_WEIGHT = 0.5;

/** One muscle's week. */
export interface MuscleWeek {
  muscle: Muscle;
  /** Hard sets the app logged. Exact. */
  loggedSets: number;
  /** Estimated trainer sets, mean. */
  trainerMean: number;
  /** Estimated trainer sets, upper credible bound — what budgeting subtracts. */
  trainerUpperBound: number;
  /** Trainer fatigue charge, upper bound, after the MRV-cost weighting. */
  trainerFatigueUpperBound: number;
  landmarks: VolumeLandmarks;
  /** `logged + trainer upper bound`, the number the budget compares to. */
  totalUpperBound: number;
  /** Where that total sits against the landmarks. */
  status: VolumeStatus;
  /** True when the landmarks themselves are extrapolated. */
  lowConfidence: boolean;
}

/** Where a muscle's weekly volume sits against its landmarks. */
export type VolumeStatus = 'under_mev' | 'mev_to_mav' | 'in_mav' | 'above_mav' | 'above_mrv';

/**
 * Classify a weekly set count against a muscle's landmarks.
 *
 * @param sets weekly hard sets
 * @param landmarks that muscle's landmarks
 * @returns the band
 */
export function classifyVolume(sets: number, landmarks: VolumeLandmarks): VolumeStatus {
  if (sets > landmarks.mrv) return 'above_mrv';
  if (sets > landmarks.mavHigh) return 'above_mav';
  if (sets >= landmarks.mavLow) return 'in_mav';
  if (sets >= landmarks.mev) return 'mev_to_mav';
  return 'under_mev';
}

/**
 * Count hard sets per muscle from logged work.
 *
 * Warm-ups are excluded, per §2.3. Sets are counted, never reps — a set of 20
 * and a set of 5 are one hard set each.
 *
 * @param sets the week's performed sets, warm-ups included (they are filtered here)
 * @param libraryBySlug the movements those sets reference
 * @param slugForSet resolves a set to its exercise slug
 * @returns a sparse map of muscle → hard sets
 */
export function loggedSetsByMuscle<T extends { warmup: boolean }>(
  sets: readonly T[],
  libraryBySlug: ReadonlyMap<string, LibraryExercise>,
  slugForSet: (set: T) => string | null,
): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const set of sets) {
    if (set.warmup) continue;
    const slug = slugForSet(set);
    if (slug === null) continue;
    const exercise = libraryBySlug.get(slug);
    if (!exercise) continue;
    for (const m of exercise.primary_muscles) out[m] = (out[m] ?? 0) + 1;
    for (const m of exercise.secondary_muscles) {
      out[m] = (out[m] ?? 0) + INDIRECT_SET_WEIGHT;
    }
  }
  return out;
}

/** Everything the budget needs to know about the trainer's week, per muscle. */
export interface TrainerWeekLoad {
  stimulusUpperBound: number;
  fatigueUpperBound: number;
  stimulusMean: number;
}

/**
 * Assemble the weekly picture for every muscle.
 *
 * @param logged hard sets the app logged, per muscle
 * @param trainer the trainer's estimated load, per muscle
 * @returns one row per muscle, ordered by how crowded it is
 */
export function buildWeek(
  logged: Partial<Record<Muscle, number>>,
  trainer: Partial<Record<Muscle, TrainerWeekLoad>>,
): MuscleWeek[] {
  return ALL_MUSCLES.map((muscle) => {
    const landmarks = LANDMARKS[muscle];
    const loggedSets = logged[muscle] ?? 0;
    const t = trainer[muscle];
    const trainerUpperBound = t?.stimulusUpperBound ?? 0;
    const totalUpperBound = loggedSets + trainerUpperBound;
    return {
      muscle,
      loggedSets,
      trainerMean: t?.stimulusMean ?? 0,
      trainerUpperBound,
      trainerFatigueUpperBound: t?.fatigueUpperBound ?? 0,
      landmarks,
      totalUpperBound,
      status: classifyVolume(totalUpperBound, landmarks),
      lowConfidence: LOW_CONFIDENCE.has(muscle),
    };
  }).sort((a, b) => b.totalUpperBound / b.landmarks.mrv - a.totalUpperBound / a.landmarks.mrv);
}

/**
 * How many sets of its own the app may still prescribe for a muscle this week.
 *
 * The §3.5 budget, in the form the logger needs it: the **minimum** of the two
 * ledgers, floored at zero.
 *
 * - The *stimulus* ledger asks "has this muscle had enough?" and compares to
 *   the week's target.
 * - The *fatigue* ledger asks "is the ceiling close?" and compares to `mavHigh`
 *   — not `mrv`. In a deficit the methodology caps volume near MAV rather than
 *   pushing to MRV; MRV stays the hard limit we never aim at.
 *
 * Both are correct reasons to stop, so the smaller wins.
 *
 * **One deliberate simplification.** §3.3's `rawTarget` ramps the weekly target
 * across a mesocycle, from a week-1 floor toward the ceiling. The logger has no
 * mesocycle — it is a record of what happened, and the block belongs to the
 * program planner (node S5). So the target here is the *static* low end of MAV,
 * with the §3.3 week-1 floor applied underneath it. That is conservative by
 * construction: it hands back fewer sets than a late-mesocycle target would,
 * and under-prescribing is the cheaper error. When S5 lands it should pass its
 * own weekly target in rather than reusing this default.
 *
 * @param week one muscle's week
 * @returns remaining sets, and the unclamped value which is diagnostic (§3.7)
 */
export function remainingBudget(week: MuscleWeek): { sets: number; unclamped: number } {
  const weekOneFloor = Math.max(
    week.landmarks.mev,
    Math.floor(0.5 * week.landmarks.mavLow),
  );
  const ceiling = week.landmarks.mavHigh;

  const stimulusBudget =
    Math.max(weekOneFloor, week.landmarks.mavLow) - week.totalUpperBound;
  const fatigueBudget = ceiling - (week.loggedSets + week.trainerFatigueUpperBound);

  const unclamped = Math.min(stimulusBudget, fatigueBudget);
  return { sets: Math.max(0, Math.floor(unclamped)), unclamped };
}

/**
 * The muscles the trainer has already covered, so the app leaves them alone.
 *
 * This is the practical output of the whole estimator: a short list the weekly
 * review can render as *"Your trainer's already covering lats — I've left them
 * alone."*
 *
 * @param weeks the week's rows
 * @returns muscles whose remaining budget is zero and whose trainer load is the
 *   reason, most crowded first
 */
export function coveredByTrainer(weeks: readonly MuscleWeek[]): MuscleWeek[] {
  return weeks.filter(
    (w) => w.trainerUpperBound > 0 && remainingBudget(w).sets === 0,
  );
}
