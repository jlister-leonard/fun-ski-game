/**
 * @file The progression engine — task graph node **A5**.
 *
 * One block of training, expressed as arithmetic: where a muscle's weekly set
 * count starts, how it climbs, when effort tightens, when to stop early, and
 * what the next block inherits.
 *
 * ## The two specs, and where they disagree
 *
 * `training-methodology.md` §3 describes the general RP block: 4 accumulation
 * weeks + 1 deload, RIR ramping `[4,3,2,1]`, volume climbing MEV → ~95% of MRV.
 * The conservative concurrent-training default uses 3 accumulation weeks
 * because conditioning, a deficit and outside trainer sessions can accumulate
 * fatigue faster, with a
 * `[3,2,1]` ramp, and a **ceiling of `mavHigh` rather than `mrv`** because
 * methodology §10 caps volume near MAV in a deficit.
 *
 * Both are exported. {@link DEFAULT_MESO} is the personalized 3+1 block;
 * {@link METHODOLOGY_MESO} is the textbook 4+1. The ceiling is a parameter, not
 * a constant, so neither spec has to be edited to change it.
 *
 * ## What this file will not do
 *
 * `training-methodology.md` §8.5 is normative. Concretely, in here:
 *
 * - Every readiness-driven change is **bounded** and routed through
 *   {@link import('./guardrails').clampAdjustment}. Volume ∈ [−50%, +10%],
 *   RIR ∈ [−1, +2].
 * - Readiness may **never raise a prescribed load**. There is no code path in
 *   this file that increases weight from a recovery score; the `high` band buys
 *   at most one extra set on the last exercise.
 * - Three consecutive readiness-driven reductions stop the adjusting and prompt
 *   a deload instead (rule 2). Quietly shaving a session forever is the failure
 *   mode that rule exists to prevent.
 * - Nothing here counsels training through pain. `painFlag` freezes progression
 *   in place; it never substitutes, never adds, and never explains.
 *
 * And one product rule from `AGENTS.md`: **nothing rewards volume for its own
 * sake.** MRV is a limit that the ramp deliberately stops short of. There is no
 * streak, no total, and no state in which "more sets" is the congratulation.
 *
 * Pure and zero-dependency. Tested in `__tests__/mesocycle.test.ts`.
 */

import type { Finding } from '../algorithms/guardrails';
import type { Muscle, VolumeLandmarks } from '../db/types';
import { ADJUSTMENT_LIMITS, clampAdjustment, type ReadinessBand } from './guardrails';

// ---------------------------------------------------------------------------
// Block shape
// ---------------------------------------------------------------------------

/** The knobs that define one mesocycle (`training-methodology.md` §3.2). */
export interface MesoConfig {
  /** Weeks of rising volume before the deload. */
  accumulationWeeks: number;
  /** Deload weeks at the end. Always 1 in both specs. */
  deloadWeeks: number;
  /** Target RIR per accumulation week. Length must equal `accumulationWeeks`. */
  rirRamp: readonly number[];
  /** Maximum week-over-week increase, per muscle, in sets. */
  setSlewCap: number;
  /** Target RIR during the deload. Never grind. */
  deloadRir: number;
}

/**
 * Conservative concurrent-training block: **3 accumulation + 1 deload**, RIR `[3,2,1]`.
 *
 * Shorter than the methodology default on purpose. With trainer sessions the
 * app only estimates, shorter blocks mean estimate errors get corrected
 * sooner.
 */
export const DEFAULT_MESO: MesoConfig = {
  accumulationWeeks: 3,
  deloadWeeks: 1,
  rirRamp: [3, 2, 1],
  setSlewCap: 3,
  deloadRir: 4,
};

/** The textbook block: 4 accumulation + 1 deload, RIR `[4,3,2,1]` (§3.1). */
export const METHODOLOGY_MESO: MesoConfig = {
  accumulationWeeks: 4,
  deloadWeeks: 1,
  rirRamp: [4, 3, 2, 1],
  setSlewCap: 3,
  deloadRir: 4,
};

/** Total weeks in a block, deload included. */
export function mesoLength(cfg: MesoConfig = DEFAULT_MESO): number {
  return cfg.accumulationWeeks + cfg.deloadWeeks;
}

/**
 * Whether a 1-based week index falls in the deload.
 *
 * @param week 1-based week within the block
 * @param cfg the block shape
 * @returns true during the deload
 */
export function isDeloadWeek(week: number, cfg: MesoConfig = DEFAULT_MESO): boolean {
  return week > cfg.accumulationWeeks;
}

/**
 * Target reps-in-reserve for a week.
 *
 * The ramp falls across the block, and that is the point: fatigue accumulates,
 * so a *fixed* RIR target silently loses effective stimulus. Lowering RIR each
 * week holds the stimulus roughly constant against a rising fatigue floor
 * (§3.1). The deload resets to 4–5 — reps unchanged, load down, never grind.
 *
 * @param week 1-based week within the block
 * @param cfg the block shape
 * @returns the RIR to prescribe
 */
export function targetRir(week: number, cfg: MesoConfig = DEFAULT_MESO): number {
  if (isDeloadWeek(week, cfg)) return cfg.deloadRir;
  const index = Math.min(Math.max(week, 1) - 1, cfg.rirRamp.length - 1);
  return cfg.rirRamp[index];
}

/** One week of the block, before any muscle-specific numbers are attached. */
export interface MesocycleWeek {
  /** 1-based week within the block. */
  week: number;
  isDeload: boolean;
  targetRir: number;
}

/**
 * The block's weeks, in order.
 *
 * @param cfg the block shape
 * @returns one row per week
 */
export function mesocycleWeeks(cfg: MesoConfig = DEFAULT_MESO): MesocycleWeek[] {
  const out: MesocycleWeek[] = [];
  for (let week = 1; week <= mesoLength(cfg); week += 1) {
    out.push({ week, isDeload: isDeloadWeek(week, cfg), targetRir: targetRir(week, cfg) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Landmark scaling
// ---------------------------------------------------------------------------

/** Training age, which scales every landmark except MV (§2.2). */
export type TrainingAge = 'beginner' | 'intermediate' | 'advanced';

/** `[coach-specific opinion]` — the §2.2 multipliers. */
export const TRAINING_AGE_SCALE: Readonly<Record<TrainingAge, number>> = {
  beginner: 0.65,
  intermediate: 1.0,
  advanced: 1.15,
};

/**
 * Beginner MEV floor for major muscles (§2.2).
 *
 * The biggest programming failure mode for novices is prescribing intermediate
 * volume, blowing up soreness and killing adherence. Beginners grow at MV-ish
 * volumes; the limiting factor is technique and connective tissue, not sets.
 */
export const BEGINNER_MEV_FLOOR = 6;

/** Muscles that are systemically expensive and capped lower per session (§2.4). */
export const LARGE_MUSCLES: ReadonlySet<Muscle> = new Set<Muscle>([
  'chest',
  'lats',
  'upper_back',
  'quads',
  'hamstrings',
  'glutes',
]);

/** Muscles the §11.6 conditioning haircut applies to. */
export const LOWER_BODY_MUSCLES: ReadonlySet<Muscle> = new Set<Muscle>([
  'quads',
  'hamstrings',
  'glutes',
  'adductors',
  'abductors',
  'calves',
  'tibialis',
  'hip_flexors',
  'spinal_erectors',
]);

/**
 * Scale a muscle's landmarks by training age.
 *
 * MV is never scaled — maintenance is maintenance whoever you are. Ordering is
 * re-established afterwards so a scaled table can never claim `mev > mavLow`.
 *
 * @param landmarks the population-prior landmarks
 * @param muscle which muscle, for the beginner floor
 * @param age the athlete's training age
 * @returns scaled landmarks
 */
export function scaleLandmarks(
  landmarks: VolumeLandmarks,
  muscle: Muscle,
  age: TrainingAge,
): VolumeLandmarks {
  const k = TRAINING_AGE_SCALE[age];
  let mev = landmarks.mev * k;
  if (age === 'beginner' && landmarks.mev > 0 && LARGE_MUSCLES.has(muscle)) {
    mev = Math.max(mev, BEGINNER_MEV_FLOOR);
  }
  const mavLow = Math.max(mev, landmarks.mavLow * k);
  const mavHigh = Math.max(mavLow, landmarks.mavHigh * k);
  const mrv = Math.max(mavHigh, landmarks.mrv * k);
  return { mv: landmarks.mv, mev, mavLow, mavHigh, mrv };
}

/** Weekly Z4/Z5 minutes past which lower-body ceilings take a haircut (§11.6). */
export const HARD_CONDITIONING_HAIRCUT_MINUTES = 60;
/** The size of that haircut. */
export const CONDITIONING_HAIRCUT = 0.9;

/**
 * The ceiling the ramp aims at — pipeline steps (b) and (c) of
 * `program-personalized.md` §3.2.
 *
 * **In a deficit the ceiling is `mavHigh`, not `mrv`** (methodology §10). MRV
 * stays the hard limit that the budget checks against; we simply never aim at
 * it. Then, if hard conditioning exceeds an hour a week, lower-body ceilings
 * come down 10% (§11.6) — evaluated every week rather than assumed, because
 * this program's late-block dose sits close enough to the threshold that one
 * added session trips it.
 *
 * @param landmarks the muscle's landmarks, already training-age scaled
 * @param muscle which muscle
 * @param options.deficit whether the athlete is in a calorie deficit
 * @param options.hardConditioningMinutes weekly Z4/Z5 minutes
 * @returns the ceiling in weekly sets
 */
export function ceilingFor(
  landmarks: VolumeLandmarks,
  muscle: Muscle,
  options: { deficit: boolean; hardConditioningMinutes?: number },
): number {
  let ceiling = options.deficit ? landmarks.mavHigh : landmarks.mrv;
  const minutes = options.hardConditioningMinutes ?? 0;
  if (minutes > HARD_CONDITIONING_HAIRCUT_MINUTES && LOWER_BODY_MUSCLES.has(muscle)) {
    ceiling *= CONDITIONING_HAIRCUT;
  }
  return Math.max(landmarks.mev, ceiling);
}

// ---------------------------------------------------------------------------
// The volume ramp
// ---------------------------------------------------------------------------

/**
 * Week-1 volume for a muscle — pipeline step (d).
 *
 * Six muscles in the seed table have MEV 0 (`front_delts`, `traps`, `abs`,
 * `obliques`, `neck`, and `rear_delts` conditionally). The unmodified ramp
 * prescribes literally zero sets for them in week 1 and then jumps. The floor
 * removes that artefact; the slew cap removes what is left of the jump.
 *
 * @param landmarks the muscle's landmarks
 * @returns the week-1 anchor in sets
 */
export function weekOneFloor(landmarks: VolumeLandmarks): number {
  return Math.max(landmarks.mev, Math.floor(0.5 * landmarks.mavLow));
}

/**
 * Deload volume: MV-ish, ~50–60% of the block's MEV anchor (§3.2).
 *
 * @param landmarks the muscle's landmarks
 * @returns sets to prescribe during the deload
 */
export function deloadSets(landmarks: VolumeLandmarks): number {
  return Math.max(landmarks.mv, Math.round(landmarks.mev * 0.6));
}

/** Load multiplier for the deload week (§3.2): 60–70% of the last hard week. */
export const DELOAD_LOAD_FACTOR = 0.65;

/** The ramp stops here. **MRV is a limit, not a target** (§3.2). */
export const RAMP_FRACTION = 0.95;

/**
 * The un-slewed weekly target for one muscle (§3.3 `rawTarget`).
 *
 * Linear from the week-1 anchor to 95% of the ceiling. The 95% is deliberate:
 * over-prescribing volume is the more common and more costly error (§11.5).
 *
 * @param landmarks the muscle's landmarks
 * @param ceiling from {@link ceilingFor}
 * @param week 1-based week within the block
 * @param cfg the block shape
 * @returns the target in sets, unrounded
 */
export function rawTarget(
  landmarks: VolumeLandmarks,
  ceiling: number,
  week: number,
  cfg: MesoConfig = DEFAULT_MESO,
): number {
  if (isDeloadWeek(week, cfg)) return deloadSets(landmarks);
  const floor = weekOneFloor(landmarks);
  const span = Math.max(0, ceiling - floor);
  const steps = Math.max(1, cfg.accumulationWeeks - 1);
  return floor + span * RAMP_FRACTION * ((Math.max(1, week) - 1) / steps);
}

/**
 * The whole block's targets for one muscle, with the slew limiter applied.
 *
 * Step (f) of the §3.2 pipeline: `target(m,w) ≤ target(m,w−1) + setSlewCap`.
 * The cap only limits *increases*; the deload is free to drop as far as it
 * likes.
 *
 * @param landmarks the muscle's landmarks
 * @param ceiling from {@link ceilingFor}
 * @param cfg the block shape
 * @returns one target per week, week 1 first
 */
export function rampTargets(
  landmarks: VolumeLandmarks,
  ceiling: number,
  cfg: MesoConfig = DEFAULT_MESO,
): number[] {
  const out: number[] = [];
  let previous: number | null = null;
  for (let week = 1; week <= mesoLength(cfg); week += 1) {
    let target = rawTarget(landmarks, ceiling, week, cfg);
    if (previous !== null && !isDeloadWeek(week, cfg)) {
      target = Math.min(target, previous + cfg.setSlewCap);
    }
    // MRV is the hard limit even when the ceiling was computed from MAV.
    target = Math.min(target, landmarks.mrv);
    out.push(target);
    previous = target;
  }
  return out;
}

/**
 * Minimum sessions per week for a weekly set count (§2.4).
 *
 * Frequency barely matters for hypertrophy at equated volume; what matters is
 * **sets per muscle per session**, which should stay ≈4–10 for large muscles.
 * So frequency falls out of volume rather than being chosen.
 *
 * @param weeklySets the week's prescribed sets
 * @param muscle which muscle
 * @returns sessions per week, at least 1
 */
export function minFrequency(weeklySets: number, muscle: Muscle): number {
  if (weeklySets <= 0) return 0;
  const perSessionCap = LARGE_MUSCLES.has(muscle) ? 8 : 10;
  return Math.max(1, Math.ceil(weeklySets / perSessionCap));
}

// ---------------------------------------------------------------------------
// Within-block progression (§3.3)
// ---------------------------------------------------------------------------

/** What the engine decided to do with a lift this week. */
export type ProgressionMove = 'add_load' | 'add_rep' | 'repeat' | 'hold';

/**
 * How hard the engine leans on an ambiguous week.
 *
 * The athlete chose **push**: propose the increase and make them decline it,
 * even after a mediocre session. Concretely, under `push` a top set that hit
 * the top of its rep range earns a load increase whether or not an RIR was
 * recorded and whether or not that RIR beat the target — missing effort data
 * stops being a reason to stand still.
 *
 * What `push` does **not** touch, because §8.5 is not overridable:
 *
 * - A **regression** is still a stall, still repeats, and still feeds the
 *   early-deload trigger. Pushing through a genuine regression is exactly what
 *   that rule exists to prevent.
 * - **Pain** still freezes everything.
 * - **Readiness** still may never raise a load.
 *
 * So this changes the default answer on a *maybe*, not the answer on a *no*.
 */
export type ProgressionBias = 'push' | 'conservative';

/** The athlete's choice: push hard, including on ambiguous days. */
export const DEFAULT_PROGRESSION_BIAS: ProgressionBias = 'push';

/** A lift's last top set, as the progression rule reads it. */
export interface TopSetHistory {
  /** Load in kilograms. Storage is SI; conversion happens at the display edge. */
  weightKg: number;
  /** Reps performed on the top set. */
  reps: number;
  /** Reps in reserve the athlete reported, or `null` when not recorded. */
  achievedRir: number | null;
  /** Reps on the same lift the week before, or `null` on a first exposure. */
  previousReps: number | null;
}

/** The next prescription for one lift, and why. */
export interface ProgressionStep {
  move: ProgressionMove;
  weightKg: number;
  reps: number;
  /** True when reps regressed — feeds the stall ledger. */
  stalled: boolean;
  /**
   * True when this is an increase the athlete is being offered rather than a
   * confirmed one. The UI proposes it and they decline; it is never applied
   * behind their back.
   */
  proposed: boolean;
  /** §8.5 rule 10: always show what drove the number. */
  reason: string;
}

/** Load jump when the top of the range is cleared (§3.3). */
export const LOAD_STEP = { upper: 0.025, lower: 0.05 } as const;

/**
 * Week-over-week progression for one lift (§3.3), in the spec's priority order.
 *
 * ```
 * IF last top set hit repMax at or below targetRir → add load, reset to repMin
 * ELSE IF reps achieved >= last week's reps        → add one rep, same load
 * ELSE (reps regressed)                            → repeat the load, log a stall
 * ```
 *
 * Two deviations, both required by specs above this one:
 *
 * - **`painFlag` freezes everything.** §8.5 rule 4: never increase load or
 *   volume while pain is flagged. The move becomes `hold` and no substitution
 *   is proposed here — that belongs to `guardrails.ts`, and it is never framed
 *   as a treatment.
 * - **In a deficit, load is the last thing to move** (`program-personalized.md`
 *   §5.2). Pass `holdLoad` and the engine progresses reps only; expecting
 *   weekly load increases in a cut manufactures false stall signals.
 *
 * @param history the lift's last top set, or `null` on a first exposure
 * @param options.repRange the exercise's `[min, max]`
 * @param options.targetRir this week's RIR target
 * @param options.upperBody smaller load jumps than lower body
 * @param options.holdLoad progress reps only — the deficit default
 * @param options.painFlag pain reported on this movement
 * @returns the next prescription, or `null` when there is no history to progress
 */
export function progressTopSet(
  history: TopSetHistory | null,
  options: {
    repRange: readonly [number, number];
    targetRir: number;
    upperBody?: boolean;
    holdLoad?: boolean;
    painFlag?: boolean;
    /** Defaults to {@link DEFAULT_PROGRESSION_BIAS}. */
    bias?: ProgressionBias;
  },
): ProgressionStep | null {
  if (history === null) return null;
  const [repMin, repMax] = options.repRange;

  const bias = options.bias ?? DEFAULT_PROGRESSION_BIAS;

  if (options.painFlag === true) {
    return {
      move: 'hold',
      weightKg: history.weightKg,
      reps: history.reps,
      stalled: false,
      proposed: false,
      reason: 'Pain is flagged, so this holds where it is rather than progressing.',
    };
  }

  const clearedTop =
    history.reps >= repMax &&
    (bias === 'push'
      ? true
      : history.achievedRir !== null && history.achievedRir <= options.targetRir);

  if (clearedTop && history.weightKg > 0 && options.holdLoad !== true) {
    const step = options.upperBody === true ? LOAD_STEP.upper : LOAD_STEP.lower;
    const effort =
      history.achievedRir === null
        ? 'You topped out the rep range'
        : `You hit ${history.reps} at ${history.achievedRir} RIR`;
    return {
      move: 'add_load',
      weightKg: history.weightKg * (1 + step),
      reps: repMin,
      stalled: false,
      proposed: true,
      reason:
        `${effort}, so I'm putting the load up ${Math.round(step * 1000) / 10}% and ` +
        `resetting the reps to ${repMin}. Knock it back if that's not the day you're having.`,
    };
  }

  const held = history.previousReps === null || history.reps >= history.previousReps;
  if (held && history.reps < repMax) {
    return {
      move: 'add_rep',
      weightKg: history.weightKg,
      reps: history.reps + 1,
      stalled: false,
      proposed: true,
      reason: `Same load, one more rep — you were at ${history.reps} of ${repMin}–${repMax}.`,
    };
  }

  if (held) {
    return {
      move: 'repeat',
      weightKg: history.weightKg,
      reps: history.reps,
      stalled: false,
      proposed: false,
      reason:
        options.holdLoad === true
          ? 'Top of the range at the same load. In a deficit the load holds — that is the plan working, not a stall.'
          : 'Repeat, so the reps are owned before the load moves.',
    };
  }

  return {
    move: 'repeat',
    weightKg: history.weightKg,
    reps: history.reps,
    stalled: true,
    proposed: false,
    reason: `Reps came down from ${history.previousReps} to ${history.reps}, so this repeats rather than progresses.`,
  };
}

// ---------------------------------------------------------------------------
// Stalls and the early deload (§3.3, §8.4)
// ---------------------------------------------------------------------------

/** Consecutive stalls per exercise slug. Absent means zero. */
export type StallLedger = Readonly<Record<string, number>>;

/** What a stall count calls for (§3.3). */
export type StallResponse = 'none' | 'repeat' | 'cut_one_set' | 'end_mesocycle';

/** Stalls on distinct lifts in one session that force a deload (§3.3). */
export const SESSION_STALL_THRESHOLD = 3;
/** Consecutive stalls on one lift that force a deload. */
export const CONSECUTIVE_STALL_THRESHOLD = 3;

/**
 * Fold one week's outcome into the ledger.
 *
 * A clean week resets the counter for that lift — stalls have to be
 * *consecutive* to mean anything, and a lift that recovered has told us the
 * fatigue was transient.
 *
 * @param ledger the current ledger
 * @param slug the exercise
 * @param stalled whether this week stalled
 * @returns the updated ledger
 */
export function recordStall(ledger: StallLedger, slug: string, stalled: boolean): StallLedger {
  const next = { ...ledger };
  if (stalled) next[slug] = (next[slug] ?? 0) + 1;
  else delete next[slug];
  return next;
}

/**
 * What to do about a lift's stall count (§3.3).
 *
 * @param consecutive consecutive stalls on that lift
 * @returns the response
 */
export function stallResponse(consecutive: number): StallResponse {
  if (consecutive >= CONSECUTIVE_STALL_THRESHOLD) return 'end_mesocycle';
  if (consecutive === 2) return 'cut_one_set';
  if (consecutive === 1) return 'repeat';
  return 'none';
}

/** Whether the block should end now, and the sentence explaining why. */
export interface EarlyDeloadCheck {
  trigger: boolean;
  reason: string | null;
  findings: Finding[];
}

/**
 * The early-deload trigger — *"the single most valuable autoregulation rule in
 * the system"* (§3.3).
 *
 * Three consecutive stalls on one lift, or stalls across three or more lifts in
 * one session, ends the mesocycle. Premature deloads cost almost nothing; late
 * deloads cost weeks. `program-personalized.md` §8.4 adds the scope: this
 * applies **only to app-programmed lifts**, because those are the only ones
 * with a load history the app can trust.
 *
 * @param ledger consecutive stalls per slug, app-programmed lifts only
 * @param stalledThisSession slugs that stalled in the session just finished
 * @returns the verdict and the findings to show
 */
export function earlyDeloadCheck(
  ledger: StallLedger,
  stalledThisSession: readonly string[] = [],
): EarlyDeloadCheck {
  const persistent = Object.entries(ledger).filter(
    ([, n]) => n >= CONSECUTIVE_STALL_THRESHOLD,
  );
  const distinct = new Set(stalledThisSession).size;

  if (persistent.length > 0) {
    const reason =
      `${persistent[0][0]} has stalled ${persistent[0][1]} weeks running. ` +
      'That is the block telling you it is done, so this week becomes the deload.';
    return {
      trigger: true,
      reason,
      findings: [
        {
          ok: false,
          level: 'info',
          code: 'meso.early_deload_stalls',
          message: `${reason} An early deload costs almost nothing; a late one costs weeks.`,
        },
      ],
    };
  }

  if (distinct >= SESSION_STALL_THRESHOLD) {
    const reason = `${distinct} lifts went backwards in the same session, which reads as accumulated fatigue rather than a bad lift.`;
    return {
      trigger: true,
      reason,
      findings: [
        {
          ok: false,
          level: 'info',
          code: 'meso.early_deload_session',
          message: `${reason} Ending the block here and deloading.`,
        },
      ],
    };
  }

  return { trigger: false, reason: null, findings: [] };
}

// ---------------------------------------------------------------------------
// The between-week feedback rule (§3.3)
// ---------------------------------------------------------------------------

/** RP's three post-session questions, collapsed to four answers (§3.3). */
export type VolumeFeedback = 'no_disruption' | 'moderate' | 'high_soreness' | 'excessive';

/** How each answer moves next week's set count. */
export const FEEDBACK_SET_CHANGE: Readonly<Record<VolumeFeedback, number>> = {
  no_disruption: 2,
  moderate: 1,
  high_soreness: 0,
  excessive: -1,
};

/** The question text, in the athlete's own terms. */
export const FEEDBACK_LABELS: Readonly<Record<VolumeFeedback, string>> = {
  no_disruption: 'No pump, no soreness, felt easy',
  moderate: 'Decent pump, recovered by the next session',
  high_soreness: 'Still sore when that muscle came round again',
  excessive: 'Very sore, performance down, joints achy',
};

/**
 * Next week's sets for a muscle, from this week's feedback (§3.3).
 *
 * Bounded on both sides: never below MV, never above 95% of the ceiling, and
 * never more than one slew step above where the week started. The feedback rule
 * *modulates* the ramp; it does not replace it.
 *
 * @param currentSets this week's prescribed sets
 * @param feedback what the athlete reported
 * @param landmarks the muscle's landmarks
 * @param ceiling the week's ceiling from {@link ceilingFor}
 * @param cfg the block shape
 * @returns next week's sets
 */
export function nextWeekSets(
  currentSets: number,
  feedback: VolumeFeedback | null,
  landmarks: VolumeLandmarks,
  ceiling: number,
  cfg: MesoConfig = DEFAULT_MESO,
  bias: ProgressionBias = DEFAULT_PROGRESSION_BIAS,
): number {
  // No answer is an ambiguous day, and the athlete asked to push on those:
  // treat silence as a normal session (+1) under `push`, as a hold under
  // `conservative`. Either way it is bounded by the ceiling below.
  const resolved: VolumeFeedback =
    feedback ?? (bias === 'push' ? 'moderate' : 'high_soreness');
  const change = Math.min(FEEDBACK_SET_CHANGE[resolved], cfg.setSlewCap);
  const proposed = currentSets + change;
  const cap = Math.min(landmarks.mrv, ceiling * RAMP_FRACTION);
  return Math.max(landmarks.mv, Math.min(cap, proposed));
}

// ---------------------------------------------------------------------------
// Block → block (§3.4)
// ---------------------------------------------------------------------------

/** Cap on landmark drift per block, so estimates cannot run away (§3.4). */
export const MAX_LANDMARK_DRIFT = 3;
/** How far MEV rises after a block that was tolerated with performance rising. */
export const MEV_STEP_UP = 1;
/** How far MRV falls after a block that ended in an early deload. */
export const MRV_STEP_DOWN = 2;

/** How the block that just ended actually went. */
export interface BlockOutcome {
  /** True when the early-deload trigger fired. */
  endedEarly: boolean;
  /** True when the final accumulation week was tolerated with performance still rising. */
  performanceRising: boolean;
}

/** Updated landmarks plus the deltas, so the UI can show the reasoning. */
export interface CarryOver {
  landmarks: VolumeLandmarks;
  mevDelta: number;
  mrvDelta: number;
  /** One sentence for the block review. */
  note: string;
}

/**
 * Seed the next block's landmarks from how this one went (§3.4).
 *
 * This is the personalization loop, and it is deliberately timid: the ±3-set
 * cap is *our* guardrail rather than a published rule (`[uncertain]`), and the
 * seed table it drifts from is a population prior with wide error bars.
 *
 * @param landmarks the block's landmarks
 * @param outcome how the block ended
 * @returns the next block's landmarks and the reasoning
 */
export function carryOverLandmarks(
  landmarks: VolumeLandmarks,
  outcome: BlockOutcome,
): CarryOver {
  let mevDelta = 0;
  let mrvDelta = 0;
  let note = 'Block ran as planned — landmarks unchanged.';

  if (outcome.endedEarly) {
    mrvDelta = -MRV_STEP_DOWN;
    note =
      'That block ended early, so the ceiling estimate comes down a couple of sets. ' +
      'The floor stays where it is.';
  } else if (outcome.performanceRising) {
    mevDelta = MEV_STEP_UP;
    note =
      'You finished the block with performance still climbing, so next block starts a set higher.';
  }

  mevDelta = clamp(mevDelta, -MAX_LANDMARK_DRIFT, MAX_LANDMARK_DRIFT);
  mrvDelta = clamp(mrvDelta, -MAX_LANDMARK_DRIFT, MAX_LANDMARK_DRIFT);

  const mev = Math.max(landmarks.mv, landmarks.mev + mevDelta);
  const mrv = Math.max(mev, landmarks.mrv + mrvDelta);
  const mavHigh = Math.min(Math.max(landmarks.mavHigh, mev), mrv);
  const mavLow = Math.min(Math.max(landmarks.mavLow, mev), mavHigh);

  return {
    landmarks: { mv: landmarks.mv, mev, mavLow, mavHigh, mrv },
    mevDelta,
    mrvDelta,
    note,
  };
}

/** Blocks between resensitization phases (§3.4). */
export const RESENSITIZATION_EVERY_BLOCKS = 3;

/**
 * Whether the next block should be a resensitization phase — 1–2 weeks at MV.
 *
 * The claimed mechanism (restoring sensitivity to volume) is `[uncertain]`. The
 * practical effect — a real break for connective tissue — is not, and it is the
 * honest reason to show the user.
 *
 * @param blocksSinceLast completed blocks since the last resensitization
 * @returns true when one is due
 */
export function needsResensitization(blocksSinceLast: number): boolean {
  return blocksSinceLast >= RESENSITIZATION_EVERY_BLOCKS;
}

// ---------------------------------------------------------------------------
// Readiness, bounded (§8.4 and §8.5)
// ---------------------------------------------------------------------------

/** What a readiness band does to a prescribed session. */
export interface ReadinessAdjustment {
  /** Sets after adjustment. Never raised by readiness beyond the `high` extra set. */
  sets: number;
  /** Change to the RIR target. Positive means "leave more in the tank". */
  rirDelta: number;
  /** `high` only: one optional extra set on the *last* exercise (§8.4). */
  extraSetOnLastExercise: boolean;
  /** Fractional load change. **Never positive** — §8.5 rule 1. */
  loadDelta: number;
  findings: Finding[];
}

/** Minimum sets an exercise keeps when readiness trims it (§8.4). */
export const MIN_SETS_WHEN_TRIMMED = 2;

/**
 * Apply a readiness band to one exercise's prescription, within §8.5 bounds.
 *
 * Every number here passes through {@link clampAdjustment}, so volume can never
 * move outside [−50%, +10%], RIR outside [−1, +2], or load outside [−20%, 0%].
 * The load ceiling of zero is the load-bearing one: **a good night's sleep is
 * not evidence that you got stronger.**
 *
 * Rule 2 is enforced here too. Once readiness has driven a reduction on three
 * consecutive sessions the engine stops adjusting and asks for a deload or a
 * rest day instead, because chronic auto-reduction quietly hides whatever is
 * actually wrong.
 *
 * @param band the day's readiness band
 * @param prescribedSets what the plan says
 * @param options.consecutiveReductions how many sessions in a row have been cut
 * @returns the bounded adjustment and its findings
 */
export function applyReadiness(
  band: ReadinessBand,
  prescribedSets: number,
  options: { consecutiveReductions?: number } = {},
): ReadinessAdjustment {
  const consecutive = options.consecutiveReductions ?? 0;
  const unchanged: ReadinessAdjustment = {
    sets: prescribedSets,
    rirDelta: 0,
    extraSetOnLastExercise: false,
    loadDelta: 0,
    findings: [],
  };

  if (
    (band === 'low' || band === 'poor') &&
    consecutive >= ADJUSTMENT_LIMITS.maxConsecutiveReductions
  ) {
    return {
      ...unchanged,
      findings: [
        {
          ok: false,
          level: 'warn',
          code: 'readiness.stop_adjusting',
          message:
            "I've trimmed three sessions in a row now, and shaving a fourth would just hide " +
            'the problem. Take a deload or a rest day, and have a look at sleep, food, life ' +
            'stress, or whether something is brewing.',
        },
      ],
    };
  }

  switch (band) {
    case 'high':
      return {
        ...unchanged,
        extraSetOnLastExercise: true,
        findings: [
          {
            ok: false,
            level: 'info',
            code: 'readiness.green_light',
            message:
              "You're primed. Green light on the planned session — that is a reason to run " +
              'the plan, not a reason to add weight to it.',
          },
        ],
      };

    case 'normal':
      return unchanged;

    case 'low': {
      const factor = clampAdjustment('volume', -0.25);
      const sets = Math.max(
        Math.min(MIN_SETS_WHEN_TRIMMED, prescribedSets),
        Math.min(prescribedSets - 1, Math.round(prescribedSets * (1 + factor))),
      );
      return {
        sets,
        rirDelta: clampAdjustment('rir', 1),
        extraSetOnLastExercise: false,
        loadDelta: clampAdjustment('load', -0.03),
        findings: [
          {
            ok: false,
            level: 'info',
            code: 'readiness.trimmed',
            message:
              'Recovery looks a bit down, so I trimmed a set and left a rep in the tank. ' +
              'You can override this.',
          },
        ],
      };
    }

    case 'poor': {
      const factor = clampAdjustment('volume', -0.45);
      const sets = Math.max(
        Math.min(MIN_SETS_WHEN_TRIMMED, prescribedSets),
        Math.round(prescribedSets * (1 + factor)),
      );
      return {
        sets,
        rirDelta: clampAdjustment('rir', 2),
        extraSetOnLastExercise: false,
        loadDelta: clampAdjustment('load', -0.15),
        findings: [
          {
            ok: false,
            level: 'info',
            code: 'readiness.technique_day',
            message:
              "Your recovery metrics are below your usual range, so today's a " +
              'technique-and-blood-flow day, not a PR day.',
          },
        ],
      };
    }
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
