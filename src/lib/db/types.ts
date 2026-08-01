/**
 * @file The vault's record types — **the data contract for the whole app**.
 *
 * Every repository in `src/lib/db/repos` takes and returns these plain
 * objects. Encryption is invisible at this layer: if you are reading this
 * file to find out what a food log looks like, you never need to think about
 * IVs, ciphertexts or keys.
 *
 * The prose companion to this file is `docs/kg/specs/vault-schema.md`, which
 * documents *why* each plaintext index field is allowed to be plaintext.
 *
 * ## Conventions
 * - **Units are SI and explicit in the field name.** `kg`, `cm`, `kcal`, `g`,
 *   `ms`, `Sec`. There are no ambiguous `weight` or `duration` fields. Display
 *   units (lb/in) are a rendering concern; the vault stores metric only.
 * - **Timestamps are epoch milliseconds** (`number`) except where a wall-clock
 *   calendar day is what actually matters, which is a {@link DateKey}.
 * - **`dateKey` is the *local* calendar day**, not UTC. A 23:30 workout belongs
 *   to that evening, not to tomorrow.
 * - **Nothing is ever hard-deleted** by default. `deletedAt` is set instead, so
 *   a re-import cannot resurrect something the user removed.
 */

/** A local calendar day, `YYYY-MM-DD`. Never a UTC instant. */
export type DateKey = string;

/** Epoch milliseconds. */
export type Millis = number;

/**
 * Where a record came from. Drives de-duplication precedence and the "this
 * number came from your watch, not from you" affordance in the UI.
 */
export type DataSource =
  | 'manual'
  | 'apple-health'
  | 'oura'
  | 'strava'
  | 'open-food-facts'
  | 'seed'
  | 'backup-import'
  | 'derived';

/** Fidelity of an Apple Health ingest path. Higher-fidelity rows win on collision. */
export type IngestFidelity = 'export-zip' | 'hae-file' | 'shortcut' | 'manual';

/**
 * Fields every vault record carries.
 *
 * `id` is a random UUID chosen by the client. It is *stable across backups and
 * restores*, which is what makes merge-import idempotent.
 */
export interface BaseRecord {
  /** Random UUID v4. Primary key. Stable forever, including across backups. */
  id: string;
  /** Epoch ms the record was first written. */
  createdAt: Millis;
  /** Epoch ms of the most recent write. Drives last-write-wins merges. */
  updatedAt: Millis;
  /** Epoch ms of soft deletion, or `null` when live. */
  deletedAt: Millis | null;
}

/**
 * Mixin for anything that can arrive from an external source.
 *
 * `sourceKey` is the **idempotency key**: a deterministic string derived from
 * the source and the natural identity of the datum, e.g.
 * `apple-health:body-mass:2026-07-26T07:12:00Z`. Re-importing the same Apple
 * Health day recomputes the same `sourceKey` and therefore *updates* the
 * existing row instead of creating a second one.
 *
 * It is never stored in plaintext — see `blindIndex` in `src/lib/crypto` and
 * the `sourceHash` column in `schema.ts`.
 */
export interface SourcedRecord {
  /** Where this record came from. */
  source: DataSource;
  /** Deterministic idempotency key, or `null` for hand-entered records. */
  sourceKey: string | null;
}

// ---------------------------------------------------------------------------
// Profile, goals, settings
// ---------------------------------------------------------------------------

/** Biological sex, used only as an input to BMR equations. */
export type Sex = 'male' | 'female';

/** Baseline non-exercise activity, used for the cold-start TDEE estimate. */
export type ActivityLevel =
  | 'sedentary'
  | 'lightly_active'
  | 'moderately_active'
  | 'very_active'
  | 'extremely_active';

/**
 * The user. Exactly one live row, with the fixed id {@link PROFILE_ID}.
 *
 * A singleton rather than a settings blob because it is genuinely the most
 * sensitive record in the vault and deserves its own ciphertext.
 */
export interface Profile extends BaseRecord {
  displayName: string | null;
  /** ISO date of birth, `YYYY-MM-DD`. Used for age in BMR equations. */
  birthDate: DateKey | null;
  sex: Sex | null;
  heightCm: number | null;
  activityLevel: ActivityLevel | null;
  /** IANA zone, e.g. `Europe/London`. Determines which day a datum lands on. */
  timeZone: string | null;
  /** Display preference only — storage is always metric. */
  unitPreference: 'metric' | 'imperial';
}

/** The fixed primary key of the singleton {@link Profile} row. */
export const PROFILE_ID = 'profile';

/** The fixed primary key of the singleton {@link AppSettings} row. */
export const SETTINGS_ID = 'settings';

/** What the user is currently trying to do with their body weight. */
export type GoalDirection = 'cut' | 'maintain' | 'gain';

/** An active or historical nutrition/body-composition goal. */
export interface Goal extends BaseRecord {
  direction: GoalDirection;
  /** Target rate of change, kg/week. Negative for a cut. */
  targetRateKgPerWeek: number;
  /** Optional absolute target. */
  targetWeightKg: number | null;
  /** Optional target body-fat percentage, 0–100. */
  targetBodyFatPct: number | null;
  startDateKey: DateKey;
  /** `null` while the goal is active. */
  endDateKey: DateKey | null;
  /** Manual protein floor in g/kg, overriding the algorithm default. */
  proteinGPerKgOverride: number | null;
  /** Free-text rationale the coach surface can echo back. */
  note: string | null;
  /** Exactly one goal should be active at a time. */
  active: boolean;
}

/** Non-secret app preferences. Singleton, id {@link SETTINGS_ID}. */
export interface AppSettings extends BaseRecord {
  /** Idle milliseconds before the vault auto-locks. */
  autoLockIdleMs: number;
  /** Milliseconds the app may sit backgrounded before locking. */
  autoLockHiddenGraceMs: number;
  /** Whether auto-lock is on at all. */
  autoLockEnabled: boolean;
  /** Days between backup nags. */
  backupReminderDays: number;
  /** Whether the user has opted into direct vendor API calls at all. */
  allowDirectVendorFetch: boolean;
  /** First day of the training/nutrition week, 0 = Sunday. */
  weekStartsOn: 0 | 1;
  /** Arbitrary UI preferences owned by the screens, namespaced by key. */
  ui: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/** A single weigh-in. Feeds `computeWeightTrend` in the algorithms package. */
export interface WeightEntry extends BaseRecord, SourcedRecord {
  /** Local calendar day of the weigh-in. */
  dateKey: DateKey;
  /** Scale reading in kilograms. */
  kg: number;
  /** Epoch ms of the actual measurement, for same-day ordering. */
  measuredAt: Millis;
  /** Body-fat percentage from a smart scale, 0–100, when available. */
  bodyFatPct: number | null;
  note: string | null;
  /** Optional while legacy rows migrate on their next ingest write. */
  fidelity?: IngestFidelity;
}

/** Tape-measure sites. Frozen vocabulary — the UI keys off it. */
export type MeasurementSite =
  | 'neck'
  | 'shoulders'
  | 'chest'
  | 'waist'
  | 'hips'
  | 'thigh_left'
  | 'thigh_right'
  | 'calf_left'
  | 'calf_right'
  | 'upper_arm_left'
  | 'upper_arm_right'
  | 'forearm_left'
  | 'forearm_right';

/** One measurement session: several sites captured on the same day. */
export interface BodyMeasurement extends BaseRecord, SourcedRecord {
  dateKey: DateKey;
  measuredAt: Millis;
  /** Site → centimetres. Sparse; only what was actually measured. */
  sitesCm: Partial<Record<MeasurementSite, number>>;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Nutrition
// ---------------------------------------------------------------------------

/** Macro and micro content of a fixed quantity of a food. */
export interface Nutrients {
  kcal: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  fiberG?: number;
  sugarG?: number;
  satFatG?: number;
  sodiumMg?: number;
  potassiumMg?: number;
}

/** A named serving size, e.g. "1 medium (118 g)". */
export interface ServingSize {
  /** Stable slug within the food, e.g. `medium`. */
  id: string;
  label: string;
  /** How many grams one of this serving weighs. */
  grams: number;
}

/**
 * A food in the catalogue: either from the bundled seed DB (node I7) or cached
 * from an Open Food Facts lookup (node I8).
 *
 * Cached foods are encrypted like everything else. The *barcode* is indexed as
 * a blind index (`sourceKey = 'off:<barcode>'`), never in the clear — knowing
 * that a vault contains barcode 5000159407236 tells you the user eats Snickers.
 */
export interface Food extends BaseRecord, SourcedRecord {
  name: string;
  brand: string | null;
  /** EAN/UPC barcode when known. */
  barcode: string | null;
  /** Nutrients per 100 g. The canonical basis for all arithmetic. */
  per100g: Nutrients;
  /** Optional named servings the UI offers as shortcuts. */
  servings: ServingSize[];
  /** True for entries the user typed in themselves. */
  userCreated: boolean;
  /** Bumped whenever the food is logged, to rank search results. */
  useCount: number;
  lastUsedAt: Millis | null;
}

/** Which meal slot a log belongs to. */
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'preworkout' | 'postworkout';

/** One logged food (or recipe) entry on a given day. */
export interface FoodLog extends BaseRecord, SourcedRecord {
  dateKey: DateKey;
  loggedAt: Millis;
  slot: MealSlot;
  /** FK into `foods`, or `null` for a quick-added macro entry. */
  foodId: string | null;
  /** FK into `recipes` when the log is a serving of a saved recipe. */
  recipeId: string | null;
  /** Snapshot of the food's name at log time, so edits to the food don't rewrite history. */
  label: string;
  /** Quantity consumed, in grams. */
  grams: number;
  /** Nutrients actually consumed — pre-multiplied, so history is immutable. */
  nutrients: Nutrients;
  note: string | null;
}

/** An ingredient line in a recipe. */
export interface RecipeIngredient {
  foodId: string;
  label: string;
  grams: number;
  nutrients: Nutrients;
}

/** A saved multi-ingredient recipe the user can log in one tap. */
export interface Recipe extends BaseRecord, SourcedRecord {
  name: string;
  ingredients: RecipeIngredient[];
  /** How many servings the whole recipe makes. */
  servings: number;
  /** Sum over ingredients, cached so listing a recipe needs no joins. */
  totalNutrients: Nutrients;
  note: string | null;
  useCount: number;
  lastUsedAt: Millis | null;
}

/**
 * A saved *meal* — a reusable bundle of food logs, e.g. "my usual breakfast".
 *
 * Distinct from a recipe: a recipe is cooked and divided into servings; a meal
 * is a set of separately-logged items eaten together.
 */
export interface Meal extends BaseRecord, SourcedRecord {
  name: string;
  slot: MealSlot;
  /** Day the meal template was captured from, for provenance. */
  dateKey: DateKey;
  items: Array<{ foodId: string | null; label: string; grams: number; nutrients: Nutrients }>;
  totalNutrients: Nutrients;
  useCount: number;
  lastUsedAt: Millis | null;
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/**
 * The frozen 22-value muscle vocabulary from
 * `docs/kg/specs/training-methodology.md` §1. The exercise library, this
 * schema and the UI all key off it. Do not extend without posting to the
 * channel.
 */
export type Muscle =
  | 'chest'
  | 'front_delts'
  | 'side_delts'
  | 'rear_delts'
  | 'lats'
  | 'upper_back'
  | 'traps'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'adductors'
  | 'abductors'
  | 'calves'
  | 'tibialis'
  | 'spinal_erectors'
  | 'abs'
  | 'obliques'
  | 'neck'
  | 'hip_flexors';

/** Weekly hard-set volume landmarks (Israetel). */
export interface VolumeLandmarks {
  /** Maintenance volume. */
  mv: number;
  /** Minimum effective volume — where a mesocycle starts. */
  mev: number;
  /** Maximum adaptive volume, low end. */
  mavLow: number;
  /** Maximum adaptive volume, high end. */
  mavHigh: number;
  /** Maximum recoverable volume — the ceiling. */
  mrv: number;
}

/** Equipment class, used for substitution when a machine is occupied. */
export type Equipment =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'band'
  | 'kettlebell'
  | 'smith'
  | 'other';

/**
 * A movement. Seeded from `exercise-library.json` (node R1) and extendable by
 * the user.
 *
 * `slug` is the stable cross-reference used by program templates. It is
 * indexed as a blind index rather than in the clear, because "this vault
 * contains `rehab-shoulder-external-rotation`" is a health inference.
 */
export interface Exercise extends BaseRecord, SourcedRecord {
  /** Stable kebab-case identifier, e.g. `barbell-bench-press`. */
  slug: string;
  name: string;
  primaryMuscles: Muscle[];
  secondaryMuscles: Muscle[];
  equipment: Equipment;
  /** Stimulus-to-fatigue ratio, 1–5. Higher is better per unit of fatigue. */
  sfr: number | null;
  /** Slugs of acceptable substitutes, in preference order. */
  substituteSlugs: string[];
  /** Whether this is a unilateral movement (sets are counted per side). */
  unilateral: boolean;
  /** True for entries the user added themselves. */
  userCreated: boolean;
  note: string | null;
}

/** A training program: a reusable template, not a scheduled block. */
export interface Program extends BaseRecord, SourcedRecord {
  name: string;
  description: string | null;
  /** Sessions per week the template assumes. */
  daysPerWeek: number;
  /** Per-day exercise slots. Index 0 = day 1 of the microcycle. */
  days: Array<{
    label: string;
    slots: Array<{
      exerciseSlug: string;
      sets: number;
      repMin: number;
      repMax: number;
      targetRir: number;
      restSeconds: number;
    }>;
  }>;
  /** Per-muscle landmark overrides for this program. */
  landmarks: Partial<Record<Muscle, VolumeLandmarks>>;
  userCreated: boolean;
}

/** A scheduled training block instantiated from a {@link Program}. */
export interface Mesocycle extends BaseRecord, SourcedRecord {
  /** FK into `programs`. */
  programId: string;
  name: string;
  /** First day of the block. Mirrored to the plaintext `dateKey` column. */
  startDateKey: DateKey;
  /** Accumulation weeks, excluding the deload. */
  accumulationWeeks: number;
  /** Whether a deload week terminates the block. */
  deloadWeek: boolean;
  /** Starting RIR for week 1, descending across the block. */
  startingRir: number;
  /** Per-muscle starting weekly set counts, typically MEV. */
  startingSetsPerMuscle: Partial<Record<Muscle, number>>;
  status: 'planned' | 'active' | 'completed' | 'abandoned';
  endDateKey: DateKey | null;
  note: string | null;
}

/** How a session was performed — matters for how much to trust the load data. */
export type SessionKind = 'self' | 'personal_trainer' | 'class' | 'rehab';

/**
 * The nine coarse body regions the trainer-confirmation UI asks about.
 *
 * Nine buckets, not the 22-value {@link Muscle} vocabulary, because the athlete
 * has just finished an hour with a trainer and will not transcribe it
 * (`program-personalized.md` §2.1).
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

/** How hard one region was worked. 0 = didn't touch it, 3 = hammered. */
export type EffortLevel = 0 | 1 | 2 | 3;

/** A per-muscle set estimate carrying its own uncertainty. */
export interface MuscleSetEstimate {
  /** Hard sets attributed to this muscle, for this session. */
  meanSets: number;
  /** 1-sigma. Floored at `max(1.0, 0.25 × meanSets)` — `program-personalized.md` §2.4. */
  sdSets: number;
}

/**
 * What the athlete reports after a session their trainer ran, plus the
 * per-muscle estimate derived from it.
 *
 * The app cannot program these days; it can only observe them. The estimate is
 * what weekly volume budgeting subtracts, so that the app stops stacking its
 * own work on top of muscles the trainer already hammered.
 *
 * **`confirmed: false` does not mean zero.** An unreported trainer session
 * still counts at full prior value. Treating missing data as no volume is the
 * inversion the whole mechanism exists to prevent — it would have the app
 * program *more* work precisely when it knows least.
 *
 * Two fields deliberately live on the {@link WorkoutSession} itself rather than
 * being duplicated here: overall perceived effort is `sessionRpe`, and free-text
 * notes are `note`. One home each.
 */
export interface TrainerReport {
  /** Session length in minutes. Typically 60. */
  durationMin: number;
  /** The nine region controls. An absent region means 0, not "unknown". */
  regionEffort: Partial<Record<TrainerRegion, EffortLevel>>;
  /** Power-user override: "it was about 22 hard sets". */
  hardSetsTotal: number | null;
  /** Roughly how close to failure the work was. Feeds the fatigue ledger only. */
  perceivedRir: number | null;
  /** Sled distance in **metres**. Charged at the concentric-only fatigue cost. */
  sledMeters: number | null;
  /** Optional recall: "trap bar deadlift, chest-supported row, sled". */
  exerciseNames: string[];
  /** True once the athlete has seen the derived estimate and accepted or edited it. */
  confirmed: boolean;
  /** The per-muscle stimulus this session is credited with. */
  estimate: Partial<Record<Muscle, MuscleSetEstimate>>;
}

/** One workout. Sets live in their own table so logging a set is one small write. */
export interface WorkoutSession extends BaseRecord, SourcedRecord {
  dateKey: DateKey;
  startedAt: Millis;
  endedAt: Millis | null;
  /** FK into `mesocycles`, or `null` for an ad-hoc session. */
  mesocycleId: string | null;
  /** Which day of the microcycle this was, 0-based. */
  dayIndex: number | null;
  kind: SessionKind;
  title: string | null;
  /** Session RPE, 1–10, captured after the fact. */
  sessionRpe: number | null;
  /** Free-text — how it felt, what hurt, who coached it. */
  note: string | null;
  /** Trainer or class instructor name, when `kind` is not `'self'`. */
  coachName: string | null;
  /**
   * The post-hoc report for a session the athlete's trainer ran.
   *
   * Non-null only when `kind === 'personal_trainer'`. `null` everywhere else —
   * the vault does not model that correlation in the type system because a
   * `class` session may grow one later.
   */
  trainerReport: TrainerReport | null;
}

/** How a set's effort was recorded. */
export type EffortKind = 'rir' | 'rpe' | 'none';

/**
 * What the numbers on a set are counted in.
 *
 * Copied from the exercise library's `rep_unit` at log time, so history renders
 * correctly forever even if the library is later corrected. Adding a fifth
 * value requires a channel post — the UI has to learn to render it.
 */
export type RepUnit = 'reps' | 'seconds' | 'meters' | 'steps';

/**
 * How much work one set was, tagged by the unit it is counted in.
 *
 * **This is a discriminated union on purpose.** The previous schema had a flat
 * `reps: number` plus a nullable `durationSec`, which made
 * "30-minute Zone 2 ride" and "0 reps" the same value — the exact class of bug
 * that `default_rep_range` overloading caused in the exercise library, and that
 * `channel/013-training-schema-fix.md` already fixed once. Here, `.reps` simply
 * **does not exist** until you narrow on `repUnit`, so the compiler refuses to
 * let a screen render "0 reps" for a sled push.
 *
 * ```ts
 * switch (set.magnitude.repUnit) {
 *   case 'reps':    return `${set.magnitude.reps} reps`;
 *   case 'seconds': return formatDuration(set.magnitude.seconds);
 *   case 'meters':  return formatDistance(set.magnitude.meters);
 *   case 'steps':   return `${set.magnitude.steps} steps`;
 * }
 * ```
 *
 * Distances are **metres** and always have been SI on disk; the yard/foot
 * conversion happens at the display boundary via `src/lib/units`.
 */
export type SetMagnitude =
  | { repUnit: 'reps'; reps: number }
  | { repUnit: 'seconds'; seconds: number }
  | { repUnit: 'meters'; meters: number }
  | { repUnit: 'steps'; steps: number };

/**
 * A range-of-motion measurement, for the 16 library movements whose
 * progression variable is **depth rather than load**.
 *
 * The Knees Over Toes ladders in `training-methodology.md` §7 progress by
 * knee-to-wall centimetres, torso angle, descent angle or rollout distance.
 * Without somewhere to put that number those ladders break silently: the set
 * looks identical week to week while the athlete is in fact progressing.
 *
 * `unit` is **deliberately free-form and deliberately not SI**. These are
 * self-describing measurements whose unit is part of the datum — `in`, `cm`,
 * `deg`, `holes`, `notch` — not quantities being converted for display.
 * Normalising a rack notch to metres would destroy the meaning, not preserve
 * it. The SI rule applies to {@link SetMagnitude} distances and to `weightKg`,
 * both of which are SI here.
 */
export interface RangeOfMotion {
  /** The measured number, in `unit`. */
  value: number;
  /** e.g. `in`, `cm`, `deg`, `holes`, `notch`. Free-form by design. */
  unit: string;
  /** "hamstring touched calf", "front foot on a 4in plate" — the real signal. */
  note: string;
}

/**
 * One performed set.
 *
 * The highest-cardinality table in the vault — a year of serious training is
 * roughly 10–15k rows. Kept deliberately narrow so a set logs in a single tiny
 * encrypt + put.
 *
 * **There is no `reps` field.** See {@link SetMagnitude}.
 */
export interface WorkoutSet extends BaseRecord, SourcedRecord {
  /** FK into `workoutSessions`. */
  sessionId: string;
  /** FK into `exercises`. */
  exerciseId: string;
  /** Order within the session, 0-based. */
  order: number;
  /** Load in kilograms. `0` for bodyweight movements. */
  weightKg: number;
  /**
   * How much work this set was, and in what unit. **Required, no default** —
   * a default is how "0 reps for a 30-minute ride" comes back.
   */
  magnitude: SetMagnitude;
  effortKind: EffortKind;
  /** Reps in reserve or RPE, per `effortKind`. */
  effort: number | null;
  /** Warm-up sets do not count toward weekly hard-set volume. */
  warmup: boolean;
  /** A set taken past failure with a drop / rest-pause. */
  technique: 'straight' | 'drop' | 'rest_pause' | 'myo_rep' | 'cluster' | null;
  /** Actual rest before this set, seconds. */
  restSeconds: number | null;
  /** Depth measurement for a `rom_tracked` movement, or `null`. */
  rom: RangeOfMotion | null;
  note: string | null;
  /**
   * Cached epoch-1RM so PR detection needs no recomputation.
   *
   * `null` for anything that is not loaded rep work: a 40-second plank and a
   * 50-metre sled drag have no 1RM, and inventing one corrupts the PR table.
   */
  estimated1rmKg: number | null;
}

/**
 * Build a {@link SetMagnitude} from a unit and a number.
 *
 * The bridge for callers that hold `(repUnit, value)` as two loose variables —
 * an entry sheet's form state, an importer's payload — and need the tagged
 * form. Doing the mapping here once means no call site has to remember which
 * key each unit uses.
 *
 * @param repUnit the unit the value is counted in
 * @param value the count
 * @returns the tagged magnitude
 */
export function setMagnitude(repUnit: RepUnit, value: number): SetMagnitude {
  switch (repUnit) {
    case 'reps':
      return { repUnit, reps: value };
    case 'seconds':
      return { repUnit, seconds: value };
    case 'meters':
      return { repUnit, meters: value };
    case 'steps':
      return { repUnit, steps: value };
  }
}

/**
 * The raw number out of a {@link SetMagnitude}, whatever its unit.
 *
 * Use this **only** where the unit is carried alongside — a chart axis, a sum
 * of like-for-like sets, an equality check. Rendering this number without its
 * unit is the bug the union exists to prevent.
 *
 * @param magnitude the tagged magnitude
 * @returns the count, in `magnitude.repUnit`
 */
export function magnitudeValue(magnitude: SetMagnitude): number {
  switch (magnitude.repUnit) {
    case 'reps':
      return magnitude.reps;
    case 'seconds':
      return magnitude.seconds;
    case 'meters':
      return magnitude.meters;
    case 'steps':
      return magnitude.steps;
  }
}

/**
 * Narrow an unknown value to a {@link RepUnit}.
 *
 * Returns `null` rather than defaulting to `'reps'`: a silent default is how a
 * sled push becomes "0 reps". Callers reading untrusted input must decide what
 * to do with an unreadable unit, explicitly.
 *
 * @param value anything
 * @returns the unit, or `null` when it is not one of the four
 */
export function asRepUnit(value: unknown): RepUnit | null {
  return value === 'reps' || value === 'seconds' || value === 'meters' || value === 'steps'
    ? value
    : null;
}

/**
 * True when a value has the shape of a {@link SetMagnitude}.
 *
 * @param value anything
 */
export function isSetMagnitude(value: unknown): value is SetMagnitude {
  if (typeof value !== 'object' || value === null) return false;
  const unit = asRepUnit((value as { repUnit?: unknown }).repUnit);
  if (unit === null) return false;
  return typeof (value as Record<string, unknown>)[unit] === 'number';
}

/**
 * True when a value has the shape of a {@link RangeOfMotion}.
 *
 * @param value anything
 */
export function isRangeOfMotion(value: unknown): value is RangeOfMotion {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RangeOfMotion>;
  return typeof v.value === 'number' && typeof v.unit === 'string';
}

/** Which flavour of personal record a row represents. */
export type PrKind = 'e1rm' | 'weight_for_reps' | 'max_reps' | 'volume';

/** A detected personal record. Derived, but stored so history is stable. */
export interface PersonalRecord extends BaseRecord, SourcedRecord {
  exerciseId: string;
  kind: PrKind;
  dateKey: DateKey;
  /** FK into `workoutSets` — the set that set the record. */
  setId: string | null;
  weightKg: number;
  reps: number;
  /** The comparable scalar for this `kind`; e1RM in kg, or total volume in kg. */
  value: number;
  /** Previous best, for "you beat it by 2.5 kg" copy. */
  previousValue: number | null;
}

// ---------------------------------------------------------------------------
// Health / recovery
// ---------------------------------------------------------------------------

/**
 * The canonical timeseries metric vocabulary. Every source — Apple Health,
 * Oura, Strava — normalises into these (node I1 owns the mapping).
 *
 * `type` is the **one plaintext enum in the vault**, because `[type+dateKey]`
 * is the index that makes "resting HR for the last 90 days" a single range
 * scan instead of a full-table decrypt. See `vault-schema.md` §4.
 */
export type HealthMetricType =
  | 'steps'
  | 'active_energy_kcal'
  | 'basal_energy_kcal'
  | 'resting_heart_rate'
  | 'hrv_sdnn_ms'
  | 'respiratory_rate'
  | 'vo2max'
  | 'body_temperature_delta_c'
  | 'blood_oxygen_pct'
  | 'exercise_minutes'
  | 'stand_hours'
  | 'distance_walking_running_m'
  | 'flights_climbed'
  | 'water_ml'
  | 'mindful_minutes';

/**
 * One value of one metric for one day (or one interval within a day).
 *
 * Deliberately generic: a new metric from a new source is a new `type` value,
 * never a new table and never a migration.
 */
export interface HealthMetric extends BaseRecord, SourcedRecord {
  type: HealthMetricType;
  dateKey: DateKey;
  /** Numeric value in the unit implied by `type`. */
  value: number;
  /** Interval start, when the datum is finer-grained than a day. */
  startedAt: Millis | null;
  /** Interval end. */
  endedAt: Millis | null;
  /** How the value was aggregated from raw samples. */
  aggregation: 'sum' | 'average' | 'min' | 'max' | 'latest' | 'raw';
  /** Optional while legacy rows migrate on their next ingest write. */
  fidelity?: IngestFidelity;
}

/** Sleep stage breakdown, minutes. */
export interface SleepStages {
  deepMin: number | null;
  remMin: number | null;
  lightMin: number | null;
  awakeMin: number | null;
}

/** One night of sleep, attributed to the day the user woke up. */
export interface SleepRecord extends BaseRecord, SourcedRecord {
  /** The **wake** day. A 23:40→07:10 sleep belongs to the morning it ended. */
  dateKey: DateKey;
  bedtimeAt: Millis;
  wakeAt: Millis;
  /** Time actually asleep, minutes. */
  asleepMin: number;
  /** Time in bed, minutes. */
  inBedMin: number;
  /** `asleepMin / inBedMin`, 0–1. */
  efficiency: number | null;
  stages: SleepStages;
  /** Vendor sleep score, 0–100, when supplied. */
  score: number | null;
  /** Average heart rate during sleep. */
  averageHeartRate: number | null;
  /** Overnight HRV, ms. */
  hrvMs: number | null;
  note: string | null;
  /** Optional while legacy rows migrate on their next ingest write. */
  fidelity?: IngestFidelity;
}

/** Rule 7 symptoms that suppress readiness-based programming. */
export interface ReadinessSymptomFlags {
  chestPain: boolean;
  dizzinessOrFainting: boolean;
  shortnessOfBreath: boolean;
  unexplainedWeightChange: boolean;
  painAtRest: boolean;
}

export type StoredReadinessBand = 'high' | 'normal' | 'low' | 'poor';

/**
 * The canonical training decision produced by the readiness engine.
 *
 * `score` is a 0–100 presentation value and cannot safely recreate this: pain,
 * illness, referral triggers, and the chronic-reduction stop rule may all
 * override what the score's band would otherwise prescribe.
 */
export interface ReadinessTrainingDecision {
  band: StoredReadinessBand;
  programmingSuppressed: boolean;
  adjustmentPaused: boolean;
  referral: boolean;
  adjustment: {
    applied: boolean;
    volumeDelta: number;
    setsPerExerciseDelta: number;
    minSetsPerExercise: number;
    rirDelta: number;
    minRir: number | null;
    loadDelta: number;
    extraSetOnLastExercise: boolean;
    conditioning: 'as_programmed' | 'downgrade_intervals' | 'easy_only' | 'rest';
    reasons: string[];
  };
}

/**
 * A daily readiness assessment.
 *
 * Two flavours coexist: `source: 'oura'` for a vendor score, and
 * `source: 'derived'` for the app's own Galpin-style computation (node A6).
 * Both are kept — the coach shows its own reasoning but respects the ring.
 */
export interface ReadinessRecord extends BaseRecord, SourcedRecord {
  dateKey: DateKey;
  /** 0–100. */
  score: number;
  /** Named contributions, each 0–100, for the "why" breakdown. */
  contributors: Record<string, number>;
  /** Subjective inputs and safety gates the user entered. */
  subjective: {
    soreness: number | null;
    energy: number | null;
    motivation: number | null;
    stress: number | null;
    sleepQuality: number | null;
    painFlag: boolean;
    illnessFlag: boolean;
    symptoms: ReadinessSymptomFlags;
  } | null;
  /** Bounded training-load multiplier this readiness implies, e.g. 0.8. */
  loadMultiplier: number | null;
  /** Canonical engine output. `null` only on safely migrated/vendor rows. */
  trainingDecision: ReadinessTrainingDecision | null;
  note: string | null;
}

/** A discrete cardio/activity session — a run, a ride, a walk. */
export interface Activity extends BaseRecord, SourcedRecord {
  dateKey: DateKey;
  startedAt: Millis;
  endedAt: Millis;
  /** Vendor activity type, normalised to lower_snake_case. */
  activityType: string;
  durationSec: number;
  distanceM: number | null;
  /** Active energy, kcal, excluding basal. */
  activeKcal: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  elevationGainM: number | null;
  /** Galpin conditioning zone, 1–5, when classifiable. */
  zone: number | null;
  name: string | null;
  note: string | null;
  /** Optional while legacy rows migrate on their next ingest write. */
  fidelity?: IngestFidelity;
}

/** One provider-issued clinical laboratory observation imported from FHIR. */
export interface LabRecord extends BaseRecord, SourcedRecord {
  /** Clinical calendar day, derived from the FHIR observation time. */
  dateKey: DateKey;
  /** Original ISO-8601 clinical time, including its source offset. */
  effectiveAt: string;
  displayName: string;
  loinc: string | null;
  /** The source value and unit are retained even when conversion is refused. */
  rawValue: number | null;
  rawUnit: string | null;
  /** Canonical value/unit when an analyte-specific safe conversion exists. */
  canonicalValue: number | null;
  canonicalUnit: string | null;
  valueText: string | null;
  rangeStatus: string;
  /** Every provider that supplied this provider-independent observation. */
  providers: string[];
  /** FHIR releases seen for this observation, retained as import provenance. */
  fhirReleases: Array<'dstu2' | 'r4' | 'unknown'>;
}

// ---------------------------------------------------------------------------
// Integrations, insights, ingest
// ---------------------------------------------------------------------------

/** A third-party data source the user has connected. */
export type IntegrationProvider = 'oura' | 'strava' | 'apple-health' | 'open-food-facts';

/**
 * Credentials and sync state for one third-party provider.
 *
 * **The single most sensitive table in the vault.** A leaked Oura token is a
 * live read handle on the user's biometrics at the vendor, independent of this
 * device. Tokens are inside the ciphertext; only the blind-indexed provider
 * name is queryable.
 */
export interface Integration extends BaseRecord {
  provider: IntegrationProvider;
  /** Long-lived access token, pasted by the user. Never leaves the device. */
  accessToken: string | null;
  refreshToken: string | null;
  /** Epoch ms the access token expires, when known. */
  expiresAt: Millis | null;
  /** Vendor-side account identifier, for display. */
  accountLabel: string | null;
  status: 'connected' | 'expired' | 'error' | 'disconnected';
  /** Epoch ms of the last successful pull. */
  lastSyncedAt: Millis | null;
  /** Most recent error message, for honest UI. */
  lastError: string | null;
  /** Provider-specific cursor / `since` marker for incremental pulls. */
  cursor: string | null;
}

/** What kind of coaching output an insight is. */
export type InsightType =
  | 'nutrition'
  | 'training'
  | 'recovery'
  | 'body'
  | 'adherence'
  | 'safety'
  | 'milestone';

/** Urgency, driving ordering on the dashboard. */
export type InsightSeverity = 'info' | 'suggestion' | 'warning' | 'critical';

/**
 * One ranked coaching output from the rules engine (node A7).
 *
 * Persisted so the weekly review can show what was said and whether the user
 * acted on it — the coach has a memory.
 */
export interface Insight extends BaseRecord {
  type: InsightType;
  dateKey: DateKey;
  severity: InsightSeverity;
  title: string;
  body: string;
  /** Stable rule identifier, so the same rule can supersede its own output. */
  ruleId: string;
  /** 0–1 ranking score. */
  score: number;
  /** Whether `guardrails.ts` cleared this. Nothing renders without it. */
  guardrailPassed: boolean;
  /** Structured evidence for "why am I seeing this". */
  evidence: Record<string, string | number | boolean | null>;
  /** Epoch ms the user dismissed it. */
  dismissedAt: Millis | null;
  /** Epoch ms the user marked it acted-upon. */
  acknowledgedAt: Millis | null;
}

/**
 * Audit trail of every ingest batch, for idempotency and for honesty.
 *
 * Node I2 writes one row per clipboard/paste payload. The `sourceKey` is the
 * batch's content hash, so reading the same Shortcut output twice is a no-op
 * rather than a duplicate import.
 */
export interface IngestLogEntry extends BaseRecord, SourcedRecord {
  dateKey: DateKey;
  /** Which pipeline produced this batch. */
  channel: 'fragment' | 'paste' | 'export-zip' | 'vendor-api' | 'backup-import';
  provider: IntegrationProvider | null;
  /** Records the batch claimed to contain. */
  recordCount: number;
  /** Records actually written (inserted + updated). */
  appliedCount: number;
  /** Records skipped because an identical `sourceKey` already existed. */
  skippedCount: number;
  status: 'applied' | 'partial' | 'failed' | 'duplicate';
  /** First error, when `status` is not `'applied'`. */
  error: string | null;
  /** Per-table applied counts, for the "what just happened" summary. */
  byTable: Record<string, number>;
}

/**
 * Union of every decrypted record type. Used by the backup importer, which
 * must round-trip rows it does not otherwise understand.
 */
export type AnyRecord =
  | Profile
  | Goal
  | AppSettings
  | WeightEntry
  | BodyMeasurement
  | Food
  | FoodLog
  | Recipe
  | Meal
  | Exercise
  | Program
  | Mesocycle
  | WorkoutSession
  | WorkoutSet
  | PersonalRecord
  | HealthMetric
  | SleepRecord
  | ReadinessRecord
  | Activity
  | Integration
  | Insight
  | IngestLogEntry;
