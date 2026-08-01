/**
 * @file The vault's public control surface (task graph node **V3**).
 *
 * Headless by design: no React, no components, no DOM rendering. The UI agent
 * binds to {@link subscribe} + {@link getState} with `useSyncExternalStore` and
 * calls these functions from event handlers.
 *
 * ## The lifecycle
 * ```
 *  first run          returning user            any time
 *  ─────────          ──────────────            ────────
 *  initializeVault ──► unlock(passphrase) ──┬──► lock()
 *      │                unlockWithRecovery  │
 *      └─ recovery      unlockWithSecret ───┘
 *         code shown                        └──► changePassphrase(old, new)
 *         exactly once                           addRecoveryCode()
 *                                                registerSecretWrapping()  ← node V4
 * ```
 *
 * ## What a wrong passphrase does
 * It fails the AES-GCM authentication tag inside `unwrapDek`, and that is the
 * *only* signal anywhere in this codebase. There is no verifier hash, no
 * stored digest, no `===` on a secret, and therefore nothing to time and no
 * oracle to probe. The cost of an attempt is one full PBKDF2 ladder — roughly
 * 0.3–0.6 s on an iPhone — which is the rate limit.
 */

import {
  addPassphraseWrapping,
  addRecoveryCodeWrapping,
  addSecretWrapping,
  changePassphraseInKeyring,
  createKeyring,
  exportDek,
  generateDek,
  isKeyring,
  removeWrapping as removeWrappingFromKeyring,
  summarizeKeyring,
  unlockKeyring,
  unlockWithRecoveryCode as unlockKeyringWithRecoveryCode,
  zeroBytes,
  type Keyring,
  type WrapMethod,
  type WrappedKeySummary,
} from '../crypto';
import { getMeta, setMeta } from '../db/db';
import { META_KEYS } from '../db/schema';
import { configureAutoLock, startAutoLock, stopAutoLock, type AutoLockConfig } from './autolock';
import { subscribe, type VaultEvent, type VaultListener, type VaultState } from './events';
import {
  activeWrappingId,
  getState,
  isUnlocked,
  lock as lockSession,
  openSession,
  requireRawDek,
  setInitialized,
  unlockedAt,
  VaultLockedError,
} from './session';

/** Thrown when {@link initializeVault} runs against a vault that already exists. */
export class VaultAlreadyInitializedError extends Error {
  constructor() {
    super('This device already has a vault. Unlock it, or wipe it first.');
    this.name = 'VaultAlreadyInitializedError';
  }
}

/** Thrown when an unlock is attempted before a vault exists. */
export class VaultNotInitializedError extends Error {
  constructor() {
    super('No vault on this device yet. Set a passphrase, or restore a backup.');
    this.name = 'VaultNotInitializedError';
  }
}

/** A complete, UI-renderable description of the vault. Contains no secrets. */
export interface VaultStatus {
  /** Current lock state. */
  readonly state: VaultState;
  /** Random vault identifier, or `null` before setup. */
  readonly vaultId: string | null;
  /** ISO-8601 creation timestamp, or `null`. */
  readonly createdAt: string | null;
  /** Every way this vault can be opened, secrets stripped. */
  readonly wrappings: readonly WrappedKeySummary[];
  /** Whether a recovery code has ever been issued. */
  readonly hasRecoveryCode: boolean;
  /** Whether a passkey/PRF wrapping exists (node V4). */
  readonly hasPasskey: boolean;
  /** Epoch ms of the current unlock, or `null`. */
  readonly unlockedAt: number | null;
  /** Which wrapping opened the current session, or `null`. */
  readonly activeWrappingId: string | null;
  /** Epoch ms of the last `.hcvault` export, or `null` if never. */
  readonly lastBackupAt: number | null;
}

/** Options for {@link initializeVault}. */
export interface InitializeOptions {
  /**
   * Also issue a recovery code. Default **true** — `ARCHITECTURE.md` §4 asks
   * the app to push the escrow, and a vault with a single wrapping is one
   * forgotten passphrase away from total loss.
   */
  issueRecoveryCode?: boolean;
  /** PBKDF2 iterations. Lower only in tests. */
  iterations?: number;
  /** Label for the passphrase wrapping. */
  label?: string;
}

/** What {@link initializeVault} hands back. */
export interface InitializeResult {
  readonly vaultId: string;
  /**
   * The printable recovery code, or `null` when `issueRecoveryCode` was false.
   *
   * **Shown exactly once.** It is not stored anywhere and cannot be recovered.
   */
  readonly recoveryCode: string | null;
}

/** In-memory cache of the keyring, so a status read is not an IndexedDB hit. */
let cachedKeyring: Keyring | null = null;

/**
 * Read the keyring from the meta table.
 *
 * Safe while locked — the keyring is public by construction.
 *
 * @param force bypass the in-memory cache
 * @returns the keyring, or `null` when this device has no vault
 */
export async function loadKeyring(force = false): Promise<Keyring | null> {
  if (cachedKeyring && !force) return cachedKeyring;
  const raw = await getMeta<unknown>(META_KEYS.keyring);
  if (raw === undefined || raw === null) {
    setInitialized(false);
    cachedKeyring = null;
    return null;
  }
  if (!isKeyring(raw)) {
    throw new Error('The keyring on this device is corrupt or from a newer version of the app');
  }
  cachedKeyring = raw;
  setInitialized(true);
  return raw;
}

/**
 * Same-origin coordination channel for destructive vault replacement.
 *
 * IndexedDB is shared by tabs in one browser storage partition, but each tab
 * has its own JS heap and may therefore hold its own unwrapped DEK. A replace
 * restore must lock those peer sessions too, or a still-open tab could write a
 * row encrypted with the retired key into the newly restored database.
 *
 * The channel carries one fixed control message and no vault identifier,
 * record, key material or other user data. `BroadcastChannel` is deliberately
 * feature-detected: failure to create it must never stop the local lock path.
 */
const VAULT_SESSION_CHANNEL = 'keel-vault-session-v1';
const VAULT_RESET_MESSAGE = 'vault-reset';
let sessionChannel: BroadcastChannel | null = null;

function installSessionChannel(): void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    sessionChannel = new BroadcastChannel(VAULT_SESSION_CHANNEL);
    sessionChannel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== VAULT_RESET_MESSAGE
      ) {
        return;
      }

      stopAutoLock();
      lockSession('reset');
      cachedKeyring = null;

      // The replacement transaction committed before the signal was sent.
      // Refresh the public keyring cache, but stay safely locked if storage is
      // temporarily unavailable in this peer.
      void loadKeyring(true).catch((error: unknown) => {
        cachedKeyring = null;
        console.error('[vault] could not refresh the keyring after a peer restore', error);
      });
    });
  } catch {
    sessionChannel = null;
  }
}

installSessionChannel();

/**
 * Persist the keyring and refresh the cache.
 *
 * @param keyring the keyring to write
 */
async function saveKeyring(keyring: Keyring): Promise<void> {
  await setMeta(META_KEYS.keyring, keyring);
  cachedKeyring = keyring;
  setInitialized(true);
}

/**
 * Whether this device already has a vault.
 *
 * @returns true when a keyring is stored
 */
export async function isInitialized(): Promise<boolean> {
  return (await loadKeyring()) !== null;
}

/**
 * Everything the UI needs to render the vault's state.
 *
 * @returns the current status; never throws when locked
 */
export async function getStatus(): Promise<VaultStatus> {
  const keyring = await loadKeyring();
  const wrappings = keyring ? summarizeKeyring(keyring) : [];
  return {
    state: getState(),
    vaultId: keyring?.vaultId ?? null,
    createdAt: keyring?.createdAt ?? null,
    wrappings,
    hasRecoveryCode: wrappings.some((w) => w.method === 'recovery-code'),
    hasPasskey: wrappings.some((w) => w.method === 'passkey-prf'),
    unlockedAt: unlockedAt(),
    activeWrappingId: activeWrappingId(),
    lastBackupAt: (await getMeta<number>(META_KEYS.lastBackupAt)) ?? null,
  };
}

/**
 * Create a brand-new vault and leave it **unlocked**.
 *
 * Generates a random 256-bit DEK, wraps it with a KEK derived from the
 * passphrase, optionally wraps it a second time with a fresh recovery code,
 * and persists the resulting keyring.
 *
 * @param passphrase the user's chosen passphrase. Length policy is the UI's
 *   call, not the vault's — but see `assessPassphrase` for a shared heuristic.
 * @param options see {@link InitializeOptions}
 * @returns the vault id and, unless suppressed, the one-time recovery code
 * @throws {VaultAlreadyInitializedError} when a keyring already exists
 */
export async function initializeVault(
  passphrase: string,
  options: InitializeOptions = {},
): Promise<InitializeResult> {
  if (await isInitialized()) throw new VaultAlreadyInitializedError();
  if (!passphrase) throw new TypeError('initializeVault: passphrase is required');

  const dek = await generateDek();
  const rawDek = await exportDek(dek);
  let recoveryCode: string | null = null;
  try {
    let keyring = createKeyring();
    keyring = await addPassphraseWrapping(keyring, rawDek, passphrase, {
      iterations: options.iterations,
      label: options.label ?? 'Passphrase',
    });
    if (options.issueRecoveryCode !== false) {
      const issued = await addRecoveryCodeWrapping(keyring, rawDek, {
        iterations: options.iterations,
      });
      keyring = issued.keyring;
      recoveryCode = issued.code;
    }
    await saveKeyring(keyring);
    await setMeta(META_KEYS.createdAt, Date.now());
    // openSession takes ownership of a *copy*; the local buffer is zeroed below.
    await openSession(Uint8Array.from(rawDek), keyring.wrappedKeys[0].id);
    startAutoLock();
    return { vaultId: keyring.vaultId, recoveryCode };
  } finally {
    zeroBytes(rawDek);
  }
}

/**
 * Unlock with the passphrase.
 *
 * @param passphrase the user's secret
 * @throws {VaultNotInitializedError} when no vault exists
 * @throws {import('../crypto').UnlockFailedError} when the passphrase is wrong.
 *   That is a GCM tag failure and nothing else — see the file header.
 */
export async function unlock(passphrase: string): Promise<void> {
  const keyring = await loadKeyring();
  if (!keyring) throw new VaultNotInitializedError();
  const result = await unlockKeyring(keyring, 'passphrase', passphrase);
  await saveKeyring(result.keyring);
  await openSession(result.rawDek, result.wrappedKeyId);
  startAutoLock();
}

/**
 * Unlock with the printable recovery code.
 *
 * The code's checksum is validated first, so an obvious typo is rejected in
 * microseconds rather than after a full PBKDF2 ladder.
 *
 * @param code the code as typed — any casing, any separators
 * @throws {import('../crypto').RecoveryCodeError} on a malformed code
 * @throws {import('../crypto').UnlockFailedError} when the code is not this vault's
 */
export async function unlockWithRecoveryCode(code: string): Promise<void> {
  const keyring = await loadKeyring();
  if (!keyring) throw new VaultNotInitializedError();
  const result = await unlockKeyringWithRecoveryCode(keyring, code);
  await saveKeyring(result.keyring);
  await openSession(result.rawDek, result.wrappedKeyId);
  startAutoLock();
}

/**
 * Unlock with a high-entropy binary secret — **the entry point for node V4's
 * WebAuthn PRF (Face ID) unlock.**
 *
 * V4 obtains the PRF output from `navigator.credentials.get()`, then calls
 * this. Nothing else in the vault needs to change.
 *
 * @param secret the 32-byte PRF output
 * @param options.method which wrapping method to try; defaults to `'passkey-prf'`
 * @param options.credentialId when set, only wrappings whose
 *   `meta.credentialId` matches are attempted
 * @throws {import('../crypto').UnlockFailedError} when no wrapping opened
 */
export async function unlockWithSecret(
  secret: Uint8Array,
  options: { method?: WrapMethod; credentialId?: string } = {},
): Promise<void> {
  const keyring = await loadKeyring();
  if (!keyring) throw new VaultNotInitializedError();
  const result = await unlockKeyring(
    keyring,
    options.method ?? 'passkey-prf',
    secret,
    options.credentialId ? (w) => w.meta?.credentialId === options.credentialId : undefined,
  );
  await saveKeyring(result.keyring);
  await openSession(result.rawDek, result.wrappedKeyId);
  startAutoLock();
}

/**
 * Lock the vault: zero the raw DEK, drop the key handles, stop the auto-lock
 * watchdog, notify subscribers.
 *
 * Idempotent.
 */
export function lock(): void {
  stopAutoLock();
  lockSession('manual');
}

/**
 * Invalidate every in-memory session after a committed replace restore.
 *
 * The current context is locked synchronously before the peer notification is
 * attempted. This function must only be called after the IndexedDB replace
 * transaction commits; failed and dry-run restores leave all sessions intact.
 */
export function resetSessionAfterRestore(): void {
  stopAutoLock();
  lockSession('reset');
  cachedKeyring = null;
  try {
    sessionChannel?.postMessage({ type: VAULT_RESET_MESSAGE });
  } catch {
    // The current context is already locked. Peer signalling is defence in
    // depth and must not turn a successful atomic restore into a false failure.
  }
}

/**
 * Change the passphrase.
 *
 * Verifies `oldPassphrase` by unwrapping the DEK with it, then re-wraps the
 * *same* DEK under a KEK derived from `newPassphrase`. **No stored row is
 * touched** — this is O(1) on a vault of any size, and every other wrapping
 * (recovery code, passkeys) keeps working untouched.
 *
 * @param oldPassphrase must open an existing passphrase wrapping
 * @param newPassphrase the replacement
 * @param options.iterations PBKDF2 iterations for the new wrapping
 * @throws {import('../crypto').UnlockFailedError} when `oldPassphrase` is wrong
 */
export async function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  options: { iterations?: number } = {},
): Promise<void> {
  const keyring = await loadKeyring();
  if (!keyring) throw new VaultNotInitializedError();
  if (!newPassphrase) throw new TypeError('changePassphrase: newPassphrase is required');
  const updated = await changePassphraseInKeyring(keyring, oldPassphrase, newPassphrase, options);
  await saveKeyring(updated);
}

/**
 * Issue a new recovery code, revoking any previous one.
 *
 * Requires an unlocked vault — it re-wraps the in-memory DEK, so the user is
 * not asked for their passphrase again.
 *
 * @param options.iterations PBKDF2 iterations
 * @returns the printable code. **Show it once, then forget it.**
 * @throws {VaultLockedError} when the vault is locked
 */
export async function addRecoveryCode(options: { iterations?: number } = {}): Promise<string> {
  const keyring = await loadKeyring();
  if (!keyring) throw new VaultNotInitializedError();
  const rawDek = requireRawDek();
  const withoutOld: Keyring = {
    ...keyring,
    wrappedKeys: keyring.wrappedKeys.filter((w) => w.method !== 'recovery-code'),
  };
  const issued = await addRecoveryCodeWrapping(withoutOld, rawDek, options);
  await saveKeyring(issued.keyring);
  return issued.code;
}

/**
 * Register an additional wrapping keyed by a high-entropy secret — **the write
 * side of node V4's Face ID support.**
 *
 * @param secret the 32-byte WebAuthn PRF output
 * @param options.label a device name to show in settings
 * @param options.credentialId base64url credential id, stored in `meta` so
 *   {@link unlockWithSecret} can pick the right wrapping
 * @param options.meta any further public metadata
 * @returns the id of the new wrapping, for later revocation
 * @throws {VaultLockedError} when the vault is locked
 */
export async function registerSecretWrapping(
  secret: Uint8Array,
  options: { label: string; credentialId?: string; meta?: Readonly<Record<string, string>> },
): Promise<string> {
  const keyring = await loadKeyring();
  if (!keyring) throw new VaultNotInitializedError();
  const rawDek = requireRawDek();
  const meta: Record<string, string> = { ...(options.meta ?? {}) };
  if (options.credentialId) meta.credentialId = options.credentialId;
  const updated = await addSecretWrapping(keyring, rawDek, secret, {
    label: options.label,
    meta,
  });
  await saveKeyring(updated);
  return updated.wrappedKeys[updated.wrappedKeys.length - 1].id;
}

/**
 * Revoke a wrapping — a lost recovery code, or a device whose passkey should
 * no longer open the vault.
 *
 * Refuses to remove the last remaining wrapping.
 *
 * @param wrappedKeyId the wrapping to remove
 * @throws {Error} when removing it would leave the vault unopenable
 */
export async function removeWrapping(wrappedKeyId: string): Promise<void> {
  const keyring = await loadKeyring();
  if (!keyring) throw new VaultNotInitializedError();
  await saveKeyring(removeWrappingFromKeyring(keyring, wrappedKeyId));
}

/**
 * Adopt a keyring wholesale — used only by the destructive-restore path in
 * `backup.ts`, which must replace this device's keyring with the backup's.
 *
 * @param keyring the keyring to install
 * @internal
 */
export async function replaceKeyring(keyring: Keyring): Promise<void> {
  await saveKeyring(keyring);
}

/** Forget the cached keyring. Called after a wipe. @internal */
export function invalidateKeyringCache(): void {
  cachedKeyring = null;
  setInitialized(false);
}

/** A blunt, offline passphrase-strength assessment. */
export interface PassphraseAssessment {
  /** 0–4, in the spirit of zxcvbn but with no 400 KB dictionary shipped. */
  readonly score: 0 | 1 | 2 | 3 | 4;
  /** Rough entropy estimate in bits, from observed character-class variety. */
  readonly entropyBits: number;
  /** Human-readable, actionable, never scolding. */
  readonly advice: string;
  /** Whether the UI should let the user proceed. */
  readonly acceptable: boolean;
}

/**
 * Assess a passphrase without shipping a dictionary or making a network call.
 *
 * Deliberately crude and deliberately honest: it measures length and character
 * variety, which is all you can do offline in a few lines. The real defence is
 * the 600,000-iteration KDF, and the copy should say so.
 *
 * @param passphrase the candidate
 * @returns a score, an entropy estimate and one line of advice
 */
export function assessPassphrase(passphrase: string): PassphraseAssessment {
  const len = passphrase.length;
  let classes = 0;
  if (/[a-z]/.test(passphrase)) classes += 26;
  if (/[A-Z]/.test(passphrase)) classes += 26;
  if (/[0-9]/.test(passphrase)) classes += 10;
  if (/[^A-Za-z0-9]/.test(passphrase)) classes += 33;
  const entropyBits = len === 0 ? 0 : Math.round(len * Math.log2(Math.max(classes, 2)));

  if (len < 8) {
    return {
      score: 0,
      entropyBits,
      advice: 'Too short. Aim for four or more unrelated words.',
      acceptable: false,
    };
  }
  if (entropyBits < 45) {
    return {
      score: 1,
      entropyBits,
      advice: 'Weak. Four unrelated words beats one word with symbols in it.',
      acceptable: false,
    };
  }
  if (entropyBits < 60) {
    return {
      score: 2,
      entropyBits,
      advice: 'Usable, but longer is genuinely better. There is no password reset here.',
      acceptable: true,
    };
  }
  if (entropyBits < 80) {
    return { score: 3, entropyBits, advice: 'Good.', acceptable: true };
  }
  return { score: 4, entropyBits, advice: 'Strong.', acceptable: true };
}

export {
  configureAutoLock,
  getState,
  isUnlocked,
  startAutoLock,
  stopAutoLock,
  subscribe,
  VaultLockedError,
};
export type { AutoLockConfig, VaultEvent, VaultListener, VaultState };
