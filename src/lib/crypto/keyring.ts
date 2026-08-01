/**
 * @file The key hierarchy.
 *
 * ```
 *                    ┌──────────────────────────┐
 *   passphrase ──────► PBKDF2-SHA-256 600k ──┐  │
 *   recovery code ────► PBKDF2-SHA-256 600k ──┤  │  each produces a KEK
 *   passkey PRF ──────► HKDF-SHA-256 ─────────┘  │
 *                    └───────────┬──────────────┘
 *                                │ AES-256-GCM wrap
 *                                ▼
 *                          ┌───────────┐
 *                          │    DEK    │  random 256-bit, generated once
 *                          └─────┬─────┘
 *                                │ encrypts every row in IndexedDB
 *                                ▼
 * ```
 *
 * The central design decision: **the DEK is wrapped N times, independently.**
 * A {@link Keyring} holds an array of {@link WrappedKey} records, each one a
 * self-contained recipe for recovering the same DEK from a different secret.
 * Consequences that fall out of this for free:
 *
 * - Changing the passphrase re-wraps the DEK. It does **not** re-encrypt a
 *   single row of data — an O(1) operation on a vault of any size.
 * - Adding Face ID (node V4) appends one record. No schema change, no
 *   migration, no re-encryption.
 * - A recovery code is not a "backdoor"; it is a peer of the passphrase.
 * - Revoking a device's passkey is a single array removal.
 *
 * The keyring itself is **not secret** and is stored in plaintext in the
 * `vaultMeta` table and in every `.hcvault` backup. Everything in it — salts,
 * IVs, iteration counts, wrapped ciphertexts — is public by design. That is
 * what makes a backup restorable from the passphrase alone, with nothing left
 * behind on the original device.
 */

import {
  DecryptionError,
  decryptBytes,
  encryptBytes,
  exportContentKey,
  generateContentKey,
  importContentKey,
} from './aead';
import {
  deriveKek,
  deriveKekFromDescriptor,
  deriveKekFromSecret,
  generateKdfSalt,
  PBKDF2_ITERATIONS,
  type KdfDescriptor,
} from './kdf';
import { deriveRecoveryKek, generateRecoveryCode, parseRecoveryCode } from './recovery-code';
import {
  fromBase64Url,
  randomId,
  toBase64Url,
  utf8,
  zeroBytes,
  type CryptoUnavailableError,
} from './random';

/** Current on-disk keyring format version. Bumped only by a breaking change. */
export const KEYRING_VERSION = 1;

/** Which kind of secret unlocks a given wrapping. */
export type WrapMethod = 'passphrase' | 'passkey-prf' | 'recovery-code';

/**
 * One independent recipe for recovering the DEK.
 *
 * Every field is public. Possessing this record without the corresponding
 * secret is worth nothing.
 */
export interface WrappedKey {
  /** Stable identifier for this wrapping, so it can be replaced or revoked. */
  readonly id: string;
  /** Which secret unlocks it. */
  readonly method: WrapMethod;
  /** User-facing label, e.g. `"Passphrase"` or `"iPhone 15 — Face ID"`. */
  readonly label: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the last successful unlock through this wrapping. */
  readonly lastUsedAt: string | null;
  /** How to turn the secret into the KEK. */
  readonly kdf: KdfDescriptor;
  /** base64url, 12-byte AES-GCM IV for the wrap. */
  readonly iv: string;
  /** base64url, AES-GCM ciphertext of the raw 32-byte DEK, plus its tag. */
  readonly ct: string;
  /**
   * Method-specific public metadata.
   *
   * For `passkey-prf` (node V4) this carries `credentialId` (base64url) and
   * `prfSalt` (base64url) so the unlock flow knows which credential to
   * challenge and with what PRF input. Left untyped-but-constrained so V4 can
   * extend it without touching this file.
   */
  readonly meta?: Readonly<Record<string, string>>;
}

/** The complete, public description of how a vault can be opened. */
export interface Keyring {
  /** {@link KEYRING_VERSION} at the time of writing. */
  readonly version: number;
  /** Random identifier for this vault, used to detect cross-vault imports. */
  readonly vaultId: string;
  /** ISO-8601 creation timestamp of the vault. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the last mutation of the keyring. */
  readonly updatedAt: string;
  /** Every independent DEK wrapping. Never empty on an initialised vault. */
  readonly wrappedKeys: readonly WrappedKey[];
}

/** A wrapping with its secret material stripped — safe to render in the UI. */
export interface WrappedKeySummary {
  readonly id: string;
  readonly method: WrapMethod;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** Thrown when no wrapping in the keyring could be opened with the given secret. */
export class UnlockFailedError extends Error {
  /** How many wrappings of the attempted method were tried. */
  readonly attempted: number;

  constructor(method: WrapMethod | 'any', attempted: number) {
    super(
      attempted === 0
        ? `No ${method} wrapping exists in this vault`
        : 'Could not unlock the vault with that secret',
    );
    this.name = 'UnlockFailedError';
    this.attempted = attempted;
  }
}

/** Associated data binding a wrapping to its vault and its own id. */
function wrapAad(vaultId: string, wrappedKeyId: string): Uint8Array {
  return utf8(`hcv1|keyring|${vaultId}|${wrappedKeyId}`);
}

/**
 * Create an empty keyring for a brand-new vault.
 *
 * @param vaultId optional explicit id; a random UUID is generated otherwise
 * @returns a keyring with no wrappings yet
 */
export function createKeyring(vaultId: string = randomId()): Keyring {
  const now = new Date().toISOString();
  return {
    version: KEYRING_VERSION,
    vaultId,
    createdAt: now,
    updatedAt: now,
    wrappedKeys: [],
  };
}

/**
 * Generate the vault's one and only data encryption key.
 *
 * Extractable, because it must be wrappable. The vault session immediately
 * re-imports a non-extractable copy for day-to-day row encryption and keeps
 * the extractable original only for re-wrapping.
 *
 * @returns a fresh random AES-256-GCM key
 */
export async function generateDek(): Promise<CryptoKey> {
  return generateContentKey(true);
}

/**
 * Wrap raw DEK bytes under an already-derived KEK.
 *
 * Prefer the method-specific helpers ({@link addPassphraseWrapping} etc.);
 * this is the shared primitive beneath them and the extension point for
 * node V4.
 *
 * @param params.vaultId the vault the wrapping belongs to
 * @param params.rawDek the raw 32-byte DEK
 * @param params.kek the key-encryption key
 * @param params.kdf the descriptor that reproduces `kek` from the secret
 * @param params.method which secret unlocks it
 * @param params.label user-facing name
 * @param params.meta optional method-specific public metadata
 * @returns the new wrapping record
 */
export async function wrapDek(params: {
  vaultId: string;
  rawDek: Uint8Array;
  kek: CryptoKey;
  kdf: KdfDescriptor;
  method: WrapMethod;
  label: string;
  meta?: Readonly<Record<string, string>>;
}): Promise<WrappedKey> {
  const id = randomId();
  const payload = await encryptBytes(params.kek, params.rawDek, wrapAad(params.vaultId, id));
  return {
    id,
    method: params.method,
    label: params.label,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    kdf: params.kdf,
    iv: toBase64Url(payload.iv),
    ct: toBase64Url(payload.ct),
    ...(params.meta ? { meta: params.meta } : {}),
  };
}

/**
 * Recover the raw DEK bytes from one wrapping.
 *
 * The caller **must** zero the returned buffer when finished.
 *
 * @param vaultId the vault id, part of the associated data
 * @param wrapped the wrapping to open
 * @param kek the KEK derived from the user's secret
 * @returns the raw 32-byte DEK
 * @throws {DecryptionError} when the KEK is wrong — the only wrong-secret signal
 */
export async function unwrapDek(
  vaultId: string,
  wrapped: WrappedKey,
  kek: CryptoKey,
): Promise<Uint8Array> {
  return decryptBytes(
    kek,
    { iv: fromBase64Url(wrapped.iv), ct: fromBase64Url(wrapped.ct) },
    wrapAad(vaultId, wrapped.id),
    `keyring:${wrapped.id}`,
  );
}

/** Result of a successful keyring unlock. */
export interface UnlockResult {
  /** Raw DEK bytes. The caller owns them and must zero them on lock. */
  readonly rawDek: Uint8Array;
  /** Which wrapping opened the vault. */
  readonly wrappedKeyId: string;
  /** The keyring with `lastUsedAt` refreshed on that wrapping. */
  readonly keyring: Keyring;
}

/**
 * Try every wrapping of a given method until one opens.
 *
 * There is deliberately **no verifier hash and no early exit on a "wrong"
 * flag**: each attempt is a real AES-GCM decryption whose 128-bit tag either
 * verifies or does not. A wrong passphrase is indistinguishable from a
 * corrupted record, which is exactly the property we want.
 *
 * Cost note: with N passphrase wrappings this runs N PBKDF2 ladders in the
 * worst case. In practice N is 1 (one passphrase, one recovery code, one
 * passkey per device), and different methods are never cross-tried.
 *
 * @param keyring the vault's keyring
 * @param method which wrappings to attempt
 * @param secret the passphrase / recovery code (string) or PRF output (bytes)
 * @param filter optional predicate to narrow the candidates, e.g. by credential id
 * @returns the raw DEK and the updated keyring
 * @throws {UnlockFailedError} when no candidate wrapping opened
 */
export async function unlockKeyring(
  keyring: Keyring,
  method: WrapMethod,
  secret: string | Uint8Array,
  filter?: (w: WrappedKey) => boolean,
): Promise<UnlockResult> {
  const candidates = keyring.wrappedKeys.filter(
    (w) => w.method === method && (filter ? filter(w) : true),
  );
  for (const candidate of candidates) {
    let kek: CryptoKey;
    try {
      kek = await deriveKekFromDescriptor(candidate.kdf, secret);
    } catch {
      continue; // descriptor/secret kind mismatch — not a candidate after all
    }
    try {
      const rawDek = await unwrapDek(keyring.vaultId, candidate, kek);
      return {
        rawDek,
        wrappedKeyId: candidate.id,
        keyring: touchWrapping(keyring, candidate.id),
      };
    } catch (err) {
      if (err instanceof DecryptionError) continue;
      throw err;
    }
  }
  throw new UnlockFailedError(method, candidates.length);
}

/**
 * Append a passphrase wrapping of the DEK.
 *
 * @param keyring the current keyring
 * @param rawDek the raw 32-byte DEK
 * @param passphrase the user's chosen passphrase
 * @param options.label user-facing name; defaults to `'Passphrase'`
 * @param options.iterations PBKDF2 iterations; defaults to {@link PBKDF2_ITERATIONS}
 * @returns the keyring with the new wrapping appended
 */
export async function addPassphraseWrapping(
  keyring: Keyring,
  rawDek: Uint8Array,
  passphrase: string,
  options: { label?: string; iterations?: number } = {},
): Promise<Keyring> {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const salt = generateKdfSalt();
  const kek = await deriveKek(passphrase, salt, iterations);
  const wrapped = await wrapDek({
    vaultId: keyring.vaultId,
    rawDek,
    kek,
    kdf: { kind: 'pbkdf2-sha256', salt: toBase64Url(salt), iterations },
    method: 'passphrase',
    label: options.label ?? 'Passphrase',
  });
  return withWrapping(keyring, wrapped);
}

/** A newly minted recovery code and the keyring that now accepts it. */
export interface RecoveryCodeIssue {
  /** Show this to the user exactly once, then forget it. */
  readonly code: string;
  /** The keyring including the new wrapping. */
  readonly keyring: Keyring;
  /** The id of the wrapping, so it can be revoked later. */
  readonly wrappedKeyId: string;
}

/**
 * Generate a recovery code and append a wrapping of the DEK under it.
 *
 * The plaintext code is returned to the caller and **never persisted** — only
 * its wrapping is. If the user loses the paper, the wrapping is dead weight
 * and should be revoked and reissued.
 *
 * @param keyring the current keyring
 * @param rawDek the raw 32-byte DEK
 * @param options.label user-facing name; defaults to `'Recovery code'`
 * @param options.iterations PBKDF2 iterations; defaults to {@link PBKDF2_ITERATIONS}
 * @returns the printable code, the wrapping id, and the updated keyring
 */
export async function addRecoveryCodeWrapping(
  keyring: Keyring,
  rawDek: Uint8Array,
  options: { label?: string; iterations?: number } = {},
): Promise<RecoveryCodeIssue> {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const code = generateRecoveryCode();
  const salt = generateKdfSalt();
  const kek = await deriveRecoveryKek(code, salt, iterations);
  const wrapped = await wrapDek({
    vaultId: keyring.vaultId,
    rawDek,
    kek,
    kdf: { kind: 'pbkdf2-sha256', salt: toBase64Url(salt), iterations },
    method: 'recovery-code',
    label: options.label ?? 'Recovery code',
  });
  return {
    code: code.formatted,
    wrappedKeyId: wrapped.id,
    keyring: withWrapping(keyring, wrapped),
  };
}

/**
 * Append a wrapping keyed by a high-entropy binary secret — the extension
 * point for node V4's WebAuthn PRF (Face ID) unlock.
 *
 * @param keyring the current keyring
 * @param rawDek the raw 32-byte DEK
 * @param secret at least 16 bytes of uniformly random material, e.g. the
 *   authenticator's PRF output
 * @param options.label user-facing device name
 * @param options.method wrapping method; defaults to `'passkey-prf'`
 * @param options.info HKDF domain-separation label
 * @param options.meta public metadata such as `{ credentialId, prfSalt }`
 * @returns the keyring with the new wrapping appended
 */
export async function addSecretWrapping(
  keyring: Keyring,
  rawDek: Uint8Array,
  secret: Uint8Array,
  options: {
    label: string;
    method?: WrapMethod;
    info?: string;
    meta?: Readonly<Record<string, string>>;
  },
): Promise<Keyring> {
  const info = options.info ?? 'hcvault/passkey-prf/v1';
  const salt = generateKdfSalt();
  const kek = await deriveKekFromSecret(secret, salt, info);
  const wrapped = await wrapDek({
    vaultId: keyring.vaultId,
    rawDek,
    kek,
    kdf: { kind: 'hkdf-sha256', salt: toBase64Url(salt), info },
    method: options.method ?? 'passkey-prf',
    label: options.label,
    meta: options.meta,
  });
  return withWrapping(keyring, wrapped);
}

/**
 * Unlock with a recovery code, validating its checksum first.
 *
 * The checksum check is what lets the UI reject a typo instantly instead of
 * burning ~0.5 s of PBKDF2 to reach the same conclusion.
 *
 * @param keyring the vault's keyring
 * @param input the code as typed, in any casing, with any separators
 * @returns the raw DEK and the updated keyring
 * @throws {import('./recovery-code').RecoveryCodeError} on a malformed code
 * @throws {UnlockFailedError} when the code is well-formed but not this vault's
 */
export async function unlockWithRecoveryCode(
  keyring: Keyring,
  input: string,
): Promise<UnlockResult> {
  const parsed = parseRecoveryCode(input);
  return unlockKeyring(keyring, 'recovery-code', parsed.normalized);
}

/**
 * Replace every passphrase wrapping with one derived from a new passphrase.
 *
 * Verifies the old passphrase by actually unwrapping the DEK, then re-wraps
 * that same DEK. **No stored data is touched** — the DEK is unchanged, so a
 * passphrase change is instantaneous on a vault of any size.
 *
 * @param keyring the current keyring
 * @param oldPassphrase must open an existing passphrase wrapping
 * @param newPassphrase the replacement
 * @param options.iterations PBKDF2 iterations for the new wrapping
 * @returns the updated keyring
 * @throws {UnlockFailedError} when `oldPassphrase` is wrong
 */
export async function changePassphraseInKeyring(
  keyring: Keyring,
  oldPassphrase: string,
  newPassphrase: string,
  options: { iterations?: number } = {},
): Promise<Keyring> {
  const { rawDek } = await unlockKeyring(keyring, 'passphrase', oldPassphrase);
  try {
    const stripped: Keyring = {
      ...keyring,
      wrappedKeys: keyring.wrappedKeys.filter((w) => w.method !== 'passphrase'),
    };
    return await addPassphraseWrapping(stripped, rawDek, newPassphrase, options);
  } finally {
    zeroBytes(rawDek);
  }
}

/**
 * Remove a wrapping — revoking a device's passkey or a lost recovery code.
 *
 * Refuses to remove the last wrapping: that would render the vault permanently
 * unopenable, which is never something a UI gesture should be able to do by
 * accident.
 *
 * @param keyring the current keyring
 * @param wrappedKeyId the wrapping to drop
 * @returns the updated keyring
 * @throws {Error} when the removal would leave the vault with no way in
 */
export function removeWrapping(keyring: Keyring, wrappedKeyId: string): Keyring {
  const remaining = keyring.wrappedKeys.filter((w) => w.id !== wrappedKeyId);
  if (remaining.length === keyring.wrappedKeys.length) return keyring;
  if (remaining.length === 0) {
    throw new Error('Refusing to remove the last wrapping — the vault would be unopenable');
  }
  return { ...keyring, wrappedKeys: remaining, updatedAt: new Date().toISOString() };
}

/**
 * Strip secret-adjacent fields for display.
 *
 * @param keyring the keyring to summarise
 * @returns one summary per wrapping, safe to hand to React
 */
export function summarizeKeyring(keyring: Keyring): WrappedKeySummary[] {
  return keyring.wrappedKeys.map((w) => ({
    id: w.id,
    method: w.method,
    label: w.label,
    createdAt: w.createdAt,
    lastUsedAt: w.lastUsedAt,
  }));
}

/**
 * Structural validation of a keyring parsed from untrusted input (a backup
 * file the user picked from Files, say).
 *
 * @param value the parsed JSON
 * @returns true when `value` has the shape of a keyring this build understands
 */
export function isKeyring(value: unknown): value is Keyring {
  if (typeof value !== 'object' || value === null) return false;
  const k = value as Partial<Keyring>;
  return (
    typeof k.version === 'number' &&
    typeof k.vaultId === 'string' &&
    typeof k.createdAt === 'string' &&
    Array.isArray(k.wrappedKeys) &&
    k.wrappedKeys.every(
      (w) =>
        typeof w === 'object' &&
        w !== null &&
        typeof (w as WrappedKey).id === 'string' &&
        typeof (w as WrappedKey).iv === 'string' &&
        typeof (w as WrappedKey).ct === 'string' &&
        typeof (w as WrappedKey).kdf === 'object',
    )
  );
}

/**
 * Import raw DEK bytes as the two session keys the vault actually uses.
 *
 * @param rawDek the raw 32-byte DEK
 * @param extractable whether the returned AES key may be exported again
 * @returns an AES-GCM key for row encryption
 */
export async function importDek(rawDek: Uint8Array, extractable = false): Promise<CryptoKey> {
  return importContentKey(rawDek, extractable);
}

/**
 * Export an extractable DEK back to raw bytes. Zero the result when done.
 *
 * @param dek an extractable AES-GCM key
 */
export async function exportDek(dek: CryptoKey): Promise<Uint8Array> {
  return exportContentKey(dek);
}

/** Append a wrapping and bump `updatedAt`. */
function withWrapping(keyring: Keyring, wrapped: WrappedKey): Keyring {
  return {
    ...keyring,
    wrappedKeys: [...keyring.wrappedKeys, wrapped],
    updatedAt: new Date().toISOString(),
  };
}

/** Refresh `lastUsedAt` on one wrapping. */
function touchWrapping(keyring: Keyring, wrappedKeyId: string): Keyring {
  const now = new Date().toISOString();
  return {
    ...keyring,
    wrappedKeys: keyring.wrappedKeys.map((w) =>
      w.id === wrappedKeyId ? { ...w, lastUsedAt: now } : w,
    ),
    updatedAt: now,
  };
}

export type { KdfDescriptor, CryptoUnavailableError };
