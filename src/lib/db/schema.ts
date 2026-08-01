/**
 * @file The Dexie schema: table names, index declarations, and the mapping
 * from a decrypted record to its plaintext index columns.
 *
 * ## The encrypted-at-rest pattern
 *
 * Every row in every table has this shape:
 *
 * ```
 * { id, updatedAt, deleted, v, iv, ct,  …a few plaintext index columns }
 *                             └──┬──┘
 *                      AES-256-GCM ciphertext of the ENTIRE record,
 *                      AAD-bound to `<table>|<id>`
 * ```
 *
 * The ciphertext contains the whole record, including the fields that are
 * *also* mirrored into plaintext columns. That redundancy is deliberate:
 * decoding is `JSON.parse(decrypt(ct))` with no reassembly step, and the
 * plaintext columns can be regenerated or dropped in a future version without
 * touching the ciphertext.
 *
 * ## Migration policy — two independent version axes
 *
 * 1. **Structural version** (`db.version(n).stores(...)`) governs *indexes*.
 *    Dexie replays these on open. Adding a table or an index is a new
 *    `.version()` block; existing rows are untouched.
 *
 * 2. **Body version** (the `v` column) governs the *shape inside the
 *    ciphertext*. Dexie's `upgrade()` callbacks **cannot** migrate bodies —
 *    the database opens before the vault is unlocked, so there is no DEK. Body
 *    migrations are therefore **lazy, on read, after unlock**: `codec.ts`
 *    checks `row.v` and runs the registered upgrade chain in memory, and the
 *    next write persists the new shape.
 *
 * The practical rule for other agents: **adding an optional field needs no
 * migration at all** (it decodes as `undefined`). Renaming or repurposing a
 * field means bumping {@link BODY_VERSION} and adding a step to the chain in
 * `codec.ts`. Post to the channel before you do the latter.
 */

import type { DateKey } from './types';

/**
 * Structural schema version. Bump when index declarations change.
 *
 * Version 2 adds the encrypted `labRecords` table. Existing tables and their
 * ciphertext are untouched during the Dexie upgrade.
 */
export const DB_VERSION = 2;

/**
 * Current record-body version. Bump when a field changes meaning.
 *
 * | v | Change |
 * |---|---|
 * | 1 | initial |
 * | 2 | `WorkoutSet.reps` + `durationSec` → the tagged `magnitude` union; `rom` and `WorkoutSession.trainerReport` promoted to first-class fields |
 * | 3 | readiness energy, pain, illness and rule-7 symptoms promoted from `contributors[input.*]` into the encrypted `subjective` object |
 */
export const BODY_VERSION = 4;

/** IndexedDB database name. */
export const DB_NAME = 'hcvault';

/** Every encrypted table in the vault. */
const VAULT_TABLES_V1 = [
  'profile',
  'goals',
  'settings',
  'weightEntries',
  'bodyMeasurements',
  'foods',
  'foodLogs',
  'recipes',
  'meals',
  'exercises',
  'programs',
  'mesocycles',
  'workoutSessions',
  'workoutSets',
  'personalRecords',
  'healthMetrics',
  'sleepRecords',
  'readinessRecords',
  'activities',
  'integrations',
  'insights',
  'ingestLog',
] as const;

/** Every encrypted table in the current vault schema. */
export const VAULT_TABLES = [...VAULT_TABLES_V1, 'labRecords'] as const;

/** Name of an encrypted table. */
export type VaultTableName = (typeof VAULT_TABLES)[number];

/**
 * The physical row as it sits in IndexedDB.
 *
 * Everything here except `iv`/`ct` is readable by anyone with the disk image.
 * Each field is justified in `docs/kg/specs/vault-schema.md` §4; the short
 * version is in the per-field docs below.
 */
export interface StoredRow {
  /** Random UUID. Reveals nothing — it is not derived from content. */
  id: string;
  /**
   * Epoch ms of the last write. **Plaintext because**: backup diffing,
   * last-write-wins merge and "what changed since" all need to order rows
   * without decrypting them. Leaks *when* the user touched the app, which is
   * already inferable from IndexedDB file mtimes.
   */
  updatedAt: number;
  /**
   * Soft-delete flag. **Plaintext because**: every list query filters on it,
   * and IndexedDB cannot index `null`. Leaks only that *a* row was deleted.
   */
  deleted: 0 | 1;
  /** Body schema version — see the migration policy above. */
  v: number;
  /** 12-byte AES-GCM IV, unique per write. */
  iv: Uint8Array;
  /** AES-GCM ciphertext of the JSON record, plus its 16-byte tag. */
  ct: Uint8Array;
  /**
   * Local calendar day, `YYYY-MM-DD`. **Plaintext because**: essentially every
   * screen is a date-range query, and a blind index cannot answer ranges.
   * Leaks *which days have data of this kind* — an activity calendar, not
   * content. Explicitly accepted; see `vault-schema.md` §4.1.
   */
  dateKey?: DateKey;
  /**
   * Metric/insight discriminator. **Plaintext because**: `[type+dateKey]` is
   * what turns "resting HR for 90 days" into one range scan instead of a
   * full-table decrypt. Leaks *which kinds* of metric exist, never a value.
   * Only `healthMetrics` and `insights` use it.
   */
  type?: string;
  /**
   * Keyed **blind index** of `sourceKey` — HMAC-SHA-256 under a DEK-derived
   * key, truncated to 128 bits. Opaque without the vault key, while still
   * giving exact-match lookup for idempotent re-import.
   */
  sourceHash?: string;
  /** FK → `workoutSessions.id`. A random UUID; reveals structure, not content. */
  sessionId?: string;
  /** FK → `exercises.id`. */
  exerciseId?: string;
  /** FK → `mesocycles.id`. */
  mesocycleId?: string;
  /** FK → `programs.id`. */
  programId?: string;
}

/** Plaintext columns a table may populate beyond the universal ones. */
export type PlaintextColumn =
  | 'dateKey'
  | 'type'
  | 'sourceHash'
  | 'sessionId'
  | 'exerciseId'
  | 'mesocycleId'
  | 'programId';

/** How one table maps its decrypted record onto plaintext index columns. */
export interface TableSpec {
  /** Dexie table name. */
  readonly name: VaultTableName;
  /** Dexie v1 index declaration. */
  readonly indexes: string;
  /** Record field mirrored into the plaintext `dateKey` column. */
  readonly dateKeyField?: string;
  /** Record field mirrored into the plaintext `type` column. */
  readonly typeField?: string;
  /**
   * Record field whose value is blind-indexed into `sourceHash`.
   *
   * Usually `'sourceKey'`. `exercises` uses `'slug'` and `integrations` uses
   * `'provider'` so those can be looked up by natural key without exposing it.
   */
  readonly sourceKeyField?: string;
  /** Record fields copied verbatim into FK columns. */
  readonly fkFields?: readonly PlaintextColumn[];
  /** True for tables holding exactly one row under a fixed id. */
  readonly singleton?: boolean;
}

/**
 * The authoritative per-table specification.
 *
 * `indexes` strings follow Dexie's syntax: the first entry is the primary key,
 * `[a+b]` is a compound index. `deleted` appears only inside compound indexes
 * because a standalone two-value index is worthless to the query planner.
 */
export const TABLE_SPECS: { readonly [K in VaultTableName]: TableSpec } = {
  profile: {
    name: 'profile',
    indexes: 'id, updatedAt',
    singleton: true,
  },
  settings: {
    name: 'settings',
    indexes: 'id, updatedAt',
    singleton: true,
  },
  goals: {
    name: 'goals',
    indexes: 'id, updatedAt, dateKey, [deleted+updatedAt]',
    dateKeyField: 'startDateKey',
  },
  weightEntries: {
    name: 'weightEntries',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  bodyMeasurements: {
    name: 'bodyMeasurements',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  foods: {
    name: 'foods',
    indexes: 'id, updatedAt, sourceHash, [deleted+updatedAt]',
    sourceKeyField: 'sourceKey',
  },
  foodLogs: {
    name: 'foodLogs',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  recipes: {
    name: 'recipes',
    indexes: 'id, updatedAt, sourceHash, [deleted+updatedAt]',
    sourceKeyField: 'sourceKey',
  },
  meals: {
    name: 'meals',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+updatedAt]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  exercises: {
    name: 'exercises',
    indexes: 'id, updatedAt, sourceHash, [deleted+updatedAt]',
    sourceKeyField: 'slug',
  },
  programs: {
    name: 'programs',
    indexes: 'id, updatedAt, sourceHash, [deleted+updatedAt]',
    sourceKeyField: 'sourceKey',
  },
  mesocycles: {
    name: 'mesocycles',
    indexes: 'id, updatedAt, dateKey, programId, [deleted+dateKey]',
    dateKeyField: 'startDateKey',
    fkFields: ['programId'],
  },
  workoutSessions: {
    name: 'workoutSessions',
    indexes: 'id, updatedAt, dateKey, mesocycleId, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
    fkFields: ['mesocycleId'],
  },
  workoutSets: {
    name: 'workoutSets',
    indexes: 'id, updatedAt, sessionId, exerciseId, [deleted+sessionId], [deleted+exerciseId]',
    sourceKeyField: 'sourceKey',
    fkFields: ['sessionId', 'exerciseId'],
  },
  personalRecords: {
    name: 'personalRecords',
    indexes: 'id, updatedAt, dateKey, exerciseId, [deleted+exerciseId]',
    dateKeyField: 'dateKey',
    fkFields: ['exerciseId'],
  },
  healthMetrics: {
    name: 'healthMetrics',
    indexes:
      'id, updatedAt, dateKey, type, sourceHash, [type+dateKey], [deleted+type+dateKey], [deleted+dateKey]',
    dateKeyField: 'dateKey',
    typeField: 'type',
    sourceKeyField: 'sourceKey',
  },
  sleepRecords: {
    name: 'sleepRecords',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  readinessRecords: {
    name: 'readinessRecords',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  activities: {
    name: 'activities',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  integrations: {
    name: 'integrations',
    indexes: 'id, updatedAt, sourceHash',
    sourceKeyField: 'provider',
  },
  insights: {
    name: 'insights',
    indexes: 'id, updatedAt, dateKey, type, [deleted+dateKey], [type+dateKey]',
    dateKeyField: 'dateKey',
    typeField: 'type',
  },
  ingestLog: {
    name: 'ingestLog',
    indexes: 'id, updatedAt, dateKey, sourceHash',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
  labRecords: {
    name: 'labRecords',
    indexes: 'id, updatedAt, dateKey, sourceHash, [deleted+dateKey]',
    dateKeyField: 'dateKey',
    sourceKeyField: 'sourceKey',
  },
};

/**
 * The non-encrypted metadata table.
 *
 * Holds exactly the things that must be readable **before** the vault is
 * unlocked: the keyring (which is public by construction — see
 * `src/lib/crypto/keyring.ts`) and the last-backup timestamp, so the app can
 * nag about backups on the lock screen.
 *
 * Nothing derived from health data ever goes here.
 */
export const META_TABLE = 'vaultMeta' as const;

/** Dexie index declaration for {@link META_TABLE}. */
export const META_INDEXES = 'key';

/** Keys used in {@link META_TABLE}. */
export const META_KEYS = {
  /** The full {@link import('../crypto/keyring').Keyring}, as plain JSON. */
  keyring: 'keyring',
  /** Epoch ms when a verified `.hcvault` file was successfully delivered. */
  lastBackupAt: 'lastBackupAt',
  /**
   * True after a replace restore commits and until the separate encrypted media
   * database has been cleared. Kept in the main transaction so an iOS kill
   * between the two databases leaves durable cleanup work, not silent residue.
   */
  pendingMediaCleanup: 'pendingMediaCleanup',
  /** Epoch ms the vault was created, for the settings screen. */
  createdAt: 'createdAt',
  /** Whether `navigator.storage.persist()` was granted, as reported. */
  storagePersisted: 'storagePersisted',
} as const;

/** One row of {@link META_TABLE}. */
export interface MetaRow {
  key: string;
  /** JSON-serialisable value. Deliberately unencrypted. */
  value: unknown;
}

/**
 * The complete v1 `stores()` argument, assembled from {@link TABLE_SPECS}.
 *
 * @returns a Dexie stores map covering every encrypted table plus the meta table
 */
export function buildStores(): Record<string, string> {
  const stores: Record<string, string> = { [META_TABLE]: META_INDEXES };
  for (const name of VAULT_TABLES) stores[name] = TABLE_SPECS[name].indexes;
  return stores;
}

/** The exact schema existing installations used before `labRecords`. */
export function buildV1Stores(): Record<string, string> {
  const stores: Record<string, string> = { [META_TABLE]: META_INDEXES };
  for (const name of VAULT_TABLES_V1) stores[name] = TABLE_SPECS[name].indexes;
  return stores;
}
