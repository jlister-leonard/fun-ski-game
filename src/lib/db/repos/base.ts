/**
 * @file The generic encrypted repository (task graph node **V6**).
 *
 * Every domain repository is an instance of, or delegates to, {@link Repo}.
 * The contract for callers is short:
 *
 * - You pass in and get back **plain typed objects** from `db/types.ts`.
 * - You never see an IV, a ciphertext or a key.
 * - Soft-deleted rows are excluded unless you ask for them.
 * - Every operation throws {@link VaultLockedError} if the vault is locked, so
 *   locking takes effect on the very next call rather than at a checkpoint.
 *
 * Reads are Dexie queries over **plaintext index columns**, so a date-range
 * scan narrows the candidate set *before* anything is decrypted. Only the rows
 * that survive the index query pay the AES cost.
 */

import type { Collection, Table } from 'dexie';
import { randomId } from '../../crypto';
import { requireKeys, VaultLockedError } from '../../vault/session';
import { getDb } from '../db';
import { decodeRow, decodeRows, encodeRow, sourceHashFor, type CodecKeys } from '../codec';
import { TABLE_SPECS, type StoredRow, type VaultTableName } from '../schema';
import type { BaseRecord, DateKey, Millis } from '../types';

/** A record being created: identity and audit fields are optional. */
export type NewRecord<T extends BaseRecord> = Omit<
  T,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
> & {
  /** Supply only when the id must be deterministic (imports, seeds). */
  id?: string;
  /** Supply only when backfilling history. */
  createdAt?: Millis;
};

/** A partial update. Audit fields are managed by the repository. */
export type RecordPatch<T extends BaseRecord> = Partial<
  Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>
>;

/** Shared read options. */
export interface ListOptions {
  /** Include soft-deleted rows. Default false. */
  includeDeleted?: boolean;
  /** Cap the number of rows read. */
  limit?: number;
  /** Skip this many rows. */
  offset?: number;
  /** Newest-first when true. Default false. */
  reverse?: boolean;
}

/** Outcome of an upsert. */
export interface UpsertResult<T> {
  readonly record: T;
  /** True when a new row was inserted, false when an existing one was updated. */
  readonly created: boolean;
}

/** Aggregate outcome of a bulk ingest. */
export interface BulkResult<T> {
  readonly records: T[];
  readonly created: number;
  readonly updated: number;
  /** Rows skipped because a tombstone or caller-supplied collision policy won. */
  readonly skipped: number;
}

/** Optional collision policy for a natural-key bulk upsert. */
export interface BulkUpsertOptions<T extends BaseRecord> {
  /** Return false to preserve the current row and count the incoming row as skipped. */
  shouldReplace?: (current: T, incoming: NewRecord<T>) => boolean;
}

/** Current epoch ms. Isolated so tests can stub it. */
function now(): Millis {
  return Date.now();
}

/**
 * A typed, transparently-encrypting repository over one vault table.
 *
 * @typeParam T the decrypted record type for this table
 */
export class Repo<T extends BaseRecord> {
  /** The table this repository owns. */
  readonly table: VaultTableName;

  /**
   * @param table the vault table name; must exist in `TABLE_SPECS`
   */
  constructor(table: VaultTableName) {
    this.table = table;
  }

  /** The Dexie table of physical rows. Browser-only. */
  protected rows(): Table<StoredRow, string> {
    return getDb().rows(this.table);
  }

  /**
   * The session keys, throwing when locked.
   *
   * @throws {VaultLockedError} when the vault is locked
   */
  protected keys(): CodecKeys {
    return requireKeys(`${this.table} access`);
  }

  /** True when this table declares the given index. */
  private hasIndex(name: string): boolean {
    return TABLE_SPECS[this.table].indexes.includes(name);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Fetch one record by id.
   *
   * @param id the record's primary key
   * @param options.includeDeleted return soft-deleted rows too. Default false.
   * @returns the record, or `null`
   */
  async get(id: string, options: { includeDeleted?: boolean } = {}): Promise<T | null> {
    const row = await this.rows().get(id);
    if (!row) return null;
    if (row.deleted === 1 && !options.includeDeleted) return null;
    return decodeRow<T>(this.keys(), this.table, row);
  }

  /**
   * Fetch several records by id, preserving nothing about order.
   *
   * @param ids the primary keys
   * @param options.includeDeleted include soft-deleted rows
   * @returns the records that exist
   */
  async getMany(ids: readonly string[], options: ListOptions = {}): Promise<T[]> {
    const rows = (await this.rows().bulkGet([...ids])).filter(
      (r): r is StoredRow => r !== undefined,
    );
    return this.decode(this.filterDeleted(rows, options));
  }

  /**
   * Every record in the table.
   *
   * Decrypts each surviving row, so prefer a narrower query on the hot path.
   *
   * @param options list options
   * @returns the records, ordered by `updatedAt`
   */
  async listAll(options: ListOptions = {}): Promise<T[]> {
    const coll = this.rows().orderBy('updatedAt');
    return this.decode(await this.collect(coll, options));
  }

  /**
   * Records on one local calendar day.
   *
   * @param dateKey `YYYY-MM-DD`
   * @param options list options
   * @returns the day's records
   */
  async listByDate(dateKey: DateKey, options: ListOptions = {}): Promise<T[]> {
    return this.listByDateRange(dateKey, dateKey, options);
  }

  /**
   * Records whose `dateKey` falls in an inclusive range.
   *
   * The workhorse read for every screen. Uses the `[deleted+dateKey]` compound
   * index where the table declares one, so soft-deleted rows are excluded by
   * the index rather than by decrypting and discarding them.
   *
   * @param from inclusive lower bound, `YYYY-MM-DD`
   * @param to inclusive upper bound, `YYYY-MM-DD`
   * @param options list options
   * @returns the records, in ascending `dateKey` order unless reversed
   */
  async listByDateRange(from: DateKey, to: DateKey, options: ListOptions = {}): Promise<T[]> {
    const table = this.rows();
    let coll: Collection<StoredRow, string>;
    if (!options.includeDeleted && this.hasIndex('[deleted+dateKey]')) {
      coll = table.where('[deleted+dateKey]').between([0, from], [0, to], true, true);
    } else {
      coll = table.where('dateKey').between(from, to, true, true);
    }
    return this.decode(this.filterDeleted(await this.collect(coll, options), options));
  }

  /**
   * Records changed at or after a timestamp — the backup-diff primitive.
   *
   * @param since epoch ms, inclusive
   * @param options list options
   * @returns matching records, including soft-deleted ones when asked
   */
  async listUpdatedSince(since: Millis, options: ListOptions = {}): Promise<T[]> {
    const coll = this.rows().where('updatedAt').aboveOrEqual(since);
    return this.decode(this.filterDeleted(await this.collect(coll, options), options));
  }

  /**
   * Find a record by its natural key, via the blind index.
   *
   * This is the read half of idempotent ingest: the same Apple Health datum
   * always produces the same `sourceKey`, hence the same `sourceHash`, hence
   * a hit here instead of a duplicate row.
   *
   * @param sourceKey the plaintext natural key
   * @param options.includeDeleted match soft-deleted rows too. Default **true**
   *   for this method — a re-import must not resurrect something the user
   *   deleted, so the caller needs to see the tombstone.
   * @returns the matching record, or `null`
   */
  async findBySourceKey(
    sourceKey: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<T | null> {
    const hash = await sourceHashFor(this.keys(), this.table, sourceKey);
    const row = await this.rows().where('sourceHash').equals(hash).first();
    if (!row) return null;
    if (row.deleted === 1 && options.includeDeleted === false) return null;
    return decodeRow<T>(this.keys(), this.table, row);
  }

  /**
   * Count live rows without decrypting anything.
   *
   * @param options.includeDeleted count tombstones too
   * @returns the row count
   */
  async count(options: { includeDeleted?: boolean } = {}): Promise<number> {
    if (options.includeDeleted) return this.rows().count();
    return this.rows()
      .filter((r) => r.deleted === 0)
      .count();
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Insert a new record.
   *
   * @param input the domain fields; `id` and `createdAt` default sensibly
   * @returns the stored record, with its audit fields populated
   */
  async create(input: NewRecord<T>): Promise<T> {
    const ts = now();
    const record = {
      ...(input as object),
      id: input.id ?? randomId(),
      createdAt: input.createdAt ?? ts,
      updatedAt: ts,
      deletedAt: null,
    } as T;
    await this.rows().put(await encodeRow(this.keys(), this.table, record));
    return record;
  }

  /**
   * Write a complete record, overwriting whatever is there.
   *
   * Prefer {@link update} for edits — this exists for the importer and for
   * callers that already hold a full record.
   *
   * @param record the complete record, including `id`
   * @param options.preserveUpdatedAt keep `record.updatedAt` instead of
   *   stamping now. Used by backup restore so timestamps survive a round trip.
   * @returns the record as written
   */
  async put(record: T, options: { preserveUpdatedAt?: boolean } = {}): Promise<T> {
    const stamped = options.preserveUpdatedAt ? record : { ...record, updatedAt: now() };
    await this.rows().put(await encodeRow(this.keys(), this.table, stamped));
    return stamped;
  }

  /**
   * Patch an existing record.
   *
   * Read-modify-write, because the ciphertext is atomic: to change one field
   * the whole record must be decrypted and re-encrypted.
   *
   * **The crypto deliberately happens outside the IndexedDB transaction.** An
   * IndexedDB transaction auto-commits as soon as the microtask queue drains
   * with no pending request, and `crypto.subtle` resolves on a different task
   * source — so awaiting a decrypt inside a transaction kills it
   * (`PrematureCommitError`). Instead the write is guarded by an optimistic
   * check on `updatedAt` inside a short, crypto-free transaction, and retried
   * if another writer got there first.
   *
   * @param id the record to change
   * @param patch the fields to change
   * @returns the updated record, or `null` when the id does not exist
   */
  async update(id: string, patch: RecordPatch<T>): Promise<T | null> {
    return this.mutateRecord(id, (current) => ({ ...current, ...patch }) as T);
  }

  /**
   * Insert or update, keyed by the natural key rather than by id.
   *
   * **The idempotency primitive.** Re-importing the same Apple Health day
   * recomputes the same `sourceKey`, finds the existing row, and updates it.
   * A soft-deleted row is *not* resurrected: the user deleting something must
   * outrank a re-import bringing it back.
   *
   * @param sourceKey the deterministic natural key
   * @param input the record to write
   * @param options.onlyIfNewer skip when the stored record is at least as new
   *   as `input.updatedAt`. Default false.
   * @returns the record and whether it was newly created
   */
  async upsertBySourceKey(
    sourceKey: string,
    input: NewRecord<T>,
    options: { onlyIfNewer?: boolean } = {},
  ): Promise<UpsertResult<T>> {
    const keys = this.keys();
    const hash = await sourceHashFor(keys, this.table, sourceKey);
    const existing = await this.rows().where('sourceHash').equals(hash).first();
    const ts = now();

    if (!existing) {
      const record = {
        ...(input as object),
        id: input.id ?? randomId(),
        createdAt: input.createdAt ?? ts,
        updatedAt: ts,
        deletedAt: null,
      } as T;
      await this.rows().put(await encodeRow(keys, this.table, record));
      return { record, created: true };
    }

    const current = await decodeRow<T>(keys, this.table, existing);
    if (current.deletedAt !== null) {
      // Respect the tombstone — a re-import never resurrects a deletion.
      return { record: current, created: false };
    }
    if (options.onlyIfNewer && current.updatedAt >= ts) {
      return { record: current, created: false };
    }
    const next = {
      ...current,
      ...(input as object),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: ts,
      deletedAt: null,
    } as T;
    await this.rows().put(await encodeRow(keys, this.table, next));
    return { record: next, created: false };
  }

  /**
   * Upsert many records by natural key.
   *
   * The shape node I2 (clipboard ingest) and node I4 (`export.zip` parser)
   * call. All decryption and encryption happens up front, then the whole batch
   * lands in **one** `bulkPut` — so a 2,000-row Apple Health day is one
   * IndexedDB write, not two thousand.
   *
   * @param items pairs of natural key and record
   * @returns the written records and insert/update/skip counts
   */
  async bulkUpsertBySourceKey(
    items: readonly { sourceKey: string; input: NewRecord<T> }[],
    options: BulkUpsertOptions<T> = {},
  ): Promise<BulkResult<T>> {
    const keys = this.keys();
    const records: T[] = [];
    const toWrite: StoredRow[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Phase 1 — resolve natural keys to existing rows. Reads only.
    const hashes = await Promise.all(
      items.map((item) => sourceHashFor(keys, this.table, item.sourceKey)),
    );
    const existing = new Map<string, StoredRow>();
    for (const hash of new Set(hashes)) {
      const row = await this.rows().where('sourceHash').equals(hash).first();
      if (row) existing.set(hash, row);
    }

    // Phase 2 — all crypto, outside any transaction.
    const ts = now();
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const { input } = items[i];
      const hash = hashes[i];
      const prior = existing.get(hash);
      if (!prior || seen.has(hash)) {
        const record = {
          ...(input as object),
          id: input.id ?? randomId(),
          createdAt: input.createdAt ?? ts,
          updatedAt: ts,
          deletedAt: null,
        } as T;
        records.push(record);
        toWrite.push(await encodeRow(keys, this.table, record));
        created++;
        seen.add(hash);
        continue;
      }
      const current = await decodeRow<T>(keys, this.table, prior);
      if (current.deletedAt !== null) {
        records.push(current);
        skipped++;
        continue;
      }
      if (options.shouldReplace && !options.shouldReplace(current, input)) {
        records.push(current);
        skipped++;
        continue;
      }
      const next = {
        ...current,
        ...(input as object),
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: ts,
        deletedAt: null,
      } as T;
      records.push(next);
      toWrite.push(await encodeRow(keys, this.table, next));
      updated++;
    }

    // Phase 3 — one atomic write.
    if (toWrite.length > 0) await this.rows().bulkPut(toWrite);
    return { records, created, updated, skipped };
  }

  /**
   * Soft-delete: set `deletedAt` and flip the plaintext `deleted` column.
   *
   * The row's ciphertext stays, so an accidental delete is undoable via
   * {@link restore} and a re-import cannot resurrect it.
   *
   * @param id the record to remove
   * @returns true when a row was changed
   */
  async softDelete(id: string): Promise<boolean> {
    const ts = now();
    const result = await this.mutateRecord(
      id,
      (current) => ({ ...current, deletedAt: ts }) as T,
      { includeDeleted: true },
    );
    return result !== null;
  }

  /**
   * Undo a soft delete.
   *
   * @param id the record to restore
   * @returns the restored record, or `null`
   */
  async restore(id: string): Promise<T | null> {
    const row = await this.rows().get(id);
    if (!row) return null;
    const keys = this.keys();
    const current = await decodeRow<T>(keys, this.table, row);
    const next = { ...current, deletedAt: null, updatedAt: now() } as T;
    await this.rows().put(await encodeRow(keys, this.table, next));
    return next;
  }

  /**
   * Permanently destroy a row, ciphertext and all.
   *
   * Only the "purge deleted records" maintenance action and the destructive
   * restore path should call this.
   *
   * @param id the record to destroy
   */
  async hardDelete(id: string): Promise<void> {
    await this.rows().delete(id);
  }

  /**
   * Permanently destroy every tombstone older than a cut-off.
   *
   * @param olderThan epoch ms; tombstones updated before this are purged
   * @returns how many rows were destroyed
   */
  async purgeDeleted(olderThan: Millis): Promise<number> {
    const doomed = await this.rows()
      .filter((r) => r.deleted === 1 && r.updatedAt < olderThan)
      .primaryKeys();
    await this.rows().bulkDelete(doomed);
    return doomed.length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Decrypt a row, transform it, and write it back under an optimistic lock.
   *
   * The transform runs *between* two crypto-free IndexedDB transactions, never
   * inside one — see the note on {@link update}. If another writer changed the
   * row while we were encrypting, the whole cycle is retried.
   *
   * @param id the row to change
   * @param mutate a pure transform of the decrypted record
   * @param options.includeDeleted operate on tombstoned rows too
   * @returns the written record, or `null` when the id does not exist
   */
  protected async mutateRecord(
    id: string,
    mutate: (current: T) => T,
    options: { includeDeleted?: boolean } = {},
  ): Promise<T | null> {
    const keys = this.keys();
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.rows().get(id);
      if (!row) return null;
      if (row.deleted === 1 && !options.includeDeleted) return null;

      const current = await decodeRow<T>(keys, this.table, row);
      const next = { ...mutate(current), updatedAt: now() } as T;
      const encoded = await encodeRow(keys, this.table, next);

      const won = await getDb().transaction('rw', this.rows(), async () => {
        const fresh = await this.rows().get(id);
        if (!fresh || fresh.updatedAt !== row.updatedAt) return false;
        await this.rows().put(encoded);
        return true;
      });
      if (won) return next;
    }
    throw new Error(
      `${this.table}/${id}: gave up after 3 attempts — the record is being written concurrently`,
    );
  }

  /** Apply limit/offset/reverse to a Dexie collection and materialise it. */
  private async collect(
    coll: Collection<StoredRow, string>,
    options: ListOptions,
  ): Promise<StoredRow[]> {
    let c = coll;
    if (options.reverse) c = c.reverse();
    if (options.offset) c = c.offset(options.offset);
    if (options.limit !== undefined) c = c.limit(options.limit);
    return c.toArray();
  }

  /** Drop tombstones unless the caller asked for them. */
  private filterDeleted(rows: StoredRow[], options: ListOptions): StoredRow[] {
    return options.includeDeleted ? rows : rows.filter((r) => r.deleted === 0);
  }

  /** Decrypt rows, silently dropping any that fail. */
  protected async decode(rows: StoredRow[]): Promise<T[]> {
    const { records, failedIds } = await decodeRows<T>(this.keys(), this.table, rows);
    if (failedIds.length > 0) {
      console.warn(
        `[vault] ${failedIds.length} unreadable row(s) in ${this.table} were skipped`,
        failedIds,
      );
    }
    return records;
  }
}

/**
 * A repository for a table holding exactly one row under a fixed id.
 *
 * @typeParam T the record type
 */
export class SingletonRepo<T extends BaseRecord> extends Repo<T> {
  /** The fixed primary key. */
  readonly fixedId: string;

  /**
   * @param table the vault table name
   * @param fixedId the constant primary key, e.g. `'profile'`
   */
  constructor(table: VaultTableName, fixedId: string) {
    super(table);
    this.fixedId = fixedId;
  }

  /**
   * Read the singleton.
   *
   * @returns the record, or `null` when it has never been written
   */
  async load(): Promise<T | null> {
    return this.get(this.fixedId);
  }

  /**
   * Create the singleton if it is missing, then return it.
   *
   * @param defaults the record body to write on first call
   * @returns the existing or newly created record
   */
  async loadOrCreate(defaults: Omit<T, keyof BaseRecord>): Promise<T> {
    const existing = await this.load();
    if (existing) return existing;
    return this.create({ ...(defaults as object), id: this.fixedId } as NewRecord<T>);
  }

  /**
   * Patch the singleton, creating it from `defaults` when absent.
   *
   * @param patch fields to change
   * @param defaults body used if the record does not exist yet
   * @returns the updated record
   */
  async save(patch: RecordPatch<T>, defaults?: Omit<T, keyof BaseRecord>): Promise<T> {
    const existing = await this.load();
    if (!existing) {
      if (!defaults) throw new Error(`${this.table}: cannot patch a record that does not exist`);
      return this.create({ ...(defaults as object), ...patch, id: this.fixedId } as NewRecord<T>);
    }
    const updated = await this.update(this.fixedId, patch);
    return updated ?? existing;
  }
}

export { VaultLockedError };
