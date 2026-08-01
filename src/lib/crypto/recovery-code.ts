/**
 * @file Printable recovery codes.
 *
 * `docs/kg/ARCHITECTURE.md` §4 is blunt: a forgotten passphrase means an
 * unrecoverable vault. The recovery code is the user's opt-in safety net — a
 * second, independent wrapping of the same DEK, generated once at setup,
 * written down on paper, and never stored on the device.
 *
 * ### Format
 * ```
 * XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX      28 chars, 7 groups of 4
 * └──────── 24 data chars ────────┘└ 4 ┘   120 bits entropy + 20-bit checksum
 * ```
 *
 * ### Alphabet
 * Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) — chosen because it
 * omits `I`, `L`, `O` and `U`, so the classic transcription confusions
 * (`0`/`O`, `1`/`I`/`l`) cannot occur, and because it defines canonical
 * aliases: a user who writes `O` gets `0`, `I` or `L` gets `1`. Case is
 * irrelevant. `U` is excluded from the alphabet so that random codes cannot
 * spell obscenities.
 *
 * ### Checksum
 * CRC-32 of the 15 data bytes, top 20 bits, encoded as the last 4 characters.
 * This is a **typo detector, not a security control** — it is unkeyed and
 * public. It exists so the UI can say "that code has a typo in it" instead of
 * spending 600,000 PBKDF2 iterations to say "wrong code". A single mistyped
 * character is always caught; a random 28-character string passes with
 * probability 2^-20 ≈ 1 in a million.
 *
 * ### Entropy
 * 120 bits. Even with PBKDF2 stripped away entirely, brute force is
 * infeasible. The 600k iterations are still applied for uniformity with the
 * passphrase path.
 */

import { randomBytes } from './random';
import { deriveKek, generateKdfSalt, PBKDF2_ITERATIONS } from './kdf';

/** Crockford base32 alphabet — no I, L, O or U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Number of random bytes behind a code. 15 bytes = 120 bits = 24 chars exactly. */
export const RECOVERY_ENTROPY_BYTES = 15;

/** Data characters (before the checksum). */
export const RECOVERY_DATA_CHARS = 24;

/** Checksum characters appended to the data characters. */
export const RECOVERY_CHECKSUM_CHARS = 4;

/** Total characters, ignoring group separators. */
export const RECOVERY_CODE_CHARS = RECOVERY_DATA_CHARS + RECOVERY_CHECKSUM_CHARS;

/** Characters per hyphen-separated group in the printable form. */
export const RECOVERY_GROUP_SIZE = 4;

/** Thrown when a supplied recovery code is malformed or fails its checksum. */
export class RecoveryCodeError extends Error {
  /** Machine-readable cause, so the UI can pick the right copy. */
  readonly reason: 'length' | 'alphabet' | 'checksum';

  constructor(reason: 'length' | 'alphabet' | 'checksum', message: string) {
    super(message);
    this.name = 'RecoveryCodeError';
    this.reason = reason;
  }
}

/** A parsed, checksum-valid recovery code. */
export interface RecoveryCode {
  /** Human form with hyphens, e.g. `A1B2-C3D4-...`. This is what gets printed. */
  readonly formatted: string;
  /** Canonical uppercase form, 28 characters, no separators. */
  readonly normalized: string;
  /** The 15 bytes of entropy the code encodes. */
  readonly bytes: Uint8Array;
}

/** Reverse alphabet lookup including Crockford's aliases. */
const CROCKFORD_VALUES: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) m.set(CROCKFORD_ALPHABET[i], i);
  m.set('O', 0);
  m.set('I', 1);
  m.set('L', 1);
  return m;
})();

/** Precomputed CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) table. */
const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 (IEEE) over a byte buffer.
 *
 * Synchronous by design: the checksum must be verifiable as the user types,
 * and WebCrypto's digest API is async.
 *
 * @param bytes input
 * @returns the unsigned 32-bit checksum
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Pack bytes into Crockford base32, MSB-first.
 *
 * @param bytes input, whose bit length must be a multiple of 5
 * @returns the encoded characters
 */
function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Encode a 20-bit checksum as exactly 4 Crockford characters.
 *
 * @param bytes the data bytes to checksum
 */
function checksumChars(bytes: Uint8Array): string {
  const top20 = crc32(bytes) >>> 12;
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) out += CROCKFORD_ALPHABET[(top20 >>> shift) & 31];
  return out;
}

/**
 * Insert group separators into a canonical 28-character code.
 *
 * @param normalized the canonical, separator-free code
 * @returns the printable hyphenated form
 */
export function formatRecoveryCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(normalized.slice(i, i + RECOVERY_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Generate a fresh recovery code with 120 bits of entropy.
 *
 * The caller is responsible for showing it to the user **exactly once** and
 * never persisting it. Only its DEK wrapping is stored.
 *
 * @returns the formatted, normalized and raw forms of a new code
 */
export function generateRecoveryCode(): RecoveryCode {
  const bytes = randomBytes(RECOVERY_ENTROPY_BYTES);
  const normalized = encodeBase32(bytes) + checksumChars(bytes);
  return { formatted: formatRecoveryCode(normalized), normalized, bytes };
}

/**
 * Normalise user input: uppercase, strip everything that is not a base32
 * character (hyphens, spaces, stray punctuation), and resolve Crockford
 * aliases so `O`→`0` and `I`/`L`→`1`.
 *
 * @param input whatever the user typed or pasted
 * @returns the canonical character sequence, not yet length- or checksum-checked
 */
export function normalizeRecoveryInput(input: string): string {
  let out = '';
  const upper = input.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    const v = CROCKFORD_VALUES.get(ch);
    if (v === undefined) continue;
    out += CROCKFORD_ALPHABET[v];
  }
  return out;
}

/**
 * Parse and validate a recovery code the user typed.
 *
 * @param input the raw user input, in any casing and with any separators
 * @returns the parsed code
 * @throws {RecoveryCodeError} with `reason` `'length'` when the wrong number
 *   of base32 characters was supplied, or `'checksum'` when the code is the
 *   right shape but contains a transcription error
 */
export function parseRecoveryCode(input: string): RecoveryCode {
  const normalized = normalizeRecoveryInput(input);
  if (normalized.length !== RECOVERY_CODE_CHARS) {
    throw new RecoveryCodeError(
      'length',
      `Recovery code must be ${RECOVERY_CODE_CHARS} characters, got ${normalized.length}`,
    );
  }
  const dataChars = normalized.slice(0, RECOVERY_DATA_CHARS);
  const given = normalized.slice(RECOVERY_DATA_CHARS);

  // 24 chars * 5 bits = 120 bits = exactly 15 bytes.
  const bytes = new Uint8Array(RECOVERY_ENTROPY_BYTES);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < dataChars.length; i++) {
    acc = (acc << 5) | CROCKFORD_ALPHABET.indexOf(dataChars[i]);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >>> bits) & 0xff;
    }
  }
  if (checksumChars(bytes) !== given) {
    throw new RecoveryCodeError(
      'checksum',
      'Recovery code checksum failed — there is a typo in the code',
    );
  }
  return { formatted: formatRecoveryCode(normalized), normalized, bytes };
}

/**
 * Non-throwing validity check, for live form validation.
 *
 * @param input the raw user input
 * @returns true when the code parses and its checksum verifies
 */
export function isValidRecoveryCode(input: string): boolean {
  try {
    parseRecoveryCode(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive a KEK from a recovery code.
 *
 * Runs the code's canonical form through the same PBKDF2 ladder as a
 * passphrase. Belt-and-braces: the code already has 120 bits of entropy, but
 * uniform treatment means one code path and no special cases at unlock.
 *
 * @param code a parsed code, or raw user input (which is parsed first)
 * @param salt the wrapping's stored salt
 * @param iterations PBKDF2 iterations; defaults to {@link PBKDF2_ITERATIONS}
 * @returns the KEK that wraps the DEK for this recovery code
 * @throws {RecoveryCodeError} when raw input fails to parse
 */
export async function deriveRecoveryKek(
  code: RecoveryCode | string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const parsed = typeof code === 'string' ? parseRecoveryCode(code) : code;
  return deriveKek(parsed.normalized, salt, iterations);
}

/**
 * Convenience: a fresh salt for a recovery-code wrapping.
 *
 * Re-exported here so callers wrapping a DEK with a recovery code do not need
 * to reach into `kdf.ts`.
 */
export { generateKdfSalt };
