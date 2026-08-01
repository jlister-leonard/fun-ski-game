/**
 * @file Live-query plumbing, so screens can subscribe instead of polling.
 *
 * Dexie's `liveQuery` observes which tables a query touched and re-runs it
 * whenever any of them changes. Because our repositories read through Dexie,
 * **any repository call composed inside `observe` is automatically reactive**
 * — including the decryption step, which simply re-runs.
 *
 * ```ts
 * const sub = observe(() => foodLogs.getForDate('2026-07-26'))
 *   .subscribe({ next: setLogs });
 * // later
 * sub.unsubscribe();
 * ```
 *
 * The React binding lives with the UI agent; nothing here imports React.
 */

import { liveQuery, type Observable, type Subscription } from 'dexie';
import { isBrowserStorageAvailable } from '../db';

/**
 * Observe a repository query.
 *
 * @typeParam T the query's result type
 * @param querier an async function composed of repository calls
 * @returns a Dexie observable that re-emits whenever the underlying tables change
 * @throws {import('../db').EnvironmentError} indirectly, on the first emission,
 *   when called outside a browser
 */
export function observe<T>(querier: () => T | Promise<T>): Observable<T> {
  return liveQuery(querier);
}

/**
 * Subscribe to a repository query with plain callbacks.
 *
 * A no-op returning an inert unsubscribe outside the browser, so a component
 * that starts a subscription during a prerender does not crash the build.
 *
 * @typeParam T the query's result type
 * @param querier an async function composed of repository calls
 * @param onValue called with each new result
 * @param onError called when the query throws — including
 *   {@link import('../../vault/session').VaultLockedError} after an auto-lock
 * @returns an unsubscribe function
 */
export function subscribeQuery<T>(
  querier: () => T | Promise<T>,
  onValue: (value: T) => void,
  onError?: (error: unknown) => void,
): () => void {
  if (!isBrowserStorageAvailable()) return () => {};
  const sub: Subscription = liveQuery(querier).subscribe({
    next: onValue,
    error: (err) => onError?.(err),
  });
  return () => sub.unsubscribe();
}
