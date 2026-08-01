/** Encrypted clinical-lab repository. LOINC and values remain ciphertext-only. */

import type { LabRecord } from '../types';
import { Repo, type BulkResult, type NewRecord } from './base';
import { encodeRow, sourceHashFor } from '../codec';

export type NewLabRecord = NewRecord<LabRecord> & { sourceKey: string };

/** Imported lab results, idempotent across providers and repeated exports. */
export class LabRecordRepo extends Repo<LabRecord> {
  constructor() {
    super('labRecords');
  }

  /** Newest clinical results, with full encrypted provenance. */
  async recent(limit = 20): Promise<LabRecord[]> {
    const rows = await this.listAll();
    return rows
      .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))
      .slice(0, Math.max(0, limit));
  }

  /**
   * Store a batch while collapsing provider-independent duplicates and
   * retaining the union of providers/releases that supplied each result.
   */
  async ingest(items: readonly NewLabRecord[]): Promise<BulkResult<LabRecord>> {
    const grouped = new Map<string, NewLabRecord>();
    for (const item of items) {
      const prior = grouped.get(item.sourceKey);
      grouped.set(
        item.sourceKey,
        prior
          ? {
              ...prior,
              providers: unique([...prior.providers, ...item.providers]),
              fhirReleases: unique([...prior.fhirReleases, ...item.fhirReleases]),
            }
          : { ...item, providers: unique(item.providers), fhirReleases: unique(item.fhirReleases) },
      );
    }

    const records: LabRecord[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const item of grouped.values()) {
      const outcome = await this.mergeOne(item);
      records.push(outcome.record);
      if (outcome.kind === 'created') created++;
      else if (outcome.kind === 'updated') updated++;
      else skipped++;
    }
    return { records, created, updated, skipped };
  }

  /** Atomic natural-key insert plus optimistic provider-union update. */
  private async mergeOne(
    item: NewLabRecord,
  ): Promise<{ record: LabRecord; kind: 'created' | 'updated' | 'skipped' }> {
    const current = await this.findBySourceKey(item.sourceKey);
    if (current) {
      if (current.deletedAt !== null) return { record: current, kind: 'skipped' };
      const updated = await this.mutateRecord(current.id, (latest) => ({
        ...latest,
        ...item,
        id: latest.id,
        createdAt: latest.createdAt,
        deletedAt: latest.deletedAt,
        providers: unique([...latest.providers, ...item.providers]),
        fhirReleases: unique([...latest.fhirReleases, ...item.fhirReleases]),
      }));
      if (updated) return { record: updated, kind: 'updated' };
      return this.mergeOne(item);
    }

    const keys = this.keys();
    const hash = await sourceHashFor(keys, 'labRecords', item.sourceKey);
    const ts = Date.now();
    const record = {
      ...(item as object),
      id: item.id ?? `lab-${hash}`,
      createdAt: item.createdAt ?? ts,
      updatedAt: ts,
      deletedAt: null,
    } as LabRecord;
    try {
      await this.rows().add(await encodeRow(keys, 'labRecords', record));
      return { record, kind: 'created' };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConstraintError') throw error;
      return this.mergeOne(item);
    }
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export const labRecords = new LabRecordRepo();
