/**
 * @file A tiny synchronous event emitter for vault lock-state changes.
 *
 * Deliberately dependency-free and framework-agnostic: the UI agent binds it
 * to React with `useSyncExternalStore`, but nothing here knows about React.
 */

/** The three states a vault can be in. */
export type VaultState =
  /** No keyring on this device — first run, or after a full wipe. */
  | 'uninitialized'
  /** A keyring exists; the DEK is not in memory. */
  | 'locked'
  /** The DEK is in memory and repositories will serve reads and writes. */
  | 'unlocked';

/** Why the vault locked. Drives the copy on the lock screen. */
export type LockReason =
  /** The user tapped Lock. */
  | 'manual'
  /** The idle timer fired. */
  | 'idle'
  /** The app was backgrounded past the grace period. */
  | 'hidden'
  /** The tab is closing. */
  | 'unload'
  /** A destructive operation (wipe, restore) reset the session. */
  | 'reset';

/** Emitted on every lock-state transition. */
export interface VaultEvent {
  /** The state after the transition. */
  readonly state: VaultState;
  /** Present when `state` became `'locked'` from `'unlocked'`. */
  readonly reason?: LockReason;
  /** Epoch ms of the transition. */
  readonly at: number;
}

/** A subscriber. Exceptions thrown by a listener are isolated, never rethrown. */
export type VaultListener = (event: VaultEvent) => void;

const listeners = new Set<VaultListener>();

/**
 * Subscribe to lock-state changes.
 *
 * @param listener called synchronously on every transition
 * @returns an unsubscribe function
 */
export function subscribe(listener: VaultListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Broadcast a transition.
 *
 * A throwing listener is logged and skipped — one broken UI subscriber must
 * never prevent the vault from actually locking.
 *
 * @param event the transition to publish
 */
export function emit(event: VaultEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      // Never let a subscriber break the lock path.
      console.error('[vault] listener threw', err);
    }
  }
}

/** Remove every subscriber. Tests only. */
export function clearListeners(): void {
  listeners.clear();
}
