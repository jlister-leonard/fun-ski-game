/**
 * @file Authenticated encryption. AES-256-GCM, one fresh 12-byte IV per
 * record, never reused.
 *
 * ### Why AES-GCM and not AES-CBC + HMAC
 * GCM is authenticated by construction: a wrong key, a flipped ciphertext bit
 * or a swapped record all fail the 128-bit authentication tag and throw. This
 * is what lets the unlock flow (`src/lib/vault`) verify a passphrase with **no
 * separate verifier hash and no comparison in JS** — there is nothing to time
 * and nothing to leak.
 *
 * ### IV discipline
 * GCM catastrophically fails if an (key, IV) pair is ever reused: the
 * authentication key is recoverable. We therefore generate a fresh 96-bit
 * random IV for every single encryption and never derive, counter or cache
 * one. At 2^32 records the collision probability is still ~2^-33; a personal
 * health vault is many orders of magnitude below that.
 *
 * ### Associated data
 * Every row is encrypted with AAD binding it to its table name and primary
 * key. An attacker with write access to IndexedDB therefore cannot move a
 * ciphertext from `weightEntries` into `foodLogs`, nor swap two rows within a
 * table — the tag check fails.
 */

import { getCrypto, randomBytes, toArrayBuffer, toBase64Url, utf8 } from './random';

/** IV length in bytes. 96 bits is the GCM-recommended size. */
export const IV_BYTES = 12;

/** GCM authentication tag length in bits. */
export const TAG_BITS = 128;

/**
 * An AES-GCM ciphertext together with the IV it was produced under.
 *
 * `ct` includes the 16-byte authentication tag appended by WebCrypto.
 */
export interface EncryptedPayload {
  /** 12-byte initialisation vector, unique per encryption. */
  readonly iv: Uint8Array;
  /** Ciphertext ‖ 16-byte GCM tag. */
  readonly ct: Uint8Array;
}

/**
 * Raised when decryption fails: wrong key, tampered ciphertext, wrong AAD, or
 * a truncated record.
 *
 * The vault deliberately surfaces this *undifferentiated* — the app must never
 * tell an attacker which of those four it was.
 */
export class DecryptionError extends Error {
  /** Optional context (table + id) to aid debugging, never shown to the user. */
  readonly context: string | undefined;

  constructor(message = 'Decryption failed', context?: string) {
    super(message);
    this.name = 'DecryptionError';
    this.context = context;
  }
}

/**
 * Generate a fresh AES-256-GCM content key.
 *
 * @param extractable whether the raw bytes may be exported. The session DEK is
 *   imported non-extractable; only key generation and re-wrapping use `true`.
 * @returns a new random 256-bit AES-GCM key
 */
export async function generateContentKey(extractable = true): Promise<CryptoKey> {
  return getCrypto().subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Import raw 32-byte key material as an AES-GCM key.
 *
 * @param raw exactly 32 bytes
 * @param extractable whether the key may later be exported back to bytes
 * @returns the imported key
 */
export async function importContentKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) {
    throw new RangeError(`importContentKey: expected 32 bytes, got ${raw.length}`);
  }
  return getCrypto().subtle.importKey('raw', toArrayBuffer(raw), 'AES-GCM', extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Export an extractable AES key back to raw bytes.
 *
 * Callers **must** {@link import('./random').zeroBytes} the result as soon as
 * they are finished with it.
 *
 * @param key an extractable AES-GCM key
 * @returns the raw 32-byte key material
 */
export async function exportContentKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await getCrypto().subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

/**
 * Encrypt arbitrary bytes under a fresh random IV.
 *
 * @param key AES-GCM key
 * @param plaintext bytes to protect
 * @param aad optional associated data — authenticated but not encrypted. Must
 *   be supplied byte-identically at decryption time.
 * @returns the IV and ciphertext‖tag
 */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<EncryptedPayload> {
  const iv = randomBytes(IV_BYTES);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: toArrayBuffer(iv),
    tagLength: TAG_BITS,
  };
  if (aad) params.additionalData = toArrayBuffer(aad);
  const ct = await getCrypto().subtle.encrypt(params, key, toArrayBuffer(plaintext));
  return { iv, ct: new Uint8Array(ct) };
}

/**
 * Decrypt bytes produced by {@link encryptBytes}.
 *
 * @param key AES-GCM key
 * @param payload the stored IV and ciphertext
 * @param aad the exact associated data used at encryption time
 * @param context optional debugging label, e.g. `'weightEntries:<id>'`
 * @returns the recovered plaintext bytes
 * @throws {DecryptionError} whenever the GCM tag does not verify — which is
 *   the *only* signal for a wrong passphrase anywhere in this codebase
 */
export async function decryptBytes(
  key: CryptoKey,
  payload: EncryptedPayload,
  aad?: Uint8Array,
  context?: string,
): Promise<Uint8Array> {
  if (payload.iv.length !== IV_BYTES) {
    throw new DecryptionError(`Malformed record: IV is ${payload.iv.length} bytes`, context);
  }
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: toArrayBuffer(payload.iv),
    tagLength: TAG_BITS,
  };
  if (aad) params.additionalData = toArrayBuffer(aad);
  try {
    const pt = await getCrypto().subtle.decrypt(params, key, toArrayBuffer(payload.ct));
    return new Uint8Array(pt);
  } catch {
    // Deliberately swallow the underlying OperationError: its message differs
    // between engines and we never want to give a caller a reason to branch.
    throw new DecryptionError('Decryption failed', context);
  }
}

/**
 * Encrypt a JSON-serialisable value.
 *
 * @typeParam T the value's static type; recovered by {@link decryptJson}
 * @param key AES-GCM key
 * @param value any value `JSON.stringify` can represent. `undefined`,
 *   functions and cyclic references are rejected.
 * @param aad optional associated data
 * @returns the IV and ciphertext of the UTF-8 JSON encoding
 */
export async function encryptJson<T>(
  key: CryptoKey,
  value: T,
  aad?: Uint8Array,
): Promise<EncryptedPayload> {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw new TypeError('encryptJson: value is not JSON-serialisable');
  }
  return encryptBytes(key, utf8(json), aad);
}

/**
 * Decrypt and parse a value written by {@link encryptJson}.
 *
 * @typeParam T the expected shape. **Not validated at runtime** — the GCM tag
 *   already guarantees the bytes are ours; shape drift is a migration concern,
 *   handled by the `v` column in `src/lib/db`.
 * @param key AES-GCM key
 * @param payload the stored IV and ciphertext
 * @param aad the exact associated data used at encryption time
 * @param context optional debugging label
 * @returns the parsed value
 * @throws {DecryptionError} on tag failure or on non-JSON plaintext
 */
export async function decryptJson<T>(
  key: CryptoKey,
  payload: EncryptedPayload,
  aad?: Uint8Array,
  context?: string,
): Promise<T> {
  const pt = await decryptBytes(key, payload, aad, context);
  try {
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    throw new DecryptionError('Decrypted plaintext is not valid JSON', context);
  }
}

/**
 * Build the associated-data bytes that bind a ciphertext to its location.
 *
 * @param table the Dexie table name
 * @param id the row's primary key
 * @returns UTF-8 of `hcv1|<table>|<id>`
 */
export function rowAad(table: string, id: string): Uint8Array {
  return utf8(`hcv1|${table}|${id}`);
}

/**
 * SHA-256 digest.
 *
 * @param bytes input
 * @returns 32-byte digest
 */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const d = await getCrypto().subtle.digest('SHA-256', toArrayBuffer(bytes));
  return new Uint8Array(d);
}


/**
 * Derive the HMAC-SHA-256 **index key** from the raw DEK.
 *
 * An AES-GCM key cannot be used for `sign`, so blind indexing needs a sibling
 * key. HKDF with a distinct `info` label makes it cryptographically
 * independent of the encryption usage: compromising one tells you nothing
 * about the other.
 *
 * Derived exactly once per unlock by `src/lib/vault`.
 *
 * @param rawDek the raw 32-byte data encryption key
 * @returns a non-extractable HMAC-SHA-256 signing key
 */
export async function deriveIndexKey(rawDek: Uint8Array): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const base = await subtle.importKey('raw', toArrayBuffer(rawDek), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(new Uint8Array(0)),
      info: toArrayBuffer(utf8('hcvault/blind-index/v1')),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/**
 * Compute a deterministic, keyed **blind index** for a value the vault must be
 * able to look up by exact match but must not store in the clear.
 *
 * This is how `sourceKey` (idempotent re-import), exercise slugs and
 * integration provider names are indexed. The same input under the same index
 * key always yields the same token; without the key the token reveals nothing
 * about its input. Range and prefix queries are impossible on a blind index by
 * construction — that is the trade being made, and it is documented per-table
 * in `docs/kg/specs/vault-schema.md`.
 *
 * Truncated to 128 bits: the birthday bound is ~2^64 rows, astronomically
 * beyond a personal vault, and short keys keep the IndexedDB b-tree small.
 *
 * @param indexKey the HMAC key from {@link deriveIndexKey}
 * @param domain namespace so the same string in two tables yields different
 *   tokens, e.g. `'weightEntries.sourceKey'`
 * @param value the plaintext value to index
 * @returns a 22-character base64url token (128 bits)
 */
export async function blindIndex(
  indexKey: CryptoKey,
  domain: string,
  value: string,
): Promise<string> {
  const sig = await getCrypto().subtle.sign(
    'HMAC',
    indexKey,
    toArrayBuffer(utf8(`${domain} ${value}`)),
  );
  return toBase64Url(new Uint8Array(sig).subarray(0, 16));
}
