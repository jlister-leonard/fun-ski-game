"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  addDays,
  subscribeQuery,
  toDateKey,
  weights,
  type WeightSeriesPoint,
} from "@/lib/db/repos";

/**
 * A live weigh-in series, bound to the repository.
 *
 * `weights.getSeries()` returns exactly the `WeightEntry[]` shape the trend
 * filter consumes (`{ date, kg }`), so this hook does no adapting — it hands
 * the repo's own output straight to `computeWeightTrend`.
 *
 * Reactivity comes from Dexie's live queries via `subscribeQuery`, which
 * re-runs the query (decryption included) on any write to the tables it
 * touched. Logging a weight therefore updates the chart without the screen
 * knowing that it did.
 *
 * The `useSyncExternalStore` binding follows `useVaultState.ts`. The store is a
 * module-level registry keyed by date range so two components asking for the
 * same window share one subscription and one snapshot object — `getSnapshot`
 * must return a referentially stable value between emissions or React will
 * loop.
 */

/** Kilograms. Storage and every algorithm signature are SI; conversion is a display concern. */
export interface WeightSeriesState {
  /** One point per day that has a reading, ascending. Kilograms. */
  points: readonly WeightSeriesPoint[];
  /**
   * `loading` until the first emission; `locked` when the vault refused the
   * read; `unavailable` outside the browser (the static prerender).
   */
  status: "loading" | "ready" | "locked" | "unavailable";
  error: unknown;
}

const LOADING: WeightSeriesState = Object.freeze({
  points: Object.freeze([]) as readonly WeightSeriesPoint[],
  status: "loading",
  error: null,
});

interface RangeEntry {
  state: WeightSeriesState;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}

const registry = new Map<string, RangeEntry>();

function keyFor(from: string, to: string): string {
  return `${from}..${to}`;
}

function publish(key: string, next: WeightSeriesState): void {
  const entry = registry.get(key);
  if (!entry) return;
  entry.state = next;
  for (const listener of entry.listeners) listener();
}

function subscribeRange(key: string, from: string, to: string, listener: () => void): () => void {
  let entry = registry.get(key);
  if (!entry) {
    entry = { state: LOADING, listeners: new Set(), stop: null };
    registry.set(key, entry);
  }
  entry.listeners.add(listener);

  if (!entry.stop) {
    entry.stop = subscribeQuery(
      () => weights.getSeries(from, to),
      (points) => publish(key, { points, status: "ready", error: null }),
      (error) => {
        // A locked vault is an expected state, not a failure: the gate will be
        // showing the lock screen and this screen will remount after unlock.
        const locked =
          error instanceof Error && error.name === "VaultLockedError";
        publish(key, {
          points: [],
          status: locked ? "locked" : "unavailable",
          error,
        });
      }
    );
  }

  return () => {
    const current = registry.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.stop?.();
      registry.delete(key);
    }
  };
}

export interface WeightSeriesBinding extends WeightSeriesState {
  /** Inclusive `YYYY-MM-DD` start of the window that was queried. */
  from: string;
  /** Inclusive `YYYY-MM-DD` end of the window that was queried. */
  to: string;
}

/**
 * Subscribe to the weigh-in series for a trailing window.
 *
 * @param days how far back to read, inclusive of today. 180 covers a full cut
 *   plus the 56-day expenditure window with room for the filter to warm up.
 * @returns the live series in kilograms, plus the window it covers
 */
export function useWeightSeries(days = 180): WeightSeriesBinding {
  // Resolved once per mount. Recomputing per render would rebuild the key at
  // midnight mid-session and silently drop the subscription; a session that
  // spans midnight keeps the window it started with, which is harmless for a
  // trend chart and cheaper than a resubscribe.
  const { from, to, key } = useMemo(() => {
    const today = toDateKey(new Date());
    const start = addDays(today, -(days - 1));
    return { from: start, to: today, key: keyFor(start, today) };
  }, [days]);

  const state = useSyncExternalStore(
    useMemo(
      () => (listener: () => void) => subscribeRange(key, from, to, listener),
      [key, from, to]
    ),
    () => registry.get(key)?.state ?? LOADING,
    () => LOADING
  );

  return { ...state, from, to };
}
