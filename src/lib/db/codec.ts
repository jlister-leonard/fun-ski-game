/**
 * @file The row codec — the only place in the app that turns a plain record
 * into ciphertext and back.
 *
 * Repositories call {@link encodeRow} / {@link decodeRow}; nothing above this
 * file knows that encryption exists.
 */

import {
  blindIndex,
  decryptJson,
  DecryptionError,
  encryptJson,
  rowAad,
} from '../crypto';
import {
  asRepUnit,
  isRangeOfMotion,
  isSetMagnitude,
  setMagnitude,
  type BaseRecord,
} from './types';
import { BODY_VERSION, TABLE_SPECS, type StoredRow, type VaultTableName } from './schema';

/**
 * The two keys a codec operation needs.
 *
 * Supplied by the vault session (`src/lib/vault`). Repositories never hold
 * these; they ask for them per call so that a lock takes effect immediately.
 */
export interface CodecKeys {
  /** AES-GCM key that encrypts row bodies. */
  readonly dek: CryptoKey;
  /** HMAC key that produces `sourceHash` blind indexes. */
  readonly indexKey: CryptoKey;
}

/** Raised when a row decrypts but is structurally wrong. */
export class CorruptRecordError extends Error {
  constructor(table: string, id: string, detail: string) {
    super(`Corrupt record ${table}/${id}: ${detail}`);
    this.name = 'CorruptRecordError';
  }
}

/**
 * Compute the blind index for a natural key.
 *
 * Exposed so repositories can look a row up by `sourceKey` without first
 * knowing its `id` — the mechanism behind idempotent ingest.
 *
 * @param keys the session keys
 * @param table the table the key belongs to
 * @param value the plaintext natural key, e.g. `'apple-health:steps:2026-07-26'`
 * @returns the 22-character blind-index token stored in `sourceHash`
 */
export async function sourceHashFor(
  keys: CodecKeys,
  table: VaultTableName,
  value: string,
): Promise<string> {
  const spec = TABLE_SPECS[table];
  return blindIndex(keys.indexKey, `${table}.${spec.sourceKeyField ?? 'sourceKey'}`, value);
}

/**
 * Encrypt a record into its physical row.
 *
 * The **whole** record is encrypted, including fields that are also mirrored
 * into plaintext columns. See the pattern note in `schema.ts`.
 *
 * @typeParam T the record type
 * @param keys the session keys
 * @param table which table the row belongs to — bound into the AAD
 * @param record the complete decrypted record, including `id`
 * @returns the row ready for `Dexie.Table.put`
 */
export async function encodeRow<T extends BaseRecord>(
  keys: CodecKeys,
  table: VaultTableName,
  record: T,
): Promise<StoredRow> {
  const spec = TABLE_SPECS[table];
  const payload = await encryptJson(keys.dek, record, rowAad(table, record.id));

  const row: StoredRow = {
    id: record.id,
    updatedAt: record.updatedAt,
    deleted: record.deletedAt === null ? 0 : 1,
    v: BODY_VERSION,
    iv: payload.iv,
    ct: payload.ct,
  };

  const asAny = record as unknown as Record<string, unknown>;

  if (spec.dateKeyField) {
    const dk = asAny[spec.dateKeyField];
    if (typeof dk === 'string') row.dateKey = dk;
  }
  if (spec.typeField) {
    const t = asAny[spec.typeField];
    if (typeof t === 'string') row.type = t;
  }
  if (spec.sourceKeyField) {
    const sk = asAny[spec.sourceKeyField];
    if (typeof sk === 'string' && sk.length > 0) {
      row.sourceHash = await sourceHashFor(keys, table, sk);
    }
  }
  for (const fk of spec.fkFields ?? []) {
    const v = asAny[fk];
    if (typeof v === 'string') row[fk] = v;
  }
  return row;
}

/**
 * Decrypt a physical row back into its record.
 *
 * @typeParam T the expected record type
 * @param keys the session keys
 * @param table the table the row came from — must match the AAD
 * @param row the stored row
 * @returns the decrypted record, migrated forward to {@link BODY_VERSION}
 * @throws {DecryptionError} on a wrong key or a tampered row
 * @throws {CorruptRecordError} when the plaintext does not match its envelope
 */
export async function decodeRow<T extends BaseRecord>(
  keys: CodecKeys,
  table: VaultTableName,
  row: StoredRow,
): Promise<T> {
  const record = await decryptJson<T>(
    keys.dek,
    { iv: row.iv, ct: row.ct },
    rowAad(table, row.id),
    `${table}:${row.id}`,
  );
  if (!record || typeof record !== 'object') {
    throw new CorruptRecordError(table, row.id, 'plaintext is not an object');
  }
  if (record.id !== row.id) {
    // Belt and braces: the AAD already makes this unreachable.
    throw new CorruptRecordError(table, row.id, `embedded id is ${record.id}`);
  }
  return migrateBody<T>(table, record, row.v ?? 1);
}

/**
 * Decrypt many rows, dropping any that fail to decrypt.
 *
 * A single corrupt row — a half-written record after an iOS kill, say — must
 * never take a whole screen down. Failures are counted and reported so the
 * settings screen can surface "3 records could not be read".
 *
 * @typeParam T the expected record type
 * @param keys the session keys
 * @param table the table the rows came from
 * @param rows the stored rows
 * @returns the decrypted records and the ids that failed
 */
export async function decodeRows<T extends BaseRecord>(
  keys: CodecKeys,
  table: VaultTableName,
  rows: readonly StoredRow[],
): Promise<{ records: T[]; failedIds: string[] }> {
  const records: T[] = [];
  const failedIds: string[] = [];
  for (const row of rows) {
    try {
      records.push(await decodeRow<T>(keys, table, row));
    } catch (err) {
      if (err instanceof DecryptionError || err instanceof CorruptRecordError) {
        failedIds.push(row.id);
      } else {
        throw err;
      }
    }
  }
  return { records, failedIds };
}

/**
 * One lazy body migration step: `from` → `from + 1`.
 *
 * Runs **in memory, after unlock** — Dexie's own `upgrade()` hooks cannot do
 * this because the database opens while the vault is still locked and there is
 * no DEK to decrypt with. The migrated record is persisted on its next write.
 */
export interface BodyMigration {
  /** The version this step upgrades *from*. */
  readonly from: number;
  /** Tables it applies to; omit for all. */
  readonly tables?: readonly VaultTableName[];
  /** Pure transform of one decrypted record. */
  readonly migrate: (record: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * v1 → v2, `workoutSets`: fold the old flat magnitude fields into the tagged
 * {@link import('./types').SetMagnitude} union, and promote `rom`.
 *
 * The v1 shape stored the count in up to three places depending on the unit:
 * `reps` when the unit was reps, `durationSec` when it was seconds, and — for
 * rows written by the workout logger's pre-schema workaround — an untyped
 * `unitValue` body key alongside a `repUnit` key. Rows written by anything else
 * had no unit at all and were implicitly reps.
 *
 * Precedence when reading the count is therefore: `unitValue` (the logger's
 * explicit value, correct for every unit) → the unit-appropriate legacy field →
 * 0. The unit itself comes from `repUnit` when present; **when it is absent the
 * row is treated as reps**, which is the only safe reading — a v1 row with no
 * unit was written by a caller that had no concept other than reps.
 *
 * @param record one decrypted v1 `workoutSets` body
 * @returns the v2 body
 */
function migrateWorkoutSetV1toV2(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };

  if (!isSetMagnitude(next.magnitude)) {
    const unit = asRepUnit(next.repUnit) ?? 'reps';
    const explicit = typeof next.unitValue === 'number' ? next.unitValue : null;
    const legacy =
      unit === 'seconds'
        ? typeof next.durationSec === 'number'
          ? next.durationSec
          : null
        : typeof next.reps === 'number'
          ? next.reps
          : null;
    next.magnitude = setMagnitude(unit, explicit ?? legacy ?? 0);
  }
  if (!isRangeOfMotion(next.rom)) next.rom = null;

  // The v1 fields and the logger's workaround keys are now represented by
  // `magnitude`; leaving them behind would recreate the ambiguity on read.
  delete next.reps;
  delete next.durationSec;
  delete next.repUnit;
  delete next.unitValue;
  return next;
}

/**
 * v1 → v2, `workoutSessions`: promote the workout logger's untyped `trainer`
 * body key to the declared `trainerReport` field.
 *
 * Shape-compatible, so this is a rename plus a null default. Anything that is
 * not an object becomes `null` rather than being coerced — a half-written
 * report is worse than no report, because volume budgeting would silently
 * credit the trainer with zero sets.
 *
 * @param record one decrypted v1 `workoutSessions` body
 * @returns the v2 body
 */
function migrateWorkoutSessionV1toV2(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  if (next.trainerReport === undefined) {
    next.trainerReport =
      typeof next.trainer === 'object' && next.trainer !== null ? next.trainer : null;
  }
  delete next.trainer;
  return next;
}

const LEGACY_READINESS_INPUT_PREFIX = 'input.';
const READINESS_SYMPTOM_KEYS = [
  'chestPain',
  'dizzinessOrFainting',
  'shortnessOfBreath',
  'unexplainedWeightChange',
  'painAtRest',
] as const;

/** Promote the recovery screen's pre-v3 contributor workaround after decryption. */
function migrateReadinessV2toV3(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  const rawContributors =
    typeof next.contributors === 'object' && next.contributors !== null && !Array.isArray(next.contributors)
      ? (next.contributors as Record<string, unknown>)
      : {};
  const contributors = { ...rawContributors };
  const rawSubjective =
    typeof next.subjective === 'object' && next.subjective !== null && !Array.isArray(next.subjective)
      ? (next.subjective as Record<string, unknown>)
      : null;
  const hasLegacyInput = Object.keys(contributors).some((key) =>
    key.startsWith(LEGACY_READINESS_INPUT_PREFIX),
  );

  // Vendor rows legitimately have no check-in. Do not fabricate one.
  if (rawSubjective || hasLegacyInput) {
    const rawSymptoms =
      typeof rawSubjective?.symptoms === 'object' &&
      rawSubjective.symptoms !== null &&
      !Array.isArray(rawSubjective.symptoms)
        ? (rawSubjective.symptoms as Record<string, unknown>)
        : {};
    const symptoms: Record<string, boolean> = {};
    for (const key of READINESS_SYMPTOM_KEYS) {
      symptoms[key] =
        typeof rawSymptoms[key] === 'boolean'
          ? rawSymptoms[key]
          : contributors[`${LEGACY_READINESS_INPUT_PREFIX}symptom.${key}`] === 1;
    }

    next.subjective = {
      soreness: typeof rawSubjective?.soreness === 'number' ? rawSubjective.soreness : null,
      energy:
        typeof rawSubjective?.energy === 'number'
          ? rawSubjective.energy
          : typeof contributors[`${LEGACY_READINESS_INPUT_PREFIX}energy`] === 'number'
            ? contributors[`${LEGACY_READINESS_INPUT_PREFIX}energy`]
            : null,
      motivation: typeof rawSubjective?.motivation === 'number' ? rawSubjective.motivation : null,
      stress: typeof rawSubjective?.stress === 'number' ? rawSubjective.stress : null,
      sleepQuality:
        typeof rawSubjective?.sleepQuality === 'number' ? rawSubjective.sleepQuality : null,
      painFlag:
        typeof rawSubjective?.painFlag === 'boolean'
          ? rawSubjective.painFlag
          : contributors[`${LEGACY_READINESS_INPUT_PREFIX}pain`] === 1,
      illnessFlag:
        typeof rawSubjective?.illnessFlag === 'boolean'
          ? rawSubjective.illnessFlag
          : contributors[`${LEGACY_READINESS_INPUT_PREFIX}illness`] === 1,
      symptoms,
    };
  }

  for (const key of Object.keys(contributors)) {
    if (key.startsWith(LEGACY_READINESS_INPUT_PREFIX)) delete contributors[key];
  }
  next.contributors = contributors;
  return next;
}

/**
 * v3 stored only a rounded 0–100 presentation score. It is unsafe to reverse
 * that into a training band because the engine's raw score uses a different
 * scale and safety gates can override it. A null decision means “do not
 * auto-adjust”; migrated subjective illness/referral flags still fail closed at
 * the consumer.
 */
function migrateReadinessV3toV4(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record, trainingDecision: null };
}

/**
 * The ordered migration chain.
 *
 * Append-only and pure — every step runs on every read of every stale row until
 * that row is rewritten at the current version.
 */
export const BODY_MIGRATIONS: readonly BodyMigration[] = [
  { from: 1, tables: ['workoutSets'], migrate: migrateWorkoutSetV1toV2 },
  { from: 1, tables: ['workoutSessions'], migrate: migrateWorkoutSessionV1toV2 },
  { from: 2, tables: ['readinessRecords'], migrate: migrateReadinessV2toV3 },
  { from: 3, tables: ['readinessRecords'], migrate: migrateReadinessV3toV4 },
];

/**
 * Apply the migration chain to bring a decoded record up to {@link BODY_VERSION}.
 *
 * @typeParam T the record type after migration
 * @param table the table the record came from
 * @param record the freshly decrypted record
 * @param fromVersion the `v` column of the row it came from
 * @returns the record at the current body version
 */
export function migrateBody<T>(table: VaultTableName, record: T, fromVersion: number): T {
  if (fromVersion >= BODY_VERSION) return record;
  let current = record as unknown as Record<string, unknown>;
  for (let v = fromVersion; v < BODY_VERSION; v++) {
    for (const step of BODY_MIGRATIONS) {
      if (step.from !== v) continue;
      if (step.tables && !step.tables.includes(table)) continue;
      current = step.migrate(current);
    }
  }
  return current as unknown as T;
}
