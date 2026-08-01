/**
 * @file The logger's data layer — everything that touches the vault.
 *
 * Only this module in `src/lib/training/**` performs I/O; the rest is pure and
 * unit-testable. Every write goes through `@/lib/db/repos`, never through the
 * codec or the crypto directly.
 *
 * The seam that matters: {@link seedExerciseLibrary} copies the 220-movement
 * library into the vault's `exercises` table on first unlock. That table exists
 * so a logged set has a stable foreign key and so `hardSetsByMuscle` works; the
 * *searchable* copy stays in the bundle, unencrypted, because it is identical
 * for every install and searching it must not require an unlocked vault.
 */

import {
  exercises,
  personalRecords,
  toDateKey,
  workoutSessions,
  workoutSets,
} from '@/lib/db/repos';
import {
  setMagnitude,
  type DateKey,
  type Equipment,
  type Exercise,
  type Muscle,
  type PersonalRecord,
  type WorkoutSession,
  type WorkoutSet,
} from '@/lib/db/types';
import { EXERCISE_LIBRARY, exerciseBySlug } from './library';
import {
  estimateFromReport,
  SEED_CONFIDENCE,
  trainerLoadFor,
  updateConfidence,
} from './trainer-estimate';
import {
  ALL_MUSCLES,
  buildWeek,
  loggedSetsByMuscle,
  type MuscleWeek,
  type TrainerWeekLoad,
} from './volume';
import {
  readSetExtras,
  readTrainerReport,
  type LibraryExercise,
  type LoggedSet,
  type RepUnit,
  type RomEntry,
  type TrainerSessionReport,
} from './types';

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** The library's equipment vocabulary is richer than the vault's; collapse it. */
const EQUIPMENT_MAP: Readonly<Record<string, Equipment>> = {
  barbell: 'barbell',
  ez_bar: 'barbell',
  trap_bar: 'barbell',
  dumbbell: 'dumbbell',
  kettlebell: 'kettlebell',
  machine: 'machine',
  smith_machine: 'smith',
  cable: 'cable',
  band: 'band',
  bodyweight: 'bodyweight',
};

/**
 * Collapse the library's equipment list onto the vault's nine-value union.
 *
 * The first recognised entry wins, because the library lists the *defining*
 * implement first and the incidentals ("bench", "box") after it.
 *
 * @param equipment the library entry's equipment list
 * @returns the vault equipment class
 */
export function equipmentClassOf(equipment: readonly string[]): Equipment {
  for (const item of equipment) {
    const mapped = EQUIPMENT_MAP[item];
    if (mapped) return mapped;
  }
  return 'other';
}

/** Shape one library entry as a vault `exercises` row. */
function toVaultExercise(entry: LibraryExercise): Omit<Exercise, keyof import('@/lib/db/types').BaseRecord> {
  return {
    source: 'seed',
    sourceKey: entry.slug,
    slug: entry.slug,
    name: entry.name,
    primaryMuscles: [...entry.primary_muscles],
    secondaryMuscles: [...entry.secondary_muscles],
    equipment: equipmentClassOf(entry.equipment),
    sfr: entry.sfr_rating,
    substituteSlugs: [...entry.regressions],
    unilateral: entry.unilateral,
    userCreated: false,
    note: entry.notes,
  };
}

let seeding: Promise<{ created: number; updated: number }> | null = null;

/**
 * Copy the bundled library into the vault, idempotently.
 *
 * Safe to call on every mount: `ExerciseRepo.seed` upserts by slug, so
 * re-running after an app update refreshes the library without duplicating
 * anything or clobbering the user's own additions. The in-flight promise is
 * memoised so two components mounting together do not seed twice.
 *
 * @returns how many rows were inserted vs. updated
 * @throws {import('@/lib/db/repos').VaultLockedError} when the vault is locked
 */
export function seedExerciseLibrary(): Promise<{ created: number; updated: number }> {
  if (seeding) return seeding;
  seeding = (async () => {
    const existing = await exercises.count();
    if (existing >= EXERCISE_LIBRARY.length) return { created: 0, updated: 0 };
    return exercises.seed(EXERCISE_LIBRARY.map(toVaultExercise));
  })().finally(() => {
    seeding = null;
  });
  return seeding;
}

/**
 * Resolve a library slug to its vault row, seeding the library if it is missing.
 *
 * @param slug the movement
 * @returns the vault record, or `null` when the slug is unknown everywhere
 */
export async function exerciseForSlug(slug: string): Promise<Exercise | null> {
  const found = await exercises.getBySlug(slug);
  if (found) return found;
  const entry = exerciseBySlug(slug);
  if (!entry) return null;
  await seedExerciseLibrary();
  return exercises.getBySlug(slug);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Open a session, or return the one already in progress.
 *
 * Reusing an open session matters on a phone: the app is backgrounded between
 * every set, and a cold start mid-workout must land back in the same session
 * rather than starting a second one.
 *
 * @param options.title an optional name for the session
 * @param options.at the moment it started. Defaults to now.
 * @returns the open session
 */
export async function startOrResumeSession(
  options: { title?: string | null; at?: Date } = {},
): Promise<WorkoutSession> {
  const open = await workoutSessions.getOpen();
  if (open) return open;
  const at = options.at ?? new Date();
  return workoutSessions.create({
    source: 'manual',
    sourceKey: null,
    dateKey: toDateKey(at),
    startedAt: at.getTime(),
    endedAt: null,
    mesocycleId: null,
    dayIndex: null,
    kind: 'self',
    title: options.title ?? null,
    sessionRpe: null,
    note: null,
    coachName: null,
    trainerReport: null,
  });
}

/**
 * Close a session.
 *
 * @param sessionId the session
 * @param options.sessionRpe overall session RPE, 1–10
 * @param options.note free text
 * @returns the closed session, or `null` when the id is unknown
 */
export async function finishSession(
  sessionId: string,
  options: { sessionRpe?: number | null; note?: string | null } = {},
): Promise<WorkoutSession | null> {
  return workoutSessions.update(sessionId, {
    endedAt: Date.now(),
    ...(options.sessionRpe !== undefined ? { sessionRpe: options.sessionRpe } : {}),
    ...(options.note !== undefined ? { note: options.note } : {}),
  });
}

/**
 * Discard a session and every set in it.
 *
 * Soft deletes throughout, so an accidental discard is recoverable and a backup
 * re-import cannot resurrect it.
 *
 * @param sessionId the session to discard
 */
export async function discardSession(sessionId: string): Promise<void> {
  await workoutSets.softDeleteForSession(sessionId);
  await workoutSessions.softDelete(sessionId);
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

/** Everything needed to write one set. */
export interface LogSetInput {
  sessionId: string;
  exerciseId: string;
  /** From the library. Determines which fields carry the number. */
  repUnit: RepUnit;
  /** Reps, seconds, metres or steps — in `repUnit`. */
  unitValue: number;
  /** Kilograms. Storage is always SI; the UI converts at the boundary. */
  weightKg: number;
  /** Reps in reserve, or `null` when not recorded. */
  rir: number | null;
  warmup?: boolean;
  rom?: RomEntry | null;
  restSeconds?: number | null;
  note?: string | null;
}

/**
 * Epley epoch-1RM, cached on the row so PR detection needs no recomputation.
 *
 * Only meaningful for loaded rep work: a 40-second plank and a 50-metre sled
 * drag have no 1RM, and inventing one would corrupt the PR table.
 *
 * @param weightKg the load
 * @param reps repetitions performed
 * @returns the estimate in kilograms, or `null` when it does not apply
 */
export function estimate1rm(weightKg: number, reps: number): number | null {
  if (weightKg <= 0 || reps <= 0 || reps > 15) return null;
  return weightKg * (1 + reps / 30);
}

/**
 * Write one performed set.
 *
 * The magnitude is stored as a tagged union, so the unit travels with the
 * number and there is no mirroring to get wrong. An e1RM is cached only for
 * loaded rep work — a 40-second plank and a 50-metre sled drag have no 1RM.
 *
 * @param input the set
 * @returns the stored set
 */
export async function logSet(input: LogSetInput): Promise<LoggedSet> {
  const existing = await workoutSets.getForSession(input.sessionId);
  const magnitude = setMagnitude(input.repUnit, input.unitValue);

  const record = await workoutSets.create({
    source: 'manual',
    sourceKey: null,
    sessionId: input.sessionId,
    exerciseId: input.exerciseId,
    order: existing.length,
    weightKg: input.weightKg,
    magnitude,
    effortKind: input.rir === null ? 'none' : 'rir',
    effort: input.rir,
    warmup: input.warmup ?? false,
    technique: 'straight',
    restSeconds: input.restSeconds ?? null,
    rom: input.rom ?? null,
    note: input.note ?? null,
    estimated1rmKg:
      magnitude.repUnit === 'reps' ? estimate1rm(input.weightKg, magnitude.reps) : null,
  });

  return readSetExtras(record);
}

/**
 * Every set in a session, in logging order, with the logger's fields resolved.
 *
 * @param sessionId the session
 * @returns the sets
 */
export async function setsForSession(sessionId: string): Promise<LoggedSet[]> {
  return (await workoutSets.getForSession(sessionId)).map(readSetExtras);
}

/** Remove a set. Soft delete, so it can be undone. */
export async function deleteSet(setId: string): Promise<void> {
  await workoutSets.softDelete(setId);
}

/** What this movement looked like the last time it was trained. */
export interface LastPerformance {
  sessionId: string;
  dateKey: DateKey;
  sets: LoggedSet[];
  /** The heaviest working set of that session, for the one-line summary. */
  topSet: LoggedSet | null;
}

/**
 * The previous session's numbers for a movement.
 *
 * This is the single most-read piece of information in a workout logger —
 * people program against what they did last time, not against a plan. It
 * excludes the session currently open, because "last time" means last time.
 *
 * @param exerciseId the movement
 * @param options.excludeSessionId the session in progress
 * @returns the previous session's work, or `null` on a first-ever exposure
 */
export async function lastPerformance(
  exerciseId: string,
  options: { excludeSessionId?: string } = {},
): Promise<LastPerformance | null> {
  const history = await workoutSets.getForExercise(exerciseId, 200);
  const candidates = history.filter(
    (s) => s.sessionId !== options.excludeSessionId && !s.warmup,
  );
  if (candidates.length === 0) return null;

  const sessionId = candidates[0].sessionId;
  const sets = candidates
    .filter((s) => s.sessionId === sessionId)
    .sort((a, b) => a.order - b.order)
    .map(readSetExtras);

  const session = await workoutSessions.get(sessionId);
  const topSet = sets.reduce<LoggedSet | null>(
    (best, s) => (best === null || s.weightKg > best.weightKg ? s : best),
    null,
  );

  return {
    sessionId,
    dateKey: session?.dateKey ?? toDateKey(new Date(sets[0].createdAt)),
    sets,
    topSet,
  };
}

// ---------------------------------------------------------------------------
// Personal records
// ---------------------------------------------------------------------------

/**
 * Detect and record any personal record the given set just set.
 *
 * Only `e1rm` and `max_reps` are detected here. Volume and weight-for-reps PRs
 * are session-level derivations and belong to the weekly review, not to the
 * hot path between sets.
 *
 * **No celebration is attached to a set count.** A PR is a fact worth showing;
 * it is not a reward for doing more work, and nothing in this app pays out for
 * volume for its own sake.
 *
 * @param set the set just logged
 * @returns any newly created records
 */
export async function detectPersonalRecords(set: LoggedSet): Promise<PersonalRecord[]> {
  if (set.warmup || set.repUnit !== 'reps') return [];
  const created: PersonalRecord[] = [];
  const bests = await personalRecords.currentBests(set.exerciseId);

  const e1rm = set.estimated1rmKg;
  if (e1rm !== null && e1rm > (bests.e1rm?.value ?? 0)) {
    created.push(
      await personalRecords.create({
        source: 'derived',
        sourceKey: null,
        exerciseId: set.exerciseId,
        kind: 'e1rm',
        dateKey: toDateKey(new Date(set.createdAt)),
        setId: set.id,
        weightKg: set.weightKg,
        reps: set.unitValue,
        value: e1rm,
        previousValue: bests.e1rm?.value ?? null,
      }),
    );
  }

  if (set.weightKg === 0 && set.unitValue > (bests.max_reps?.value ?? 0)) {
    created.push(
      await personalRecords.create({
        source: 'derived',
        sourceKey: null,
        exerciseId: set.exerciseId,
        kind: 'max_reps',
        dateKey: toDateKey(new Date(set.createdAt)),
        setId: set.id,
        weightKg: 0,
        reps: set.unitValue,
        value: set.unitValue,
        previousValue: bests.max_reps?.value ?? null,
      }),
    );
  }

  return created;
}

// ---------------------------------------------------------------------------
// Trainer sessions
// ---------------------------------------------------------------------------

/** What the confirmation screen submits. */
export interface TrainerSessionInput {
  /** Which day it happened. Defaults to today. */
  dateKey?: DateKey;
  durationMin: number;
  regionEffort: TrainerSessionReport['regionEffort'];
  hardSetsTotal: number | null;
  /** Session RPE, 1–10 — "how hard was that, overall?" */
  perceivedEffort: number | null;
  perceivedRir: number | null;
  sledMeters: number | null;
  exerciseNames: string[];
  note: string | null;
  coachName: string | null;
  /** True when the user reviewed the derived estimate. */
  confirmed: boolean;
}

/**
 * Record a session the trainer ran.
 *
 * The app cannot program these days; it can only observe them. So this is a
 * post-hoc capture, and it is written as a normal `WorkoutSession` with
 * `kind: 'personal_trainer'` plus the report and the derived estimate. The
 * estimate is what weekly volume budgeting subtracts — see
 * {@link weeklyVolume}.
 *
 * @param input the report
 * @param options.prior the current per-muscle prior, when one has been learned
 * @returns the stored session
 */
export async function logTrainerSession(
  input: TrainerSessionInput,
  options: { prior?: TrainerSessionReport['estimate'] } = {},
): Promise<WorkoutSession> {
  const at = new Date();
  const report: TrainerSessionReport = {
    durationMin: input.durationMin,
    regionEffort: input.regionEffort,
    hardSetsTotal: input.hardSetsTotal,
    perceivedRir: input.perceivedRir,
    sledMeters: input.sledMeters,
    exerciseNames: input.exerciseNames,
    confirmed: input.confirmed,
    estimate: estimateFromReport(
      {
        regionEffort: input.regionEffort,
        hardSetsTotal: input.hardSetsTotal,
        confirmed: input.confirmed,
      },
      options.prior,
    ),
  };

  const dateKey = input.dateKey ?? toDateKey(at);
  return workoutSessions.create({
    source: 'manual',
    sourceKey: null,
    dateKey,
    startedAt: at.getTime() - input.durationMin * 60_000,
    endedAt: at.getTime(),
    mesocycleId: null,
    dayIndex: null,
    kind: 'personal_trainer',
    title: 'Trainer session',
    sessionRpe: input.perceivedEffort,
    note: input.note,
    coachName: input.coachName,
    trainerReport: report,
  });
}

/**
 * Update a stored trainer session's report — the "confirm or edit afterwards"
 * half of the contract.
 *
 * @param sessionId the session
 * @param report the corrected report
 * @returns the updated session, or `null`
 */
export async function updateTrainerReport(
  sessionId: string,
  report: TrainerSessionReport,
): Promise<WorkoutSession | null> {
  return workoutSessions.update(sessionId, { trainerReport: report });
}

/**
 * The learned trainer workload carried into a later planning week.
 *
 * A calendar week with no reports means “not observed yet”, not “the trainer
 * now does nothing”. This reads the most recent stored reports so confirmed
 * corrections continue to shape future plans until newer evidence replaces
 * them.
 */
export async function learnedTrainerWeek(
  sessionsPerWeek = 3,
): Promise<Partial<Record<Muscle, TrainerWeekLoad>>> {
  if (sessionsPerWeek <= 0) return {};
  const reports = (await workoutSessions.recent(Math.max(12, sessionsPerWeek * 4)))
    .filter((session) => session.kind === 'personal_trainer')
    .map(readTrainerReport)
    .filter((report): report is TrainerSessionReport => report !== null)
    .slice(0, sessionsPerWeek);
  if (reports.length === 0) return {};

  let confidence = SEED_CONFIDENCE;
  for (const report of reports) confidence = updateConfidence(confidence, report.confirmed);
  const trainer: Partial<Record<Muscle, TrainerWeekLoad>> = {};
  for (const muscle of ALL_MUSCLES) {
    const load = trainerLoadFor(reports, muscle, confidence);
    if (load.stimulusMean > 0 || load.stimulusUpperBound > 0) {
      trainer[muscle] = {
        stimulusMean: load.stimulusMean,
        stimulusUpperBound: load.stimulusUpperBound,
        fatigueUpperBound: load.fatigueUpperBound,
      };
    }
  }
  return trainer;
}

// ---------------------------------------------------------------------------
// Weekly picture
// ---------------------------------------------------------------------------

/** A week of training, both ledgers. */
export interface TrainingWeek {
  from: DateKey;
  to: DateKey;
  sessions: WorkoutSession[];
  /** Per-muscle rows, most crowded first. */
  muscles: MuscleWeek[];
  /** How many trainer sessions in the window, and how many were confirmed. */
  trainerSessions: number;
  trainerConfirmed: number;
  /** Current confidence in the trainer estimate. */
  confidence: number;
}

/**
 * Assemble the week: what the app logged, plus what the trainer probably did.
 *
 * **This is where the trainer estimate feeds volume budgeting.** Trainer
 * sessions never contribute `workoutSets` rows — there are none, the app was
 * not in the room — so their contribution enters here as the upper credible
 * bound of the stored estimate, on both the stimulus and the fatigue ledger.
 * A muscle the trainer has already hammered therefore shows as full, and
 * {@link import('./volume').remainingBudget} returns zero for it, which is what
 * stops the app stacking more work on top.
 *
 * @param from inclusive `YYYY-MM-DD`
 * @param to inclusive `YYYY-MM-DD`
 * @returns the week
 */
export async function weeklyVolume(from: DateKey, to: DateKey): Promise<TrainingWeek> {
  const sessions = await workoutSessions.getForRange(from, to);

  const ownSessions = sessions.filter((s) => s.kind !== 'personal_trainer');
  const allSets: (WorkoutSet & { slug?: string })[] = [];
  for (const session of ownSessions) {
    allSets.push(...(await workoutSets.getForSession(session.id)));
  }

  // Resolve exercise ids to slugs once, then to library entries.
  const ids = [...new Set(allSets.map((s) => s.exerciseId))];
  const rows = await exercises.getMany(ids);
  const slugById = new Map(rows.map((r) => [r.id, r.slug]));
  const libraryBySlug = new Map(EXERCISE_LIBRARY.map((e) => [e.slug, e]));

  const logged = loggedSetsByMuscle(
    allSets,
    libraryBySlug,
    (set) => slugById.get(set.exerciseId) ?? null,
  );

  const reports = sessions
    .filter((s) => s.kind === 'personal_trainer')
    .map(readTrainerReport)
    .filter((r): r is TrainerSessionReport => r !== null);

  const confirmed = reports.filter((r) => r.confirmed).length;
  let confidence = SEED_CONFIDENCE;
  for (const report of reports) confidence = updateConfidence(confidence, report.confirmed);

  const trainer: Partial<Record<Muscle, TrainerWeekLoad>> = {};
  for (const muscle of ALL_MUSCLES) {
    const load = trainerLoadFor(reports, muscle, confidence);
    if (load.stimulusMean > 0 || load.stimulusUpperBound > 0) {
      trainer[muscle] = {
        stimulusMean: load.stimulusMean,
        stimulusUpperBound: load.stimulusUpperBound,
        fatigueUpperBound: load.fatigueUpperBound,
      };
    }
  }

  return {
    from,
    to,
    sessions,
    muscles: buildWeek(logged, trainer),
    trainerSessions: reports.length,
    trainerConfirmed: confirmed,
    confidence,
  };
}
