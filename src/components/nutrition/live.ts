'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { subscribeQuery } from '@/lib/db/repos';

/**
 * @file A small `useSyncExternalStore` binding over Dexie live queries.
 *
 * `src/lib/hooks/useWeightSeries.ts` established the pattern: a module-level
 * registry keyed by the query's parameters, so two components asking for the
 * same data share one subscription and one snapshot object. `getSnapshot` must
 * return a referentially stable value between emissions or React re-renders
 * forever, which is the only real subtlety here.
 *
 * This is the generic form of that hook. It lives in the nutrition folder
 * rather than `src/lib/hooks` because `src/lib/**` belongs to another agent —
 * if it proves generally useful it should be promoted, and that is noted in
 * the channel post rather than done unilaterally.
 */

/**
 * `locked` is an expected state, not a failure: the vault gate is showing the
 * lock screen and this component will re-render after unlock.
 */
export type LiveStatus = 'loading' | 'ready' | 'locked' | 'unavailable';

export interface LiveState<T> {
  data: T;
  status: LiveStatus;
  error: unknown;
}

interface Entry {
  state: LiveState<unknown>;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}

const registry = new Map<string, Entry>();

function publish(key: string, next: LiveState<unknown>): void {
  const entry = registry.get(key);
  if (!entry) return;
  entry.state = next;
  for (const listener of entry.listeners) listener();
}

function subscribeKey<T>(
  key: string,
  querier: () => T | Promise<T>,
  initial: T,
  listener: () => void,
): () => void {
  let entry = registry.get(key);
  if (!entry) {
    entry = {
      state: { data: initial, status: 'loading', error: null },
      listeners: new Set(),
      stop: null,
    };
    registry.set(key, entry);
  }
  entry.listeners.add(listener);

  if (!entry.stop) {
    entry.stop = subscribeQuery<T>(
      querier,
      (value) => publish(key, { data: value, status: 'ready', error: null }),
      (error) => {
        const locked = error instanceof Error && error.name === 'VaultLockedError';
        publish(key, {
          data: initial,
          status: locked ? 'locked' : 'unavailable',
          error,
        });
      },
    );
  }

  return () => {
    const found = registry.get(key);
    if (!found) return;
    found.listeners.delete(listener);
    if (found.listeners.size === 0) {
      found.stop?.();
      registry.delete(key);
    }
  };
}

/**
 * Subscribe to a vault query that re-runs on any write to the tables it reads.
 *
 * @param key a stable string encoding every parameter of the query. Two calls
 *   with the same key share a subscription, so the key must change whenever
 *   the query would return something different.
 * @param querier the query. Captured on first subscribe for a given key.
 * @param initial the value to report before the first emission, and after a
 *   failure. Must be referentially stable across renders.
 */
export function useLiveQuery<T>(
  key: string,
  querier: () => T | Promise<T>,
  initial: T,
): LiveState<T> {
  const subscribe = useMemo(
    () => (listener: () => void) => subscribeKey(key, querier, initial, listener),
    // `querier` is intentionally excluded: an inline arrow changes identity on
    // every render, and the key is the contract for what the query returns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const fallback = useMemo<LiveState<T>>(
    () => ({ data: initial, status: 'loading', error: null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return useSyncExternalStore(
    subscribe,
    () => (registry.get(key)?.state as LiveState<T> | undefined) ?? fallback,
    () => fallback,
  );
}
