'use client';

/**
 * @file The Recovery screen's live binding to the vault.
 *
 * One Dexie live query covers every table the screen reads — health metrics,
 * sleep, activities and past readiness rows — so saving a check-in re-renders
 * the readiness card without the screen knowing that it did.
 *
 * The `useSyncExternalStore` shape follows `@/lib/hooks/useWeightSeries`: a
 * module-level registry keyed by the day, so `getSnapshot` returns a
 * referentially stable object between emissions.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  activities as activityRepo,
  healthMetrics,
  readiness as readinessRepo,
  sleep as sleepRepo,
  subscribeQuery,
  toDateKey,
} from '@/lib/db/repos';
import { assessReadiness, readinessPercent, type ReadinessAssessment } from '@/lib/algorithms';
import {
  HISTORY_DAYS,
  buildReadinessInput,
  decodeCheckIn,
  encodeCheckIn,
  checkInSourceKey,
  shiftDateKey,
  type ReadinessBuild,
  type RecoveryCheckIn,
  type RecoverySnapshot,
} from './model';

/** Days of activity history the screen lists. */
const ACTIVITY_DAYS = 14;

/**
 * Days of readiness history read for the consecutive-reduction run.
 *
 * §8.5 rule 2 needs only three, but reading a month means the run is counted
 * from real rows rather than from the edge of the window.
 */
const READINESS_HISTORY_DAYS = 30;

export type RecoveryStatus = 'loading' | 'ready' | 'locked' | 'unavailable';

export interface RecoveryState {
  snapshot: RecoverySnapshot | null;
  status: RecoveryStatus;
}

function emptySnapshot(todayKey: string): RecoverySnapshot {
  return {
    todayKey,
    hrv: [],
    rhr: [],
    nights: [],
    activities: [],
    history: [],
    checkIn: null,
  };
}

const LOADING: RecoveryState = Object.freeze({ snapshot: null, status: 'loading' });

/**
 * Read every table the screen needs, in one query.
 *
 * ## Why `Promise.all`, and why it is not a micro-optimisation
 *
 * Dexie's `liveQuery` records which tables a query touched, and it can only do
 * that for reads issued inside its observability zone. Every repository read
 * here decrypts its rows, and `crypto.subtle` resolves on a different task
 * source — so the *first* `await` inside the querier leaves the zone and every
 * read after it is invisible to the tracker.
 *
 * Awaited in sequence, only `healthMetrics` ends up observed: saving a check-in
 * writes to `readinessRecords`, nothing re-runs, and the screen silently shows
 * yesterday's answer until a reload. (Confirmed in a browser, not deduced.)
 *
 * `Promise.all` starts all five reads in the same tick, so all four tables'
 * Dexie queries are registered before any crypto await — and a write from
 * anywhere, this screen or an import, re-runs the whole thing.
 *
 * @param todayKey the local day the screen is showing
 */
async function readSnapshot(todayKey: string): Promise<RecoverySnapshot> {
  const from = shiftDateKey(todayKey, -(HISTORY_DAYS - 1));

  const [hrv, rhr, nights, activities, history] = await Promise.all([
    healthMetrics.getSeries('hrv_sdnn_ms', from, todayKey),
    healthMetrics.getSeries('resting_heart_rate', from, todayKey),
    sleepRepo.listByDateRange(from, todayKey),
    activityRepo.getForRange(shiftDateKey(todayKey, -(ACTIVITY_DAYS - 1)), todayKey),
    readinessRepo.listByDateRange(
      shiftDateKey(todayKey, -(READINESS_HISTORY_DAYS - 1)),
      todayKey,
    ),
  ]);

  const todayRow =
    history.find((r) => r.dateKey === todayKey && r.source === 'derived') ??
    history.find((r) => r.dateKey === todayKey) ??
    null;

  return {
    todayKey,
    hrv,
    rhr,
    nights: [...nights].sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)),
    activities: [...activities].sort((a, b) => b.startedAt - a.startedAt),
    history,
    checkIn: todayRow ? decodeCheckIn(todayRow) : null,
  };
}

interface Entry {
  state: RecoveryState;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}

const registry = new Map<string, Entry>();

function publish(key: string, next: RecoveryState): void {
  const entry = registry.get(key);
  if (!entry) return;
  entry.state = next;
  for (const listener of entry.listeners) listener();
}

function subscribeDay(todayKey: string, listener: () => void): () => void {
  let entry = registry.get(todayKey);
  if (!entry) {
    entry = { state: LOADING, listeners: new Set(), stop: null };
    registry.set(todayKey, entry);
  }
  entry.listeners.add(listener);

  if (!entry.stop) {
    entry.stop = subscribeQuery(
      () => readSnapshot(todayKey),
      (snapshot) => publish(todayKey, { snapshot, status: 'ready' }),
      (error) => {
        // A locked vault is an expected state, not a failure — the gate is
        // showing the lock screen and this screen remounts after unlock.
        const locked = error instanceof Error && error.name === 'VaultLockedError';
        publish(todayKey, {
          snapshot: emptySnapshot(todayKey),
          status: locked ? 'locked' : 'unavailable',
        });
      },
    );
  }

  return () => {
    const current = registry.get(todayKey);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.stop?.();
      registry.delete(todayKey);
    }
  };
}

export interface RecoveryBinding {
  /** The local day being shown, `YYYY-MM-DD`. */
  todayKey: string;
  status: RecoveryStatus;
  /** What is in the vault. `null` until the first emission. */
  snapshot: RecoverySnapshot | null;
  /** The day's check-in, or `null` when it has not been done. */
  checkIn: RecoveryCheckIn | null;
  /** The assembled model input and its working, or `null` with no check-in. */
  build: ReadinessBuild | null;
  /**
   * The assessment, or `null` when there is nothing to assess.
   *
   * `null` is not "everything is fine". It is "the app has not been given
   * enough to say anything", and the screen must render it as such.
   */
  assessment: ReadinessAssessment | null;
  /** Persist a check-in for the day and re-score. */
  save: (checkIn: RecoveryCheckIn) => Promise<void>;
}

/**
 * The Recovery screen's data.
 *
 * @returns the day's vault snapshot, the assessment when one is possible, and
 *   the writer for the subjective check-in
 */
export function useRecovery(): RecoveryBinding {
  // Resolved once per mount, like `useWeightSeries`: recomputing per render
  // would rebuild the key at midnight and silently drop the subscription.
  const todayKey = useMemo(() => toDateKey(new Date()), []);

  const state = useSyncExternalStore(
    useMemo(() => (listener: () => void) => subscribeDay(todayKey, listener), [todayKey]),
    () => registry.get(todayKey)?.state ?? LOADING,
    () => LOADING,
  );

  const build = useMemo(
    () => (state.snapshot ? buildReadinessInput(state.snapshot) : null),
    [state.snapshot],
  );

  const assessment = useMemo(
    () => (build ? assessReadiness(build.input) : null),
    [build],
  );

  const save = useCallback(
    async (checkIn: RecoveryCheckIn) => {
      // Score against the snapshot the user was looking at, with their new
      // answers substituted in — so what is stored is exactly what the screen
      // will render back.
      const base = registry.get(todayKey)?.state.snapshot ?? emptySnapshot(todayKey);
      const next = buildReadinessInput({ ...base, checkIn });
      if (!next) return;
      const scored = assessReadiness(next.input);

      const contributors: Record<string, number> = {};
      for (const c of scored.contributions) {
        contributors[c.id] = readinessPercent(c.score);
      }

      await readinessRepo.upsertBySourceKey(
        checkInSourceKey(checkIn.dateKey),
        encodeCheckIn(
          checkIn,
          contributors,
          readinessPercent(scored.score),
          scored.adjustment.applied ? 1 + scored.adjustment.volumeDelta : null,
          {
            band: scored.band,
            programmingSuppressed: scored.programmingSuppressed,
            adjustmentPaused: scored.adjustmentPaused,
            referral: scored.referral,
            adjustment: { ...scored.adjustment, reasons: [...scored.adjustment.reasons] },
          },
        ),
      );
    },
    [todayKey],
  );

  return {
    todayKey,
    status: state.status,
    snapshot: state.snapshot,
    checkIn: state.snapshot?.checkIn ?? null,
    build,
    assessment,
    save,
  };
}
