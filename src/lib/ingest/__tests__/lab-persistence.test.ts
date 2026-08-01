import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, setDb, VaultDatabase } from '@/lib/db';
import { labRecords } from '@/lib/db/repos';
import { buildV1Stores, DB_NAME } from '@/lib/db/schema';
import { initializeVault } from '@/lib/vault';
import { applyBatch, sourceKeys } from '../apply';
import { emptyBatch, emptyReceipt, type CanonicalLab } from '../types';

const PASSPHRASE = 'correct horse battery staple';

describe('lab table migration', () => {
  it('upgrades a schema-v1 vault without losing existing metadata', async () => {
    const old = new Dexie(DB_NAME);
    old.version(1).stores(buildV1Stores());
    await old.table('vaultMeta').put({ key: 'migrationProbe', value: 'survived' });
    old.close();

    const upgraded = new VaultDatabase();
    setDb(upgraded);
    await upgraded.open();
    expect(upgraded.tables.map((table) => table.name)).toContain('labRecords');
    expect(await upgraded.vaultMeta.get('migrationProbe')).toEqual({
      key: 'migrationProbe',
      value: 'survived',
    });

    upgraded.close();
    setDb(null);
    await Dexie.delete(DB_NAME);
  });
});

function lab(overrides: Partial<CanonicalLab> = {}): CanonicalLab {
  return {
    sourceKey: 'obs:provider-independent-key',
    displayName: 'Hemoglobin A1c',
    loinc: '4548-4',
    effectiveAt: '2025-11-04T08:15:00Z',
    rawValue: 5.4,
    rawUnit: '%',
    canonicalValue: 5.4,
    canonicalUnit: '%',
    valueText: null,
    rangeStatus: 'in_range',
    provider: 'Sutter Health',
    fhirRelease: 'r4',
    ...overrides,
  };
}

describe('lab persistence', () => {
  beforeAll(async () => {
    await initializeVault(PASSPHRASE, { iterations: 1000, issueRecoveryCode: false });
  });

  it('deduplicates providers while retaining their encrypted provenance', async () => {
    const batch = emptyBatch();
    batch.labs.push(lab(), lab({ provider: 'UCSF Health', fhirRelease: 'dstu2' }));
    const receipt = emptyReceipt('export-zip', 'export-zip');

    expect(await applyBatch(batch, receipt)).toBe(1);
    expect(receipt.created).toEqual({ labRecords: 1 });
    expect(await labRecords.count()).toBe(1);

    const stored = await labRecords.findBySourceKey(
      sourceKeys.lab('obs:provider-independent-key'),
    );
    expect(stored).toEqual(
      expect.objectContaining({
        dateKey: '2025-11-04',
        providers: ['Sutter Health', 'UCSF Health'],
        fhirReleases: ['r4', 'dstu2'],
      }),
    );

    const raw = await getDb().rows('labRecords').toArray();
    const visible = JSON.stringify(raw, (_key, value) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    );
    expect(visible).not.toContain('Hemoglobin A1c');
    expect(visible).not.toContain('4548-4');
    expect(visible).not.toContain('Sutter Health');
    expect(visible).not.toContain('5.4');
  });

  it('re-imports in place and adds newly observed provenance', async () => {
    const batch = emptyBatch();
    batch.labs.push(lab({ provider: 'Stanford Health', fhirRelease: 'unknown' }));
    const receipt = emptyReceipt('export-zip', 'export-zip');

    expect(await applyBatch(batch, receipt)).toBe(1);
    expect(receipt.updated).toEqual({ labRecords: 1 });
    expect(await labRecords.count()).toBe(1);
    expect((await labRecords.recent(1))[0].providers).toEqual([
      'Sutter Health',
      'UCSF Health',
      'Stanford Health',
    ]);
  });

  it('keeps one row and unions provenance across simultaneous imports', async () => {
    const batches = ['Mass General', 'Mayo Clinic'].map((provider) => {
      const batch = emptyBatch();
      batch.labs.push(lab({ sourceKey: 'obs:simultaneous', provider }));
      return batch;
    });
    await Promise.all(batches.map((batch) =>
      applyBatch(batch, emptyReceipt('export-zip', 'export-zip')),
    ));
    const stored = await labRecords.findBySourceKey(sourceKeys.lab('obs:simultaneous'));
    expect(stored?.providers.slice().sort()).toEqual(['Mass General', 'Mayo Clinic']);
    const all = await labRecords.listAll();
    expect(all.filter((row) => row.sourceKey === sourceKeys.lab('obs:simultaneous'))).toHaveLength(1);
  });

  it('keeps a genuinely different result and respects a deletion on replay', async () => {
    const before = await labRecords.count();
    const changed = emptyBatch();
    changed.labs.push(lab({ sourceKey: 'obs:different-value', rawValue: 5.5, canonicalValue: 5.5 }));
    await applyBatch(changed, emptyReceipt('export-zip', 'export-zip'));
    expect(await labRecords.count()).toBe(before + 1);

    const original = await labRecords.findBySourceKey(
      sourceKeys.lab('obs:provider-independent-key'),
    );
    expect(original).not.toBeNull();
    await labRecords.softDelete(original!.id);

    const replay = emptyBatch();
    replay.labs.push(lab());
    const receipt = emptyReceipt('export-zip', 'export-zip');
    expect(await applyBatch(replay, receipt)).toBe(0);
    expect(receipt.skipped).toBe(1);
    expect(await labRecords.count()).toBe(before);
  });
});
