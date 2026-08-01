'use client';

/**
 * @file The weekly review's live binding to the vault.
 *
 * One Dexie live query covers every table the screen reads, so logging a
 * workout or a meal re-runs the review without the screen knowing that it did.
 *
 * The `useSyncExternalStore` shape and the `Promise.all` inside the querier
 * both follow `@/components/recovery/useRecovery`, and the second one is not a
 * micro-optimisation: Dexie's `liveQuery` can only record which tables a query
 * touched for reads issued inside its observability zone, and every repository
 * read here decrypts its rows. The first `await` leaves the zone, so awaiting
 * in sequence would leave every table after the first unobserved and the screen
 * would silently show yesterday's answer until a reload.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { reviewWeek, type CoachInsight, type CoachReview } from '@/lib/algorithms';
import {
  activities as activityRepo,
  exercises as exerciseRepo,
  foodLogs,
  goals as goalRepo,
  insights as insightRepo,
  profiles,
  readiness as readinessRepo,
  subscribeQuery,
  toDateKey,
  weights,
  workoutSessions,
  workoutSets,
} from '@/lib/db/repos';
import { PROFILE_ID, type Exercise, type Muscle } from '@/lib/db/types';
import {
  HISTORY_DAYS,
  buildReview,
  shiftDateKey,
  weekKeys,
  type ReviewBuild,
  type ReviewSnapshot,
} from './model';
import {
  memoryForRule,
  persistCoachInsights,
  toStoredInsight,
  type InsightMemory,
} from './memory';

export type ReviewStatus = 'loading' | 'ready' | 'unavailable';

export interface ReviewState {
  status: ReviewStatus;
  snapshot: ReviewSnapshot | null;
}

const LOADING: ReviewState = Object.freeze({ status: 'loading', snapshot: null });

/**
 * Read every table the review needs, in one query.
 *
 * @param weekEndingDate the last day of the week under review
 */
async function readSnapshot(weekEndingDate: string): Promise<ReviewSnapshot> {
  const historyFrom = shiftDateKey(weekEndingDate, -(HISTORY_DAYS - 1));
  const keys = weekKeys(weekEndingDate);
  const weekFrom = keys[0];

  const [
    profile,
    goal,
    weightSeries,
    weightEntries,
    intakeSeries,
    weekFoodLogs,
    sessions,
    activities,
    zoneMinutes,
    readinessRows,
    insightHistory,
  ] = await Promise.all([
    profiles.get(PROFILE_ID),
    goalRepo.getActive(),
    weights.getSeries(historyFrom, weekEndingDate),
    weights.listByDateRange(historyFrom, weekEndingDate),
    foodLogs.getDailyIntakeSeries(historyFrom, weekEndingDate),
    foodLogs.getForRange(weekFrom, weekEndingDate),
    workoutSessions.getForRange(weekFrom, weekEndingDate),
    activityRepo.getForRange(weekFrom, weekEndingDate),
    activityRepo.zoneMinutes(weekFrom, weekEndingDate),
    readinessRepo.listByDateRange(weekFrom, weekEndingDate),
    // Range through the current review only: future-dated rows cannot be
    // history, and the date index avoids decrypting them needlessly.
    insightRepo.listByDateRange('0000-01-01', weekEndingDate),
  ]);

  // Sets need the sessions first, so this second round-trip is unavoidable.
  // It reads two already-observed tables, so the subscription is unaffected.
  const ownSessionIds = sessions.filter((s) => s.kind === 'self').map((s) => s.id);
  const exerciseRows: Exercise[] = ownSessionIds.length > 0 ? await exerciseRepo.listAll() : [];
  const exercisesById = new Map(exerciseRows.map((e) => [e.id, e]));
  const appSetsByMuscle: Partial<Record<Muscle, number>> =
    ownSessionIds.length > 0
      ? await workoutSets.hardSetsByMuscle(ownSessionIds, exercisesById)
      : {};

  return {
    weekEndingDate,
    profile,
    goal,
    weights: weightSeries,
    intakeSeries,
    weekFoodLogs,
    // The most recent smart-scale body-fat reading, or `null`. The review never
    // estimates one: a guessed body-fat percentage drives the whole projection,
    // and a projection built on a guess reads exactly like one built on a
    // measurement.
    bodyFatPct: latestBodyFatPct(weightEntries),
    sessions,
    exercisesById,
    appSetsByMuscle,
    activities,
    zoneMinutes,
    readiness: readinessRows,
    insightHistory,
  };
}

/** The most recent non-null body-fat reading in a set of weigh-ins. */
function latestBodyFatPct(entries: readonly { dateKey: string; bodyFatPct: number | null }[]): number | null {
  let best: { dateKey: string; pct: number } | null = null;
  for (const e of entries) {
    if (e.bodyFatPct === null) continue;
    if (!best || e.dateKey > best.dateKey) best = { dateKey: e.dateKey, pct: e.bodyFatPct };
  }
  return best?.pct ?? null;
}

interface Entry {
  state: ReviewState;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}

const registry = new Map<string, Entry>();

function publish(key: string, next: ReviewState): void {
  const entry = registry.get(key);
  if (!entry) return;
  entry.state = next;
  for (const listener of entry.listeners) listener();
}

function subscribeWeek(weekEndingDate: string, listener: () => void): () => void {
  let entry = registry.get(weekEndingDate);
  if (!entry) {
    entry = { state: LOADING, listeners: new Set(), stop: null };
    registry.set(weekEndingDate, entry);
  }
  entry.listeners.add(listener);

  if (!entry.stop) {
    entry.stop = subscribeQuery(
      () => readSnapshot(weekEndingDate),
      (snapshot) => publish(weekEndingDate, { status: 'ready', snapshot }),
      // A locked vault is an expected state: the gate is showing the lock
      // screen and this component remounts after unlock.
      () => publish(weekEndingDate, { status: 'unavailable', snapshot: null }),
    );
  }

  return () => {
    const current = registry.get(weekEndingDate);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.stop?.();
      registry.delete(weekEndingDate);
    }
  };
}

export interface ReviewBinding {
  status: ReviewStatus;
  weekEndingDate: string;
  snapshot: ReviewSnapshot | null;
  build: ReviewBuild | null;
  review: CoachReview | null;
  /** Stored state and verified repeat history, keyed by stable rule id. */
  memory: ReadonlyMap<string, InsightMemory>;
  markActedOn: (insight: CoachInsight) => Promise<void>;
  dismiss: (insight: CoachInsight) => Promise<void>;
  memoryWriteFailed: boolean;
}

/**
 * Subscribe to this week's review.
 *
 * @returns the coach's ranked output, the assembled input behind it, and the
 *   raw snapshot. `review` is `null` when the profile is too incomplete for any
 *   energy calculation to mean anything — the screen renders an honest prompt
 *   for the missing fields rather than a review of guessed numbers.
 */
export function useReview(): ReviewBinding {
  // Resolved once per mount, like `useWeightSeries`: recomputing per render
  // would rebuild the key at midnight mid-session and drop the subscription.
  const weekEndingDate = useMemo(() => toDateKey(new Date()), []);

  const state = useSyncExternalStore(
    useMemo(
      () => (listener: () => void) => subscribeWeek(weekEndingDate, listener),
      [weekEndingDate],
    ),
    () => registry.get(weekEndingDate)?.state ?? LOADING,
    () => LOADING,
  );

  const build = useMemo(
    () => (state.snapshot ? buildReview(state.snapshot) : null),
    [state.snapshot],
  );
  const review = useMemo(() => (build ? reviewWeek(build.input) : null), [build]);
  const [memoryWriteFailed, setMemoryWriteFailed] = useState(false);

  // Persist after the pure review is computed. InsightRepo's idempotent upsert
  // returns without writing when output is unchanged, preventing a live-query
  // feedback loop while still refreshing genuinely changed recommendations.
  useEffect(() => {
    if (!review) return;
    let current = true;
    void persistCoachInsights(insightRepo, weekEndingDate, review.insights)
      .then(() => {
        if (current) setMemoryWriteFailed(false);
      })
      .catch(() => {
        if (current) setMemoryWriteFailed(true);
      });
    return () => {
      current = false;
    };
  }, [review, weekEndingDate]);

  const memory = useMemo(() => {
    const history = state.snapshot?.insightHistory ?? [];
    const result = new Map<string, InsightMemory>();
    for (const insight of review?.insights ?? []) {
      result.set(insight.id, memoryForRule(insight.id, weekEndingDate, history));
    }
    return result;
  }, [review?.insights, state.snapshot?.insightHistory, weekEndingDate]);

  const ensureCurrent = useCallback(async (insight: CoachInsight) => {
    return insightRepo.upsertRuleOutput(
      insight.id,
      weekEndingDate,
      // Use the same adapter as background persistence so an immediate tap on
      // first paint cannot race the initial write.
      toStoredInsight(insight, weekEndingDate),
    );
  }, [weekEndingDate]);

  const markActedOn = useCallback(async (insight: CoachInsight) => {
    const stored = await ensureCurrent(insight);
    await insightRepo.acknowledge(stored.id);
  }, [ensureCurrent]);

  const dismiss = useCallback(async (insight: CoachInsight) => {
    const stored = await ensureCurrent(insight);
    await insightRepo.dismiss(stored.id);
  }, [ensureCurrent]);

  return {
    status: state.status,
    weekEndingDate,
    snapshot: state.snapshot,
    build,
    review,
    memory,
    markActedOn,
    dismiss,
    memoryWriteFailed,
  };
}
