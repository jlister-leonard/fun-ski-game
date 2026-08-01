/**
 * @file The in-memory session — the only place the unwrapped DEK ever lives.
 *
 * ## The one rule
 * **The DEK is never persisted.** Not to IndexedDB, not to `localStorage`, not
 * to `sessionStorage`, not to a cookie, not to a service worker cache. It
 * exists as JS heap state for exactly as long as the vault is unlocked, and
 * {@link lock} drops it.
 *
 * ## What "zeroed on lock" actually means
 * A `CryptoKey` handle cannot be zeroed from JavaScript — the bytes live in
 * the engine's crypto implementation and the spec gives us no wipe primitive.
 * What we *can* do, and do:
 *
 * - the raw 32-byte DEK buffer is overwritten with zeroes and dereferenced;
 * - the AES key used for row bodies is imported **non-extractable**, so even a
 *   script that gets hold of the handle cannot read the bytes back out;
 * - both handles are dropped so they become garbage-collectable.
 *
 * This is stated plainly rather than dressed up: after `lock()` the key
 * material is unreachable from JS and eligible for collection, but we cannot
 * promise it has left physical memory.
 */

import { deriveIndexKey, importDek, zeroBytes } from '../crypto';
import type { CodecKeys } from '../db/codec';
import { emit, type LockReason, type VaultState } from './events';

/** Everything a live session holds. */
interface Session {
  /** AES-GCM key for row bodies. Non-extractable. */
  readonly dek: CryptoKey;
  /** HMAC key for blind indexes. Non-extractable. */
  readonly indexKey: CryptoKey;
  /**
   * The raw DEK bytes.
   *
   * Retained — not zeroed at unlock — because re-wrapping the DEK (adding a
   * recovery code, registering a passkey, changing the passphrase) needs them,
   * and demanding the passphrase again for every such action would be hostile.
   * Zeroed by {@link lock}. This is the deliberate trade; see the file header.
   */
  readonly rawDek: Uint8Array;
  /** Which wrapping opened the vault. */
  readonly wrappedKeyId: string;
  /** Epoch ms of the unlock. */
  readonly unlockedAt: number;
}

let session: Session | null = null;
let initialized: boolean | null = null;

/** Thrown by any repository operation attempted while the vault is locked. */
export class VaultLockedError extends Error {
  constructor(operation = 'This operation') {
    super(`${operation} requires an unlocked vault`);
    this.name = 'VaultLockedError';
  }
}

/**
 * The current lock state.
 *
 * Synchronous and allocation-free — safe to call from a React render or a
 * `useSyncExternalStore` snapshot.
 *
 * @returns `'unlocked'` when the DEK is in memory, otherwise `'locked'` or
 *   `'uninitialized'` depending on what the last {@link setInitialized} said
 */
export function getState(): VaultState {
  if (session) return 'unlocked';
  return initialized === false ? 'uninitialized' : 'locked';
}

/** True when the DEK is in memory. */
export function isUnlocked(): boolean {
  return session !== null;
}

/**
 * Record whether a keyring exists on this device.
 *
 * Called by `vault.ts` after it reads the meta table, so that the synchronous
 * {@link getState} can distinguish "locked" from "never set up".
 *
 * @param value whether a keyring is present
 */
export function setInitialized(value: boolean): void {
  initialized = value;
}

/** The cached initialised flag, or `null` when it has not been read yet. */
export function getInitializedFlag(): boolean | null {
  return initialized;
}

/**
 * The keys the codec needs, or `null` when locked.
 *
 * @returns the session keys, or `null`
 */
export function getKeys(): CodecKeys | null {
  return session ? { dek: session.dek, indexKey: session.indexKey } : null;
}

/**
 * The keys the codec needs, throwing when locked.
 *
 * Every repository entry point calls this, which is what makes a lock take
 * effect on the very next operation rather than at some later checkpoint.
 *
 * @param operation a label used in the error message
 * @returns the session keys
 * @throws {VaultLockedError} when the vault is locked
 */
export function requireKeys(operation?: string): CodecKeys {
  const keys = getKeys();
  if (!keys) throw new VaultLockedError(operation);
  return keys;
}

/**
 * The raw DEK, for re-wrapping operations only.
 *
 * Callers must **not** zero the returned buffer — it is the session's own
 * copy, and {@link lock} owns its lifetime.
 *
 * @returns the raw 32-byte DEK
 * @throws {VaultLockedError} when the vault is locked
 */
export function requireRawDek(): Uint8Array {
  if (!session) throw new VaultLockedError('Re-wrapping the vault key');
  return session.rawDek;
}

/** Epoch ms of the current unlock, or `null`. */
export function unlockedAt(): number | null {
  return session?.unlockedAt ?? null;
}

/** Id of the wrapping that opened the current session, or `null`. */
export function activeWrappingId(): string | null {
  return session?.wrappedKeyId ?? null;
}

/**
 * Install a new session from freshly unwrapped DEK bytes.
 *
 * Takes ownership of `rawDek`: the caller must not zero or reuse it.
 *
 * @param rawDek the raw 32-byte DEK, freshly unwrapped
 * @param wrappedKeyId which wrapping produced it
 */
export async function openSession(rawDek: Uint8Array, wrappedKeyId: string): Promise<void> {
  const dek = await importDek(rawDek, false);
  const indexKey = await deriveIndexKey(rawDek);
  if (session) closeSession('reset', false);
  session = { dek, indexKey, rawDek, wrappedKeyId, unlockedAt: Date.now() };
  initialized = true;
  emit({ state: 'unlocked', at: Date.now() });
}

/**
 * Tear the session down.
 *
 * @param reason why the vault locked
 * @param notify whether to emit a state change (false during an internal swap)
 */
function closeSession(reason: LockReason, notify: boolean): void {
  if (!session) return;
  zeroBytes(session.rawDek);
  session = null;
  if (notify) emit({ state: getState(), reason, at: Date.now() });
}

/**
 * Lock the vault: zero the raw DEK, drop the key handles, notify subscribers.
 *
 * Idempotent — locking an already-locked vault is a no-op and emits nothing.
 *
 * @param reason why the vault locked; defaults to `'manual'`
 */
export function lock(reason: LockReason = 'manual'): void {
  closeSession(reason, true);
}
