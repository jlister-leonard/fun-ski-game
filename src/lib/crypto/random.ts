/**
 * @file Randomness and byte-encoding primitives.
 *
 * Zero dependencies, zero network, works identically in the browser and in
 * Node 22 (both expose WebCrypto as `globalThis.crypto`).
 *
 * Base64url is implemented by hand rather than via `btoa`/`atob` so that the
 * behaviour is identical everywhere and binary-safe for bytes >= 0x80.
 */

/** Thrown when WebCrypto is not available in the current environment. */
export class CryptoUnavailableError extends Error {
  constructor(detail: string) {
    super(`WebCrypto unavailable: ${detail}`);
    this.name = 'CryptoUnavailableError';
  }
}

/**
 * Return the ambient WebCrypto object, throwing a clear error when absent.
 *
 * Called lazily by every primitive in this package so that importing the
 * module during a Next.js build-time prerender can never throw.
 *
 * @returns the global {@link Crypto} instance
 * @throws {CryptoUnavailableError} when `globalThis.crypto.subtle` is missing
 *   (e.g. a non-secure browser context, or a very old runtime)
 */
export function getCrypto(): Crypto {
  const c: Crypto | undefined = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new CryptoUnavailableError('globalThis.crypto.getRandomValues is missing');
  }
  if (!c.subtle) {
    throw new CryptoUnavailableError(
      'crypto.subtle is missing — the page must be served over HTTPS or localhost',
    );
  }
  return c;
}

/** True when WebCrypto (including SubtleCrypto) is usable right now. */
export function isCryptoAvailable(): boolean {
  try {
    getCrypto();
    return true;
  } catch {
    return false;
  }
}

/**
 * Cryptographically secure random bytes.
 *
 * @param length number of bytes to generate
 * @returns a fresh `Uint8Array` of exactly `length` bytes
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`randomBytes: length must be a non-negative integer, got ${length}`);
  }
  const out = new Uint8Array(length);
  // getRandomValues is capped at 65536 bytes per call.
  const c = getCrypto();
  for (let offset = 0; offset < length; offset += 65536) {
    c.getRandomValues(out.subarray(offset, Math.min(offset + 65536, length)));
  }
  return out;
}

/**
 * A RFC 4122 v4 UUID, used as the primary key of every vault row.
 *
 * Falls back to a hand-rolled v4 when `crypto.randomUUID` is unavailable
 * (Safari exposes it only in secure contexts on older versions).
 *
 * @returns a lowercase hyphenated UUID string
 */
export function randomId(): string {
  const c = getCrypto();
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = bytesToHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Reverse lookup table for {@link fromBase64Url}; index = char code. */
const B64URL_LOOKUP: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) t[B64URL_ALPHABET.charCodeAt(i)] = i;
  // Accept standard base64 characters too, so hand-edited files still parse.
  t['+'.charCodeAt(0)] = 62;
  t['/'.charCodeAt(0)] = 63;
  return t;
})();

/**
 * Encode bytes as unpadded base64url (RFC 4648 §5).
 *
 * @param bytes input buffer
 * @returns an ASCII string containing only `A-Za-z0-9-_`
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63] +
      B64URL_ALPHABET[(n >>> 12) & 63] +
      B64URL_ALPHABET[(n >>> 6) & 63] +
      B64URL_ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64URL_ALPHABET[(n >>> 18) & 63] + B64URL_ALPHABET[(n >>> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63] +
      B64URL_ALPHABET[(n >>> 12) & 63] +
      B64URL_ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/**
 * Decode unpadded (or padded) base64url back to bytes.
 *
 * @param text base64url text; `=` padding and whitespace are tolerated
 * @returns the decoded bytes
 * @throws {TypeError} on any character outside the alphabet
 */
export function fromBase64Url(text: string): Uint8Array {
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '=' || ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
    const code = text.charCodeAt(i);
    if (code > 127 || B64URL_LOOKUP[code] < 0) {
      throw new TypeError(`fromBase64Url: invalid character ${JSON.stringify(ch)} at index ${i}`);
    }
    clean += ch;
  }
  const outLen = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64URL_LOOKUP[clean.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * Lowercase hex encoding. Used for debugging and for the vault fingerprint.
 *
 * @param bytes input buffer
 */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * UTF-8 encode a string.
 *
 * @param text input string
 */
export function utf8(text: string): Uint8Array {
  return TEXT_ENCODER.encode(text);
}

/**
 * UTF-8 decode bytes.
 *
 * @param bytes input buffer
 * @throws {TypeError} when the bytes are not valid UTF-8
 */
export function fromUtf8(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

/**
 * Constant-time byte comparison.
 *
 * Length is compared first and leaks (it always does — the buffers have a
 * visible `.length`), but content comparison never short-circuits.
 *
 * @param a first buffer
 * @param b second buffer
 * @returns true when the buffers are byte-identical
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Overwrite a buffer with zeroes in place.
 *
 * This is best-effort hygiene, not a guarantee: a JS engine may have copied
 * the bytes during GC. It still meaningfully shortens the window in which raw
 * key material sits in a heap snapshot.
 *
 * @param buf the buffer to wipe; safe to call with `null`/`undefined`
 */
export function zeroBytes(buf: Uint8Array | null | undefined): void {
  if (!buf) return;
  buf.fill(0);
}

/**
 * Concatenate byte buffers.
 *
 * @param parts buffers to join, in order
 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Copy a `Uint8Array` into a standalone `ArrayBuffer`.
 *
 * Needed because `subarray`/`slice` views share their parent buffer, and
 * WebCrypto + structured clone both operate on the *whole* backing buffer.
 *
 * @param bytes input view
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
