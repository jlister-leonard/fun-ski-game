/**
 * @file Public surface of the crypto core (task graph node **V1**).
 *
 * Pure WebCrypto. No npm crypto dependencies, no polyfills, no network.
 * Everything here is browser-safe *and* Node-safe; nothing touches `window`,
 * `document` or `indexedDB`, so importing this module during a Next.js
 * build-time prerender is inert.
 *
 * Read the module-level docs in `keyring.ts` first — it explains the hierarchy
 * the rest of this package exists to serve.
 */

export {
  CryptoUnavailableError,
  bytesToHex,
  concatBytes,
  constantTimeEqual,
  fromBase64Url,
  fromUtf8,
  getCrypto,
  isCryptoAvailable,
  randomBytes,
  randomId,
  toArrayBuffer,
  toBase64Url,
  utf8,
  zeroBytes,
} from './random';

export {
  KDF_SALT_BYTES,
  KEK_BITS,
  PBKDF2_ITERATIONS,
  benchmarkKdf,
  deriveKek,
  deriveKekFromDescriptor,
  deriveKekFromSecret,
  generateKdfSalt,
  type KdfDescriptor,
} from './kdf';

export {
  DecryptionError,
  IV_BYTES,
  TAG_BITS,
  blindIndex,
  decryptBytes,
  decryptJson,
  deriveIndexKey,
  encryptBytes,
  encryptJson,
  exportContentKey,
  generateContentKey,
  importContentKey,
  rowAad,
  sha256,
  type EncryptedPayload,
} from './aead';

export {
  KEYRING_VERSION,
  UnlockFailedError,
  addPassphraseWrapping,
  addRecoveryCodeWrapping,
  addSecretWrapping,
  changePassphraseInKeyring,
  createKeyring,
  exportDek,
  generateDek,
  importDek,
  isKeyring,
  removeWrapping,
  summarizeKeyring,
  unlockKeyring,
  unlockWithRecoveryCode,
  unwrapDek,
  wrapDek,
  type Keyring,
  type RecoveryCodeIssue,
  type UnlockResult,
  type WrapMethod,
  type WrappedKey,
  type WrappedKeySummary,
} from './keyring';

export {
  CROCKFORD_ALPHABET,
  RECOVERY_CODE_CHARS,
  RECOVERY_ENTROPY_BYTES,
  RecoveryCodeError,
  crc32,
  deriveRecoveryKek,
  formatRecoveryCode,
  generateRecoveryCode,
  isValidRecoveryCode,
  normalizeRecoveryInput,
  parseRecoveryCode,
  type RecoveryCode,
} from './recovery-code';
