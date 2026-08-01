import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { beforeAll, describe, expect, it } from 'vitest';
import { weights } from '@/lib/db/repos';
import {
  deleteAllUserDemos,
  listAllUserDemos,
  loadUserDemoBlob,
  saveUserDemo,
  MEDIA_DB_NAME,
} from '@/lib/video';
import { isMediaCleanupPending, recordMediaCleanupComplete, initializeVault, unlock } from '../index';
import {
  MediaMergeUnsupportedError,
  importPortableBackup,
  previewPortableImport,
  writePortableBackup,
  type PortableBackupSink,
} from '../media-backup';
import { exportVault } from '../backup';

const PASSPHRASE = 'correct horse battery staple';
const SECRET = { kind: 'passphrase', value: PASSPHRASE } as const;
const MARKER_A = 'FIRST-SECRET-CLIP-';
const MARKER_B = 'SECOND-SECRET-CLIP-';

class MemorySink implements PortableBackupSink {
  readonly chunks: Uint8Array[] = [];
  closed = false;
  aborted = false;

  constructor(private readonly failAtWrite: number | null = null) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.failAtWrite !== null && this.chunks.length === this.failAtWrite) {
      throw new Error('simulated interrupted write');
    }
    this.chunks.push(chunk.slice());
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.chunks.length = 0;
  }

  blob(): Blob {
    return new Blob(this.chunks.map((chunk) => chunk as BlobPart));
  }
}

async function build(): Promise<Blob> {
  const sink = new MemorySink();
  const result = await writePortableBackup(SECRET, sink);
  expect(result.mediaCount).toBe(2);
  expect(sink.closed).toBe(true);
  return sink.blob();
}

describe('version-3 media backup', () => {
  beforeAll(async () => {
    await initializeVault(PASSPHRASE, { iterations: 1000, issueRecoveryCode: false });
    await weights.create({
      source: 'manual',
      sourceKey: null,
      dateKey: '2026-08-01',
      kg: 80,
      measuredAt: Date.parse('2026-08-01T08:00:00Z'),
      bodyFatPct: null,
      note: 'must survive with clips',
    });
    await saveUserDemo({
      slug: 'squat',
      file: new Blob([MARKER_A.repeat(128)], { type: 'video/mp4' }),
      label: 'Squat cue',
      note: 'knees forward',
    });
    await saveUserDemo({
      slug: 'deadlift',
      file: new Blob([MARKER_B.repeat(96)], { type: 'video/mp4' }),
      label: 'Deadlift cue',
      note: 'push the floor',
    });
  });

  it('writes sequential raw ciphertext and verifies the complete container', async () => {
    const file = await build();
    const preview = await previewPortableImport(file, SECRET);
    expect(preview.formatVersion).toBe(3);
    expect(preview.mediaCount).toBe(2);
    expect(preview.mediaBytes).toBeGreaterThan(MARKER_A.length * 128);
    expect(preview.integrityOk).toBe(true);
    expect(preview.mediaIntegrityOk).toBe(true);
    expect(preview.restorable).toBe(true);
    // Raw footage is not present: the container carries existing ciphertext.
    expect(await file.text()).not.toContain(MARKER_A);
    expect(await file.text()).not.toContain(MARKER_B);
  });

  it('refuses to certify a clip whose blind exercise index is corrupted', async () => {
    const raw = new Dexie(MEDIA_DB_NAME);
    raw.version(1).stores({ demoMeta: 'id, slugHash, savedAt', demoBlobs: 'id' });
    const table = raw.table<{ id: string; slugHash: string }, string>('demoMeta');
    const row = (await table.toArray())[0];
    const original = row.slugHash;
    await table.update(row.id, { slugHash: 'x'.repeat(22) });
    try {
      await expect(writePortableBackup(SECRET, new MemorySink())).rejects.toThrow(/exercise index/i);
    } finally {
      await table.update(row.id, { slugHash: original });
      raw.close();
    }
  });

  it('aborts and discards a partially written container', async () => {
    // Header and manifest succeed; the first ciphertext write is interrupted.
    const sink = new MemorySink(2);
    await expect(writePortableBackup(SECRET, sink)).rejects.toThrow(/interrupted/);
    expect(sink.aborted).toBe(true);
    expect(sink.closed).toBe(false);
    expect(sink.chunks).toHaveLength(0);
  });

  it('rejects a wrong secret before treating the file as restorable', async () => {
    const file = await build();
    await expect(
      previewPortableImport(file, { kind: 'passphrase', value: 'wrong passphrase' }),
    ).rejects.toThrow(/open|unlock|secret/i);
  });

  it('rejects truncated and tampered media before any restore write', async () => {
    const file = await build();
    await expect(previewPortableImport(file.slice(0, file.size - 1), SECRET)).rejects.toThrow(
      /truncated|integrity/i,
    );

    const bytes = new Uint8Array(await file.arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    await expect(previewPortableImport(new Blob([bytes]), SECRET)).rejects.toThrow(/integrity/i);
    expect(await listAllUserDemos()).toHaveLength(2);
  });

  it('refuses media merge explicitly without changing local clips', async () => {
    const file = await build();
    await expect(
      importPortableBackup(file, SECRET, { mode: 'merge' }),
    ).rejects.toBeInstanceOf(MediaMergeUnsupportedError);
    expect(await listAllUserDemos()).toHaveLength(2);
  });

  it('round-trips clips, metadata, and vault records through replace', async () => {
    const file = await build();
    await deleteAllUserDemos();
    expect(await listAllUserDemos()).toHaveLength(0);

    const result = await importPortableBackup(file, SECRET, { mode: 'replace' });
    expect(result.mediaApplied).toBe(2);
    await unlock(PASSPHRASE);

    const restored = await listAllUserDemos();
    expect(restored.map((item) => item.label).sort()).toEqual(['Deadlift cue', 'Squat cue']);
    const squat = restored.find((item) => item.slug === 'squat');
    expect(squat?.note).toBe('knees forward');
    expect(await (await loadUserDemoBlob(squat!.id)).text()).toBe(MARKER_A.repeat(128));
    expect((await weights.listByDate('2026-08-01'))[0].note).toBe('must survive with clips');
  });

  it('continues to inspect format-2 vault-only backups as zero-media files', async () => {
    const legacy = await exportVault(SECRET);
    const preview = await previewPortableImport(legacy, SECRET);
    expect(preview.formatVersion).toBe(2);
    expect(preview.mediaCount).toBe(0);
    expect(preview.mediaIntegrityOk).toBe(true);
  });

  it('leaves the durable cleanup gate set after an interrupted media restore', async () => {
    const file = await build();
    await expect(
      importPortableBackup(file, SECRET, { mode: 'replace' }, {
        beforeMediaWrite: (applied) => {
          if (applied === 1) throw new Error('simulated iOS termination');
        },
      }),
    ).rejects.toThrow(/termination/);
    expect(await isMediaCleanupPending()).toBe(true);

    // Startup's fail-closed recovery performs these same two idempotent steps.
    await deleteAllUserDemos();
    await recordMediaCleanupComplete();
    expect(await isMediaCleanupPending()).toBe(false);
    await unlock(PASSPHRASE);
  });

  it('restores format 2 as vault-only and clears clips it cannot contain', async () => {
    await saveUserDemo({
      slug: 'bench-press',
      file: new Blob(['format-2-cannot-contain-this'], { type: 'video/mp4' }),
    });
    const legacy = await exportVault(SECRET);
    const result = await importPortableBackup(legacy, SECRET, { mode: 'replace' });
    expect(result.mediaApplied).toBe(0);
    expect(await isMediaCleanupPending()).toBe(false);
    await unlock(PASSPHRASE);
    expect(await listAllUserDemos()).toHaveLength(0);
  });
});
