/**
 * @file The user's own demonstration videos — encrypted, on the device.
 *
 * ## Why this is the important half of the feature
 *
 * A stranger on YouTube demonstrates the movement. The user's coach — whom they
 * see three days a week — demonstrates *the user's* version of the movement,
 * with the cue for *their* hips. A ten-second clip filmed in their own gym, on
 * their own bar, beats any curated id we could ship. So this is not a bonus
 * feature bolted onto the YouTube path; it is the path that outranks it in
 * `resolveDemo`.
 *
 * It is also the only demonstration path that survives a plane, a basement gym
 * with no signal, and YouTube deleting a video.
 *
 * ## Encryption
 *
 * Identical scheme to the vault's rows, using the same keys via
 * `requireKeys()`:
 *
 * - The video bytes are AES-256-GCM under the DEK, AAD-bound to
 *   `hcv1|demoBlobs|<id>`, so a row cannot be moved or swapped.
 * - The metadata (label, note, MIME type, **and the exercise slug**) is a
 *   second, independently encrypted payload — small, so listing every
 *   recording never touches a 40 MB ciphertext.
 * - The slug is indexed as a keyed blind index, exactly as
 *   `vault-schema.md` §1 requires: `rehab-shoulder-external-rotation` in
 *   plaintext would be a medical inference sitting in a disk image.
 * - Every operation calls `requireKeys()`, so a locked vault throws
 *   `VaultLockedError` rather than returning anything.
 *
 * ## Backups
 *
 * The media database remains separate so ordinary vault queries and JSON
 * backups never load large ciphertexts. Format-3 backups stream these raw
 * ciphertexts into a binary container through OPFS, one clip at a time;
 * format-2 remains the explicitly vault-only compatibility format.
 */

import Dexie, { type Table } from 'dexie';
import { blindIndex, decryptBytes, decryptJson, encryptBytes, encryptJson, randomId, rowAad, zeroBytes } from '../crypto';
import { EnvironmentError, isBrowserStorageAvailable } from '../db/db';
import { requireKeys } from '../vault/session';
import type { UserDemoMeta } from './types';

/** Database name. Deliberately not `hcvault` — that one is the vault agent's. */
export const MEDIA_DB_NAME = 'keel-media';

/** Schema version for the media database. */
export const MEDIA_DB_VERSION = 1;

/**
 * Largest recording we will store, in bytes.
 *
 * 200 MB is roughly three minutes of iPhone 4K, or fifteen minutes of 1080p —
 * far more than a form check needs. The cap exists because AES-GCM here is
 * single-shot: encrypting a file holds its plaintext, its ciphertext and the
 * WebCrypto copy in memory at once, and a 1 GB video would simply crash the tab
 * on a phone. Refusing with a sentence beats a crash with none.
 */
export const MAX_DEMO_BYTES = 200 * 1024 * 1024;

/** Metadata row: small, so listing is cheap. */
export interface RawMediaMetaRow {
  id: string;
  /** Blind index of the exercise slug. Opaque without the vault key. */
  slugHash: string;
  /** Epoch ms. Plaintext for ordering, exactly as the vault does with `updatedAt`. */
  savedAt: number;
  iv: Uint8Array;
  ct: Uint8Array;
}

/** Blob row: one big ciphertext, fetched only when something plays. */
export interface RawMediaBlobRow {
  id: string;
  iv: Uint8Array;
  ct: Uint8Array;
}

class MediaDatabase extends Dexie {
  declare demoMeta: Table<RawMediaMetaRow, string>;
  declare demoBlobs: Table<RawMediaBlobRow, string>;

  constructor() {
    super(MEDIA_DB_NAME);
    this.version(MEDIA_DB_VERSION).stores({
      demoMeta: 'id, slugHash, savedAt',
      demoBlobs: 'id',
    });
  }
}

let instance: MediaDatabase | null = null;

/**
 * The media database, constructed on first use.
 *
 * Lazy for the same reason the vault's handle is: `next build` prerenders every
 * route in Node, where `indexedDB` does not exist, and a module-scope `new
 * Dexie(...)` would take the build down.
 *
 * @returns the database
 * @throws {EnvironmentError} when IndexedDB is unavailable
 */
function getMediaDb(): MediaDatabase {
  if (!isBrowserStorageAvailable()) throw new EnvironmentError('indexedDB');
  if (!instance) instance = new MediaDatabase();
  return instance;
}

/** Replace the singleton — tests only. */
export function setMediaDbForTests(db: MediaDatabase | null): void {
  instance = db;
}

/** AAD domain for a metadata payload. */
const META_AAD = 'demoMeta';
/** AAD domain for a video payload. */
const BLOB_AAD = 'demoBlobs';
/** Blind-index domain for the slug. Mirrors the vault's `<table>.<field>` form. */
const SLUG_DOMAIN = 'demoMeta.slug';

/** What {@link saveUserDemo} needs. */
export interface SaveDemoInput {
  /** Exercise slug the recording demonstrates. */
  readonly slug: string;
  /** The recorded file, straight from `<input type="file" capture>`. */
  readonly file: Blob;
  /** What to call it. Defaults to a dated label. */
  readonly label?: string;
  /** The coach's actual words, typed while they are fresh. */
  readonly note?: string | null;
  /** Duration in seconds when the caller could measure it. */
  readonly durationSec?: number | null;
}

/** Raised when a recording is refused before anything is written. */
export class DemoTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(
      `That video is ${(bytes / 1024 / 1024).toFixed(0)} MB. The limit is ${(
        MAX_DEMO_BYTES /
        1024 /
        1024
      ).toFixed(0)} MB — trim it, or record a shorter clip.`,
    );
    this.name = 'DemoTooLargeError';
  }
}

/**
 * Encrypt and store one recording.
 *
 * @param input the slug, the file, and what the user called it
 * @returns the stored metadata
 * @throws {DemoTooLargeError} when the file exceeds {@link MAX_DEMO_BYTES}
 * @throws {import('@/lib/vault').VaultLockedError} when the vault is locked
 * @throws {EnvironmentError} outside a browser
 */
export async function saveUserDemo(input: SaveDemoInput): Promise<UserDemoMeta> {
  if (input.file.size > MAX_DEMO_BYTES) throw new DemoTooLargeError(input.file.size);
  const keys = requireKeys('saving a demonstration video');
  const db = getMediaDb();
  const id = randomId();

  const meta: UserDemoMeta = {
    id,
    slug: input.slug,
    label: input.label?.trim() || defaultLabel(),
    mimeType: input.file.type || 'video/mp4',
    bytes: input.file.size,
    savedAt: Date.now(),
    durationSec: input.durationSec ?? null,
    note: input.note?.trim() || null,
  };

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  // All crypto happens before the transaction: an IndexedDB transaction
  // auto-commits when the microtask queue drains, and WebCrypto resolves on a
  // different task source. This is the house rule from `channel/020-vault.md`.
  const blobPayload = await encryptBytes(keys.dek, bytes, rowAad(BLOB_AAD, id));
  const metaPayload = await encryptJson(keys.dek, meta, rowAad(META_AAD, id));
  const slugHash = await blindIndex(keys.indexKey, SLUG_DOMAIN, input.slug);

  await db.transaction('rw', db.demoMeta, db.demoBlobs, async () => {
    await db.demoBlobs.put({ id, iv: blobPayload.iv, ct: blobPayload.ct });
    await db.demoMeta.put({
      id,
      slugHash,
      savedAt: meta.savedAt,
      iv: metaPayload.iv,
      ct: metaPayload.ct,
    });
  });

  return meta;
}

/** A dated label, so an unnamed recording is still identifiable in a list. */
function defaultLabel(): string {
  return `Recorded ${new Date().toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`;
}

/**
 * Every recording for one exercise, newest first.
 *
 * @param slug the exercise slug
 * @returns metadata only — the video bytes are not touched
 */
export async function listUserDemos(slug: string): Promise<UserDemoMeta[]> {
  const keys = requireKeys('listing demonstration videos');
  const db = getMediaDb();
  const slugHash = await blindIndex(keys.indexKey, SLUG_DOMAIN, slug);
  const rows = await db.demoMeta.where('slugHash').equals(slugHash).toArray();
  const out = await decodeMetaRows(rows);
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Every recording in the store, newest first.
 *
 * @returns metadata for all recordings
 */
export async function listAllUserDemos(): Promise<UserDemoMeta[]> {
  requireKeys('listing demonstration videos');
  const rows = await getMediaDb().demoMeta.orderBy('savedAt').reverse().toArray();
  return decodeMetaRows(rows);
}

/** Decrypt metadata rows, skipping any that fail rather than failing the list. */
async function decodeMetaRows(rows: readonly RawMediaMetaRow[]): Promise<UserDemoMeta[]> {
  const keys = requireKeys('reading demonstration videos');
  const out: UserDemoMeta[] = [];
  for (const row of rows) {
    try {
      const meta = await decryptJson<UserDemoMeta>(
        keys.dek,
        { iv: row.iv, ct: row.ct },
        rowAad(META_AAD, row.id),
        `demoMeta:${row.id}`,
      );
      if (meta && typeof meta === 'object' && meta.id === row.id) out.push(meta);
    } catch {
      // One unreadable row must not blank the whole list. The count of live
      // rows minus the count returned is what the settings screen reports.
    }
  }
  return out;
}

/**
 * The recording to show for an exercise: the most recent one.
 *
 * @param slug the exercise slug
 * @returns its metadata, or `null` when there is none
 */
export async function primaryUserDemo(slug: string): Promise<UserDemoMeta | null> {
  const all = await listUserDemos(slug);
  return all[0] ?? null;
}

/**
 * Decrypt one recording into a playable `Blob`.
 *
 * The result is handed to `URL.createObjectURL`, which produces a `blob:` URL —
 * same-origin, in-memory, and covered by the `media-src 'self' blob:` line in
 * the CSP. It never touches the network.
 *
 * **Revoke the object URL when the player unmounts.** `useUserDemoUrl` in
 * `components/video` does it, including on vault lock.
 *
 * @param id the recording id
 * @returns the decrypted video
 * @throws {Error} when the id is unknown
 */
export async function loadUserDemoBlob(id: string): Promise<Blob> {
  const keys = requireKeys('playing a demonstration video');
  const db = getMediaDb();
  const [blobRow, metaRow] = await Promise.all([db.demoBlobs.get(id), db.demoMeta.get(id)]);
  if (!blobRow || !metaRow) throw new Error(`No demonstration video with id ${id}`);

  const meta = await decryptJson<UserDemoMeta>(
    keys.dek,
    { iv: metaRow.iv, ct: metaRow.ct },
    rowAad(META_AAD, id),
    `demoMeta:${id}`,
  );
  const bytes = await decryptBytes(
    keys.dek,
    { iv: blobRow.iv, ct: blobRow.ct },
    rowAad(BLOB_AAD, id),
    `demoBlobs:${id}`,
  );
  return new Blob([bytes as BlobPart], { type: meta.mimeType || 'video/mp4' });
}

/**
 * Delete one recording, bytes and metadata.
 *
 * A hard delete, not the vault's soft delete: there is no re-import path that
 * could resurrect a video, and a user deleting footage of their own body means
 * it should be gone.
 *
 * @param id the recording id
 */
export async function deleteUserDemo(id: string): Promise<void> {
  const db = getMediaDb();
  await db.transaction('rw', db.demoMeta, db.demoBlobs, async () => {
    await db.demoMeta.delete(id);
    await db.demoBlobs.delete(id);
  });
}

/**
 * Delete every recording, bytes and metadata.
 *
 * Shared by both "remove my videos" and the app-wide "delete everything"
 * control. This operation intentionally does not require the vault key: even
 * orphaned clips left behind by a replaced or damaged keyring must remain
 * deletable.
 */
export async function deleteAllUserDemos(): Promise<void> {
  if (!isBrowserStorageAvailable()) throw new EnvironmentError('indexedDB');

  // Delete the database itself instead of clearing today's two tables. That
  // gives the app-wide wipe a future-proof guarantee: a table introduced by a
  // later media schema cannot be forgotten here and leave footage behind.
  // Closing our singleton first also prevents our own connection from
  // blocking IndexedDB's database-deletion request.
  instance?.close();
  instance = null;
  await Dexie.delete(MEDIA_DB_NAME);
}

/**
 * Encrypted metadata rows for the streaming backup writer.
 *
 * This intentionally does not require an unlocked session: callers receive
 * only ciphertext and opaque indexes, exactly as a disk image would. The
 * backup module authenticates the complete container with the user's backup
 * secret before any file is offered or restored.
 */
export async function listRawMediaMeta(): Promise<RawMediaMetaRow[]> {
  if (!isBrowserStorageAvailable()) throw new EnvironmentError('indexedDB');
  return getMediaDb().demoMeta.orderBy('savedAt').toArray();
}

/** Read one encrypted clip without loading any other clip. */
export async function readRawMediaBlob(id: string): Promise<RawMediaBlobRow | null> {
  if (!isBrowserStorageAvailable()) throw new EnvironmentError('indexedDB');
  return (await getMediaDb().demoBlobs.get(id)) ?? null;
}

/** Authenticate one raw pair and validate its encrypted metadata/body binding. */
export async function authenticateRawMediaPair(
  dek: CryptoKey,
  indexKey: CryptoKey,
  metaRow: RawMediaMetaRow,
  blobRow: RawMediaBlobRow,
): Promise<void> {
  if (metaRow.id !== blobRow.id) throw new Error('Media row ids do not match');
  const meta = await decryptJson<UserDemoMeta>(
    dek,
    { iv: metaRow.iv, ct: metaRow.ct },
    rowAad(META_AAD, metaRow.id),
    `demoMeta:${metaRow.id}`,
  );
  if (
    !meta || meta.id !== metaRow.id || meta.savedAt !== metaRow.savedAt ||
    typeof meta.slug !== 'string' || meta.slug.length === 0
  ) {
    throw new Error(`Recorded clip ${metaRow.id} has invalid metadata`);
  }
  const expectedSlugHash = await blindIndex(indexKey, SLUG_DOMAIN, meta.slug);
  if (expectedSlugHash !== metaRow.slugHash) {
    throw new Error(`Recorded clip ${metaRow.id} has an invalid exercise index`);
  }
  const plain = await decryptBytes(
    dek,
    { iv: blobRow.iv, ct: blobRow.ct },
    rowAad(BLOB_AAD, blobRow.id),
    `demoBlobs:${blobRow.id}`,
  );
  try {
    if (plain.byteLength !== meta.bytes) {
      throw new Error(`Recorded clip ${metaRow.id} has an invalid byte count`);
    }
  } finally {
    zeroBytes(plain);
  }
}

/**
 * Start a fail-closed media replacement by deleting the complete old store.
 * The vault's durable cleanup marker must already be set by the caller.
 */
export async function beginRawMediaReplace(): Promise<void> {
  await deleteAllUserDemos();
}

/** Write one already-encrypted media pair during a container restore. */
export async function putRawMediaPair(
  meta: RawMediaMetaRow,
  blob: RawMediaBlobRow,
): Promise<void> {
  if (meta.id !== blob.id) throw new Error('Media metadata and ciphertext ids do not match');
  const db = getMediaDb();
  await db.transaction('rw', db.demoMeta, db.demoBlobs, async () => {
    await db.demoBlobs.put(blob);
    await db.demoMeta.put(meta);
  });
}

/** What the storage row in Settings shows. */
export interface DemoStorageUsage {
  readonly count: number;
  readonly bytes: number;
}

/**
 * How much space the recordings take.
 *
 * Counted from the decrypted metadata rather than from ciphertext lengths, so
 * the number matches what the user thinks they filmed. Requires an unlocked
 * vault, like everything else here.
 *
 * @returns count and total bytes
 */
export async function userDemoStorageUsage(): Promise<DemoStorageUsage> {
  const all = await listAllUserDemos();
  return {
    count: all.length,
    bytes: all.reduce((sum, meta) => sum + meta.bytes, 0),
  };
}

/**
 * Slugs that have at least one recording.
 *
 * Used by the Settings coverage line and by any screen that wants to badge the
 * exercises the user has filmed.
 *
 * @returns unique slugs
 */
export async function recordedSlugs(): Promise<string[]> {
  const all = await listAllUserDemos();
  return [...new Set(all.map((meta) => meta.slug))];
}
