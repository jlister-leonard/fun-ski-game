/**
 * @file Training repositories: exercises, programs, mesocycles, sessions,
 * sets and personal records.
 */

import type {
  DateKey,
  Exercise,
  Mesocycle,
  Muscle,
  PersonalRecord,
  Program,
  WorkoutSession,
  WorkoutSet,
} from '../types';
import { Repo, type NewRecord } from './base';

/** The exercise library. Seeded from `exercise-library.json`, user-extendable. */
export class ExerciseRepo extends Repo<Exercise> {
  constructor() {
    super('exercises');
  }

  /**
   * Look up an exercise by its stable slug.
   *
   * Program templates reference exercises by slug, so this is the join every
   * planner query makes. The slug is stored as a blind index, never in the
   * clear — see `vault-schema.md` §4.3.
   *
   * @param slug e.g. `barbell-bench-press`
   * @returns the exercise, or `null`
   */
  async getBySlug(slug: string): Promise<Exercise | null> {
    return this.findBySourceKey(slug);
  }

  /**
   * Resolve many slugs at once.
   *
   * @param slugs the slugs to resolve
   * @returns a map from slug to exercise, omitting misses
   */
  async getBySlugs(slugs: readonly string[]): Promise<Map<string, Exercise>> {
    const out = new Map<string, Exercise>();
    for (const slug of slugs) {
      const ex = await this.getBySlug(slug);
      if (ex) out.set(slug, ex);
    }
    return out;
  }

  /**
   * Every exercise that trains a muscle, primaries first.
   *
   * @param muscle one of the frozen 22 values
   * @returns matching exercises, primary movers before secondary
   */
  async forMuscle(muscle: Muscle): Promise<Exercise[]> {
    const all = await this.listAll();
    const primary = all.filter((e) => e.primaryMuscles.includes(muscle));
    const secondary = all.filter(
      (e) => !e.primaryMuscles.includes(muscle) && e.secondaryMuscles.includes(muscle),
    );
    return [...primary.sort((a, b) => (b.sfr ?? 0) - (a.sfr ?? 0)), ...secondary];
  }

  /**
   * Substring search over exercise names.
   *
   * In-memory, because names are inside the ciphertext. The library is ~200
   * rows, which decrypts in single-digit milliseconds.
   *
   * @param query free text
   * @param limit maximum results. Default 25.
   */
  async search(query: string, limit = 25): Promise<Exercise[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all = await this.listAll();
    return all
      .filter((e) => e.name.toLowerCase().includes(q) || e.slug.includes(q))
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, limit);
  }

  /**
   * Insert or update seed-library exercises idempotently.
   *
   * Re-running the seeder after an app update refreshes the library without
   * duplicating anything or clobbering the user's own additions.
   *
   * @param items the library entries
   * @returns how many were inserted vs. updated
   */
  async seed(items: readonly NewRecord<Exercise>[]): Promise<{ created: number; updated: number }> {
    const result = await this.bulkUpsertBySourceKey(
      items.map((input) => ({ sourceKey: input.slug, input })),
    );
    return { created: result.created, updated: result.updated };
  }
}

/** Program templates. */
export class ProgramRepo extends Repo<Program> {
  constructor() {
    super('programs');
  }

  /**
   * All programs, most recently touched first.
   *
   * @returns the programs
   */
  async list(): Promise<Program[]> {
    return this.listAll({ reverse: true });
  }
}

/** Scheduled training blocks. */
export class MesocycleRepo extends Repo<Mesocycle> {
  constructor() {
    super('mesocycles');
  }

  /**
   * The block currently being run.
   *
   * @returns the active mesocycle, or `null`
   */
  async getActive(): Promise<Mesocycle | null> {
    const all = await this.listAll({ reverse: true });
    return all.find((m) => m.status === 'active') ?? null;
  }

  /**
   * Every block built from a given program.
   *
   * Served by the plaintext `programId` index — a UUID, which reveals
   * structure but no content.
   *
   * @param programId the program's id
   * @returns the blocks, newest first
   */
  async forProgram(programId: string): Promise<Mesocycle[]> {
    const rows = await this.rows().where('programId').equals(programId).toArray();
    const records = await this.decode(rows.filter((r) => r.deleted === 0));
    return records.sort((a, b) => (a.startDateKey < b.startDateKey ? 1 : -1));
  }

  /**
   * Which week of the block a date falls in, 1-based.
   *
   * @param mesocycle the block
   * @param dateKey the day in question
   * @returns the week number, or `null` when the date is outside the block
   */
  weekIndexFor(mesocycle: Mesocycle, dateKey: DateKey): number | null {
    const start = Date.parse(`${mesocycle.startDateKey}T00:00:00Z`);
    const day = Date.parse(`${dateKey}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(day) || day < start) return null;
    const week = Math.floor((day - start) / (7 * 86_400_000)) + 1;
    const total = mesocycle.accumulationWeeks + (mesocycle.deloadWeek ? 1 : 0);
    return week > total ? null : week;
  }
}

/** Workouts. */
export class WorkoutSessionRepo extends Repo<WorkoutSession> {
  constructor() {
    super('workoutSessions');
  }

  /**
   * Every session in a training block, chronological.
   *
   * @param mesocycleId the block's id
   * @returns the sessions, earliest first
   */
  async getForMesocycle(mesocycleId: string): Promise<WorkoutSession[]> {
    const rows = await this.rows().where('mesocycleId').equals(mesocycleId).toArray();
    const records = await this.decode(rows.filter((r) => r.deleted === 0));
    return records.sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Sessions on one day.
   *
   * @param dateKey `YYYY-MM-DD`
   */
  async getForDate(dateKey: DateKey): Promise<WorkoutSession[]> {
    return (await this.listByDate(dateKey)).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Sessions in a date range, chronological.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   */
  async getForRange(from: DateKey, to: DateKey): Promise<WorkoutSession[]> {
    return (await this.listByDateRange(from, to)).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * The session still in progress, if any.
   *
   * @returns the open session, or `null`
   */
  async getOpen(): Promise<WorkoutSession | null> {
    const recent = await this.listAll({ reverse: true, limit: 20 });
    return recent.find((s) => s.endedAt === null) ?? null;
  }

  /**
   * The most recent completed sessions.
   *
   * @param limit maximum results. Default 10.
   */
  async recent(limit = 10): Promise<WorkoutSession[]> {
    const rows = await this.listAll({ reverse: true, limit: limit * 2 });
    return rows.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }
}

/** Performed sets. The highest-cardinality table in the vault. */
export class WorkoutSetRepo extends Repo<WorkoutSet> {
  constructor() {
    super('workoutSets');
  }

  /**
   * Every set in a session, in logging order.
   *
   * Served by the `[deleted+sessionId]` compound index, so a session with 40
   * sets decrypts 40 rows and not the whole table.
   *
   * @param sessionId the session's id
   * @returns the sets, ordered by `order`
   */
  async getForSession(sessionId: string): Promise<WorkoutSet[]> {
    const rows = await this.rows().where('[deleted+sessionId]').equals([0, sessionId]).toArray();
    const records = await this.decode(rows);
    return records.sort((a, b) => a.order - b.order);
  }

  /**
   * Recent history for one movement — the "what did I lift last time" query.
   *
   * @param exerciseId the exercise's id
   * @param limit maximum sets. Default 100.
   * @returns the sets, most recent first
   */
  async getForExercise(exerciseId: string, limit = 100): Promise<WorkoutSet[]> {
    const rows = await this.rows().where('[deleted+exerciseId]').equals([0, exerciseId]).toArray();
    const records = await this.decode(rows);
    return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /**
   * Weekly hard-set counts per muscle — the input to the volume-landmark
   * comparison in `training-methodology.md` §2.
   *
   * Counts working sets only. Warm-ups are excluded, per §2.3. A set counts
   * fully toward every primary muscle and at half toward every secondary, which
   * is the convention the spec's set-counting rules describe.
   *
   * @param sessionIds the sessions to count over — typically one training week
   * @param exercisesById the exercise records those sets reference
   * @returns a sparse map of muscle → hard sets
   */
  async hardSetsByMuscle(
    sessionIds: readonly string[],
    exercisesById: ReadonlyMap<string, Exercise>,
  ): Promise<Partial<Record<Muscle, number>>> {
    const out: Partial<Record<Muscle, number>> = {};
    for (const sessionId of sessionIds) {
      for (const set of await this.getForSession(sessionId)) {
        if (set.warmup) continue;
        const exercise = exercisesById.get(set.exerciseId);
        if (!exercise) continue;
        for (const m of exercise.primaryMuscles) out[m] = (out[m] ?? 0) + 1;
        for (const m of exercise.secondaryMuscles) out[m] = (out[m] ?? 0) + 0.5;
      }
    }
    return out;
  }

  /**
   * Delete every set belonging to a session — used when a session is discarded.
   *
   * @param sessionId the session's id
   * @returns how many sets were tombstoned
   */
  async softDeleteForSession(sessionId: string): Promise<number> {
    const sets = await this.getForSession(sessionId);
    for (const s of sets) await this.softDelete(s.id);
    return sets.length;
  }
}

/** Detected personal records. */
export class PersonalRecordRepo extends Repo<PersonalRecord> {
  constructor() {
    super('personalRecords');
  }

  /**
   * Every PR for one movement, newest first.
   *
   * @param exerciseId the exercise's id
   */
  async getForExercise(exerciseId: string): Promise<PersonalRecord[]> {
    const rows = await this.rows().where('[deleted+exerciseId]').equals([0, exerciseId]).toArray();
    const records = await this.decode(rows);
    return records.sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
  }

  /**
   * The current best of each kind, per movement.
   *
   * @param exerciseId the exercise's id
   * @returns a sparse map of PR kind → the record holding it
   */
  async currentBests(exerciseId: string): Promise<Partial<Record<string, PersonalRecord>>> {
    const all = await this.getForExercise(exerciseId);
    const out: Partial<Record<string, PersonalRecord>> = {};
    for (const pr of all) {
      const existing = out[pr.kind];
      if (!existing || pr.value > existing.value) out[pr.kind] = pr;
    }
    return out;
  }

  /**
   * PRs set within a date range — the weekly review's highlight reel.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   */
  async getForRange(from: DateKey, to: DateKey): Promise<PersonalRecord[]> {
    return this.listByDateRange(from, to);
  }
}

/** Exercise-library repository. */
export const exercises = new ExerciseRepo();
/** Program-template repository. */
export const programs = new ProgramRepo();
/** Mesocycle repository. */
export const mesocycles = new MesocycleRepo();
/** Workout-session repository. */
export const workoutSessions = new WorkoutSessionRepo();
/** Performed-set repository. */
export const workoutSets = new WorkoutSetRepo();
/** Personal-record repository. */
export const personalRecords = new PersonalRecordRepo();
