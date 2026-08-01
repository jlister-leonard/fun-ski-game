/**
 * @file `.hcvault` backup export and import (task graph node **V5**).
 *
 * ## Why this file is load-bearing
 * `ARCHITECTURE.md` §3 spells out the risk: iOS Safari evicts IndexedDB for
 * regular sites after ~7 days of inactivity, and only Home Screen web apps are
 * exempt. There is no server copy. **The backup file is the only durable
 * copy of the user's health data that exists.**
 *
 * ## The vault-only format
 * Format 2 is a single UTF-8 JSON document. Self-describing, inspectable in a text editor,
 * and — most importantly — **decryptable with the passphrase or recovery code
 * alone**, with nothing left behind on the original device:
 *
 * ```jsonc
 * {
 *   "format": "hcvault",
 *   "formatVersion": 2,
 *   "createdAt": "2026-07-26T09:14:22.031Z",
 *   "app": { "dbVersion": 1, "bodyVersion": 1 },
 *   "vaultId": "…",
 *   "keyring": { …every wrapped-key record… },   // ← makes it self-contained
 *   "recordCount": 4213,
 *   "tables": {
 *     "weightEntries": [ { "id":…, "updatedAt":…, "deleted":0, "v":1,
 *                          "dateKey":"2026-07-26", "sourceHash":"…",
 *                          "iv":"b64url", "ct":"b64url" } ]
 *   },
 *   "integrity": { "algorithm": "HMAC-SHA-256", "tag": "b64url" }
 * }
 * ```
 *
 * Rows travel **still encrypted**, byte-identical to what was in IndexedDB.
 * Export opens the copied keyring with a supplied passphrase or recovery code
 * to authenticate the complete envelope, but never decrypts row content and
 * does not require an already-unlocked local session.
 *
 * The v2 `integrity` tag is HMAC-SHA-256 over a canonical (key-sorted)
 * serialisation of every field except `integrity` itself, under a key derived
 * from the raw DEK with a backup-only HKDF label. It proves that no table, row,
 * ciphertext, schema header, or plaintext index was removed or changed.
 * Per-row AES-GCM tags independently bind each body to its table + id.
 *
 * Format 3, implemented in `media-backup.ts`, wraps this authenticated vault
 * envelope in a signed binary container and appends raw media ciphertexts.
 * Keeping the formats separate preserves every existing format-2 import.
 */

import {
  blindIndex,
  fromBase64Url,
  getCrypto,
  isKeyring,
  KEYRING_VERSION,
  toArrayBuffer,
  toBase64Url,
  unlockKeyring,
  unlockWithRecoveryCode as unlockKeyringWithRecoveryCode,
  utf8,
  zeroBytes,
  deriveIndexKey,
  importDek,
  type Keyring,
  type WrappedKeySummary,
} from '../crypto';
import { encodeRow, decodeRow, type CodecKeys } from '../db/codec';
import { getDb, getMeta, setMeta } from '../db/db';
import {
  BODY_VERSION,
  DB_VERSION,
  META_KEYS,
  TABLE_SPECS,
  VAULT_TABLES,
  type StoredRow,
  type VaultTableName,
} from '../db/schema';
import type { BaseRecord } from '../db/types';
import { requireKeys } from './session';
import { loadKeyring, resetSessionAfterRestore } from './vault';

/** Current `.hcvault` format version. */
export const BACKUP_FORMAT_VERSION = 2;

/** The `format` discriminator every file carries. */
export const BACKUP_FORMAT = 'hcvault';

/** Suggested file extension. */
export const BACKUP_EXTENSION = '.hcvault';

/** A row as it appears inside a backup file: binary fields base64url-encoded. */
export interface BackupRow {
  id: string;
  updatedAt: number;
  deleted: 0 | 1;
  v: number;
  /** base64url of the 12-byte IV. */
  iv: string;
  /** base64url of the ciphertext ‖ GCM tag. */
  ct: string;
  dateKey?: string;
  type?: string;
  sourceHash?: string;
  sessionId?: string;
  exerciseId?: string;
  mesocycleId?: string;
  programId?: string;
}

/** The complete `.hcvault` envelope. */
export interface BackupEnvelope {
  readonly format: typeof BACKUP_FORMAT;
  readonly formatVersion: number;
  /** ISO-8601 instant the file was written. */
  readonly createdAt: string;
  /** Schema versions the writing app was on, for forward-compatibility checks. */
  readonly app: { readonly dbVersion: number; readonly bodyVersion: number };
  readonly vaultId: string;
  /** Every DEK wrapping. This is what makes the file self-contained. */
  readonly keyring: Keyring;
  /** Total rows across every table. */
  readonly recordCount: number;
  /** Encrypted rows, grouped by table. */
  readonly tables: Readonly<Partial<Record<VaultTableName, readonly BackupRow[]>>>;
  /**
   * Keyed authenticator over everything above.
   *
   * The HMAC key is purpose-separated from the DEK with HKDF. Unlike the v1
   * public SHA-256 checksum, this proves both that every present row is genuine
   * and that no table, row, or plaintext index header was removed or changed.
   */
  readonly integrity: { readonly algorithm: 'HMAC-SHA-256'; readonly tag: string };
}

/** Raised when a file is not a usable `.hcvault`. */
export class BackupFormatError extends Error {
  /** Machine-readable cause so the UI can pick the right copy. */
  readonly reason: 'not-json' | 'not-hcvault' | 'version' | 'integrity' | 'keyring';

  constructor(reason: BackupFormatError['reason'], message: string) {
    super(message);
    this.name = 'BackupFormatError';
    this.reason = reason;
  }
}

/** The secret used to open a backup. */
export type ImportSecret =
  | { readonly kind: 'passphrase'; readonly value: string }
  | { readonly kind: 'recovery-code'; readonly value: string };

/** What a dry run reports before anything is written. */
export interface BackupPreview {
  /** Format version of the file. */
  readonly formatVersion: number;
  /** ISO-8601 instant the file was written. */
  readonly createdAt: string;
  /** Vault the backup came from. */
  readonly vaultId: string;
  /** Whether that is the vault currently on this device. */
  readonly sameVault: boolean;
  /** Total rows in the file. */
  readonly recordCount: number;
  /** Per-table row counts. */
  readonly byTable: Readonly<Partial<Record<VaultTableName, number>>>;
  /** Whether the keyed whole-envelope authenticator matched. */
  readonly integrityOk: boolean;
  /** Whether the supplied secret actually opened the backup's keyring. */
  readonly canDecrypt: boolean;
  /** Whether every recognized encrypted row authenticated and decoded. */
  readonly recordsOk: boolean;
  /** Whether this app understands the database and record-body versions. */
  readonly compatible: boolean;
  /** True only when every restore precondition has passed. */
  readonly restorable: boolean;
  /** The ways this backup can be opened, secrets stripped. */
  readonly wrappings: readonly WrappedKeySummary[];
  /** Schema versions the file was written with. */
  readonly app: { readonly dbVersion: number; readonly bodyVersion: number };
  /** Rows currently on this device, for a before/after comparison. */
  readonly currentRecordCount: number;
  /** Human-readable notes: version skew, cross-vault import, and so on. */
  readonly warnings: readonly string[];
}

/** How an import should reconcile with what is already on the device. */
export type ImportMode =
  /**
   * Wipe the device and adopt the backup wholesale, keyring included.
   *
   * Fast — rows are written back byte-identically with no re-encryption — and
   * it is the only mode available when the device has no vault yet. After it
   * the device unlocks with the *backup's* passphrase.
   */
  | 'replace'
  /**
   * Keep the device's vault and fold the backup's rows in, last-write-wins by
   * `updatedAt`.
   *
   * Requires the local vault to be **unlocked**, because rows encrypted under
   * the backup's DEK must be decrypted and re-encrypted under this device's.
   */
  | 'merge';

/** What an import actually did. */
export interface ImportResult {
  readonly mode: ImportMode;
  /** Rows written. */
  readonly applied: number;
  /** Rows skipped because the local copy was newer. */
  readonly skipped: number;
  /** Rows that could not be decrypted or re-encrypted. */
  readonly failed: number;
  readonly byTable: Readonly<Partial<Record<VaultTableName, number>>>;
  /** True when nothing was written because this was a dry run. */
  readonly dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Canonical serialisation + authenticated integrity
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted, so two runs over the same data
 * produce byte-identical output and therefore the same authenticator input.
 *
 * @param value any JSON-serialisable value
 * @returns the canonical JSON text
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Domain-separation label for the v2 backup authenticator.
 *
 * The vault also derives a blind-index HMAC key from the same raw DEK. A
 * distinct HKDF `info` value ensures the two keys are cryptographically
 * independent even though they share input key material.
 */
const BACKUP_AUTH_INFO = 'hcvault/backup-integrity/v2';

/** Derive the non-extractable HMAC key used only for backup envelopes. */
async function deriveBackupAuthKey(
  rawDek: Uint8Array,
  usage: readonly KeyUsage[],
): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const base = await subtle.importKey(
    'raw',
    toArrayBuffer(rawDek),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(new Uint8Array(0)),
      info: toArrayBuffer(utf8(BACKUP_AUTH_INFO)),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    [...usage],
  );
}

/**
 * Compute the keyed authenticator over an envelope minus `integrity`.
 *
 * @param envelope every field whose completeness and ordering matter
 * @param rawDek raw backup DEK, zeroed by the caller
 * @returns base64url HMAC-SHA-256 tag
 */
async function computeAuthenticator(
  envelope: Omit<BackupEnvelope, 'integrity'>,
  rawDek: Uint8Array,
): Promise<string> {
  const key = await deriveBackupAuthKey(rawDek, ['sign']);
  const signature = await getCrypto().subtle.sign(
    'HMAC',
    key,
    toArrayBuffer(utf8(canonicalJson(envelope))),
  );
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Verify the keyed authenticator in WebCrypto.
 *
 * `SubtleCrypto.verify()` performs the tag comparison inside the crypto
 * implementation rather than with an early-exit JavaScript string comparison.
 */
async function verifyAuthenticator(
  envelope: Omit<BackupEnvelope, 'integrity'>,
  encodedTag: string,
  rawDek: Uint8Array,
): Promise<boolean> {
  let tag: Uint8Array;
  try {
    tag = fromBase64Url(encodedTag);
  } catch {
    return false;
  }
  if (tag.byteLength !== 32) return false;
  const key = await deriveBackupAuthKey(rawDek, ['verify']);
  return getCrypto().subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(tag),
    toArrayBuffer(utf8(canonicalJson(envelope))),
  );
}

/** Convert a stored row to its base64url backup form. */
function toBackupRow(row: StoredRow): BackupRow {
  const out: BackupRow = {
    id: row.id,
    updatedAt: row.updatedAt,
    deleted: row.deleted,
    v: row.v,
    iv: toBase64Url(row.iv),
    ct: toBase64Url(row.ct),
  };
  if (row.dateKey !== undefined) out.dateKey = row.dateKey;
  if (row.type !== undefined) out.type = row.type;
  if (row.sourceHash !== undefined) out.sourceHash = row.sourceHash;
  if (row.sessionId !== undefined) out.sessionId = row.sessionId;
  if (row.exerciseId !== undefined) out.exerciseId = row.exerciseId;
  if (row.mesocycleId !== undefined) out.mesocycleId = row.mesocycleId;
  if (row.programId !== undefined) out.programId = row.programId;
  return out;
}

/** Convert a backup row back to its stored form. */
function fromBackupRow(row: BackupRow): StoredRow {
  const out: StoredRow = {
    id: row.id,
    updatedAt: row.updatedAt,
    deleted: row.deleted,
    v: row.v,
    iv: fromBase64Url(row.iv),
    ct: fromBase64Url(row.ct),
  };
  if (row.dateKey !== undefined) out.dateKey = row.dateKey;
  if (row.type !== undefined) out.type = row.type;
  if (row.sourceHash !== undefined) out.sourceHash = row.sourceHash;
  if (row.sessionId !== undefined) out.sessionId = row.sessionId;
  if (row.exerciseId !== undefined) out.exerciseId = row.exerciseId;
  if (row.mesocycleId !== undefined) out.mesocycleId = row.mesocycleId;
  if (row.programId !== undefined) out.programId = row.programId;
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Options for {@link exportVault}. */
export interface ExportOptions {
  /** Omit soft-deleted rows to shrink the file. Default false — tombstones
   *  matter, because without them a restore-then-reimport resurrects deletions. */
  excludeDeleted?: boolean;
}

/**
 * Serialise the whole vault to a `.hcvault` blob.
 *
 * Rows are copied out still encrypted. The supplied passphrase or recovery code
 * opens the copied keyring solely so the complete envelope can receive a v2
 * keyed authenticator. This works while the local vault session is locked; it
 * does not use or change the session.
 *
 * @param secret passphrase or recovery code that opens the copied keyring
 * @param options see {@link ExportOptions}
 * @returns a `application/json` blob, ready for a download anchor or the
 *   iOS share sheet
 * @throws {BackupFormatError} when this device has no usable keyring
 * @throws {import('../crypto').UnlockFailedError} when the secret is wrong
 */
export async function exportVault(
  secret: ImportSecret,
  options: ExportOptions = {},
): Promise<Blob> {
  const db = getDb();
  const body = await db.transaction('r', db.tables, async () => {
    const keyringRow = await db.vaultMeta.get(META_KEYS.keyring);
    if (!isKeyring(keyringRow?.value)) {
      throw new BackupFormatError(
        'keyring',
        'There is no usable vault on this device to export',
      );
    }
    const keyring = keyringRow.value;
    if (keyring.version !== KEYRING_VERSION) {
      throw new BackupFormatError(
        'version',
        `This vault uses keyring format ${keyring.version}; update Keel before exporting it.`,
      );
    }

    // Every known table is present, including empty ones. Besides producing a
    // self-describing file, this means the keyed authenticator proves that no
    // table was silently dropped.
    const tables = {} as Record<VaultTableName, BackupRow[]>;
    let recordCount = 0;
    for (const name of VAULT_TABLES) {
      const rows = await db.rows(name).toArray();
      const kept = options.excludeDeleted ? rows.filter((r) => r.deleted === 0) : rows;
      tables[name] = kept.map(toBackupRow);
      recordCount += kept.length;
    }

    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      app: { dbVersion: DB_VERSION, bodyVersion: BODY_VERSION },
      vaultId: keyring.vaultId,
      keyring,
      recordCount,
      tables,
    } satisfies Omit<BackupEnvelope, 'integrity'>;
  });

  const { rawDek } = await openBackupKeys(body.keyring, secret);
  try {
    const envelope: BackupEnvelope = {
      ...body,
      integrity: {
        algorithm: 'HMAC-SHA-256',
        tag: await computeAuthenticator(body, rawDek),
      },
    };
    return new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  } finally {
    zeroBytes(rawDek);
  }
}

/**
 * Record that a verified backup file was successfully handed to the user.
 *
 * Blob creation alone is not a backup: the passphrase check can fail, or the
 * iOS share sheet can be dismissed. The settings UI calls this only after both
 * verification and delivery have completed.
 *
 * @param at the successful delivery instant; defaults to now
 */
export async function recordBackupDelivered(at = Date.now()): Promise<void> {
  if (!Number.isFinite(at)) throw new TypeError('Backup delivery time must be finite');
  await setMeta(META_KEYS.lastBackupAt, at);
}

/** Whether a committed replace restore still needs its separate media DB cleared. */
export async function isMediaCleanupPending(): Promise<boolean> {
  return (await getMeta<boolean>(META_KEYS.pendingMediaCleanup)) === true;
}

/**
 * Record that the separate encrypted media database was successfully cleared.
 *
 * Clearing media first and this marker second is intentionally retry-safe: an
 * iOS kill between the two repeats an idempotent clear on next launch instead
 * of forgetting potentially orphaned ciphertext.
 */
export async function recordMediaCleanupComplete(): Promise<void> {
  await setMeta(META_KEYS.pendingMediaCleanup, false);
}

/**
 * A filename the user will recognise six months from now.
 *
 * @param at the instant to stamp; defaults to now
 * @returns e.g. `health-vault-2026-07-26.hcvault`
 */
export function suggestBackupFilename(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `health-vault-${y}-${m}-${d}${BACKUP_EXTENSION}`;
}

/**
 * Days since the last verified backup file was successfully delivered.
 *
 * Reads the unencrypted meta table, so the nag can render on the **lock
 * screen** — which is exactly where a user who has not opened the app in a
 * fortnight will see it.
 *
 * @returns whole days since the last backup, or `null` when there has never
 *   been one
 */
export async function daysSinceLastBackup(): Promise<number | null> {
  const at = await getMeta<number>(META_KEYS.lastBackupAt);
  if (typeof at !== 'number') return null;
  return Math.floor((Date.now() - at) / 86_400_000);
}

/**
 * Whether the user is overdue for a backup.
 *
 * @param thresholdDays how stale is too stale. Default 7 — Safari's eviction
 *   window for non-installed sites.
 * @returns true when there has never been a backup, or the last one is older
 *   than the threshold
 */
export async function isBackupOverdue(thresholdDays = 7): Promise<boolean> {
  const days = await daysSinceLastBackup();
  return days === null || days >= thresholdDays;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parse and structurally validate a `.hcvault` file.
 *
 * @param file the blob the user picked
 * @returns the parsed v2 envelope; keyed verification happens after unlock
 * @throws {BackupFormatError} when the file is not a usable backup
 */
async function parseBackup(file: Blob): Promise<BackupEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new BackupFormatError('not-json', 'That file is not a valid .hcvault backup');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BackupFormatError('not-hcvault', 'That file is not a valid .hcvault backup');
  }
  const env = parsed as Partial<BackupEnvelope>;
  if (env.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('not-hcvault', 'That file is not a .hcvault backup');
  }
  if (env.formatVersion === 1) {
    throw new BackupFormatError(
      'version',
      'This is a legacy format 1 backup, which cannot prove that rows were not removed or their indexes changed. Open it in the older Keel version that created it, restore it there, then re-export a format 2 backup.',
    );
  }
  if (!Number.isInteger(env.formatVersion) || env.formatVersion !== BACKUP_FORMAT_VERSION) {
    const newer =
      typeof env.formatVersion === 'number' && env.formatVersion > BACKUP_FORMAT_VERSION;
    throw new BackupFormatError(
      'version',
      newer
        ? `This backup was written by a newer version of the app (format ${String(env.formatVersion)}). Update the app, then try again.`
        : `This backup uses unsupported format ${String(env.formatVersion)} and cannot be restored safely.`,
    );
  }
  if (!isKeyring(env.keyring)) {
    throw new BackupFormatError('keyring', 'This backup has no usable keyring and cannot be opened');
  }
  if (env.keyring.version !== KEYRING_VERSION) {
    throw new BackupFormatError(
      'version',
      `This backup uses keyring format ${env.keyring.version}; this app understands ${KEYRING_VERSION}. Update the app before restoring.`,
    );
  }
  if (
    typeof env.vaultId !== 'string' ||
    env.vaultId.length === 0 ||
    env.vaultId !== env.keyring.vaultId
  ) {
    throw new BackupFormatError('keyring', 'This backup has inconsistent vault identifiers');
  }
  if (
    typeof env.createdAt !== 'string' ||
    Number.isNaN(Date.parse(env.createdAt)) ||
    !Number.isInteger(env.recordCount) ||
    (env.recordCount ?? -1) < 0
  ) {
    throw new BackupFormatError('not-hcvault', 'This backup has invalid envelope metadata');
  }
  if (
    typeof env.app !== 'object' ||
    env.app === null ||
    !Number.isInteger(env.app.dbVersion) ||
    !Number.isInteger(env.app.bodyVersion) ||
    env.app.dbVersion < 1 ||
    env.app.bodyVersion < 1
  ) {
    throw new BackupFormatError('version', 'This backup has invalid schema version information');
  }
  if (typeof env.tables !== 'object' || env.tables === null || Array.isArray(env.tables)) {
    throw new BackupFormatError('not-hcvault', 'This backup has no usable table data');
  }
  let countedRows = 0;
  for (const rows of Object.values(env.tables)) {
    if (!Array.isArray(rows)) {
      throw new BackupFormatError('not-hcvault', 'This backup contains an invalid table');
    }
    countedRows += rows.length;
  }
  if (countedRows !== env.recordCount) {
    throw new BackupFormatError(
      'integrity',
      `This backup declares ${env.recordCount} records but contains ${countedRows}.`,
    );
  }
  if (
    typeof env.integrity !== 'object' ||
    env.integrity === null ||
    env.integrity.algorithm !== 'HMAC-SHA-256' ||
    typeof env.integrity.tag !== 'string'
  ) {
    throw new BackupFormatError(
      'integrity',
      'This backup has no usable keyed integrity authenticator.',
    );
  }
  try {
    if (fromBase64Url(env.integrity.tag).byteLength !== 32) {
      throw new TypeError('wrong HMAC length');
    }
  } catch {
    throw new BackupFormatError(
      'integrity',
      'This backup has a malformed keyed integrity authenticator.',
    );
  }
  return parsed as BackupEnvelope;
}

/**
 * Open the backup's keyring with the supplied secret.
 *
 * @param keyring the backup's keyring
 * @param secret passphrase or recovery code
 * @returns the codec keys for the backup's DEK, plus the raw bytes to zero
 */
async function openBackupKeys(
  keyring: Keyring,
  secret: ImportSecret,
): Promise<{ keys: CodecKeys; rawDek: Uint8Array }> {
  const result =
    secret.kind === 'recovery-code'
      ? await unlockKeyringWithRecoveryCode(keyring, secret.value)
      : await unlockKeyring(keyring, 'passphrase', secret.value);
  try {
    const keys: CodecKeys = {
      dek: await importDek(result.rawDek, false),
      indexKey: await deriveIndexKey(result.rawDek),
    };
    return { keys, rawDek: result.rawDek };
  } catch (error) {
    zeroBytes(result.rawDek);
    throw error;
  }
}

/** Verify the complete parsed envelope with the raw DEK opened from its keyring. */
async function authenticateEnvelope(
  envelope: BackupEnvelope,
  rawDek: Uint8Array,
): Promise<boolean> {
  const { integrity, ...body } = envelope;
  return verifyAuthenticator(body, integrity.tag, rawDek);
}

/** A row whose body and every plaintext header have been authenticated. */
interface ValidatedRow {
  readonly stored: StoredRow;
  readonly record: BaseRecord;
}

/** Rows that passed envelope MAC, AES-GCM, and index regeneration checks. */
type ValidatedTables = Partial<Record<VaultTableName, ValidatedRow[]>>;

/** Table names this build cannot safely preserve during a restore. */
function unknownBackupTables(envelope: BackupEnvelope): string[] {
  return Object.keys(envelope.tables).filter(
    (name) => !(VAULT_TABLES as readonly string[]).includes(name),
  );
}

/** Known table names absent from the authenticated v2 manifest. */
function missingBackupTables(envelope: BackupEnvelope): VaultTableName[] {
  return VAULT_TABLES.filter(
    (name) =>
      !Object.prototype.hasOwnProperty.call(envelope.tables, name) &&
      // Schema-v1 backups predate the lab table. Restoring them leaves the new
      // table empty, exactly as upgrading the original live database would.
      !(name === 'labRecords' && envelope.app.dbVersion < 2),
  );
}

/** Plaintext columns that are optional but must remain strings when present. */
const OPTIONAL_BACKUP_ROW_STRINGS = [
  'dateKey',
  'type',
  'sourceHash',
  'sessionId',
  'exerciseId',
  'mesocycleId',
  'programId',
] as const satisfies readonly (keyof BackupRow)[];

type OptionalBackupRowString = (typeof OPTIONAL_BACKUP_ROW_STRINGS)[number];

/**
 * Regenerate every plaintext index column from the authenticated record body.
 *
 * The v2 envelope MAC already prevents an outsider from changing these fields.
 * Recomputing them additionally catches a buggy exporter or a validly signed
 * file produced by a tool that did not follow the table schema.
 */
async function expectedPlaintextIndexes(
  keys: CodecKeys,
  table: VaultTableName,
  record: BaseRecord,
): Promise<Partial<Record<OptionalBackupRowString, string>>> {
  const expected: Partial<Record<OptionalBackupRowString, string>> = {};
  const spec = TABLE_SPECS[table];
  const body = record as unknown as Record<string, unknown>;

  if (spec.dateKeyField) {
    const value = body[spec.dateKeyField];
    if (typeof value === 'string') expected.dateKey = value;
  }
  if (spec.typeField) {
    const value = body[spec.typeField];
    if (typeof value === 'string') expected.type = value;
  }
  if (spec.sourceKeyField) {
    const value = body[spec.sourceKeyField];
    if (typeof value === 'string' && value.length > 0) {
      expected.sourceHash = await blindIndex(
        keys.indexKey,
        `${table}.${spec.sourceKeyField}`,
        value,
      );
    }
  }
  for (const field of spec.fkFields ?? []) {
    const value = body[field];
    if (typeof value === 'string') {
      expected[field as OptionalBackupRowString] = value;
    }
  }
  return expected;
}

/**
 * Authenticate and structurally validate every row before import may write.
 *
 * The envelope HMAC proves completeness and authenticates plaintext headers;
 * each row's AES-GCM tag independently binds its encrypted body to table + id.
 * Index regeneration protects against signed-but-buggy backup producers.
 */
async function validateBackupRows(
  envelope: BackupEnvelope,
  keys: CodecKeys,
  onRow?: () => void,
): Promise<ValidatedTables> {
  const validated: ValidatedTables = {};

  for (const name of VAULT_TABLES) {
    const rows = envelope.tables[name];
    if (!rows || rows.length === 0) continue;
    const validatedRows: ValidatedRow[] = [];
    const seenIds = new Set<string>();

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] as BackupRow;
      const label =
        row && typeof row === 'object' && typeof row.id === 'string'
          ? `${name}/${row.id}`
          : `${name} row ${index + 1}`;

      try {
        if (
          !row ||
          typeof row !== 'object' ||
          typeof row.id !== 'string' ||
          row.id.length === 0 ||
          !Number.isFinite(row.updatedAt) ||
          (row.deleted !== 0 && row.deleted !== 1) ||
          !Number.isInteger(row.v) ||
          row.v < 1 ||
          row.v > BODY_VERSION ||
          row.v > envelope.app.bodyVersion ||
          typeof row.iv !== 'string' ||
          typeof row.ct !== 'string'
        ) {
          throw new TypeError('invalid row envelope');
        }
        if (seenIds.has(row.id)) throw new TypeError('duplicate row id');
        seenIds.add(row.id);
        for (const key of OPTIONAL_BACKUP_ROW_STRINGS) {
          if (row[key] !== undefined && typeof row[key] !== 'string') {
            throw new TypeError(`invalid ${key} index`);
          }
        }

        const stored = fromBackupRow(row);
        if (stored.iv.byteLength !== 12 || stored.ct.byteLength < 17) {
          throw new TypeError('invalid AES-GCM payload length');
        }

        const record = await decodeRow<BaseRecord>(keys, name, stored);
        if (
          !Number.isFinite(record.updatedAt) ||
          record.updatedAt !== stored.updatedAt ||
          (record.deletedAt === null ? 0 : 1) !== stored.deleted
        ) {
          throw new TypeError('encrypted record does not match its row envelope');
        }

        const expectedIndexes = await expectedPlaintextIndexes(keys, name, record);
        for (const key of OPTIONAL_BACKUP_ROW_STRINGS) {
          if (stored[key] !== expectedIndexes[key]) {
            throw new TypeError(`plaintext ${key} index does not match encrypted record`);
          }
        }

        validatedRows.push({ stored, record });
        onRow?.();
      } catch {
        throw new BackupFormatError(
          'integrity',
          `Record ${label} could not be authenticated. Nothing was restored.`,
        );
      }
    }
    validated[name] = validatedRows;
  }

  return validated;
}

/**
 * Inspect a backup without writing anything — the dry run the UI shows before
 * asking "restore this?".
 *
 * Actually attempts the decryption, so `canDecrypt` is a real answer rather
 * than a guess, and a wrong passphrase is caught *before* the destructive
 * step rather than halfway through it.
 *
 * @param file the blob the user picked
 * @param secret the passphrase or recovery code to try; omit to inspect the
 *   envelope only
 * @returns a full preview, including warnings
 * @throws {BackupFormatError} when the file is not a usable backup
 */
export async function previewImport(
  file: Blob,
  secret?: ImportSecret,
): Promise<BackupPreview> {
  const envelope = await parseBackup(file);
  const byTable: Partial<Record<VaultTableName, number>> = {};
  for (const name of VAULT_TABLES) {
    const rows = envelope.tables[name];
    if (rows) byTable[name] = rows.length;
  }

  let canDecrypt = false;
  let integrityOk = false;
  let recordsOk = false;
  if (secret) {
    let rawDek: Uint8Array | null = null;
    try {
      const opened = await openBackupKeys(envelope.keyring, secret);
      rawDek = opened.rawDek;
      canDecrypt = true;
      integrityOk = await authenticateEnvelope(envelope, rawDek);
      if (integrityOk) {
        await validateBackupRows(envelope, opened.keys);
        recordsOk = true;
      }
    } catch {
      // `canDecrypt` deliberately remains true when the keyring opened but a
      // row/index failed validation, so the UI can explain the right failure.
    } finally {
      if (rawDek) zeroBytes(rawDek);
    }
  }

  const unknownTables = unknownBackupTables(envelope);
  const missingTables = missingBackupTables(envelope);
  const compatible =
    envelope.app.dbVersion <= DB_VERSION &&
    envelope.app.bodyVersion <= BODY_VERSION &&
    unknownTables.length === 0 &&
    missingTables.length === 0;
  const restorable = integrityOk && canDecrypt && recordsOk && compatible;
  const localKeyring = await loadKeyring();
  const db = getDb();
  let currentRecordCount = 0;
  for (const name of VAULT_TABLES) currentRecordCount += await db.rows(name).count();

  const warnings: string[] = [];
  if (!secret) {
    warnings.push(
      'Enter the backup passphrase or recovery code to authenticate the complete file.',
    );
  } else if (canDecrypt && !integrityOk) {
    warnings.push(
      'The keyed integrity check failed. A table, row, or row header may have been removed or changed, so restore is blocked and nothing will be written.',
    );
  }
  if (envelope.app.dbVersion > DB_VERSION) {
    warnings.push(
      `This backup uses database schema v${envelope.app.dbVersion}; this app understands v${DB_VERSION}. Update the app before restoring.`,
    );
  }
  if (envelope.app.bodyVersion > BODY_VERSION) {
    warnings.push(
      `Records in this backup use schema v${envelope.app.bodyVersion}; this app understands v${BODY_VERSION}. Update the app before restoring.`,
    );
  }
  if (localKeyring && localKeyring.vaultId !== envelope.vaultId) {
    warnings.push(
      'This backup is from a different vault. Replacing will discard everything currently on this device; merging will re-encrypt the backup under this device’s key.',
    );
  }
  if (currentRecordCount > 0) {
    warnings.push(`This device currently holds ${currentRecordCount} records.`);
  }
  if (secret && !canDecrypt) {
    warnings.push('That passphrase or recovery code does not open this backup.');
  }
  if (secret && canDecrypt && integrityOk && !recordsOk) {
    warnings.push(
      'The secret authenticates the file, but at least one encrypted record or plaintext index is invalid. Restore is blocked and nothing will be written.',
    );
  }

  if (unknownTables.length > 0) {
    warnings.push(
      `This app does not recognise ${unknownTables.length} table(s): ${unknownTables.join(', ')}. Update the app before restoring so no data is discarded.`,
    );
  }
  if (missingTables.length > 0) {
    warnings.push(
      `This backup is missing ${missingTables.length} required table(s): ${missingTables.join(', ')}. Restore is blocked so absent data cannot be mistaken for an empty table.`,
    );
  }

  return {
    formatVersion: envelope.formatVersion,
    createdAt: envelope.createdAt,
    vaultId: envelope.vaultId,
    sameVault: localKeyring?.vaultId === envelope.vaultId,
    recordCount: envelope.recordCount,
    byTable,
    integrityOk,
    canDecrypt,
    recordsOk,
    compatible,
    restorable,
    wrappings: envelope.keyring.wrappedKeys.map((w) => ({
      id: w.id,
      method: w.method,
      label: w.label,
      createdAt: w.createdAt,
      lastUsedAt: w.lastUsedAt,
    })),
    app: envelope.app,
    currentRecordCount,
    warnings,
  };
}

/** Options for {@link importVault}. */
export interface ImportOptions {
  /**
   * How to reconcile with existing data. Defaults to `'replace'` when the
   * device has no vault, `'merge'` otherwise.
   */
  mode?: ImportMode;
  /** Validate everything and report, but write nothing. */
  dryRun?: boolean;
  /** Called with 0–1 progress. Restores of 100k rows are not instant. */
  onProgress?: (fraction: number) => void;
}

/**
 * Restore a `.hcvault` backup.
 *
 * Always verifies the secret against the backup's keyring **first**: an import
 * cannot get halfway through wiping the device and then discover the
 * passphrase was wrong.
 *
 * @param file the blob the user picked
 * @param secret the passphrase or recovery code that opens the backup
 * @param options see {@link ImportOptions}
 * @returns what was (or would have been) written
 * @throws {BackupFormatError} when the file is unusable
 * @throws {import('../crypto').UnlockFailedError} when the secret is wrong
 * @throws {import('./session').VaultLockedError} in `'merge'` mode when the
 *   local vault is locked
 */
export async function importVault(
  file: Blob,
  secret: ImportSecret,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const envelope = await parseBackup(file);
  const localKeyring = await loadKeyring();
  const mode: ImportMode = options.mode ?? (localKeyring ? 'merge' : 'replace');
  const dryRun = options.dryRun === true;

  // Open the keyring, then authenticate the *complete* envelope before reading
  // any untrusted row header as restore authority.
  const { keys: backupKeys, rawDek } = await openBackupKeys(envelope.keyring, secret);

  const byTable: Partial<Record<VaultTableName, number>> = {};
  let applied = 0;
  let skipped = 0;
  const failed = 0;
  const totalRows = envelope.recordCount;
  let verified = 0;
  const verifiedTick = () => {
    verified++;
    if (options.onProgress && verified % 200 === 0) {
      options.onProgress(totalRows === 0 ? 0.5 : (verified / totalRows) * 0.5);
    }
  };

  try {
    if (!(await authenticateEnvelope(envelope, rawDek))) {
      throw new BackupFormatError(
        'integrity',
        'This backup failed its keyed integrity check. A table, row, or row header may have been removed or changed. Nothing was restored.',
      );
    }
    if (envelope.app.dbVersion > DB_VERSION || envelope.app.bodyVersion > BODY_VERSION) {
      throw new BackupFormatError(
        'version',
        'This backup was written by a newer version of the app. Update the app before restoring.',
      );
    }
    if (
      unknownBackupTables(envelope).length > 0 ||
      missingBackupTables(envelope).length > 0
    ) {
      throw new BackupFormatError(
        'version',
        'This backup has a different table manifest than this app understands. Update the app before restoring.',
      );
    }

    // This is deliberately before either merge puts or a destructive clear.
    // A single malformed or unauthenticated row blocks the whole operation.
    const validated = await validateBackupRows(envelope, backupKeys, verifiedTick);

    if (mode === 'replace') {
      const db = getDb();
      for (const name of VAULT_TABLES) {
        const rows = validated[name];
        if (!rows || rows.length === 0) continue;
        byTable[name] = rows.length;
        applied += rows.length;
      }

      if (!dryRun) {
        // Clear, keyring adoption, pending media cleanup, and every bulk write
        // share one transaction. A quota/write error rolls the whole replace
        // back, including its destructive clears.
        await db.transaction('rw', db.tables, async () => {
          for (const name of VAULT_TABLES) await db.rows(name).clear();
          await db.vaultMeta.clear();
          for (const name of VAULT_TABLES) {
            const rows = validated[name];
            if (rows && rows.length > 0) {
              await db.rows(name).bulkPut(rows.map(({ stored }) => stored));
            }
          }
          await db.vaultMeta.bulkPut([
            { key: META_KEYS.keyring, value: envelope.keyring },
            {
              key: META_KEYS.lastBackupAt,
              value: Date.parse(envelope.createdAt),
            },
            { key: META_KEYS.pendingMediaCleanup, value: true },
          ]);
        });

        // The old DEK must become unreachable synchronously after commit.
        // Separate media cleanup may fail and must not leave callers able to
        // write the restored vault with the pre-restore key.
        resetSessionAfterRestore();

        // The transaction wrote the keyring directly. Refresh the public cache
        // only after locking; a read failure cannot resurrect the old session.
        await loadKeyring(true);
      }
    } else {
      // Run all WebCrypto before opening an IndexedDB transaction. Awaiting a
      // WebCrypto task from inside a transaction can let IndexedDB auto-commit.
      const localKeys = requireKeys('Merging a backup');
      const prepared: Partial<Record<VaultTableName, StoredRow[]>> = {};
      let preparedCount = 0;
      for (const name of VAULT_TABLES) {
        const rows = validated[name];
        if (!rows || rows.length === 0) continue;
        const encoded: StoredRow[] = [];
        for (const { record } of rows) {
          encoded.push(await encodeRow(localKeys, name, record));
          preparedCount++;
          if (options.onProgress && preparedCount % 200 === 0) {
            options.onProgress(
              totalRows === 0 ? 0.9 : 0.5 + (preparedCount / totalRows) * 0.4,
            );
          }
        }
        prepared[name] = encoded;
      }

      const db = getDb();
      // Existing-row comparisons and all writes share one transaction.
      // Concurrent tabs cannot slip a newer row between comparison and put,
      // and any failed write rolls every merge write back.
      await db.transaction('rw', db.tables, async () => {
        for (const name of VAULT_TABLES) {
          const rows = prepared[name];
          if (!rows || rows.length === 0) continue;
          const table = db.rows(name);
          const existingRows = await table.bulkGet(rows.map(({ id }) => id));
          const writes: StoredRow[] = [];
          for (let index = 0; index < rows.length; index++) {
            const incoming = rows[index];
            const existing = existingRows[index];
            if (existing && existing.updatedAt >= incoming.updatedAt) {
              skipped++;
            } else {
              writes.push(incoming);
            }
          }
          if (!dryRun && writes.length > 0) await table.bulkPut(writes);
          if (writes.length > 0) byTable[name] = writes.length;
          applied += writes.length;
        }
      });
    }
  } finally {
    zeroBytes(rawDek);
  }

  options.onProgress?.(1);
  return { mode, applied, skipped, failed, byTable, dryRun };
}

/**
 * Export, re-parse and verify in one shot — the "prove my backup works" button.
 *
 * Restoring a corrupt backup is a discovery you want to make *now*, not in six
 * months when the phone is gone. This round-trips the file through the real
 * parser, verifies the keyed authenticator and confirms the secret opens the
 * keyring.
 *
 * @param secret the passphrase or recovery code to test against
 * @returns the blob and its preview, so the UI can offer to save the very file
 *   it just verified
 */
export async function exportAndVerify(
  secret: ImportSecret,
): Promise<{ blob: Blob; preview: BackupPreview }> {
  const blob = await exportVault(secret);
  const preview = await previewImport(blob, secret);
  return { blob, preview };
}
