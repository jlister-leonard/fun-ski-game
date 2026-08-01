/**
 * The user's own demonstration clips, exercised against the real stack.
 *
 * `fake-indexeddb` plus Node's WebCrypto runs the shipped code — the same
 * Dexie stores, the same AES-GCM, the same vault session — so the claims this
 * feature makes about the recordings are executed rather than asserted in
 * prose. The two that matter:
 *
 * - a disk image of the media database contains neither the video nor the name
 *   of the movement it demonstrates;
 * - a locked vault refuses to list or decrypt anything.
 */

import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { beforeAll, describe, expect, it } from 'vitest';

import { initializeVault, lock, unlock } from '@/lib/vault';
import {
  DemoTooLargeError,
  MAX_DEMO_BYTES,
  MEDIA_DB_NAME,
  deleteAllUserDemos,
  deleteUserDemo,
  listUserDemos,
  loadUserDemoBlob,
  primaryUserDemo,
  recordedSlugs,
  saveUserDemo,
  userDemoStorageUsage,
} from '../media';

const PASSPHRASE = 'correct horse battery staple';
/** A slug that is a medical inference all by itself — the reason slugs are blind-indexed. */
const SLUG = 'rehab-shoulder-external-rotation';
/** A recognisable byte pattern, so "is the video in the clear?" is answerable. */
const MARKER = 'SECRET-VIDEO-FRAMES-0123456789';

function fakeVideo(marker = MARKER, repeats = 64): Blob {
  return new Blob([marker.repeat(repeats)], { type: 'video/mp4' });
}

/** Read the media database the way an attacker with the disk image would. */
async function rawRows(): Promise<{ meta: unknown[]; blobs: unknown[] }> {
  const db = new Dexie(MEDIA_DB_NAME);
  db.version(1).stores({ demoMeta: 'id, slugHash, savedAt', demoBlobs: 'id' });
  await db.open();
  const meta = await db.table('demoMeta').toArray();
  const blobs = await db.table('demoBlobs').toArray();
  db.close();
  return { meta, blobs };
}

/** Every byte in the store, as a latin1 string, for substring searching. */
function flatten(rows: { meta: unknown[]; blobs: unknown[] }): string {
  const parts: string[] = [JSON.stringify(rows, (_k, v) => v)];
  for (const row of [...rows.meta, ...rows.blobs] as Record<string, unknown>[]) {
    for (const value of Object.values(row)) {
      if (value instanceof Uint8Array) {
        parts.push(String.fromCharCode(...value));
      }
    }
  }
  return parts.join('\n');
}

describe('user demo storage', () => {
  beforeAll(async () => {
    // 1,000 iterations, not 600,000: this exercises the flow, not the KDF cost.
    await initializeVault(PASSPHRASE, { iterations: 1000, issueRecoveryCode: false });
  });

  it('round-trips a recording through encryption', async () => {
    const saved = await saveUserDemo({
      slug: SLUG,
      file: fakeVideo(),
      label: "Ellie's cue for my hips",
      note: 'Keep the elbow pinned to the ribs',
      durationSec: 12,
    });

    expect(saved.slug).toBe(SLUG);
    expect(saved.bytes).toBeGreaterThan(0);

    const listed = await listUserDemos(SLUG);
    expect(listed).toHaveLength(1);
    expect(listed[0].label).toBe("Ellie's cue for my hips");
    expect(listed[0].note).toBe('Keep the elbow pinned to the ribs');
    expect(listed[0].durationSec).toBe(12);

    const blob = await loadUserDemoBlob(saved.id);
    expect(blob.type).toBe('video/mp4');
    expect(await blob.text()).toBe(MARKER.repeat(64));
  });

  it('leaves nothing readable in the raw database', async () => {
    const rows = await rawRows();
    const stored = rows.blobs[0] as { iv: Uint8Array; ct: Uint8Array };
    // Without this the substring search below could pass vacuously.
    expect(stored.ct).toBeInstanceOf(Uint8Array);
    expect(stored.iv).toHaveLength(12);

    const flat = flatten(rows);
    // The footage itself.
    expect(flat).not.toContain(MARKER);
    // Which movement it is — a medical inference on its own.
    expect(flat).not.toContain(SLUG);
    expect(flat).not.toContain('shoulder');
    // What the coach said.
    expect(flat).not.toContain('elbow');
    expect(flat).not.toContain('Ellie');
  });

  it('indexes the slug as an opaque token, not as text', async () => {
    const { meta } = await rawRows();
    const row = meta[0] as { slugHash: string };
    expect(typeof row.slugHash).toBe('string');
    expect(row.slugHash).not.toContain('shoulder');
    // 128 bits of HMAC, base64url — the same 22-character shape the vault uses.
    expect(row.slugHash).toHaveLength(22);
  });

  it('reports storage usage and which movements have footage', async () => {
    const usage = await userDemoStorageUsage();
    expect(usage.count).toBe(1);
    expect(usage.bytes).toBe(MARKER.length * 64);
    expect(await recordedSlugs()).toEqual([SLUG]);
  });

  it('shows the newest recording first', async () => {
    const second = await saveUserDemo({ slug: SLUG, file: fakeVideo('LATER', 8) });
    const primary = await primaryUserDemo(SLUG);
    expect(primary?.id).toBe(second.id);
    await deleteUserDemo(second.id);
    expect(await listUserDemos(SLUG)).toHaveLength(1);
  });

  it('refuses a file too large to encrypt in one pass', async () => {
    const huge = { size: MAX_DEMO_BYTES + 1, type: 'video/mp4' } as Blob;
    await expect(saveUserDemo({ slug: SLUG, file: huge })).rejects.toBeInstanceOf(
      DemoTooLargeError,
    );
  });

  it('refuses to read or write anything while the vault is locked', async () => {
    lock();
    await expect(listUserDemos(SLUG)).rejects.toThrow(/unlock/i);
    await expect(saveUserDemo({ slug: SLUG, file: fakeVideo() })).rejects.toThrow(/unlock/i);
    await unlock(PASSPHRASE);
    expect(await listUserDemos(SLUG)).toHaveLength(1);
  });

  it('deletes the complete media database while the vault is unlocked', async () => {
    await deleteAllUserDemos();
    const { meta, blobs } = await rawRows();
    expect(meta).toHaveLength(0);
    expect(blobs).toHaveLength(0);
    await saveUserDemo({ slug: SLUG, file: fakeVideo() });
  });

  it('deletes the complete media database even while the vault is locked', async () => {
    lock();
    await deleteAllUserDemos();
    const { meta, blobs } = await rawRows();
    expect(meta).toHaveLength(0);
    expect(blobs).toHaveLength(0);
  });
});
