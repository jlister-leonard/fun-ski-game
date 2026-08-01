/**
 * @file Writing a generated plan into the vault.
 *
 * The generator in `@/lib/training/program` is pure and stays that way. This is
 * the only file in the planner that touches storage, and it goes through
 * `@/lib/db/repos` like everything else — never the codec, never the crypto.
 *
 * Two records get written, matching the vault schema's own split:
 *
 * - a **`Program`**, the reusable shape of the week; and
 * - a **`Mesocycle`**, one scheduled block instantiated from it.
 *
 * Trainer days are deliberately *not* written as program days. The app does not
 * prescribe them and must not produce a record that implies it did.
 */

import { mesocycles, programs, toDateKey, workoutSessions, workoutSets } from '@/lib/db/repos';
import { magnitudeValue, type Mesocycle, type Muscle, type Program } from '@/lib/db/types';
import {
  ALWAYS_SATISFIED_TAGS,
  itemsSatisfying,
  LIBRARY_EQUIPMENT_TAGS,
  type LibraryEquipmentTag,
} from '@/lib/gyms/equipment';
import type { GymProfile } from '@/lib/gyms/profiles';
import { checkRequirement, requirementFor } from '@/lib/gyms/requirements';
import {
  estimatePace,
  type PaceSample,
  type SessionPace,
  type WeekPlan,
} from '@/lib/training/program';

/** Turn the app-owned days of a plan into the vault's program-day shape. */
function toProgramDays(plan: WeekPlan): Program['days'] {
  return plan.days
    .filter((day) => day.owner === 'app')
    .map((day) => ({
      label: day.label,
      slots: day.items.map((item) => ({
        exerciseSlug: item.slug,
        sets: item.sets,
        repMin: item.repMin,
        repMax: item.repMax,
        // Conditioning and mobility carry no RIR target; the schema wants a
        // number, so the deload RIR stands in as "not near failure".
        targetRir: item.targetRir ?? plan.config.deloadRir,
        restSeconds: item.restSeconds,
      })),
    }));
}

/** Week-1 weekly sets per muscle — what the block starts from. */
function startingSets(plan: WeekPlan): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const budget of plan.budgets) {
    if (budget.sets > 0) out[budget.muscle] = budget.sets;
  }
  return out;
}

/** What {@link startMesocycle} wrote. */
export interface StartedBlock {
  program: Program;
  mesocycle: Mesocycle;
}

/**
 * Save a plan and start the block.
 *
 * @param plan the generated week — normally week 1
 * @param options.name what to call the block
 * @param options.startDate the first day. Defaults to today.
 * @returns the stored program and mesocycle
 * @throws {import('@/lib/db/repos').VaultLockedError} when the vault is locked
 */
export async function startMesocycle(
  plan: WeekPlan,
  options: { name?: string; startDate?: Date } = {},
): Promise<StartedBlock> {
  const name = options.name ?? 'Around your trainer';
  const startDateKey = toDateKey(options.startDate ?? new Date());

  const program = await programs.create({
    source: 'derived',
    sourceKey: null,
    name,
    description:
      'Generated around the trainer days the app does not program. Weekly volume is ' +
      "budgeted against an upper bound on the trainer's work, so the muscles they already " +
      'cover get nothing here — by design.',
    daysPerWeek: plan.days.filter((d) => d.owner === 'app').length,
    days: toProgramDays(plan),
    landmarks: Object.fromEntries(
      plan.budgets.map((budget) => [budget.muscle, budget.landmarks]),
    ) as Program['landmarks'],
    userCreated: false,
  });

  const mesocycle = await mesocycles.create({
    source: 'derived',
    sourceKey: null,
    programId: program.id,
    name,
    startDateKey,
    accumulationWeeks: plan.config.accumulationWeeks,
    deloadWeek: plan.config.deloadWeeks > 0,
    startingRir: plan.config.rirRamp[0] ?? plan.targetRir,
    startingSetsPerMuscle: startingSets(plan),
    status: 'active',
    endDateKey: null,
    note: null,
  });

  return { program, mesocycle };
}

/**
 * Stop the current block without pretending it finished.
 *
 * @param mesocycleId the block
 * @param status why it stopped
 * @returns the updated record, or `null`
 */
export async function endMesocycle(
  mesocycleId: string,
  status: 'completed' | 'abandoned',
): Promise<Mesocycle | null> {
  return mesocycles.update(mesocycleId, {
    status,
    endDateKey: toDateKey(new Date()),
  });
}

// ---------------------------------------------------------------------------
// Learning the athlete's real pace
// ---------------------------------------------------------------------------

/** How many recent sessions the pace estimate reads. */
const PACE_SESSIONS = 8;

/**
 * What the athlete's sessions actually cost, from the sessions they did.
 *
 * The plan is fitted to a clock, so the clock has to be real. Prescribed rest
 * and taken rest are different numbers and the gap compounds: a session built
 * on a theoretical 90 seconds when someone genuinely takes 140 overruns by ten
 * minutes and then gets trimmed for a reason that was never true.
 *
 * Elapsed time comes from the session's own start and end; rest comes from the
 * `restSeconds` the logger records per set. Trainer sessions are excluded —
 * the app was not in the room and has no set-level data for them.
 *
 * @returns the pace estimate, or the population prior when there is nothing yet
 * @throws {import('@/lib/db/repos').VaultLockedError} when the vault is locked
 */
export async function observedPace(): Promise<SessionPace> {
  const sessions = (await workoutSessions.recent(PACE_SESSIONS * 2))
    .filter((s) => s.kind !== 'personal_trainer' && s.endedAt !== null)
    .slice(0, PACE_SESSIONS);

  const samples: PaceSample[] = [];
  for (const session of sessions) {
    const sets = (await workoutSets.getForSession(session.id)).filter((s) => !s.warmup);
    if (sets.length < 2 || session.endedAt === null) continue;

    let reps = 0;
    let timedSeconds = 0;
    let actualRestSeconds = 0;
    for (const set of sets) {
      const value = magnitudeValue(set.magnitude);
      if (set.magnitude.repUnit === 'reps') reps += value;
      else if (set.magnitude.repUnit === 'seconds') timedSeconds += value;
      actualRestSeconds += set.restSeconds ?? 0;
    }

    samples.push({
      elapsedSeconds: Math.max(0, (session.endedAt - session.startedAt) / 1000),
      sets: sets.length,
      reps,
      timedSeconds,
      actualRestSeconds,
    });
  }

  return estimatePace(samples);
}

// ---------------------------------------------------------------------------
// Filtering by the gym the athlete is actually at
// ---------------------------------------------------------------------------

/**
 * A per-slug availability predicate backed by a gym profile.
 *
 * This is the seam between the planner and `@/lib/gyms`. Generation asks "can
 * they do this movement, here?" rather than assuming a full commercial gym, and
 * the answer comes from the equipment model's own requirement resolver — which
 * knows that `assisted-pull-up` needs *a machine, or a bar and a band*, not all
 * three, and that a gym with a leg press does not thereby own a hack squat.
 *
 * @param profile the active gym, or `null` for "assume nothing is missing"
 * @returns a predicate for {@link import('@/lib/training/program').GenerateOptions.canPerform}
 */
export function gymAvailability(
  profile: GymProfile | null,
): ((slug: string) => boolean) | undefined {
  if (profile === null) return undefined;

  const owned = new Set(profile.items.map((s) => s.id));
  const tags = new Set<LibraryEquipmentTag>(ALWAYS_SATISFIED_TAGS);
  for (const tag of LIBRARY_EQUIPMENT_TAGS) {
    if (itemsSatisfying(tag).some((item) => owned.has(item.id))) tags.add(tag);
  }

  return (slug: string): boolean => {
    const requirement = requirementFor(slug);
    // A movement the equipment model has never heard of is not something to
    // silently delete — fall through to available and let the user drop it.
    if (requirement === null) return true;
    return checkRequirement(
      requirement,
      (tag) => tags.has(tag),
      (id) => owned.has(id),
    ).ok;
  };
}
