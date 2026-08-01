/**
 * @file The trainer-session estimator (`program-personalized.md` §2 and §3.4).
 *
 * Some athletes train in person with a personal trainer. **The app cannot
 * program those sessions.** It learns what happened only if the athlete tells
 * it afterwards, and even then only coarsely.
 *
 * So this module does one job: turn a nine-slider post-hoc report into a
 * per-muscle set estimate *with an honest uncertainty attached*, and then into
 * the **upper credible bound** that weekly volume budgeting subtracts.
 *
 * ## The asymmetry that shapes everything here
 *
 * > When you do not know how much work someone else did, round it **up**.
 *
 * Over-estimating the trainer costs the athlete a couple of sets of their own.
 * Under-estimating pushes them past MRV on the exact muscles already getting
 * the most work. Those errors are not
 * symmetric, so the estimator is not symmetric either: budgeting subtracts
 * `mean + z·sd`, never the mean, and `z` shrinks only as confirmations
 * accumulate.
 *
 * Pure, zero-dependency, no I/O. Tested in `__tests__/trainer-estimate.test.ts`.
 */

import type { Muscle } from '../db/types';
import type {
  EffortLevel,
  MuscleEstimate,
  TrainerRegion,
  TrainerSessionReport,
} from './types';

/** The nine regions, in the order the confirmation screen shows them. */
export const TRAINER_REGIONS: readonly TrainerRegion[] = [
  'hips',
  'mid_back',
  'lats',
  'quads_sled',
  'core',
  'calves_lower_leg',
  'pressing',
  'arms',
  'conditioning',
];

/** Slider position → hard sets credited to that region. */
export const EFFORT_TO_SETS: readonly [number, number, number, number] = [0, 2, 4, 7];

/** What each slider position means, in the athlete's own words. */
export const EFFORT_LABELS: readonly [string, string, string, string] = [
  "Didn't touch it",
  'A bit',
  'Solid',
  'Hammered',
];

/**
 * How a coarse region distributes onto the frozen 22-muscle vocabulary.
 *
 * Weights sum to more than 1 per region on purpose: one exercise loads several
 * muscles, at 1.0 direct and 0.5 indirect (`training-methodology.md` §2.3).
 */
export const REGION_MAP: Readonly<Record<TrainerRegion, Readonly<Partial<Record<Muscle, number>>>>> =
  {
    hips: {
      glutes: 0.55,
      hamstrings: 0.35,
      adductors: 0.12,
      abductors: 0.12,
      spinal_erectors: 0.22,
      quads: 0.15,
    },
    mid_back: {
      upper_back: 0.6,
      rear_delts: 0.22,
      traps: 0.18,
      biceps: 0.18,
      spinal_erectors: 0.12,
    },
    lats: { lats: 0.65, biceps: 0.22, upper_back: 0.2, forearms: 0.15 },
    quads_sled: { quads: 0.6, glutes: 0.18, calves: 0.15, tibialis: 0.12 },
    pressing: { chest: 0.5, front_delts: 0.3, triceps: 0.3, side_delts: 0.1 },
    arms: { biceps: 0.5, triceps: 0.5, forearms: 0.2 },
    core: { abs: 0.55, obliques: 0.35, hip_flexors: 0.15 },
    calves_lower_leg: { calves: 0.6, tibialis: 0.3 },
    conditioning: { quads: 0.2, calves: 0.1 },
  };

/**
 * A neutral whole-body fallback for a trainer session when the local vault has
 * days configured but no description of what the trainer covers. A locally
 * stored description produces a more useful prior through {@link priorFromFocus}.
 */
export const NEUTRAL_REGION_EFFORT: Readonly<Record<TrainerRegion, EffortLevel>> =
  Object.freeze(Object.fromEntries(TRAINER_REGIONS.map((region) => [region, 1])) as Record<TrainerRegion, EffortLevel>);

/** Generic per-region session shapes at "solid" effort. */
const REGION_PRIOR: Readonly<Record<TrainerRegion, Readonly<Partial<Record<Muscle, number>>>>> = {
  hips: { glutes: 3, hamstrings: 2.5, spinal_erectors: 1.2, adductors: 1, abductors: 1 },
  mid_back: { upper_back: 3, rear_delts: 1.5, traps: 1, biceps: 0.5, spinal_erectors: 0.3 },
  lats: { lats: 2.5, upper_back: 0.5, biceps: 1, forearms: 1 },
  quads_sled: { quads: 4, glutes: 0.5 },
  core: { abs: 2, obliques: 1.5, hip_flexors: 1 },
  calves_lower_leg: { calves: 1, tibialis: 1 },
  pressing: { chest: 2.5, front_delts: 1.5, side_delts: 0.5, triceps: 1.5 },
  arms: { biceps: 0.5, triceps: 0.5, forearms: 0.25 },
  conditioning: {},
};

const FOCUS_TERMS: Readonly<Record<TrainerRegion, readonly string[]>> = {
  hips: ['hip', 'hips', 'glute', 'glutes', 'hamstring', 'hamstrings', 'posterior chain'],
  mid_back: ['mid back', 'upper back', 'row', 'rows', 'rowing', 'traps'],
  lats: ['lat', 'lats', 'pull up', 'pull-up', 'pulldown'],
  quads_sled: ['quad', 'quads', 'sled', 'knee', 'knees', 'leg press'],
  core: ['core', 'abs', 'abdominal', 'oblique'],
  calves_lower_leg: ['calf', 'calves', 'tibialis', 'lower leg'],
  pressing: ['press', 'pressing', 'chest', 'pec', 'shoulder'],
  arms: ['arm', 'arms', 'biceps', 'triceps', 'forearm'],
  conditioning: ['conditioning', 'cardio', 'interval', 'aerobic', 'bike', 'running'],
};

/** Interpret locally stored free text into coarse slider defaults. No text leaves the device. */
export function regionEffortFromFocus(focus: string): Record<TrainerRegion, EffortLevel> {
  const normalized = focus.toLocaleLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return { ...NEUTRAL_REGION_EFFORT };
  const out = {} as Record<TrainerRegion, EffortLevel>;
  for (const region of TRAINER_REGIONS) {
    const matched = FOCUS_TERMS[region].some((term) => normalized.includes(term));
    if (matched) out[region] = region === 'quads_sled' && normalized.includes('sled') ? 1 : 2;
    else out[region] = ['core', 'calves_lower_leg', 'arms', 'conditioning'].includes(region) ? 1 : 0;
  }
  return Object.values(out).some((effort) => effort > 0) ? out : { ...NEUTRAL_REGION_EFFORT };
}

/** Convert local trainer-focus text into the uncertain per-muscle prior. */
export function priorFromFocus(focus: string): Partial<Record<Muscle, MuscleEstimate>> {
  const effort = regionEffortFromFocus(focus);
  const means: Partial<Record<Muscle, number>> = {};
  for (const region of TRAINER_REGIONS) {
    const scale = effort[region] / 2;
    for (const [muscle, solidSets] of Object.entries(REGION_PRIOR[region]) as [Muscle, number][]) {
      means[muscle] = (means[muscle] ?? 0) + solidSets * scale;
    }
  }
  return Object.fromEntries(Object.entries(means).map(([muscle, meanSets]) => [
    muscle,
    { meanSets, sdSets: Math.max(0.5, Math.min(1.2, meanSets * 0.4)) },
  ])) as Partial<Record<Muscle, MuscleEstimate>>;
}

export const DEFAULT_TRAINER_PRIOR = Object.freeze(priorFromFocus(''));

/** Starting confidence in the prior, before any confirmation. */
export const SEED_CONFIDENCE = 0.35;

/** Inter-session correlation. `[uncertain]` — a modelling choice, see §2.3. */
export const RHO = 0.5;

/** Mean EWMA gain — roughly a three-session half-life. */
export const ALPHA = 0.4;
/** Variance EWMA gain. */
export const BETA = 0.3;

/**
 * Weekly standard deviation across `n` correlated sessions.
 *
 * **Not `sd × n` and not `sd × √n`.** Sessions from the same trainer in the
 * same week are positively correlated — same plan, same emphasis — so the
 * weekly spread sits between "every session identical" (`ρ = 1`, `sd × 3`) and
 * "independent" (`ρ = 0`, `sd × 1.73`). At `ρ = 0.5` and `n = 3` it is
 * `sd × 2.45`.
 *
 * @param sd per-session 1-sigma
 * @param n number of sessions in the week
 * @param rho inter-session correlation. Default {@link RHO}.
 * @returns the weekly sigma
 */
export function weeklySd(sd: number, n: number, rho = RHO): number {
  if (n <= 0) return 0;
  return sd * Math.sqrt(n + n * (n - 1) * rho);
}

/**
 * How many sigmas above the mean to budget against.
 *
 * At the seed confidence of 0.35 this is 0.865 — cautious. After roughly ten
 * confirmed sessions (confidence → 0.90) it falls to 0.26. That gives the
 * athlete a concrete reason to confirm sessions: *confirm them and the app can
 * hand back about three sets a week.*
 *
 * @param confidence 0..1
 * @returns the z multiplier, clamped to [0.25, 1.25]
 */
export function zFor(confidence: number): number {
  return Math.min(1.25, Math.max(0.25, 1.25 - 1.1 * confidence));
}

/**
 * Turn a slider report into observed hard sets per muscle.
 *
 * @param regionEffort the nine sliders; absent regions count as 0
 * @returns sets attributed to each muscle for this one session
 */
export function observedSets(
  regionEffort: Partial<Record<TrainerRegion, EffortLevel>>,
): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const region of TRAINER_REGIONS) {
    const effort = regionEffort[region];
    if (effort === undefined || effort === 0) continue;
    const regionSets = EFFORT_TO_SETS[effort];
    for (const [muscle, weight] of Object.entries(REGION_MAP[region]) as [Muscle, number][]) {
      out[muscle] = (out[muscle] ?? 0) + regionSets * weight;
    }
  }
  return out;
}

/**
 * Scale a report's muscle estimate to a stated total hard-set count.
 *
 * The power-user override: someone who counted 22 sets should have the
 * *distribution* from the sliders and the *magnitude* from the count. A total
 * of zero is ignored rather than zeroing everything, because "0" from a session
 * that happened is far more likely to be an unfilled field than the truth.
 *
 * @param sets per-muscle sets from {@link observedSets}
 * @param hardSetsTotal the athlete's own count, or `null`
 * @returns the scaled sets
 */
export function scaleToTotal(
  sets: Partial<Record<Muscle, number>>,
  hardSetsTotal: number | null,
): Partial<Record<Muscle, number>> {
  if (hardSetsTotal === null || hardSetsTotal <= 0) return sets;
  // Direct-set equivalent: the region weights already spread one exercise over
  // several muscles, so the natural total is the sum divided by the average
  // spread. Comparing like with like means comparing sums.
  const current = Object.values(sets).reduce<number>((a, b) => a + (b ?? 0), 0);
  if (current <= 0) return sets;
  const factor = (hardSetsTotal * 1.6) / current;
  const out: Partial<Record<Muscle, number>> = {};
  for (const [muscle, value] of Object.entries(sets) as [Muscle, number][]) {
    out[muscle] = value * factor;
  }
  return out;
}

/**
 * EWMA update of one muscle's estimate from one observation.
 *
 * The `sdSets` floor of `max(1.0, 0.25 × mean)` is deliberate and load-bearing.
 * Without it a run of similar confirmations drives sigma toward zero and the
 * app starts treating a guess as a measurement. The trainer varies. The
 * athlete's recall is coarse. Uncertainty never goes away.
 *
 * @param estimate the current estimate
 * @param observed sets observed this session
 * @returns the updated estimate
 */
export function updateEstimate(estimate: MuscleEstimate, observed: number): MuscleEstimate {
  const meanNext = estimate.meanSets + ALPHA * (observed - estimate.meanSets);
  const varNext =
    (1 - BETA) * estimate.sdSets ** 2 + BETA * (observed - estimate.meanSets) ** 2;
  return {
    meanSets: meanNext,
    sdSets: Math.max(Math.sqrt(varNext), 1.0, 0.25 * meanNext),
  };
}

/**
 * Move confidence after a session.
 *
 * Capped at 0.90 for the same reason sigma has a floor: the app never gets to
 * claim it knows what happened in a room it was not in.
 *
 * @param confidence the current value
 * @param confirmed whether the athlete confirmed this session
 * @returns the updated confidence, in [0.30, 0.90]
 */
export function updateConfidence(confidence: number, confirmed: boolean): number {
  return confirmed
    ? Math.min(0.9, confidence + 0.08)
    : Math.max(0.3, confidence - 0.05);
}

/**
 * Fold a report into a per-muscle estimate.
 *
 * When the athlete has not touched the sliders, the seed prior stands
 * unmodified — which is the whole point of §2.2: *if the athlete never
 * confirms, the prior is counted at full value.*
 *
 * @param report what the athlete submitted
 * @param prior the current per-muscle prior. Defaults to a neutral fallback.
 * @returns the estimate to store on the session
 */
export function estimateFromReport(
  report: Pick<TrainerSessionReport, 'regionEffort' | 'hardSetsTotal' | 'confirmed'>,
  prior: Partial<Record<Muscle, MuscleEstimate>> = DEFAULT_TRAINER_PRIOR,
): Partial<Record<Muscle, MuscleEstimate>> {
  if (!report.confirmed) return { ...prior };

  const observed = scaleToTotal(observedSets(report.regionEffort), report.hardSetsTotal);
  const muscles = new Set<Muscle>([
    ...(Object.keys(prior) as Muscle[]),
    ...(Object.keys(observed) as Muscle[]),
  ]);

  const out: Partial<Record<Muscle, MuscleEstimate>> = {};
  for (const muscle of muscles) {
    const current = prior[muscle] ?? { meanSets: 0, sdSets: 1.0 };
    out[muscle] = updateEstimate(current, observed[muscle] ?? 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fatigue weighting
// ---------------------------------------------------------------------------

/** How a set is classified when charging it against the fatigue ceiling. */
export type MovementClass =
  | 'compound_eccentric'
  | 'machine'
  | 'isolation'
  | 'carry'
  | 'concentric_only'
  | 'prehab_submaximal';

/**
 * Multiplier applied to a set when charging it against the MRV ceiling
 * (`program-personalized.md` §3.4).
 *
 * Sled work is concentric-only: it delivers real stimulus with very little of
 * the muscle damage that drives MRV. Counting it the same as a set of Bulgarian
 * split squats would be wrong in a way that matters *specifically for this
 * athlete*, whose trainer uses a sled. That single distinction is what makes
 * room for the knee-ability ladder without blowing the quad ceiling.
 */
export const MRV_COST: Readonly<Record<MovementClass, number>> = {
  compound_eccentric: 1.0,
  machine: 0.9,
  isolation: 0.8,
  carry: 0.5,
  concentric_only: 0.4,
  prehab_submaximal: 0.5,
};

/**
 * The blended fatigue cost of one trainer session's work on one muscle.
 *
 * Sled metres, when reported, shift the quad and calf ledger toward
 * `concentric_only`. Everything else is charged as compound eccentric work,
 * which is the conservative reading of an hour with a trainer.
 *
 * @param muscle the muscle being charged
 * @param report the session report
 * @returns a multiplier in [0.4, 1.0]
 */
export function meanMrvCost(muscle: Muscle, report: Pick<TrainerSessionReport, 'sledMeters'>): number {
  const sledMuscle = muscle === 'quads' || muscle === 'calves' || muscle === 'tibialis';
  if (!sledMuscle) return MRV_COST.compound_eccentric;
  const metres = report.sledMeters ?? 0;
  if (metres <= 0) return MRV_COST.compound_eccentric;
  // 200 m of sled is a session's worth; past that the muscle's work is
  // essentially all concentric.
  const sledShare = Math.min(1, metres / 200);
  return (
    MRV_COST.concentric_only * sledShare + MRV_COST.compound_eccentric * (1 - sledShare)
  );
}

/** A week's worth of trainer load on one muscle, both ledgers, with bounds. */
export interface TrainerLoad {
  /** Σ mean sets across the week's trainer sessions. */
  stimulusMean: number;
  /** Σ mean sets × MRV cost. */
  fatigueMean: number;
  /** Upper credible bound on stimulus — what the budget actually subtracts. */
  stimulusUpperBound: number;
  /** Upper credible bound on fatigue. */
  fatigueUpperBound: number;
  /** How many trainer sessions contributed. */
  sessions: number;
}

/**
 * A week of trainer sessions, aggregated into the two ledgers.
 *
 * @param reports the week's trainer reports, one per session
 * @param muscle the muscle to aggregate
 * @param confidence current confidence in the estimates, 0..1
 * @returns both ledgers with their upper bounds
 */
export function trainerLoadFor(
  reports: readonly TrainerSessionReport[],
  muscle: Muscle,
  confidence: number,
): TrainerLoad {
  let stimulusMean = 0;
  let fatigueMean = 0;
  let sdSum = 0;
  let costSum = 0;

  for (const report of reports) {
    const estimate = report.estimate[muscle];
    if (!estimate) continue;
    const cost = meanMrvCost(muscle, report);
    stimulusMean += estimate.meanSets;
    fatigueMean += estimate.meanSets * cost;
    sdSum += estimate.sdSets;
    costSum += cost;
  }

  const n = reports.length;
  const meanSd = n > 0 ? sdSum / n : 0;
  const meanCost = n > 0 ? costSum / n : MRV_COST.compound_eccentric;
  const spread = zFor(confidence) * weeklySd(meanSd, n);

  return {
    stimulusMean,
    fatigueMean,
    stimulusUpperBound: stimulusMean + spread,
    fatigueUpperBound: fatigueMean + spread * meanCost,
    sessions: n,
  };
}
