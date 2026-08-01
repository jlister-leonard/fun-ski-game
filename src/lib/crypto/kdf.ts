/**
 * @file Key derivation. Turns a *secret the human supplies* into a KEK
 * (key-encryption key) that wraps the vault DEK.
 *
 * Two derivation paths, deliberately different:
 *
 * | Input                         | KDF                       | Why                                    |
 * |-------------------------------|---------------------------|----------------------------------------|
 * | Passphrase / recovery code    | PBKDF2-SHA-256, 600k iter | low-entropy human input needs stretching |
 * | Passkey PRF output, 32 bytes  | HKDF-SHA-256              | already uniformly random; stretching is pointless cost |
 *
 * 600,000 iterations is the OWASP 2023 floor for PBKDF2-SHA-256 and is what
 * `docs/kg/ARCHITECTURE.md` §3 mandates. On an A17 iPhone this costs roughly
 * 0.3–0.6 s — deliberately noticeable, once per unlock.
 */

import { fromBase64Url, getCrypto, randomBytes, toArrayBuffer, utf8, zeroBytes } from './random';

/** OWASP 2023 minimum for PBKDF2-SHA-256. Do not lower this. */
export const PBKDF2_ITERATIONS = 600_000;

/** Salt length for PBKDF2, in bytes. 16 bytes = 128 bits. */
export const KDF_SALT_BYTES = 16;

/** Derived key length in bits. AES-256. */
export const KEK_BITS = 256;

/**
 * How a particular {@link import('./keyring').WrappedKey} derived its KEK.
 *
 * Stored in plaintext alongside the wrapped DEK — none of it is secret, and
 * all of it is required to reproduce the derivation on another device or from
 * a backup file.
 */
export type KdfDescriptor =
  | {
      readonly kind: 'pbkdf2-sha256';
      /** base64url, {@link KDF_SALT_BYTES} bytes. */
      readonly salt: string;
      /** Iteration count actually used. Recorded so it can be raised later. */
      readonly iterations: number;
    }
  | {
      readonly kind: 'hkdf-sha256';
      /** base64url salt. */
      readonly salt: string;
      /** Domain-separation string mixed into HKDF-Expand. */
      readonly info: string;
    };

/**
 * Generate a fresh random PBKDF2 salt.
 *
 * A new salt is generated per wrapping, so two wrappings of the same DEK by
 * the same passphrase produce unrelated KEKs.
 *
 * @returns {@link KDF_SALT_BYTES} random bytes
 */
export function generateKdfSalt(): Uint8Array {
  return randomBytes(KDF_SALT_BYTES);
}

/**
 * Derive a 256-bit AES-GCM KEK from a human passphrase via PBKDF2-SHA-256.
 *
 * The returned key is **non-extractable**: it exists only to wrap and unwrap
 * the DEK, and JS can never read its bytes back out.
 *
 * @param passphrase the user's secret. Normalised to Unicode NFKC so that a
 *   passphrase typed with a composed vs. decomposed accent still unlocks.
 * @param salt per-wrapping random salt, {@link KDF_SALT_BYTES} bytes
 * @param iterations PBKDF2 iteration count; defaults to {@link PBKDF2_ITERATIONS}
 * @returns an AES-GCM `CryptoKey` usable for `encrypt`/`decrypt`
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('deriveKek: passphrase must be a non-empty string');
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(`deriveKek: iterations must be a positive integer, got ${iterations}`);
  }
  const subtle = getCrypto().subtle;
  const material = utf8(passphrase.normalize('NFKC'));
  try {
    const base = await subtle.importKey('raw', toArrayBuffer(material), 'PBKDF2', false, [
      'deriveKey',
    ]);
    return await subtle.deriveKey(
      { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: KEK_BITS },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    zeroBytes(material);
  }
}

/**
 * Derive a 256-bit AES-GCM KEK from an already-high-entropy secret via HKDF.
 *
 * This is the path for the WebAuthn PRF extension (Face ID unlock, node V4):
 * the authenticator returns 32 uniformly random bytes, so password stretching
 * would burn hundreds of milliseconds for zero security gain.
 *
 * @param secret at least 16 bytes of uniformly random material
 * @param salt per-wrapping random salt
 * @param info domain-separation label, e.g. `'hcvault/passkey-prf/v1'`
 * @returns an AES-GCM `CryptoKey` usable for `encrypt`/`decrypt`
 */
export async function deriveKekFromSecret(
  secret: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  if (secret.length < 16) {
    throw new RangeError(
      `deriveKekFromSecret: secret must be >= 16 bytes of high-entropy material, got ${secret.length}`,
    );
  }
  const subtle = getCrypto().subtle;
  const base = await subtle.importKey('raw', toArrayBuffer(secret), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(utf8(info)),
    },
    base,
    { name: 'AES-GCM', length: KEK_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Rebuild a KEK from a stored {@link KdfDescriptor} plus the human secret.
 *
 * The single entry point used at unlock time: the caller does not need to know
 * which KDF a given wrapping used.
 *
 * @param descriptor the stored, plaintext derivation parameters
 * @param secret the passphrase / recovery code (string) or PRF output (bytes)
 * @returns the reconstructed KEK
 */
export async function deriveKekFromDescriptor(
  descriptor: KdfDescriptor,
  secret: string | Uint8Array,
): Promise<CryptoKey> {
  const salt = fromBase64Url(descriptor.salt);
  if (descriptor.kind === 'pbkdf2-sha256') {
    if (typeof secret !== 'string') {
      throw new TypeError('deriveKekFromDescriptor: pbkdf2 wrappings require a string secret');
    }
    return deriveKek(secret, salt, descriptor.iterations);
  }
  if (typeof secret === 'string') {
    throw new TypeError('deriveKekFromDescriptor: hkdf wrappings require a raw byte secret');
  }
  return deriveKekFromSecret(secret, salt, descriptor.info);
}

/**
 * Measure how long {@link PBKDF2_ITERATIONS} takes on this device.
 *
 * The settings screen uses this to show an honest "unlock takes ~Ns here"
 * figure rather than guessing.
 *
 * @param iterations iteration count to benchmark; defaults to the production value
 * @returns elapsed milliseconds
 */
export async function benchmarkKdf(iterations: number = PBKDF2_ITERATIONS): Promise<number> {
  const salt = generateKdfSalt();
  const t0 = Date.now();
  await deriveKek('benchmark-passphrase', salt, iterations);
  return Date.now() - t0;
}
