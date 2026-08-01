/**
 * @file The Dexie handle, constructed lazily and never at module scope.
 *
 * ## Why lazy matters
 * Next.js prerenders every route at build time in Node, where `indexedDB` does
 * not exist. A `new Dexie(...)` at module scope would crash `next build` the
 * moment any component transitively imported a repository. Everything here is
 * therefore behind {@link getDb}, which is only ever called from an effect, an
 * event handler or an explicitly client-side code path.
 *
 * Import this module freely from anywhere. Calling into it is the guarded part.
 */

import Dexie, { type Table } from 'dexie';
import {
  DB_NAME,
  DB_VERSION,
  META_KEYS,
  VAULT_TABLES,
  buildStores,
  buildV1Stores,
  type MetaRow,
  type StoredRow,
  type VaultTableName,
} from './schema';

/** Thrown when vault code runs somewhere IndexedDB does not exist. */
export class EnvironmentError extends Error {
  constructor(what: string) {
    super(
      `${what} is not available here. The vault is browser-only — call this from a client component, an effect, or an event handler, never during render or prerender.`,
    );
    this.name = 'EnvironmentError';
  }
}

/** The typed Dexie instance. */
export class VaultDatabase extends Dexie {
  /** Non-encrypted metadata: the keyring and backup bookkeeping. */
  declare vaultMeta: Table<MetaRow, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores(buildV1Stores());
    this.version(DB_VERSION).stores(buildStores());
  }

  /**
   * Get an encrypted table by name.
   *
   * @param name the table name
   * @returns the Dexie table of {@link StoredRow}
   */
  rows(name: VaultTableName): Table<StoredRow, string> {
    return this.table<StoredRow, string>(name);
  }
}

let instance: VaultDatabase | null = null;

/**
 * True when IndexedDB is usable in the current environment.
 *
 * Call this before anything else in a component that might render on the
 * server. Safari in Private Browsing on older iOS versions exposes
 * `indexedDB` but throws on open; that case surfaces as a rejected promise
 * from {@link getDb}, not from here.
 */
export function isBrowserStorageAvailable(): boolean {
  return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
}

/**
 * The process-wide Dexie singleton, constructed on first use.
 *
 * @returns the vault database
 * @throws {EnvironmentError} when `indexedDB` is absent (SSR, prerender, Node)
 */
export function getDb(): VaultDatabase {
  if (!isBrowserStorageAvailable()) throw new EnvironmentError('indexedDB');
  if (!instance) instance = new VaultDatabase();
  return instance;
}

/**
 * Replace the singleton — **tests and the backup importer only**.
 *
 * Lets `importVault` swap in a fresh database after a destructive restore, and
 * lets a headless test harness point the vault at a fake indexedDB.
 *
 * @param db the instance to use, or `null` to force reconstruction on next use
 */
export function setDb(db: VaultDatabase | null): void {
  instance = db;
}

/**
 * Read a value from the non-encrypted meta table.
 *
 * Safe to call while the vault is locked — that is the entire point of this
 * table (the keyring must be readable *before* unlock).
 *
 * @typeParam T the expected value type
 * @param key one of {@link META_KEYS}
 * @returns the stored value, or `undefined`
 */
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await getDb().vaultMeta.get(key);
  return row?.value as T | undefined;
}

/**
 * Write a value to the non-encrypted meta table.
 *
 * @param key one of {@link META_KEYS}
 * @param value any JSON-serialisable value. **Never health data.**
 */
export async function setMeta(key: string, value: unknown): Promise<void> {
  await getDb().vaultMeta.put({ key, value });
}

/**
 * Delete a meta key.
 *
 * @param key the key to remove
 */
export async function deleteMeta(key: string): Promise<void> {
  await getDb().vaultMeta.delete(key);
}

/**
 * Count every live (non-soft-deleted) row across every encrypted table.
 *
 * Cheap: it counts index entries and never decrypts anything.
 *
 * @returns per-table counts plus the total
 */
export async function countAllRows(): Promise<{
  total: number;
  byTable: Record<VaultTableName, number>;
}> {
  const db = getDb();
  const byTable = {} as Record<VaultTableName, number>;
  let total = 0;
  for (const name of VAULT_TABLES) {
    const n = await db.rows(name).count();
    byTable[name] = n;
    total += n;
  }
  return { total, byTable };
}

/**
 * Delete **everything** — every encrypted row, the keyring, and all metadata.
 *
 * This is the "delete all my data" button in settings. It is unrecoverable
 * without a `.hcvault` backup, and deliberately has no confirmation of its own;
 * the UI owns that.
 *
 * @param options.keepMeta when true, preserve the keyring and backup timestamp
 *   (used by the destructive-restore path, which rewrites them immediately)
 */
export async function wipeVault(options: { keepMeta?: boolean } = {}): Promise<void> {
  const db = getDb();
  await db.transaction('rw', db.tables, async () => {
    for (const name of VAULT_TABLES) await db.rows(name).clear();
    if (!options.keepMeta) await db.vaultMeta.clear();
  });
}

/**
 * Ask the browser to exempt this origin from storage eviction.
 *
 * `docs/kg/ARCHITECTURE.md` §3 explains why this is a correctness requirement
 * rather than an optimisation: Safari evicts IndexedDB for regular sites after
 * ~7 days of inactivity, and only Home Screen web apps are exempt.
 *
 * @returns the granted state, or `null` when the API is unsupported
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return null;
  const granted = await navigator.storage.persist();
  await setMeta(META_KEYS.storagePersisted, granted);
  return granted;
}

/**
 * Report the browser's current storage grant and usage.
 *
 * @returns persistence state plus a byte estimate, all fields `null` when
 *   the Storage API is unavailable
 */
export async function storageStatus(): Promise<{
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { persisted: null, usageBytes: null, quotaBytes: null };
  }
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
  const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
  return {
    persisted,
    usageBytes: est?.usage ?? null,
    quotaBytes: est?.quota ?? null,
  };
}
