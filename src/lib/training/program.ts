/**
 * @file Program generation — task graph node **A5**, consumed by the planner
 * screen **S5**.
 *
 * ## The one idea this file exists for
 *
 * > **Subtract the trainer's upper credible bound from the weekly landmarks
 * > before allocating a single set.**
 *
 * When an athlete trains with a trainer, the app cannot program those days, it
 * cannot move them, and it learns what happened only if the athlete tells it
 * afterwards. So the app's job is not to write a program. It is to write **the
 * complement of someone else's program, under uncertainty about what that
 * program contains** (`program-personalized.md` §1).
 *
 * The consequence people find surprising, and which is *correct*: this
 * generator can prescribe **zero** for muscles the trainer already covers.
 * That is not an oversight; it prevents the app from stacking its own work on
 * top of an uncertain outside program.
 *
 * ## The pipeline (`program-personalized.md` §3.2)
 *
 * ```
 * base landmarks
 *   ├─(a) training-age scale        mesocycle.scaleLandmarks
 *   ├─(b) deficit ceiling := mavHigh mesocycle.ceilingFor
 *   ├─(c) conditioning haircut       ditto, if weekly Z4/Z5 > 60 min
 *   ├─(d) week-1 floor               mesocycle.weekOneFloor
 *   ├─(e) mesocycle ramp             mesocycle.rampTargets
 *   ├─(f) slew limiter               ditto
 *   ├─(g) prehab off the top         rank-0 veto work, 0.5 set weight
 *   ├─(h) trainer upper bound        trainer-estimate.trainerLoadFor
 *   ├─(i) app conditioning           this file
 *   └─(j) budget = min(stimulus, fatigue), floored at 0, + indicator reservation
 * ```
 *
 * Two ledgers, and the **smaller** wins (§3.5). When stimulus says "this muscle
 * has had enough" the app stops even though fatigue capacity remains; when
 * fatigue says "the ceiling is close" it stops even though the muscle is
 * under-stimulated. Both are correct reasons to stop.
 *
 * ### A note on §3.9's worked example
 *
 * The example table's app columns move in uniform +3 steps, which reads as the
 * slew cap applied to the *budget*. The pipeline text applies it to the
 * *target* (step f), and the `setSlewCap` comment in §3.3 describes it as "max
 * increase in an app budget". Where the two readings differ this file takes the
 * **minimum of both**, which is the conservative side. Under-prescribing is the
 * cheaper error, and the table is explicitly labelled EXAMPLE.
 *
 * ## Priorities (`athlete-profile.md` §3.2)
 *
 * `joint_integrity` (a veto, rank 0) > `fat_loss` > `vo2max` > `strength`
 * (maintain) > `hypertrophy` (monitor). Concretely, in this file: prehab and
 * conditioning are charged off the top of both ledgers before hypertrophy
 * volume is allocated at all, and the interval session is defended
 * against everything except a `poor` readiness band.
 *
 * ## Honesty
 *
 * Fat loss and VO2max are compatible and mutually helpful. Fat loss and
 * hypertrophy are **not**, at this rate. {@link TRADEOFF_COPY} carries the four
 * statements `athlete-profile.md` §3.3 specifies verbatim; they are emitted as
 * `Finding`s and the planner shows them. No silent downgrades.
 *
 * Pure and zero-dependency. Tested in `__tests__/program.test.ts`, including a
 * test that every slug this file can emit resolves in the 220-entry library.
 */

import type { Finding } from '../algorithms/guardrails';
import type { Muscle, VolumeLandmarks } from '../db/types';
import { exerciseBySlug } from './library';
import {
  ceilingFor,
  isDeloadWeek,
  rampTargets,
  scaleLandmarks,
  targetRir,
  DEFAULT_MESO,
  type MesoConfig,
  type TrainingAge,
} from './mesocycle';
import {
  DEFAULT_TRAINER_PRIOR,
  MRV_COST,
  SEED_CONFIDENCE,
  priorFromFocus,
  regionEffortFromFocus,
  trainerLoadFor,
} from './trainer-estimate';
import type { LibraryExercise, RepUnit, TrainerSessionReport } from './types';
import { ALL_MUSCLES, INDIRECT_SET_WEIGHT, LANDMARKS, LOW_CONFIDENCE, type TrainerWeekLoad } from './volume';

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** 0 = Sunday, matching `Date#getDay` and `program-personalized.md` §2.1. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The five goals, ranked (`athlete-profile.md` §1.3). */
export type GoalId = 'joint_integrity' | 'fat_loss' | 'vo2max' | 'strength' | 'hypertrophy';

/** What the engine is actually doing about a goal. */
export type GoalIntent = 'improve' | 'maintain' | 'monitor';

/** One ranked goal, as the generator reads it. */
export interface ProgramGoal {
  id: GoalId;
  /** 0 = veto/constraint. 1..n = ordinary priority. */
  rank: number;
  intent: GoalIntent;
  /** The athlete's own words. **Immutable** — §3.5 rule 1. */
  statedAs: string;
}

/** Where the athlete currently sits on one Knees-Over-Toes ladder (§7.1). */
export interface LadderPosition {
  ladder:
    | 'knee_split_squat'
    | 'tibialis'
    | 'calf_knee_ability'
    | 'hamstring_nordic'
    | 'sled'
    | 'hip_spine_mobility'
    | 'shoulder_external_rotation';
  /** Must resolve in the library. */
  currentSlug: string;
  /** Human-readable, from methodology §7.1. */
  advancementStandard: string;
}

/** Everything the generator needs from the athlete profile. */
export interface ProgramProfile {
  trainingAge: TrainingAge;
  /** In a calorie deficit — caps the ramp at MAV rather than MRV. */
  deficit: boolean;
  /** Days the app may program. */
  appDays: readonly DayOfWeek[];
  /** Days the trainer owns. The app observes; it never prescribes. */
  trainerDays: readonly DayOfWeek[];
  /** Locally stored free text describing trainer emphasis. */
  trainerFocus?: string;
  /** Equipment tokens available on app days, from the library's vocabulary. */
  equipment: readonly string[];
  /** App-programmed lifts whose e1RM is tracked (`athlete-profile.md` §3.4). */
  indicatorLifts: readonly string[];
  ladders: readonly LadderPosition[];
  goals: readonly ProgramGoal[];
  /** Sites the athlete has flagged. Non-empty suppresses progression there. */
  discomfortSites: readonly string[];
}

/**
 * Synthetic fixture used by deterministic tests and development previews.
 * It is intentionally generic and does not describe a real person.
 */
export const SYNTHETIC_PROFILE: ProgramProfile = {
  trainingAge: 'intermediate',
  deficit: true,
  appDays: [1, 5, 6, 0],
  trainerDays: [2, 3, 4],
  trainerFocus: 'posterior chain, rows, pull-ups and sled work',
  equipment: [
    'barbell', 'dumbbell', 'cable', 'machine', 'bench', 'bodyweight', 'band',
    'bike', 'treadmill', 'box', 'pull_up_bar', 'plate', 'wall', 'sled',
    'nordic_bench', 'ab_wheel', 'ez_bar', 'kettlebell',
  ],
  indicatorLifts: ['incline-dumbbell-press', 'weighted-pull-up', 'hack-squat'],
  ladders: [
    {
      ladder: 'knee_split_squat',
      currentSlug: 'patrick-step',
      advancementStandard: 'full bodyweight ATG split squat, hamstring to calf, pain-free',
    },
    {
      ladder: 'tibialis',
      currentSlug: 'tibialis-raise',
      advancementStandard: '25% bodyweight × 5×5 on tib-bar-raise',
    },
    {
      ladder: 'hamstring_nordic',
      currentSlug: 'assisted-nordic-curl',
      advancementStandard: '3×5 clean eccentric before adding concentric',
    },
    {
      ladder: 'calf_knee_ability',
      currentSlug: 'standing-calf-raise',
      advancementStandard: 'full-ROM knees-over-toes-calf-raise, knee travelling forward',
    },
  ],
  goals: [
    { id: 'joint_integrity', rank: 0, intent: 'maintain', statedAs: 'maintain joint resilience' },
    { id: 'fat_loss', rank: 1, intent: 'improve', statedAs: 'pursue gradual fat loss' },
    { id: 'vo2max', rank: 2, intent: 'improve', statedAs: 'improve aerobic fitness' },
    { id: 'strength', rank: 3, intent: 'maintain', statedAs: 'maintain strength' },
    { id: 'hypertrophy', rank: 4, intent: 'monitor', statedAs: 'monitor muscle retention' },
  ],
  discomfortSites: [],
};

// ---------------------------------------------------------------------------
// Generic tradeoff copy
// ---------------------------------------------------------------------------

/**
 * It is a product requirement, not a nicety: every automated tradeoff produces
 * a user-visible statement containing *what was asked, what was done instead,
 * why, and what it costs*. No silent downgrades.
 */
export const TRADEOFF_COPY: Readonly<Record<string, { goalId: GoalId; title: string; body: string }>> = {
  rate_capped: {
    goalId: 'fat_loss',
    title: 'On faster fat loss → a capped rate',
    body:
      "I've set the rate at 0.65% of bodyweight per week " +
      'rather than the fastest thing your calorie floor would allow. At roughly double that rate, ' +
      'the research in trained lifters shows lean mass stops improving and starts being spent — ' +
      'which would cost you the strength and the interval performance you also asked for. The cap ' +
      "makes this take longer. You can raise it in Settings up to 1.0%/week; above that I won't go.",
  },
  strength_held: {
    goalId: 'strength',
    title: 'On "get stronger" → strength held, not built',
    body:
      "I've set strength to hold, not build, for this block. In a calorie deficit you can keep " +
      'your strength and usually still add a bit through better technique and neural drive, but new ' +
      "muscle needs energy you're deliberately not eating. I'll show you your indicator lifts every " +
      'week — if they hold, this block worked. Block C is where we build.',
  },
  vo2max_realistic: {
    goalId: 'vo2max',
    title: 'On improving VO2 max → a realistic dose',
    body:
      'One to two hard interval sessions a week for 16 weeks, run in a deficit, is a solid dose but ' +
      "it isn't the 3-sessions-a-week research protocol. Expect a meaningful improvement, not a " +
      'transformation, and expect it to be blunted a little by the deficit. The dose goes up in ' +
      "Block B when you're eating at maintenance.",
  },
  trainer_crowding: {
    goalId: 'hypertrophy',
    title: "On the trainer's volume crowding out app volume",
    body:
      'Your trainer already covers some of this week’s muscle volume. I’ve budgeted my own ' +
      'programming around that rather than on top of it. If I added more, you could be over the weekly ceiling on the muscles ' +
      'getting the most work.',
  },
};

/**
 * The goal-conflict summary the planner shows before the block starts.
 *
 * Compatible pairs and incompatible ones, stated plainly
 * (`athlete-profile.md` §3.1). The engine does not get to promise all four at
 * full speed.
 */
export const GOAL_CONFLICTS: readonly {
  pair: string;
  compatible: 'yes' | 'partly' | 'no';
  why: string;
}[] = [
  {
    pair: 'Fat loss + VO2max',
    compatible: 'yes',
    why:
      'Mutually helpful. Zone 2 is recovery-positive and adds expenditure without much fatigue. ' +
      'The only real cost is that hard intervals on low glycogen lose quality — fixable by fuelling, ' +
      'not by dropping the goal.',
  },
  {
    pair: 'Fat loss + joint integrity',
    compatible: 'yes',
    why: 'Prehab is low-load, low-fatigue, low-calorie. Nothing competes.',
  },
  {
    pair: 'Fat loss + strength maintenance',
    compatible: 'yes',
    why:
      'With high protein and continued lifting, a moderate deficit generally preserves lean ' +
      'mass and usually preserves maximal strength through neural adaptation.',
  },
  {
    pair: 'Fat loss + strength *gain*',
    compatible: 'partly',
    why:
      'Real gains in a deficit come from skill and neural drive, and those have a ceiling. Expect ' +
      'them in the first 6–10 weeks and expect them to flatten. That flattening is the expected ' +
      'shape, not failure.',
  },
  {
    pair: 'Fat loss + hypertrophy',
    compatible: 'no',
    why:
      'Not at this rate. Building new contractile tissue takes energy a deficit by definition does ' +
      "not provide. The purpose of this block is to get leaner and fitter while protecting strength; " +
      'a later maintenance or surplus block is the better place to build.',
  },
  {
    pair: 'VO2max + strength',
    compatible: 'partly',
    why:
      'Mild interference, manageable. It mostly hits lower-body strength when high-volume endurance ' +
      'sits close in time, so the conditioning here is low-eccentric (bike, sled) and separated from ' +
      'the heavy lifting day.',
  },
];

// ---------------------------------------------------------------------------
// Budgeting (§3.5)
// ---------------------------------------------------------------------------

/** Where a muscle's budget landed, with every term retained (§3.7). */
export interface MuscleBudget {
  muscle: Muscle;
  /** Landmarks after training-age scaling. */
  landmarks: VolumeLandmarks;
  /** Steps (b)+(c). */
  ceiling: number;
  /** Steps (e)+(f) — this week's slewed target. */
  target: number;
  /** Step (h), stimulus ledger. */
  trainerStimulus: number;
  /** Step (h), fatigue ledger. */
  trainerFatigue: number;
  /** Step (g) — rank-0 prehab, counted at 0.5 set weight. */
  prehab: number;
  /** Step (i) — the app's own conditioning, on both ledgers. */
  conditioningStimulus: number;
  conditioningFatigue: number;
  stimulusBudget: number;
  fatigueBudget: number;
  /** What the app may actually prescribe. Floored at 0 — zero is a valid answer. */
  sets: number;
  /** The *unclamped* budget. Negative is diagnostic, not an error (§3.7). */
  unclamped: number;
  /** Sets reserved for an indicator lift, charged to the fatigue ledger only (§3.6). */
  indicatorSets: number;
  /** Whether the indicator had to be dropped for lack of headroom — and said so. */
  indicatorDropped: boolean;
  status: BudgetStatus;
  /** The landmarks themselves are extrapolated rather than published. */
  lowConfidence: boolean;
}

/** How to read a budget, per the §3.7 table. */
export type BudgetStatus = 'room' | 'covered' | 'over' | 'over_ceiling';

/** Reservation cap per indicator lift, per week (§3.6). */
export const INDICATOR_MAX_SETS = 2;
/** Fatigue headroom below which the indicator is dropped — and the app says so. */
export const INDICATOR_MIN_HEADROOM = 4;

function budgetStatus(unclamped: number, overCeiling: boolean): BudgetStatus {
  if (unclamped >= 1) return 'room';
  if (unclamped >= 0) return 'covered';
  return overCeiling ? 'over_ceiling' : 'over';
}

/** Everything the budget needs that is not the profile. */
export interface BudgetInput {
  /** Per-muscle trainer load, from `trainerLoadFor` via `store.weeklyVolume`. */
  trainer: Partial<Record<Muscle, TrainerWeekLoad>>;
  /** Rank-0 prehab charge per muscle, already at 0.5 set weight. */
  prehab: Partial<Record<Muscle, number>>;
  /** The app's own conditioning charge, both ledgers. */
  conditioning: Partial<Record<Muscle, { stimulus: number; fatigue: number }>>;
  /** Weekly Z4/Z5 minutes — drives the §11.6 haircut. */
  hardConditioningMinutes: number;
  /** 1-based week within the mesocycle. */
  week: number;
  /** Muscles an indicator lift is measured on. */
  indicatorMuscles: ReadonlySet<Muscle>;
}

/**
 * The per-muscle budget for one week — the §3.2 pipeline, end to end.
 *
 * @param profile the athlete
 * @param input the week's trainer load, prehab and conditioning charges
 * @param cfg the block shape
 * @returns one row per muscle, most crowded first
 */
export function budgetWeek(
  profile: ProgramProfile,
  input: BudgetInput,
  cfg: MesoConfig = DEFAULT_MESO,
): MuscleBudget[] {
  const rows = ALL_MUSCLES.map((muscle): MuscleBudget => {
    const landmarks = scaleLandmarks(LANDMARKS[muscle], muscle, profile.trainingAge);
    const ceiling = ceilingFor(landmarks, muscle, {
      deficit: profile.deficit,
      hardConditioningMinutes: input.hardConditioningMinutes,
    });

    const ramp = rampTargets(landmarks, ceiling, cfg);
    const index = Math.min(Math.max(1, input.week), ramp.length) - 1;
    const target = ramp[index];

    const trainer = input.trainer[muscle];
    const trainerStimulus = trainer?.stimulusUpperBound ?? 0;
    const trainerFatigue = trainer?.fatigueUpperBound ?? 0;
    const prehab = input.prehab[muscle] ?? 0;
    const conditioning = input.conditioning[muscle] ?? { stimulus: 0, fatigue: 0 };

    const stimulusBudget = target - trainerStimulus - prehab - conditioning.stimulus;
    const fatigueBudget = ceiling - trainerFatigue - prehab - conditioning.fatigue;

    // Step (f), second reading: the app budget itself never climbs more than
    // one slew step week over week. See the header note on §3.9.
    const previousTarget = index > 0 ? ramp[index - 1] : ramp[0];
    const previousStimulus = previousTarget - trainerStimulus - prehab - conditioning.stimulus;
    const slewCapped = Math.min(
      stimulusBudget,
      Math.max(previousStimulus, 0) + cfg.setSlewCap,
    );

    const unclamped = Math.min(slewCapped, fatigueBudget);
    const sets = Math.max(0, Math.floor(unclamped));

    // §3.6 — up to 2 sets per indicator lift, fatigue ledger only, gated on
    // real headroom so it can never be the thing that tips a muscle over.
    let indicatorSets = 0;
    let indicatorDropped = false;
    if (input.indicatorMuscles.has(muscle)) {
      if (fatigueBudget >= INDICATOR_MIN_HEADROOM) {
        indicatorSets = Math.min(INDICATOR_MAX_SETS, Math.floor(fatigueBudget / 2));
      } else {
        indicatorDropped = true;
      }
    }

    return {
      muscle,
      landmarks,
      ceiling,
      target,
      trainerStimulus,
      trainerFatigue,
      prehab,
      conditioningStimulus: conditioning.stimulus,
      conditioningFatigue: conditioning.fatigue,
      stimulusBudget,
      fatigueBudget,
      sets,
      unclamped,
      indicatorSets,
      indicatorDropped,
      status: budgetStatus(unclamped, fatigueBudget < 0),
      lowConfidence: LOW_CONFIDENCE.has(muscle),
    };
  });

  return rows.sort(
    (a, b) =>
      (b.trainerStimulus + b.prehab) / Math.max(1, b.ceiling) -
      (a.trainerStimulus + a.prehab) / Math.max(1, a.ceiling),
  );
}

// ---------------------------------------------------------------------------
// The week skeleton (§7)
// ---------------------------------------------------------------------------

/** What a slot is for. Drives ordering, deload behaviour and set allocation. */
export type SlotRole =
  | 'indicator'
  | 'main'
  | 'accessory'
  | 'prehab'
  | 'conditioning'
  | 'mobility';

/** One prescribed slot before its sets have been allocated. */
interface SlotSpec {
  slug: string;
  role: SlotRole;
  /** The budget bucket this slot draws from. `null` for prehab and conditioning. */
  charge: Muscle | null;
  /** Sets in week 1 / the minimum worth doing at all. */
  baseSets: number;
  maxSets: number;
  /** Overrides the library's `default_rep_range`. */
  range?: readonly [number, number];
  /** Fixed RIR. `null` means "follow the mesocycle ramp". */
  rir: number | null;
  restSeconds: number;
  /** 1.0 for hard sets; 0.5 for KOT/prehab work (methodology §7.2). */
  setWeight: number;
  /** How this slot's load is charged against MRV (§3.4). */
  cost: keyof typeof MRV_COST;
  note?: string;
  /** Tried in order when the slot's own equipment is unavailable. */
  fallbacks?: readonly string[];
  /** Dropped in a deload week (§8.2). */
  dropOnDeload?: boolean;
  /** Conditioning only. */
  zone?: 'z1' | 'z2' | 'z3' | 'z5';
  /** Weekly Z4/Z5 minutes this slot contributes. */
  hardMinutes?: number;
  /** Never trimmed for time — a warm-up or the protected interval session. */
  protectedSlot?: boolean;
  /** Which ladder, if this slot is a ladder position that can advance. */
  ladder?: LadderPosition['ladder'];
  /**
   * This slot *is* the ladder's current rung, so the profile's `currentSlug`
   * replaces it as the athlete advances. Only one slot per ladder may claim it —
   * otherwise advancing the knee ladder would rewrite three separate slots.
   */
  ladderAnchor?: boolean;
}

/** One day of the week. */
interface DaySpec {
  day: DayOfWeek;
  label: string;
  kind: 'lift' | 'resilience' | 'aerobic' | 'trainer';
  systemicCost: 'low' | 'moderate' | 'high';
  note: string;
  slots: readonly SlotSpec[];
}

/**
 * Hard-set equivalent of one sled bout.
 *
 * A 30–40 m push is not a set of squats and must not be counted as one. Six
 * bouts read as roughly two hard sets of stimulus, then charged at
 * `MRV_COST.concentric_only` (0.40) on the fatigue ledger because there is no
 * lowering phase and therefore very little of the muscle damage that drives MRV
 * (`program-personalized.md` §3.4). `[coach-specific opinion]` — this is a
 * judgement call from a well-established mechanism, not a measured number.
 */
export const SLED_BOUT_SET_WEIGHT = 1 / 3;

/**
 * Zone 2 is charged at **zero** against the hypertrophy budget.
 *
 * It is recovery-positive and is explicitly the last thing ever cut
 * (methodology §9.3). Billing 50 minutes of conversational walking against the
 * calf budget would misprice it and would push the app toward cutting the one
 * modality it should never cut.
 */
export const ZONE2_SET_WEIGHT = 0;

const FACE_PULL: SlotSpec = {
  slug: 'face-pull',
  role: 'prehab',
  charge: null,
  baseSets: 2,
  maxSets: 2,
  range: [12, 20],
  rir: 4,
  restSeconds: 60,
  setWeight: 0.5,
  cost: 'prehab_submaximal',
  note:
    "Cavaliere's standing prescription: upper back, rotator cuff and scapular retractors at once. " +
    'On the pressing days only — that is his actual rationale.',
};

/**
 * Four ordered app-session templates. Their placeholder day numbers are not a
 * schedule; {@link scheduledAppTemplates} maps them onto the locally configured
 * app days at runtime.
 */
export const WEEK_SKELETON: readonly DaySpec[] = [
  {
    day: 1,
    label: 'Lift A — push & knee',
    kind: 'lift',
    systemicCost: 'high',
    note:
      'The freshest day of the week, so it carries the heaviest app lifting and every strength ' +
      'indicator. Pulling and hinging volume still respects the trainer estimate so this session ' +
      'does not pre-fatigue work already covered elsewhere.',
    slots: [
      {
        slug: 'incline-dumbbell-press', role: 'indicator', charge: 'chest',
        baseSets: 3, maxSets: 6, range: [6, 12], rir: null, restSeconds: 150,
        setWeight: 1, cost: 'compound_eccentric',
        note: 'Set 1 is the indicator top set: 3–6 reps at RIR 2, then the rest at the ramp RIR.',
      },
      {
        slug: 'weighted-pull-up', role: 'indicator', charge: 'lats',
        baseSets: 1, maxSets: 1, range: [3, 6], rir: 2, restSeconds: 180,
        setWeight: 1, cost: 'compound_eccentric',
        note:
          'One top set only — about twenty seconds of work with little residual fatigue. Strength ' +
          'measurement uses the freshest app-owned day.',
        fallbacks: ['pull-up', 'neutral-grip-pull-up'],
      },
      {
        slug: 'machine-chest-press', role: 'accessory', charge: 'chest',
        baseSets: 2, maxSets: 5, range: [8, 15], rir: null, restSeconds: 120,
        setWeight: 1, cost: 'machine',
      },
      {
        slug: 'seated-dumbbell-shoulder-press', role: 'accessory', charge: 'front_delts',
        baseSets: 1, maxSets: 4, range: [6, 12], rir: null, restSeconds: 120,
        setWeight: 1, cost: 'compound_eccentric',
        note: 'Dumbbells over a barbell overhead — independent arms let the scapula move as it wants.',
      },
      {
        slug: 'hack-squat', role: 'indicator', charge: 'quads',
        baseSets: 2, maxSets: 5, range: [8, 15], rir: null, restSeconds: 150,
        setWeight: 1, cost: 'machine',
        note:
          'Chosen over a back squat or leg press because it loads quads with minimal spinal-erector ' +
          'and hip cost — both fully spent by the trainer.',
        fallbacks: ['leg-press', 'leg-extension'],
      },
      {
        slug: 'cable-lateral-raise', role: 'accessory', charge: 'side_delts',
        baseSets: 3, maxSets: 7, range: [12, 20], rir: null, restSeconds: 75,
        setWeight: 1, cost: 'isolation',
        fallbacks: ['machine-lateral-raise', 'dumbbell-lateral-raise'],
      },
      {
        slug: 'overhead-cable-triceps-extension', role: 'accessory', charge: 'triceps',
        baseSets: 2, maxSets: 5, range: [10, 15], rir: null, restSeconds: 75,
        setWeight: 1, cost: 'isolation',
        fallbacks: ['dumbbell-overhead-extension'],
      },
      {
        slug: 'standing-calf-raise', role: 'accessory', charge: 'calves',
        baseSets: 2, maxSets: 5, range: [8, 20], rir: null, restSeconds: 60,
        setWeight: 1, cost: 'isolation', ladder: 'calf_knee_ability', ladderAnchor: true,
      },
      FACE_PULL,
    ],
  },
  {
    day: 2,
    label: 'Lift B — accessories & sled',
    kind: 'lift',
    systemicCost: 'moderate',
    note:
      'Deliberately short in week 1. This lower-systemic template follows the trainer block and ' +
      'grows substantially by week 3.',
    slots: [
      {
        slug: 'seated-cable-fly', role: 'accessory', charge: 'chest',
        baseSets: 3, maxSets: 6, range: [10, 20], rir: null, restSeconds: 90,
        setWeight: 1, cost: 'isolation',
      },
      {
        slug: 'machine-lateral-raise', role: 'accessory', charge: 'side_delts',
        baseSets: 3, maxSets: 7, range: [10, 20], rir: null, restSeconds: 60,
        setWeight: 1, cost: 'machine',
        fallbacks: ['dumbbell-lateral-raise', 'cable-lateral-raise'],
      },
      {
        slug: 'cable-pushdown-rope', role: 'accessory', charge: 'triceps',
        baseSets: 2, maxSets: 5, range: [10, 20], rir: null, restSeconds: 60,
        setWeight: 1, cost: 'isolation',
      },
      {
        slug: 'incline-dumbbell-curl', role: 'accessory', charge: 'biceps',
        baseSets: 1, maxSets: 4, range: [8, 15], rir: null, restSeconds: 60,
        setWeight: 1, cost: 'isolation',
        fallbacks: ['hammer-curl', 'ez-bar-curl'],
      },
      {
        slug: 'seated-calf-raise', role: 'accessory', charge: 'calves',
        baseSets: 2, maxSets: 5, range: [12, 25], rir: null, restSeconds: 60,
        setWeight: 1, cost: 'isolation',
      },
      {
        slug: 'tibialis-raise', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [15, 25], rir: 3, restSeconds: 45,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'tibialis', ladderAnchor: true,
        note:
          'Three minutes, near-zero systemic cost. Plausibly useful for dorsiflexion and shin ' +
          'tolerance — but it is not a claim that it prevents knee injury.',
      },
      {
        slug: 'cable-crunch', role: 'accessory', charge: 'abs',
        baseSets: 3, maxSets: 6, range: [10, 20], rir: null, restSeconds: 60,
        setWeight: 1, cost: 'isolation',
      },
      {
        slug: 'side-lying-external-rotation', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [12, 20], rir: 3, restSeconds: 45,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'shoulder_external_rotation', ladderAnchor: true,
        note: 'The app owns the external-rotation work because the app owns the pressing.',
      },
      FACE_PULL,
      {
        slug: 'sled-push-forward', role: 'conditioning', charge: null,
        baseSets: 6, maxSets: 8, range: [30, 40], rir: null, restSeconds: 60,
        setWeight: SLED_BOUT_SET_WEIGHT, cost: 'concentric_only', zone: 'z3', hardMinutes: 0,
        dropOnDeload: true,
        note:
          'Concentric-only, so it buys real conditioning with very little muscle damage. Lift first, ' +
          'then this — walk back as the rest.',
        fallbacks: ['sled-drag-backward', 'backward-walk-treadmill', 'assault-bike-intervals'],
      },
    ],
  },
  {
    day: 3,
    label: 'Resilience + VO2max',
    kind: 'resilience',
    systemicCost: 'high',
    note:
      'The resilience work follows the lower-systemic app day so its soreness is separated from ' +
      'the next configured trainer block.',
    slots: [
      {
        slug: 'zone2-cycling', role: 'conditioning', charge: null,
        baseSets: 1, maxSets: 1, range: [600, 600], rir: null, restSeconds: 0,
        setWeight: ZONE2_SET_WEIGHT, cost: 'concentric_only', zone: 'z2',
        protectedSlot: true,
        note: 'Warm-up.',
        fallbacks: ['zone2-incline-walk'],
      },
      {
        slug: 'ankle-dorsiflexion-mobilization', role: 'mobility', charge: null,
        baseSets: 2, maxSets: 2, range: [10, 20], rir: null, restSeconds: 30,
        setWeight: 0.5, cost: 'prehab_submaximal',
        note: 'Range prep for the split squat. Per side.',
      },
      {
        slug: 'assisted-nordic-curl', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [5, 8], rir: 3, restSeconds: 90,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'hamstring_nordic', ladderAnchor: true,
        note:
          'The strongest evidence base in the whole KOT toolkit. Advance to eccentric-only Nordics ' +
          'when three sets of five clean eccentrics are there.',
      },
      {
        slug: 'patrick-step', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [8, 12], rir: 3, restSeconds: 60,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'knee_split_squat', ladderAnchor: true,
        note: 'Range before load.',
      },
      {
        slug: 'atg-split-squat', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [5, 10], rir: 3, restSeconds: 90,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'knee_split_squat',
        note: 'Bodyweight, front foot elevated. Load only after a clean full-range bodyweight rep.',
      },
      {
        slug: 'knees-over-toes-calf-raise', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [10, 25], rir: 2, restSeconds: 60,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'calf_knee_ability',
        note: 'Full range, knee travelling forward.',
      },
      {
        slug: 'assault-bike-intervals', role: 'conditioning', charge: null,
        baseSets: 4, maxSets: 5, range: [240, 240], rir: null, restSeconds: 180,
        setWeight: ZONE2_SET_WEIGHT, cost: 'concentric_only', zone: 'z5', hardMinutes: 16,
        dropOnDeload: true, protectedSlot: true,
        note:
          '4 × 4 min at 90–95% HRmax, 3 min easy between. This is the protected session — the one ' +
          'slot the app defends against everything except a poor readiness day. Never fasted: an ' +
          'under-fuelled 4×4 is a Zone 3 session with none of the adaptation.',
        fallbacks: ['sled-push-forward', 'backward-walk-treadmill'],
      },
      {
        slug: 'sled-drag-backward', role: 'conditioning', charge: null,
        baseSets: 2, maxSets: 2, range: [40, 40], rir: null, restSeconds: 60,
        setWeight: SLED_BOUT_SET_WEIGHT, cost: 'concentric_only', zone: 'z2',
        dropOnDeload: true,
        note: 'Easy cooldown, blood flow. Optional.',
        fallbacks: ['backward-walk-treadmill'],
      },
    ],
  },
  {
    day: 4,
    label: 'Zone 2 + mobility',
    kind: 'aerobic',
    systemicCost: 'low',
    note:
      'Recovery-positive by design, and the last thing ever cut. Zone 2 is identified by the talk ' +
      'test, not by the heart-rate number.',
    slots: [
      {
        slug: 'zone2-incline-walk', role: 'conditioning', charge: null,
        baseSets: 1, maxSets: 1, range: [2700, 4500], rir: null, restSeconds: 0,
        setWeight: ZONE2_SET_WEIGHT, cost: 'concentric_only', zone: 'z2',
        protectedSlot: true,
        note: '45–75 minutes. Conversational and slightly effortful — if you cannot talk, ease off.',
        fallbacks: ['zone2-cycling'],
      },
      {
        slug: 'couch-stretch', role: 'mobility', charge: null,
        baseSets: 2, maxSets: 2, range: [60, 60], rir: null, restSeconds: 30,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'hip_spine_mobility', ladderAnchor: true,
        note:
          'Hip-flexor *length*. The trainer does hip *strength* — this is the clearest case in the ' +
          'plan of "looks like overlap, is not". Per side.',
      },
      {
        slug: 'ninety-ninety-hip-switch', role: 'mobility', charge: null,
        baseSets: 2, maxSets: 2, range: [8, 12], rir: null, restSeconds: 30,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'hip_spine_mobility',
      },
      {
        slug: 'seated-tibialis-raise', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [15, 25], rir: 3, restSeconds: 45,
        setWeight: 0.5, cost: 'prehab_submaximal', ladder: 'tibialis',
      },
      {
        slug: 'pallof-press', role: 'prehab', charge: null,
        baseSets: 2, maxSets: 2, range: [10, 15], rir: 3, restSeconds: 60,
        setWeight: 0.5, cost: 'prehab_submaximal',
        note: 'Anti-rotation. Cheap and distinct from anything else in the week. Per side.',
      },
      {
        slug: 'quadruped-thoracic-rotation', role: 'mobility', charge: null,
        baseSets: 2, maxSets: 2, range: [8, 10], rir: null, restSeconds: 30,
        setWeight: 0.5, cost: 'prehab_submaximal',
        note: 'Loaded rowing is not thoracic mobility. Per side.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One prescribed exercise, with its sets allocated. */
export interface PrescribedItem {
  slug: string;
  name: string;
  role: SlotRole;
  sets: number;
  repMin: number;
  repMax: number;
  /** Never inferred from `pattern` — read straight off the library entry. */
  repUnit: RepUnit;
  /** Target reps in reserve, or `null` for conditioning and mobility. */
  targetRir: number | null;
  restSeconds: number;
  /** Depth, not load, is this movement's progression variable. */
  romTracked: boolean;
  unilateral: boolean;
  /** Hard-set charge per muscle, at 1.0 direct / 0.5 indirect × the set weight. */
  charges: Partial<Record<Muscle, number>>;
  note: string | null;
  /** Set when the requested slug was unavailable and a fallback was taken. */
  substitutedFor: string | null;
  zone: 'z1' | 'z2' | 'z3' | 'z5' | null;
  ladder: LadderPosition['ladder'] | null;
  /** Warm-ups and the protected interval session. Never trimmed for time. */
  timeProtected: boolean;
  /**
   * Sets the §3.6 indicator reservation paid for — i.e. sets the ordinary
   * stimulus budget could not fund. Non-zero means "the app is running this
   * lift to keep measuring it, not because the muscle had room".
   */
  reservedSets: number;
}

/** One day of the generated week. */
export interface PlannedDay {
  day: DayOfWeek;
  label: string;
  kind: 'lift' | 'resilience' | 'aerobic' | 'trainer';
  owner: 'app' | 'trainer';
  systemicCost: 'low' | 'moderate' | 'high';
  note: string;
  items: PrescribedItem[];
  /** Estimated wall-clock seconds, warm-up and full prescribed rest included. */
  estimatedSeconds: number;
  /**
   * What was cut to fit the time available.
   *
   * Silent by default — the plan simply arrives the right length — but never
   * concealed: the screen shows a "trimmed for time" line the athlete can
   * expand if they care. They are not asked to decide.
   */
  trimmed: TrimmedItem[];
  /**
   * Slugs performed alternately, one group per pair.
   *
   * Pairing non-competing accessories reclaims most of the dead time at no cost
   * to quality — each movement rests while the other works — which is why it is
   * preferred over any form of rest compression.
   */
  supersets: string[][];
}

/** A whole generated week. */
export interface WeekPlan {
  /** 1-based week within the mesocycle. */
  week: number;
  isDeload: boolean;
  targetRir: number;
  days: PlannedDay[];
  budgets: MuscleBudget[];
  /**
   * Hard sets the app is **actually prescribing**, per muscle, indirect work
   * included.
   *
   * Distinct from `budgets[].sets`, which is how much room there *was*. The two
   * differ whenever a muscle had budget but no slot spends it — `neck` has a
   * budget every week and the app never programs it — and showing the budget as
   * though it were a prescription would put sets on the screen that appear
   * nowhere in the week.
   */
  prescribed: Partial<Record<Muscle, number>>;
  /** Muscles the app prescribed nothing for because the trainer covers them. */
  coveredByTrainer: Muscle[];
  /** Tradeoff copy, balance checks, coverage notes. Never a silent downgrade. */
  findings: Finding[];
  /** Weekly Z4/Z5 minutes, so the §11.6 haircut can be re-evaluated each week. */
  hardConditioningMinutes: number;
  config: MesoConfig;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Resolve a slot to a library entry the athlete can actually perform.
 *
 * Walks the slot's own fallbacks in order, taking the first whose equipment is
 * satisfied. Returns `null` when nothing resolves — the slot is then dropped
 * and flagged rather than silently substituted for something that trains a
 * different muscle.
 */
function resolveSlot(
  slot: SlotSpec,
  equipment: ReadonlySet<string>,
  ladders: ReadonlyMap<LadderPosition['ladder'], LadderPosition> = new Map(),
  canPerform?: (slug: string) => boolean,
): { entry: LibraryExercise; substitutedFor: string | null } | null {
  // A ladder anchor tracks the athlete's current rung. Advancing the knee
  // ladder from `patrick-step` to `poliquin-step-up` is a profile edit, not a
  // code change — and ROM, not load, is what earns the advance (§7.1).
  const anchor =
    slot.ladderAnchor === true && slot.ladder !== undefined
      ? ladders.get(slot.ladder)?.currentSlug
      : undefined;
  const candidates = [
    ...(anchor !== undefined && anchor !== slot.slug ? [anchor] : []),
    slot.slug,
    ...(slot.fallbacks ?? []),
  ];
  for (const slug of candidates) {
    const entry = exerciseBySlug(slug);
    if (!entry) continue;
    const available =
      canPerform !== undefined
        ? canPerform(slug)
        : entry.equipment.length === 0 || entry.equipment.some((e) => equipment.has(e));
    if (available) {
      return { entry, substitutedFor: slug === slot.slug ? null : slot.slug };
    }
  }
  return null;
}

/**
 * Hard-set charge per muscle for one prescribed slot.
 *
 * Methodology §2.3: direct volume counts 1.0, indirect counts 0.5, and KOT /
 * prehab work is counted at half weight again (§7.2) because it is deliberately
 * sub-maximal.
 */
function chargesFor(
  entry: LibraryExercise,
  sets: number,
  setWeight: number,
): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  if (setWeight === 0 || sets === 0) return out;
  for (const muscle of entry.primary_muscles) {
    out[muscle] = (out[muscle] ?? 0) + sets * setWeight;
  }
  for (const muscle of entry.secondary_muscles) {
    out[muscle] = (out[muscle] ?? 0) + sets * setWeight * INDIRECT_SET_WEIGHT;
  }
  return out;
}

/** Everything that comes off the top of both ledgers before allocation. */
function offTheTop(
  schedule: readonly DaySpec[],
  equipment: ReadonlySet<string>,
  isDeload: boolean,
  ladders: ReadonlyMap<LadderPosition['ladder'], LadderPosition>,
  canPerform?: (slug: string) => boolean,
): {
  prehab: Partial<Record<Muscle, number>>;
  conditioning: Partial<Record<Muscle, { stimulus: number; fatigue: number }>>;
  hardMinutes: number;
} {
  const prehab: Partial<Record<Muscle, number>> = {};
  const conditioning: Partial<Record<Muscle, { stimulus: number; fatigue: number }>> = {};
  let hardMinutes = 0;

  for (const day of schedule) {
    for (const slot of day.slots) {
      if (slot.role !== 'prehab' && slot.role !== 'mobility' && slot.role !== 'conditioning') {
        continue;
      }
      if (isDeload && slot.dropOnDeload === true) continue;
      const resolved = resolveSlot(slot, equipment, ladders, canPerform);
      if (!resolved) continue;

      const charges = chargesFor(resolved.entry, slot.baseSets, slot.setWeight);
      if (slot.role === 'conditioning') {
        hardMinutes += slot.hardMinutes ?? 0;
        for (const [muscle, value] of Object.entries(charges) as [Muscle, number][]) {
          const current = conditioning[muscle] ?? { stimulus: 0, fatigue: 0 };
          conditioning[muscle] = {
            stimulus: current.stimulus + value,
            fatigue: current.fatigue + value * MRV_COST[slot.cost],
          };
        }
      } else {
        for (const [muscle, value] of Object.entries(charges) as [Muscle, number][]) {
          prehab[muscle] = (prehab[muscle] ?? 0) + value;
        }
      }
    }
  }

  return { prehab, conditioning, hardMinutes };
}

// ---------------------------------------------------------------------------
// Session length (see `channel/097`)
// ---------------------------------------------------------------------------

/**
 * How long a session may run, and what the clock is spent on.
 *
 * This population fallback targets a 45–60 minute session. A locally stored
 * session-length preference overrides it, and the generator truncates the
 * exercise list when needed.
 *
 * **What it will never do is compress rest.** Rest below roughly two minutes on
 * compound work measurably costs reps, and reps are the strength stimulus.
 * Shortening rest to fit the clock could quietly convert
 * a strength session into a metabolic one — and they would have no way of
 * knowing why their numbers stalled. The time budget is therefore
 * `warm-up + Σ(work + prescribed rest) + conditioning`, and when it overflows
 * the *exercise list* gives way, never the rest.
 */
export const SESSION_TIME = {
  /** What the generator aims at. */
  targetMinutes: 55,
  /** Below this a session is short enough that trimming is pointless. */
  minMinutes: 45,
  /** General warm-up and getting to the first station. */
  warmupSeconds: 8 * 60,
  /** Moving between stations, loading a bar, finding a bench. */
  transitionSeconds: 60,
  /** Rest below which a compound set stops being a strength set. Never crossed. */
  protectedRestSeconds: 120,
} as const;

/**
 * How fast the current user actually trains, learned from local sessions.
 *
 * Prescribed rest and real rest are different numbers, and the difference
 * compounds: a plan built on a theoretical 90 seconds when someone really takes
 * 140 overruns by ten minutes and then gets trimmed for a reason that was never
 * true. So elapsed time and real rest are recorded and fed back here, and the
 * estimate converges on the athlete's own pace.
 */
export interface SessionPace {
  /** Seconds of work per rep under load. */
  secondsPerRep: number;
  /** Real rest ÷ prescribed rest. Above 1 means they take longer than the card says. */
  restFactor: number;
  /** How many sessions informed this. Zero means it is still the population prior. */
  samples: number;
}

/** The prior, used until a few real sessions exist. `[uncertain]`. */
export const DEFAULT_PACE: SessionPace = {
  secondsPerRep: 3.5,
  restFactor: 1,
  samples: 0,
};

/** One observed session, as the pace estimator reads it. */
export interface PaceSample {
  /** Wall-clock seconds from first set to last. */
  elapsedSeconds: number;
  /** Working sets performed. */
  sets: number;
  /** Reps performed across those sets, where the movement is measured in reps. */
  reps: number;
  /** Seconds of non-rep work — carries, intervals, holds. */
  timedSeconds: number;
  /** Rest the athlete explicitly timed between sets, summed. */
  actualRestSeconds: number;
}

/** How many past sessions the pace estimate looks at. */
export const PACE_WINDOW = 8;

/**
 * Estimate the athlete's real pace from sessions they actually did.
 *
 * Deliberately crude and heavily damped: it is used to decide whether one
 * accessory gets cut, so being roughly right beats being precisely wrong. Both
 * outputs are clamped to a sane band, because one session where the phone sat
 * in a locker for an hour must not convince the app that every set takes four
 * minutes.
 *
 * @param samples recent sessions, newest first
 * @returns the pace estimate, or {@link DEFAULT_PACE} when there is nothing to go on
 */
export function estimatePace(samples: readonly PaceSample[]): SessionPace {
  const usable = samples
    .slice(0, PACE_WINDOW)
    .filter((s) => s.elapsedSeconds > 0 && s.sets > 1);
  if (usable.length === 0) return DEFAULT_PACE;

  let restRatioSum = 0;
  let secondsPerRepSum = 0;
  let repWeight = 0;

  for (const sample of usable) {
    // Measured rest is not the same thing as prescribed rest. Compare it with
    // the population prior (90 seconds between working sets) only to obtain the
    // conservative multiplier used by future cards.
    const expectedRestSeconds = Math.max(0, sample.sets - 1) * 90;
    if (sample.actualRestSeconds > 0 && expectedRestSeconds > 0) {
      restRatioSum += sample.actualRestSeconds / expectedRestSeconds;
    } else {
      restRatioSum += 1;
    }
    if (sample.reps > 0) {
      // Attribute the measured non-rest remainder to work and transitions,
      // bounded heavily so a forgotten timer cannot distort the plan.
      const workSeconds = Math.max(
        0,
        sample.elapsedSeconds - sample.actualRestSeconds - sample.timedSeconds,
      );
      const perRep = Math.max(1.5, Math.min(8, workSeconds / sample.reps));
      secondsPerRepSum += perRep * sample.reps;
      repWeight += sample.reps;
    }
  }

  return {
    secondsPerRep:
      repWeight > 0
        ? clamp(secondsPerRepSum / repWeight, 2, 6)
        : DEFAULT_PACE.secondsPerRep,
    restFactor: clamp(restRatioSum / usable.length, 0.6, 2),
    samples: usable.length,
  };
}

/** The minimum an item has to look like to be priced. */
export interface TimedPrescription {
  sets: number;
  repMin: number;
  repMax: number;
  repUnit: RepUnit;
  unilateral: boolean;
  restSeconds: number;
}

/** Seconds one prescribed item takes, rest included. */
export function itemSeconds(item: TimedPrescription, pace: SessionPace = DEFAULT_PACE): number {
  const midpoint = (item.repMin + item.repMax) / 2;
  const sides = item.unilateral ? 2 : 1;

  let workPerSet: number;
  switch (item.repUnit) {
    case 'reps':
      workPerSet = midpoint * pace.secondsPerRep * sides;
      break;
    case 'seconds':
      workPerSet = midpoint * sides;
      break;
    case 'meters':
      // A loaded sled trip and the walk back. ~0.8 m/s pushing, ~1.3 walking.
      workPerSet = midpoint / 0.8 + midpoint / 1.3;
      break;
    case 'steps':
      workPerSet = midpoint * 1.2 * sides;
      break;
  }

  const rest = item.restSeconds * pace.restFactor * Math.max(0, item.sets - 1);
  return workPerSet * item.sets + rest + SESSION_TIME.transitionSeconds;
}

/** An item the generator removed to fit the session in the time available. */
export interface TrimmedItem {
  slug: string;
  name: string;
  /** Plain language, so an expanded "trimmed for time" line reads as a sentence. */
  reason: string;
}

/** Conservative sled distance used only when the local trainer focus mentions sled work. */
export const ASSUMED_SLED_METRES = 200;

/**
 * The trainer's week from the seed prior alone, before anything is confirmed.
 *
 * **This is the single most important default in the planner.** The rule from
 * `program-personalized.md` §2.2 is unambiguous: *if the athlete never
 * confirms, the prior is counted at full value. Never treat missing data as
 * zero volume. That inversion is the failure mode this whole system exists to
 * prevent.*
 *
 * Without it, the first week of a fresh install sees no logged trainer sessions
 * and cheerfully programs eight sets of rowing on top of three days of the
 * trainer's mid-back work. So a planner with no observations falls back here
 * rather than to an empty map, and the confidence stays at the seed value so
 * the upper bound stays wide.
 *
 * @param profile the athlete — `trainerDays.length` sets the session count
 * @param options.confidence current confidence. Defaults to the seed value.
 * @returns per-muscle trainer load, both ledgers, with upper bounds
 */
export function expectedTrainerWeek(
  profile: ProgramProfile,
  options: { confidence?: number } = {},
): Partial<Record<Muscle, TrainerWeekLoad>> {
  const sessions = profile.trainerDays.length;
  if (sessions === 0) return {};
  const focusEffort = regionEffortFromFocus(profile.trainerFocus ?? '');
  const prior = profile.trainerFocus ? priorFromFocus(profile.trainerFocus) : DEFAULT_TRAINER_PRIOR;

  const reports: TrainerSessionReport[] = Array.from({ length: sessions }, () => ({
    durationMin: 60,
    regionEffort: {},
    hardSetsTotal: null,
    perceivedRir: null,
    sledMeters: focusEffort.quads_sled > 0 && /sled/i.test(profile.trainerFocus ?? '')
      ? ASSUMED_SLED_METRES
      : null,
    exerciseNames: [],
    confirmed: false,
    estimate: { ...prior },
  }));

  const confidence = options.confidence ?? SEED_CONFIDENCE;
  const out: Partial<Record<Muscle, TrainerWeekLoad>> = {};
  for (const muscle of ALL_MUSCLES) {
    const load = trainerLoadFor(reports, muscle, confidence);
    if (load.stimulusUpperBound <= 0) continue;
    out[muscle] = {
      stimulusMean: load.stimulusMean,
      stimulusUpperBound: load.stimulusUpperBound,
      fatigueUpperBound: load.fatigueUpperBound,
    };
  }
  return out;
}

/** Options for {@link generateWeek}. */
export interface GenerateOptions {
  /** 1-based week within the mesocycle. Default 1. */
  week?: number;
  /** Per-muscle trainer load for the week. Absent means "no trainer sessions". */
  trainer?: Partial<Record<Muscle, TrainerWeekLoad>>;
  cfg?: MesoConfig;
  /**
   * How long a lifting session may run. Defaults to
   * {@link SESSION_TIME.targetMinutes}. Sessions are truncated to fit, silently
   * — there is no negotiation screen and no "what would you like me to cut?".
   */
  sessionMinutes?: number;
  /** The athlete's observed pace. Defaults to the population prior. */
  pace?: SessionPace;
  /**
   * Whether the athlete can perform a movement at the gym they are actually at.
   *
   * This is the seam onto `@/lib/gyms`: pass a predicate backed by the active
   * {@link import('../gyms/profiles').GymProfile} and generation filters by the
   * real place rather than assuming a full commercial gym. When omitted it
   * falls back to matching `profile.equipment` against the library's flat tag
   * list, which is coarser but never wrong in the "invents a machine you do not
   * have" direction.
   */
  canPerform?: (slug: string) => boolean;
}

/**
 * Generate one week of training.
 *
 * The order is the order of the §3.2 pipeline, and it matters: prehab and
 * conditioning are costed **first** because `joint_integrity` is rank 0 and
 * `vo2max` is rank 2, both above the hypertrophy volume the budget allocates.
 * Only then does the trainer's upper bound come off, and only then is anything
 * left over spent on accessories.
 *
 * A deload week is a **trainer-only week** (§8.2): app lifting drops to MV, the
 * VO2max session and the sled block are dropped entirely, and Zone 2,
 * prehab and mobility stay at full dose. Mobility is not what needs deloading.
 *
 * @param profile the athlete
 * @param options the week index, the trainer's estimated load, the block shape
 * @returns the week, its budgets and the findings that explain them
 */
export function generateWeek(
  profile: ProgramProfile,
  options: GenerateOptions = {},
): WeekPlan {
  const cfg = options.cfg ?? DEFAULT_MESO;
  const week = Math.max(1, options.week ?? 1);
  const pace = options.pace ?? DEFAULT_PACE;
  const budgetSeconds = (options.sessionMinutes ?? SESSION_TIME.targetMinutes) * 60;
  const isDeload = isDeloadWeek(week, cfg);
  const rampRir = targetRir(week, cfg);
  const equipment = new Set(profile.equipment);

  const ladderByName = new Map(profile.ladders.map((l) => [l.ladder, l]));
  const appSchedule = scheduledAppTemplates(profile.appDays);
  const { prehab, conditioning, hardMinutes } = offTheTop(
    appSchedule,
    equipment,
    isDeload,
    ladderByName,
    options.canPerform,
  );

  const indicatorMuscles = new Set<Muscle>();
  for (const slug of profile.indicatorLifts) {
    const entry = exerciseBySlug(slug);
    for (const muscle of entry?.primary_muscles ?? []) indicatorMuscles.add(muscle);
  }

  const budgets = budgetWeek(
    profile,
    {
      trainer: options.trainer ?? {},
      prehab,
      conditioning,
      hardConditioningMinutes: hardMinutes,
      week,
      indicatorMuscles,
    },
    cfg,
  );
  const byMuscle = new Map(budgets.map((b) => [b.muscle, b]));

  // ---- resolve every slot the athlete can actually perform ---------------
  const pending: PendingSlot[] = [];
  const dropped: string[] = [];

  for (const day of appSchedule) {
    for (const slot of day.slots) {
      if (isDeload && slot.dropOnDeload === true) continue;
      const resolved = resolveSlot(slot, equipment, ladderByName, options.canPerform);
      if (!resolved) {
        dropped.push(slot.slug);
        continue;
      }
      pending.push({ day, slot, ...resolved, sets: 0, reserved: 0 });
    }
  }

  // ---- allocate ----------------------------------------------------------
  // Three passes over the *whole week*, not one day at a time. Allocating day
  // by day would spend the first session's chest budget entirely and leave a
  // later cable fly at zero — the budget belongs to the muscle's week.
  const remaining = new Map<Muscle, number>();
  for (const budget of budgets) remaining.set(budget.muscle, budget.sets);

  /** How many of `want` sets the slot's own muscle can still afford. */
  const affordable = (p: PendingSlot, want: number): number => {
    if (p.slot.charge === null) return want;
    return Math.max(0, Math.min(want, Math.floor(remaining.get(p.slot.charge) ?? 0)));
  };

  /**
   * Spend a slot's sets against **every** muscle it loads, not just its own.
   *
   * Methodology §2.3 counts a secondary muscle at 0.5, and being inconsistent
   * about that "silently corrupts every volume calculation". Concretely: three
   * chest presses are also 1.5 sets of triceps and 1.5 of front delts. Debiting
   * only the primary would let the app prescribe a full triceps allocation on
   * top of a full pressing allocation and quietly land well past the ceiling by
   * week 3.
   */
  const spend = (p: PendingSlot, sets: number): void => {
    if (sets <= 0) return;
    for (const [muscle, value] of Object.entries(
      chargesFor(p.entry, sets, p.slot.setWeight),
    ) as [Muscle, number][]) {
      remaining.set(muscle, (remaining.get(muscle) ?? 0) - value);
    }
  };

  // Pass 0 — indicator floor (§3.6). The floor comes out of the ordinary
  // budget first; only the shortfall is the reservation, and only the shortfall
  // is charged to the fatigue ledger alone. That is why `hack-squat` still gets
  // its two sets in a week when the quad stimulus budget is zero.
  for (const p of pending) {
    if (p.slot.role !== 'indicator' || p.slot.charge === null) continue;
    const budget = byMuscle.get(p.slot.charge);
    if (budget?.indicatorDropped === true) continue;
    const floor = Math.min(p.slot.maxSets, Math.max(1, budget?.indicatorSets ?? 1));
    p.reserved = floor - affordable(p, floor);
    p.sets = floor;
    spend(p, floor);
  }

  // Pass 1 — each slot's base sets, in the order the session is performed.
  // Compounds and the priority muscle get the freshest slots and the first call
  // on the budget (§4.3 rules 1–2); isolation is last and is what loses sets
  // when the budget runs out.
  for (const p of pending) {
    if (p.slot.charge === null) {
      p.sets = p.slot.baseSets;
      continue;
    }
    const granted = affordable(p, Math.max(0, p.slot.baseSets - p.sets));
    p.sets += granted;
    spend(p, granted);
  }

  // Pass 2 — spread whatever is left, one set at a time, so a surplus lands
  // across the week rather than piling onto the first exercise.
  //
  // **Bounded by the clock as well as by the budget.** The weekly ramp will
  // happily ask for more volume than two 55-minute sessions can hold, and
  // allocating it anyway just means the truncation step deletes whole exercises
  // later. Stopping here instead keeps the session complete and only shortens
  // it — a session with every movement at four sets beats one with two
  // movements at six and the rest cut.
  const ordered = [...pending].sort((a, b) => rolePriority(a.slot.role) - rolePriority(b.slot.role));
  const dayClock = new Map<DaySpec, number>();
  for (const p of pending) {
    dayClock.set(p.day, (dayClock.get(p.day) ?? 0) + pendingSeconds(p, pace));
  }
  const clockRoom = (p: PendingSlot): boolean => {
    const budget = dayBudgetSeconds(p.day.kind, budgetSeconds) - SESSION_TIME.warmupSeconds;
    return (dayClock.get(p.day) ?? 0) < budget;
  };

  for (let guard = 0; guard < 200; guard += 1) {
    let moved = false;
    for (const p of ordered) {
      if (p.slot.charge === null || p.sets >= p.slot.maxSets) continue;
      if (!clockRoom(p)) continue;
      if (affordable(p, 1) < 1) continue;
      const before = pendingSeconds(p, pace);
      p.sets += 1;
      spend(p, 1);
      dayClock.set(p.day, (dayClock.get(p.day) ?? 0) + pendingSeconds(p, pace) - before);
      moved = true;
    }
    if (!moved) break;
  }

  // ---- materialise -------------------------------------------------------
  const days: PlannedDay[] = [];
  for (const day of appSchedule) {
    const items: PrescribedItem[] = [];

    for (const p of pending) {
      if (p.day !== day) continue;
      // A charged slot with no sets is not a slot. Dropping it is the correct
      // output when the trainer has already covered that muscle.
      if (p.slot.charge !== null && p.sets <= 0) continue;

      const range = p.slot.range ?? p.entry.default_rep_range;
      const rir =
        p.slot.role === 'conditioning' || p.slot.role === 'mobility'
          ? null
          : (p.slot.rir ?? (isDeload ? cfg.deloadRir : rampRir));

      items.push({
        slug: p.entry.slug,
        name: p.entry.name,
        role: p.slot.role,
        sets: p.sets,
        repMin: range[0],
        repMax: range[1],
        repUnit: p.entry.rep_unit,
        targetRir: rir,
        restSeconds: p.slot.restSeconds,
        romTracked: p.entry.rom_tracked,
        unilateral: p.entry.unilateral,
        charges: chargesFor(p.entry, p.sets, p.slot.setWeight),
        note: p.slot.note ?? null,
        substitutedFor: p.substitutedFor,
        zone: p.slot.zone ?? null,
        ladder: p.slot.ladder ?? null,
        timeProtected: p.slot.protectedSlot === true,
        reservedSets: p.reserved,
      });
    }

    // Aerobic days are a duration, not a list of stations; trimming them to a
    // 55-minute clock would cut the Zone 2 dose, which is the last thing that
    // should ever go.
    const fitted = fitToTime(items, dayBudgetSeconds(day.kind, budgetSeconds), pace);

    days.push({
      day: day.day,
      label: day.label,
      kind: day.kind,
      owner: 'app',
      systemicCost: isDeload && day.kind === 'lift' ? 'low' : day.systemicCost,
      note: isDeload && day.kind !== 'aerobic' ? deloadNote(day.kind) : day.note,
      items: fitted.items,
      estimatedSeconds: fitted.estimatedSeconds,
      trimmed: fitted.trimmed,
      supersets: fitted.supersets,
    });
  }

  for (const trainerDay of profile.trainerDays) {
    days.push({
      day: trainerDay,
      label: 'Trainer session',
      kind: 'trainer',
      owner: 'trainer',
      systemicCost: 'high',
      note:
        "I can't program this day and I wasn't in the room. Tell me roughly what you did afterwards " +
        'and I will work around it for the rest of the week.',
      items: [],
      estimatedSeconds: 0,
      trimmed: [],
      supersets: [],
    });
  }

  days.sort((a, b) => weekOrder(a.day) - weekOrder(b.day));

  const covered = budgets
    .filter((b) => b.sets === 0 && b.trainerStimulus > 0)
    .map((b) => b.muscle);

  return {
    prescribed: prescribedByMuscle(days),
    week,
    isDeload,
    targetRir: isDeload ? cfg.deloadRir : rampRir,
    days,
    budgets,
    coveredByTrainer: covered,
    findings: planFindings(profile, budgets, days, { isDeload, dropped }),
    hardConditioningMinutes: hardMinutes,
    config: cfg,
  };
}

// ---------------------------------------------------------------------------
// Fitting the session into the time available
// ---------------------------------------------------------------------------

/**
 * How long each kind of day may run.
 *
 * A lifting day gets the athlete's stated session length. The resilience-day
 * resilience-plus-intervals day is structurally longer — the spec puts 8–10
 * minutes of rest between the two blocks precisely so the intervals are not run
 * on split-squat legs — so it gets that back. Aerobic days are a duration
 * rather than a list of stations and are never trimmed: Zone 2 is the last
 * thing that should ever be cut.
 *
 * @param kind the day
 * @param sessionSeconds the athlete's session length
 * @returns the clock this day is fitted to
 */
export function dayBudgetSeconds(kind: DaySpec['kind'], sessionSeconds: number): number {
  switch (kind) {
    case 'aerobic':
      return Number.POSITIVE_INFINITY;
    case 'resilience':
      return sessionSeconds + 10 * 60;
    default:
      return sessionSeconds;
  }
}

/** Roles the clock is never allowed to touch, in the order they are protected. */
const PROTECTED_ROLES: ReadonlySet<SlotRole> = new Set<SlotRole>([
  'indicator',
  'main',
  'prehab',
  'mobility',
]);

/**
 * Which muscles two movements would fight over.
 *
 * Two accessories can be alternated when they share no muscle at all — each
 * genuinely rests while the other works. Antagonists (triceps/biceps,
 * quads/hamstrings, push/pull) are the classic case and fall out of this test
 * for free, without a hand-maintained pairing table that would go stale the
 * moment the library grows.
 */
function competes(a: PrescribedItem, b: PrescribedItem): boolean {
  for (const muscle of Object.keys(a.charges)) {
    if (muscle in b.charges) return true;
  }
  return false;
}

/**
 * Cut a day down to the time available, without ever shortening rest.
 *
 * The order is fixed and it encodes what is allowed to be sacrificed:
 *
 * 1. **Drop the lowest stimulus-to-fatigue accessories.** Cheapest thing in the
 *    session per minute spent.
 * 2. **Pair what remains into supersets** where two accessories share no
 *    muscle. This reclaims dead time at no cost to quality.
 * 3. **Drop the optional conditioning finisher** — but never the protected
 *    interval session, which is the whole point of the VO2max goal.
 * 4. **Protect the main compound work, the indicators, and their full rest.**
 *    These are last and they are never trimmed.
 *
 * Prehab is never dropped before accessories. `joint_integrity` outranks
 * hypertrophy (`athlete-profile.md` §3.2), it is eight to twelve minutes, and
 * it is the goal most easily lost to attrition.
 *
 * @param items the day's items, in performance order
 * @param budgetSeconds how long the session may run
 * @param pace the athlete's observed pace
 * @returns the kept items, what was trimmed, the superset groups and the estimate
 */
export function fitToTime(
  items: readonly PrescribedItem[],
  budgetSeconds: number,
  pace: SessionPace = DEFAULT_PACE,
): {
  items: PrescribedItem[];
  trimmed: TrimmedItem[];
  supersets: string[][];
  estimatedSeconds: number;
} {
  const kept = [...items];
  const trimmed: TrimmedItem[] = [];
  let supersets: string[][] = [];

  const total = (list: readonly PrescribedItem[], pairs: string[][]): number => {
    const base = list.reduce((sum, item) => sum + itemSeconds(item, pace), 0);
    // A pair costs the longer of the two rests, not the sum of both.
    let saved = 0;
    for (const pair of pairs) {
      const members = list.filter((i) => pair.includes(i.slug));
      if (members.length < 2) continue;
      const shortest = Math.min(...members.map((i) => i.restSeconds));
      const sets = Math.min(...members.map((i) => i.sets));
      saved += shortest * pace.restFactor * Math.max(0, sets - 1);
      saved += SESSION_TIME.transitionSeconds;
    }
    return SESSION_TIME.warmupSeconds + base - saved;
  };

  // (1) and (2), interleaved. Drop the lowest stimulus-to-fatigue accessory,
  // then try supersetting what remains before dropping another. Supersetting is
  // free — each movement rests while the other works — so every drop it avoids
  // is volume kept at no cost. Doing all the dropping first and only then
  // pairing would throw away accessories that pairing would have saved.
  const droppable = () =>
    kept
      .filter(
        (i) =>
          !PROTECTED_ROLES.has(i.role) && i.role !== 'conditioning' && !i.timeProtected,
      )
      .sort(
        (a, b) =>
          (exerciseBySlug(a.slug)?.sfr_rating ?? 3) - (exerciseBySlug(b.slug)?.sfr_rating ?? 3),
      );

  while (total(kept, supersets) > budgetSeconds) {
    const paired = pairUp(kept);
    if (paired.length > supersets.length) {
      supersets = paired;
      if (total(kept, supersets) <= budgetSeconds) break;
    }
    const worst = droppable()[0];
    if (!worst) break;
    kept.splice(kept.indexOf(worst), 1);
    trimmed.push({
      slug: worst.slug,
      name: worst.name,
      reason: 'Lowest return per minute in the session, so it went first.',
    });
  }

  // (3) The optional conditioning finisher. Never the protected interval work —
  // that slot is defended against everything except a poor readiness day.
  while (total(kept, supersets) > budgetSeconds) {
    const optional = kept.find(
      (i) => i.role === 'conditioning' && i.zone !== 'z5' && !i.timeProtected,
    );
    if (!optional) break;
    kept.splice(kept.indexOf(optional), 1);
    trimmed.push({
      slug: optional.slug,
      name: optional.name,
      reason: 'Optional finisher — the hard conditioning stays, this went.',
    });
  }

  // A pair whose partner was dropped is not a pair.
  supersets = supersets
    .map((pair) => pair.filter((slug) => kept.some((i) => i.slug === slug)))
    .filter((pair) => pair.length >= 2);

  // (4) Whatever is left is main work, indicators and prehab. It stays, at full
  // rest, even if that overruns. Cutting rest here would silently turn a
  // strength session into a metabolic one.
  return { items: kept, trimmed, supersets, estimatedSeconds: total(kept, supersets) };
}

/** Greedily pair non-competing accessories that sit near each other. */
function pairUp(items: readonly PrescribedItem[]): string[][] {
  const candidates = items.filter(
    (i) => i.role === 'accessory' && i.repUnit === 'reps',
  );
  const used = new Set<string>();
  const pairs: string[][] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    if (used.has(a.slug)) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (used.has(b.slug) || competes(a, b)) continue;
      pairs.push([a.slug, b.slug]);
      used.add(a.slug);
      used.add(b.slug);
      break;
    }
  }
  return pairs;
}

/** A slot that has resolved to a real movement but not yet been given its sets. */
interface PendingSlot {
  day: DaySpec;
  slot: SlotSpec;
  entry: LibraryExercise;
  substitutedFor: string | null;
  sets: number;
  reserved: number;
}

/** Price a slot mid-allocation, before the prescribed item exists. */
function pendingSeconds(p: PendingSlot, pace: SessionPace): number {
  if (p.sets <= 0) return 0;
  const range = p.slot.range ?? p.entry.default_rep_range;
  return itemSeconds(
    {
      sets: p.sets,
      repMin: range[0],
      repMax: range[1],
      repUnit: p.entry.rep_unit,
      unilateral: p.entry.unilateral,
      restSeconds: p.slot.restSeconds,
    },
    pace,
  );
}

/** Compounds and indicators get the freshest slots and the first call (§4.3). */
function rolePriority(role: SlotRole): number {
  switch (role) {
    case 'indicator':
      return 0;
    case 'main':
      return 1;
    case 'accessory':
      return 2;
    default:
      return 3;
  }
}

function deloadNote(kind: DaySpec['kind']): string {
  if (kind === 'resilience') {
    return (
      'Deload week: the interval session is dropped entirely — it is the first thing to go — and the ' +
      'resilience work stays at full dose. Mobility is not what needs deloading.'
    );
  }
  return (
    'Deload week: sets at maintenance, load 60–70%, RIR 4–5. Your trainer cannot deload with you, so ' +
    'this week is essentially their trainer sessions and very little else. That is a coherent deload.'
  );
}

/**
 * What the app is actually asking for, per muscle.
 *
 * Prehab and conditioning are included, because they are work the athlete does
 * and they charge the same ledgers. What is excluded is anything that only
 * existed as headroom.
 *
 * @param days the materialised week
 * @returns hard sets per muscle, at 1.0 direct and 0.5 indirect
 */
export function prescribedByMuscle(
  days: readonly PlannedDay[],
): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const day of days) {
    for (const item of day.items) {
      for (const [muscle, value] of Object.entries(item.charges) as [Muscle, number][]) {
        out[muscle] = Math.round(((out[muscle] ?? 0) + value) * 100) / 100;
      }
    }
  }
  return out;
}

/** Map ordered session roles onto the app days derived from the local profile. */
function scheduledAppTemplates(appDays: readonly DayOfWeek[]): DaySpec[] {
  return WEEK_SKELETON.slice(0, appDays.length).map((template, index) => ({
    ...template,
    day: appDays[index],
  }));
}

/** Monday first, Sunday last for display. */
function weekOrder(day: DayOfWeek): number {
  return day === 0 ? 7 : day;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function finding(level: Finding['level'], code: string, message: string): Finding {
  return { ok: false, level, code, message };
}

/** Pull-to-push balance rules, adjusted when trainer volume dominates. */
/**
 * Where the pull:push check actually fires.
 *
 * The rule's floor is 1.0, but firing at 0.99 would be noise, and for some users
 * the ratio is dominated by a trainer estimate with wide error bars.
 * So the warning waits for a clear deficit, and the over-satisfied branch —
 * whose fix is **add pressing, not rows** — waits for a clear surplus.
 */
export const PULL_PUSH_WARN = 0.85;
/** Above this the ratio is over-satisfied and the advice inverts (§6.1). */
export const PULL_PUSH_OVER_SATISFIED = 1.5;

export const BALANCE_RULES = [
  { name: 'pull_to_push', min: 1.0 },
  { name: 'rear_to_front_delt', min: 1.0 },
  { name: 'hinge_to_squat', min: 0.75 },
] as const;

/**
 * Everything the planner has to say out loud.
 *
 * Three families, in priority order:
 *
 * 1. **Tradeoffs** — the four `athlete-profile.md` §3.3 statements, verbatim.
 *    A goal that was downgraded must say so, in the athlete's own framing.
 * 2. **Coverage** — which muscles the app deliberately left alone, and the §3.7
 *    escalation when the trainer's estimated load is past the ceiling. Never
 *    phrased as the trainer being wrong: the model is a population prior with
 *    wide error bars, and the trainer is a professional watching the athlete
 *    move.
 * 3. **Balance** — the §6.1 check, run against `trainer + app`, never against
 *    the app's prescription alone. Checking only what the app wrote would report
 *    a catastrophic pull deficit that does not exist, and the auto-suggested fix
 *    here is **add pressing, not rows**.
 */
export function planFindings(
  profile: ProgramProfile,
  budgets: readonly MuscleBudget[],
  days: readonly PlannedDay[],
  context: { isDeload: boolean; dropped: readonly string[] },
): Finding[] {
  const out: Finding[] = [];

  // ---- 1. tradeoffs ------------------------------------------------------
  const strength = profile.goals.find((g) => g.id === 'strength');
  const hypertrophy = profile.goals.find((g) => g.id === 'hypertrophy');
  const fatLoss = profile.goals.find((g) => g.id === 'fat_loss');
  const vo2max = profile.goals.find((g) => g.id === 'vo2max');

  if (fatLoss?.intent === 'improve') {
    out.push(finding('info', 'goal.rate_capped', TRADEOFF_COPY.rate_capped.body));
  }
  if (strength && strength.intent !== 'improve') {
    out.push(finding('info', 'goal.strength_held', TRADEOFF_COPY.strength_held.body));
  }
  if (vo2max?.intent === 'improve') {
    out.push(finding('info', 'goal.vo2max_realistic', TRADEOFF_COPY.vo2max_realistic.body));
  }
  if (hypertrophy?.intent === 'monitor' && fatLoss?.intent === 'improve') {
    out.push(
      finding(
        'info',
        'goal.hypertrophy_not_this_block',
        'Hypertrophy is on the list but I am not programming for it this block, and I want to be ' +
          'straight about why: building new muscle takes energy a deficit deliberately withholds. ' +
          "You will not get bigger over the next few months. You'll get leaner, fitter and about as " +
          'strong — and the next block starts from a much better place.',
      ),
    );
  }

  // ---- 2. coverage -------------------------------------------------------
  const covered = budgets.filter((b) => b.status === 'covered' && b.trainerStimulus > 0);
  if (covered.length > 0) {
    out.push(finding('info', 'volume.covered_by_trainer', TRADEOFF_COPY.trainer_crowding.body));
  }
  for (const budget of budgets) {
    if (budget.status === 'over_ceiling') {
      out.push(
        finding(
          'info',
          'volume.over_ceiling_unconfirmed',
          `By my model, ${humanMuscle(budget.muscle)} is above the weekly ceiling I'd normally plan ` +
            "to. My model doesn't see your sessions and could easily be wrong — your trainer does. " +
            'Confirming a session or two sharpens this; right now it is mostly a guess.',
        ),
      );
    }
    if (budget.indicatorDropped) {
      out.push(
        finding(
          'warn',
          'strength.indicator_dropped',
          `There isn't enough headroom on ${humanMuscle(budget.muscle)} this week to run its ` +
            'indicator lift, so I have stopped tracking that number rather than squeezing it in. ' +
            'A silently dropped indicator looks exactly like a silently plateaued lift.',
        ),
      );
    }
  }

  // ---- 3. balance --------------------------------------------------------
  const totals = totalCharges(budgets, days);
  const pull = totals.trainer.lats + totals.trainer.upper_back + totals.app.lats + totals.app.upper_back;
  const push = totals.app.chest + totals.app.front_delts + totals.trainer.chest + totals.trainer.front_delts;
  if (push > 0 && pull / push < PULL_PUSH_WARN) {
    out.push(
      finding(
        'info',
        'balance.pull_to_push',
        'Pulling volume has dropped below pressing across the week. Worth a row — but check your ' +
          'trainer days first; they usually carry it.',
      ),
    );
  } else if (push > 0 && pull / push > PULL_PUSH_OVER_SATISFIED) {
    out.push(
      finding(
        'info',
        'balance.pull_over_satisfied',
        'Your pull-to-push ratio is well over the minimum after including trainer volume. ' +
          'The fix for that is more pressing from me, not more rowing — ' +
          'which is the opposite of the usual advice and is why I am saying it out loud.',
      ),
    );
  }

  // ---- the clock ---------------------------------------------------------
  const trimmedCount = days.reduce((n, d) => n + d.trimmed.length, 0);
  if (trimmedCount > 0) {
    out.push(
      finding(
        'info',
        'plan.trimmed_for_time',
        `I cut ${trimmedCount} item${trimmedCount === 1 ? '' : 's'} to keep your sessions in ` +
          'the time you actually have. I trimmed the exercise list rather than the rest ' +
          'periods — shortening rest would quietly turn a strength session into a ' +
          'conditioning one, and in a deficit that is the last thing you want. Each day ' +
          'shows what came out.',
      ),
    );
  }

  const budgeted = budgets.reduce((n, b) => n + b.sets, 0);
  const prescribed = Math.round(
    days.reduce(
      (n, d) =>
        n +
        d.items
          .filter((i) => i.role === 'accessory' || i.role === 'main' || i.role === 'indicator')
          .reduce((m, i) => m + i.sets, 0),
      0,
    ),
  );
  if (budgeted > 0 && prescribed < budgeted * 0.75) {
    out.push(
      finding(
        'info',
        'plan.time_capped',
        `Your weekly budget had room for about ${budgeted} sets and two sessions of this ` +
          `length hold about ${prescribed}. That is the honest constraint, and I would rather ` +
          'keep your rest periods intact than squeeze more sets in. So progression this block ' +
          'comes mostly from load and reps rather than from adding sets — which is the right ' +
          'emphasis in a deficit anyway. If you want the extra volume, the lever is a longer ' +
          'session, not a shorter rest.',
      ),
    );
  }

  // ---- housekeeping ------------------------------------------------------
  if (context.dropped.length > 0) {
    out.push(
      finding(
        'info',
        'plan.slot_dropped',
        `I dropped ${context.dropped.length} slot${context.dropped.length === 1 ? '' : 's'} because ` +
          'the equipment for them and every substitute is missing. Add the kit in Settings and they ' +
          'come back.',
      ),
    );
  }
  if (profile.discomfortSites.length > 0) {
    out.push(
      finding(
        'block',
        'plan.discomfort_flagged',
        "You've flagged discomfort, so nothing in this plan goes up in load or volume. Pain isn't " +
          'soreness — if it is sharp, radiating, swelling, or lasts more than a couple of weeks, see ' +
          "a qualified clinician; we can't assess that.",
      ),
    );
  }
  if (context.isDeload) {
    out.push(
      finding(
        'info',
        'plan.deload_week',
        "This is a deload, and your trainer can't deload with you. So the week is essentially their " +
          'trainer sessions, your Zone 2, and your prehab — and with fixed trainer days that ' +
          'is a real deload, not a week off.',
      ),
    );
  }

  return out;
}

/** Trainer-side and app-side charges, per muscle, for the balance check. */
function totalCharges(
  budgets: readonly MuscleBudget[],
  days: readonly PlannedDay[],
): { app: Record<Muscle, number>; trainer: Record<Muscle, number> } {
  const app = emptyTotals();
  const trainer = emptyTotals();
  for (const budget of budgets) trainer[budget.muscle] = budget.trainerStimulus;
  for (const day of days) {
    for (const item of day.items) {
      for (const [muscle, value] of Object.entries(item.charges) as [Muscle, number][]) {
        app[muscle] += value;
      }
    }
  }
  return { app, trainer };
}

function emptyTotals(): Record<Muscle, number> {
  const out = {} as Record<Muscle, number>;
  for (const muscle of ALL_MUSCLES) out[muscle] = 0;
  return out;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function humanMuscle(muscle: Muscle): string {
  return muscle.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** A pickable starting point on the planner screen. */
export interface ProgramTemplate {
  id: string;
  name: string;
  /** Who it is for, in one line. */
  who: string;
  daysPerWeek: number;
  accumulationWeeks: number;
  deloadWeeks: number;
  rirRamp: readonly number[];
  /** True for the one generated around this athlete's trainer days. */
  personalized: boolean;
  /** Why you would or would not pick it. */
  note: string;
}

/**
 * The templates the planner offers (`program-templates.md`).
 *
 * The personalized block is first and is the recommendation, because it is the
 * only one that knows about the locally configured trainer days. The other four are
 * the published templates, offered honestly: they are good programs that assume
 * the app owns the whole week, which here it does not.
 */
export const PROGRAM_TEMPLATES: readonly ProgramTemplate[] = [
  {
    id: 'personalized-4d',
    name: 'Around your trainer',
    who: 'Built around the trainer days stored in your private profile.',
    daysPerWeek: 4,
    accumulationWeeks: 3,
    deloadWeeks: 1,
    rirRamp: [3, 2, 1],
    personalized: true,
    note:
      'Three accumulation weeks rather than four: concurrent conditioning, a deficit, and trainer ' +
      'sessions whose real load I can only estimate can accumulate fatigue faster. Shorter blocks ' +
      'mean my estimate errors get corrected sooner.',
  },
  {
    id: 'upper-lower-4d',
    name: 'Upper / Lower, 4 days',
    who: 'The default for most intermediate lifters with the whole week to themselves.',
    daysPerWeek: 4,
    accumulationWeeks: 4,
    deloadWeeks: 1,
    rirRamp: [4, 3, 2, 1],
    personalized: false,
    note: 'Best volume-per-time ratio, every muscle twice a week, survives a missed session.',
  },
  {
    id: 'ppl-6d',
    name: 'Push / Pull / Legs, 6 days',
    who: 'Advanced lifters with high MRVs and the schedule to actually show up six times.',
    daysPerWeek: 6,
    accumulationWeeks: 4,
    deloadWeeks: 1,
    rirRamp: [4, 3, 2, 1],
    personalized: false,
    note: 'Highest achievable weekly volume, and the highest early-deload rate. Usually incompatible with several fixed trainer days.',
  },
  {
    id: 'full-body-3d',
    name: 'Full body, 3 days',
    who: 'Beginners, returners, and anyone with unpredictable availability.',
    daysPerWeek: 3,
    accumulationWeeks: 5,
    deloadWeeks: 1,
    rirRamp: [4, 4, 3, 2, 1],
    personalized: false,
    note: 'Beginner volume scaling applies. Missing one of three still leaves every muscle trained twice a fortnight.',
  },
  {
    id: 'hybrid-5d',
    name: 'Hybrid strength + conditioning, 5 days',
    who: 'General athleticism — strength, a real VO2max, and enough muscle.',
    daysPerWeek: 5,
    accumulationWeeks: 3,
    deloadWeeks: 1,
    rirRamp: [3, 2, 1],
    personalized: false,
    note: 'A balanced template, but it assumes it owns all five days.',
  },
  {
    id: 'joint-resilience-4d',
    name: 'Joint resilience, 4 days',
    who: 'A history of knee, shoulder or low-back irritation, currently symptom-free.',
    daysPerWeek: 4,
    accumulationWeeks: 5,
    deloadWeeks: 1,
    rirRamp: [4, 4, 3, 2, 1],
    personalized: false,
    note:
      'Heavy on prehab and the Knees-Over-Toes ladders, light on axial loading. Not for anyone ' +
      'currently in pain — that is a clinician, not a template.',
  },
];

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

/**
 * Every slug this file can ever emit, including fallbacks and ladder positions.
 *
 * Exported so the test suite — and `scripts`-style checks — can assert that all
 * of them resolve against the 220-entry library. A dangling slug in a program
 * generator is a runtime hole that a type system cannot see.
 *
 * @returns the slugs, deduplicated and sorted
 */
export function allProgramSlugs(): string[] {
  const out = new Set<string>();
  for (const day of WEEK_SKELETON) {
    for (const slot of day.slots) {
      out.add(slot.slug);
      for (const fallback of slot.fallbacks ?? []) out.add(fallback);
    }
  }
  return [...out].sort();
}

/**
 * Every slug in a generated plan.
 *
 * @param plan a generated week
 * @returns the slugs, deduplicated and sorted
 */
export function slugsInPlan(plan: WeekPlan): string[] {
  const out = new Set<string>();
  for (const day of plan.days) for (const item of day.items) out.add(item.slug);
  return [...out].sort();
}
