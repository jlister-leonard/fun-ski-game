/**
 * @file Domain types for the workout logger (task graph node **S4**).
 *
 * Two families live here.
 *
 * 1. **{@link LibraryExercise}** — the on-disk shape of
 *    `docs/kg/specs/exercise-library.json`, verbatim, snake_case and all. It is
 *    deliberately *not* translated into camelCase: the bundled copy is asserted
 *    byte-identical to the spec file by a test, and a translation layer would
 *    make that assertion weaker and the drift harder to see. This is public
 *    reference data — it ships unencrypted with the bundle. Only the user's own
 *    logs go in the vault.
 *
 * 2. **Logger records** — thin extensions of the vault record types in
 *    `@/lib/db/types`, carrying the three facts the vault schema does not model
 *    yet: `rep_unit`, range-of-motion measurements, and the trainer-session
 *    estimate. See the note on {@link LoggedSetExtras} for why they are stored
 *    as extra body fields rather than as a parallel table.
 *
 * ## A note on import style
 *
 * The pure modules in this directory — this file, `library`, `format`,
 * `volume`, `trainer-estimate`, `guardrails` — import their siblings and
 * `src/lib/*` **relatively**, not through the `@/` alias that the rest of the
 * app uses. That is deliberate: they are the unit-tested half of the logger,
 * and relative imports resolve under Vitest with or without the root
 * `vitest.config.ts` (which is owned by another agent and flagged in its own
 * header as possibly moving). `store.ts` and `hooks.ts` do I/O and are not unit
 * tested, so they keep the house `@/` style.
 */

import {
  asRepUnit as vaultAsRepUnit,
  isRangeOfMotion,
  magnitudeValue,
  type Muscle,
  type RangeOfMotion,
  type RepUnit as VaultRepUnit,
  type TrainerReport,
  type WorkoutSession,
  type WorkoutSet,
} from '../db/types';

// ---------------------------------------------------------------------------
// The exercise library
// ---------------------------------------------------------------------------

/**
 * What the two numbers in `default_rep_range` mean.
 *
 * **Never inferred from `pattern`** — `training-methodology.md` §1.1 and
 * `channel/013` both make this explicit, and the failure cases are not obscure:
 * `dead-hang` is a `vertical_pull` measured in seconds, and `sled-drag-backward`
 * is a `conditioning` entry measured in metres while every other conditioning
 * entry is in seconds. Rendering "1800 reps" on the Zone 2 cycling screen is
 * exactly the bug this field exists to prevent.
 *
 * Adding a fifth value requires a channel post, because the UI has to render it.
 */
export type RepUnit = VaultRepUnit;

/** Movement pattern. 13 values, all populated in the library. */
export type MovementPattern =
  | 'horizontal_push'
  | 'vertical_push'
  | 'horizontal_pull'
  | 'vertical_pull'
  | 'squat'
  | 'hinge'
  | 'lunge'
  | 'carry'
  | 'rotation'
  | 'isolation'
  | 'mobility'
  | 'conditioning'
  | 'plyometric';

/** Whether the movement loads one joint or several. */
export type Mechanic = 'compound' | 'isolation';

/** Coarse joint-stress band, used to order a session and to flag substitutions. */
export type JointStress = 'low' | 'moderate' | 'high';

/**
 * One entry in the 220-exercise library.
 *
 * The 19 keys are the contract from `channel/013-training-schema-fix.md`, in
 * that order. `rom_tracked` and `rep_unit` are the two that the logger cannot
 * render correctly without.
 */
export interface LibraryExercise {
  /** Stable kebab-case identifier, e.g. `barbell-bench-press`. */
  readonly slug: string;
  readonly name: string;
  /** Gym slang the user is likely to type. Searched alongside `name`. */
  readonly aliases: readonly string[];
  readonly primary_muscles: readonly Muscle[];
  readonly secondary_muscles: readonly Muscle[];
  readonly equipment: readonly string[];
  readonly pattern: MovementPattern;
  readonly mechanic: Mechanic;
  /** Sets are performed, and counted, per side. */
  readonly unilateral: boolean;
  /** Depth is the progression variable — surface a ROM input, not a load field. */
  readonly rom_tracked: boolean;
  /** `[min, max]` in `rep_unit`, not necessarily in reps. */
  readonly default_rep_range: readonly [number, number];
  readonly rep_unit: RepUnit;
  /** Stimulus-to-fatigue ratio, 1–5. Higher is better per unit of fatigue. */
  readonly sfr_rating: number;
  readonly joint_stress: JointStress;
  readonly coach_tags: readonly string[];
  /** Easier variants, in preference order. */
  readonly regressions: readonly string[];
  /** Harder variants, in preference order. */
  readonly progressions: readonly string[];
  readonly cues: readonly string[];
  /**
   * Always non-empty. For a `rom_tracked` entry it contains the sentence
   * `ROM progression: measured as …`, which is what {@link romMeasurementOf}
   * extracts to label the ROM field.
   */
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Logger records
// ---------------------------------------------------------------------------

/**
 * A range-of-motion measurement.
 *
 * Deliberately heterogeneous — knee-to-wall centimetres, torso angle, descent
 * angle, rollout distance — so it is stored as a number plus its own unit
 * string plus free text, never forced onto one scale
 * (`training-methodology.md` §1.2).
 *
 * `unit` is stored as the user entered it. These are not SI quantities being
 * converted for display; they are self-describing measurements whose unit is
 * part of the datum. Where the unit *is* a length the picker offers inches
 * first, per the US-customary display rule, and stores the string alongside.
 */
export type RomEntry = RangeOfMotion;

/**
 * The flat convenience view of a set's magnitude.
 *
 * **These are no longer stored fields.** As of vault body schema v2
 * (`channel/021-vault-schema-v2.md`) `WorkoutSet` carries a tagged
 * {@link import('../db/types').SetMagnitude} union and a first-class `rom`, so
 * the trap this shim used to paper over — `WorkoutSet.reps` being meaningless
 * unless `repUnit === 'reps'` — is now a compile error rather than a "0 reps"
 * label on a 30-minute ride.
 *
 * The flat shape survives because 50-odd call sites read `unitValue` and the
 * screens genuinely want the number and its unit side by side. It is derived
 * from `magnitude` by {@link readSetExtras}, never written.
 */
export interface LoggedSetExtras {
  /** `set.magnitude.repUnit`, hoisted. */
  repUnit: RepUnit;
  /** The count in `repUnit`. Never render it without the unit. */
  unitValue: number;
  /** Depth measurement for a `rom_tracked` movement. Now stored on the set itself. */
  rom: RomEntry | null;
}

/** A performed set as the logger writes and reads it. */
export type LoggedSet = WorkoutSet & LoggedSetExtras;

// ---------------------------------------------------------------------------
// Trainer sessions
// ---------------------------------------------------------------------------

/**
 * The vocabulary the confirmation UI uses — nine regions, not twenty-two
 * muscles (`program-personalized.md` §2.1).
 *
 * The athlete has just finished an hour with a trainer. They will not
 * transcribe it. Nine coarse buckets is what someone can actually report.
 */
export type TrainerRegion =
  | 'hips'
  | 'mid_back'
  | 'lats'
  | 'quads_sled'
  | 'pressing'
  | 'arms'
  | 'core'
  | 'calves_lower_leg'
  | 'conditioning';

/** 0 = didn't touch it, 1 = a bit, 2 = solid, 3 = hammered. */
export type EffortLevel = 0 | 1 | 2 | 3;

/** Per-muscle set estimate for one session, with its own uncertainty. */
export interface MuscleEstimate {
  /** Hard sets attributed to this muscle, per session. */
  meanSets: number;
  /** 1-sigma. Floored at `max(1.0, 0.25 × meanSets)` — see §2.4. */
  sdSets: number;
}

/**
 * What the athlete reports after a trainer session, plus the estimate derived
 * from it.
 *
 * Stored as an extra body field on the `WorkoutSession` record whose `kind` is
 * `'personal_trainer'`, for the same reason as {@link LoggedSetExtras}.
 */
export type TrainerSessionReport = TrainerReport;

/** A trainer session as the logger writes and reads it. */
export type TrainerSessionRecord = WorkoutSession & {
  kind: 'personal_trainer';
  trainerReport: TrainerSessionReport;
};

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a {@link RepUnit}, defaulting to `reps`. */
export function asRepUnit(value: unknown): RepUnit {
  return vaultAsRepUnit(value) ?? 'reps';
}

/**
 * Project a stored set onto the flat `repUnit` / `unitValue` view.
 *
 * Total and lossless: since v2 both facts come straight off the tagged
 * `magnitude` union, so there are no defaults to guess and no legacy branch.
 * Rows written before v2 were already normalised by the body migration in
 * `@/lib/db/codec` before they reach here.
 *
 * @param set a stored set
 * @returns the set with `repUnit` and `unitValue` hoisted alongside
 */
export function readSetExtras(set: WorkoutSet): LoggedSet {
  return {
    ...set,
    repUnit: set.magnitude.repUnit,
    unitValue: magnitudeValue(set.magnitude),
    rom: set.rom,
  };
}

/** True when a value has the shape of a {@link RomEntry}. */
export function isRomEntry(value: unknown): value is RomEntry {
  return isRangeOfMotion(value);
}

/**
 * Read a trainer report off a stored session.
 *
 * @param session a stored session
 * @returns the report, or `null` when the session carries none
 */
export function readTrainerReport(session: WorkoutSession): TrainerSessionReport | null {
  const t: unknown = session.trainerReport;
  if (typeof t !== 'object' || t === null) return null;
  const r = t as Partial<TrainerSessionReport>;
  return {
    durationMin: typeof r.durationMin === 'number' ? r.durationMin : 60,
    regionEffort: r.regionEffort ?? {},
    hardSetsTotal: typeof r.hardSetsTotal === 'number' ? r.hardSetsTotal : null,
    perceivedRir: typeof r.perceivedRir === 'number' ? r.perceivedRir : null,
    sledMeters: typeof r.sledMeters === 'number' ? r.sledMeters : null,
    exerciseNames: Array.isArray(r.exerciseNames) ? r.exerciseNames : [],
    confirmed: r.confirmed === true,
    estimate: r.estimate ?? {},
  };
}
