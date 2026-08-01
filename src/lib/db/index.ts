/**
 * @file Public surface of the vault's storage layer (nodes **V2** + **V6**).
 *
 * Most callers want `@/lib/db/repos`. This barrel is for the schema itself:
 * record types, table names, and the database-level operations (wipe, counts,
 * persistent-storage requests) that the settings screen needs.
 */

export {
  EnvironmentError,
  VaultDatabase,
  countAllRows,
  deleteMeta,
  getDb,
  getMeta,
  isBrowserStorageAvailable,
  requestPersistentStorage,
  setDb,
  setMeta,
  storageStatus,
  wipeVault,
} from './db';

export {
  BODY_VERSION,
  DB_NAME,
  DB_VERSION,
  META_KEYS,
  META_TABLE,
  TABLE_SPECS,
  VAULT_TABLES,
  buildStores,
  buildV1Stores,
  type MetaRow,
  type PlaintextColumn,
  type StoredRow,
  type TableSpec,
  type VaultTableName,
} from './schema';

export {
  BODY_MIGRATIONS,
  CorruptRecordError,
  decodeRow,
  decodeRows,
  encodeRow,
  migrateBody,
  sourceHashFor,
  type BodyMigration,
  type CodecKeys,
} from './codec';

export * from './types';
export * from './repos';
