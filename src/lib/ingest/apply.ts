/**
 * @file Writing a {@link CanonicalBatch} into the vault (task graph node **I4**,
 * write half).
 *
 * ## Why this is not in the worker
 *
 * The DEK is held in the main thread's session as a **non-extractable**
 * `CryptoKey`. That is not an accident of the implementation, it is the point:
 * a key that cannot be exported cannot be posted to a worker, cloned into a
 * service worker, or serialised anywhere by a bug. So the worker parses and
 * this module — running on the main thread, with the session in scope — writes.
 *
 * ## Idempotency
 *
 * Every row carries a deterministic `sourceKey`, so re-importing the same
 * `export.zip` recomputes the same keys, hits the blind index, and updates in
 * place. Re-importing a *newer* export updates the days it covers and inserts
 * the ones it adds. Neither produces a duplicate.
 *
 * A soft-deleted row is left alone by `bulkUpsertBySourceKey`: a user deleting
 * something outranks a re-import bringing it back.
 */

import { activities, healthMetrics, ingestLog, labRecords, sleep, weights } from '../db/repos';
import type {
  Activity,
  HealthMetric,
  IngestFidelity,
  LabRecord,
  SleepRecord,
  WeightEntry,
} from '../db/types';
import type { NewRecord } from '../db/repos/base';
import { maxDateKey, minDateKey } from './apple-dates';
import { APPLE_SOURCE, FIDELITY_RANK, type CanonicalBatch, type ImportReceipt } from './types';

/** Namespace for every Apple-derived idempotency key. */
const NS = 'apple-health';

/**
 * Deterministic natural keys.
 *
 * Each is the smallest tuple that identifies the datum *as a fact about a day*
 * rather than as a particular sample. A metric is one value per type per day; a
 * weigh-in is one per day; a night is one per wake day; a workout is identified
 * by when it started and what it was, which survives re-export.
 */
export const sourceKeys = {
  metric: (type: string, dateKey: string): string => `${NS}:metric:${type}:${dateKey}`,
  weight: (dateKey: string): string => `${NS}:weight:${dateKey}`,
  sleep: (dateKey: string): string => `${NS}:sleep:${dateKey}`,
  activity: (startedAt: number, activityType: string): string =>
    `${NS}:activity:${startedAt}:${activityType}`,
  lab: (observationKey: string): string => `${NS}:lab:${observationKey}`,
} as const;

/** Add `n` to `receipt.created[table]` (or `updated`). */
function bump(into: Record<string, number>, table: string, n: number): void {
  if (n > 0) into[table] = (into[table] ?? 0) + n;
}

/**
 * Preserve richer Apple data when two ingest paths target the same natural key.
 * Legacy Apple rows predate the field and are conservatively treated as ZIP
 * fidelity so enabling daily sync cannot silently downgrade them.
 */
function mayReplaceByFidelity(
  current: { source: string; fidelity?: IngestFidelity },
  incoming: { fidelity?: IngestFidelity },
): boolean {
  const currentFidelity = current.fidelity ?? (current.source === APPLE_SOURCE ? 'export-zip' : 'manual');
  const incomingFidelity = incoming.fidelity ?? 'manual';
  return FIDELITY_RANK[incomingFidelity] >= FIDELITY_RANK[currentFidelity];
}

/**
 * Write one batch, folding the outcome into the receipt.
 *
 * @param batch the parsed rows
 * @param receipt accumulated across the whole import; mutated in place
 * @returns how many rows were inserted or updated
 * @throws {import('../vault/session').VaultLockedError} when the vault locked
 *   mid-import — auto-lock does not make an exception for a long write
 */
export async function applyBatch(
  batch: CanonicalBatch,
  receipt: ImportReceipt,
): Promise<number> {
  let written = 0;

  if (batch.metrics.length > 0) {
    const items = batch.metrics.map((m) => ({
      sourceKey: sourceKeys.metric(m.type, m.dateKey),
      input: {
        source: APPLE_SOURCE,
        sourceKey: sourceKeys.metric(m.type, m.dateKey),
        type: m.type,
        dateKey: m.dateKey,
        value: m.value,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        aggregation: m.aggregation,
        fidelity: receipt.fidelity,
      } satisfies NewRecord<HealthMetric>,
    }));
    const result = await healthMetrics.bulkUpsertBySourceKey(items, {
      shouldReplace: mayReplaceByFidelity,
    });
    bump(receipt.created, 'healthMetrics', result.created);
    bump(receipt.updated, 'healthMetrics', result.updated);
    receipt.skipped += result.skipped;
    written += result.created + result.updated;
    for (const m of batch.metrics) note(receipt, m.dateKey);
  }

  if (batch.weights.length > 0) {
    const items = batch.weights.map((w) => ({
      sourceKey: sourceKeys.weight(w.dateKey),
      input: {
        source: APPLE_SOURCE,
        sourceKey: sourceKeys.weight(w.dateKey),
        dateKey: w.dateKey,
        kg: w.kg,
        measuredAt: w.measuredAt,
        bodyFatPct: w.bodyFatPct,
        note: null,
        fidelity: receipt.fidelity,
      } satisfies NewRecord<WeightEntry>,
    }));
    const result = await weights.bulkUpsertBySourceKey(items, {
      shouldReplace: mayReplaceByFidelity,
    });
    bump(receipt.created, 'weightEntries', result.created);
    bump(receipt.updated, 'weightEntries', result.updated);
    receipt.skipped += result.skipped;
    written += result.created + result.updated;
    for (const w of batch.weights) note(receipt, w.dateKey);
  }

  if (batch.sleep.length > 0) {
    const items = batch.sleep.map((s) => ({
      sourceKey: sourceKeys.sleep(s.dateKey),
      input: {
        source: APPLE_SOURCE,
        sourceKey: sourceKeys.sleep(s.dateKey),
        dateKey: s.dateKey,
        bedtimeAt: s.bedtimeAt,
        wakeAt: s.wakeAt,
        asleepMin: s.asleepMin,
        inBedMin: s.inBedMin,
        efficiency: s.efficiency,
        stages: s.stages,
        score: s.score,
        averageHeartRate: s.averageHeartRate,
        hrvMs: s.hrvMs,
        note: s.sourceLabel,
        fidelity: receipt.fidelity,
      } satisfies NewRecord<SleepRecord>,
    }));
    const result = await sleep.bulkUpsertBySourceKey(items, {
      shouldReplace: mayReplaceByFidelity,
    });
    bump(receipt.created, 'sleepRecords', result.created);
    bump(receipt.updated, 'sleepRecords', result.updated);
    receipt.skipped += result.skipped;
    written += result.created + result.updated;
    for (const s of batch.sleep) note(receipt, s.dateKey);
  }

  if (batch.activities.length > 0) {
    const items = batch.activities.map((a) => ({
      sourceKey: sourceKeys.activity(a.startedAt, a.activityType),
      input: {
        source: APPLE_SOURCE,
        sourceKey: sourceKeys.activity(a.startedAt, a.activityType),
        dateKey: a.dateKey,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        activityType: a.activityType,
        durationSec: a.durationSec,
        distanceM: a.distanceM,
        activeKcal: a.activeKcal,
        averageHeartRate: a.averageHeartRate,
        maxHeartRate: a.maxHeartRate,
        elevationGainM: a.elevationGainM,
        // Zone classification is the readiness algorithm's call, not the
        // importer's — it needs the user's heart-rate reserve.
        zone: null,
        name: a.name,
        note: null,
        fidelity: receipt.fidelity,
      } satisfies NewRecord<Activity>,
    }));
    const result = await activities.bulkUpsertBySourceKey(items, {
      shouldReplace: mayReplaceByFidelity,
    });
    bump(receipt.created, 'activities', result.created);
    bump(receipt.updated, 'activities', result.updated);
    receipt.skipped += result.skipped;
    written += result.created + result.updated;
    for (const a of batch.activities) note(receipt, a.dateKey);
  }

  if (batch.labs.length > 0) {
    const result = await labRecords.ingest(
      batch.labs.map((lab) => ({
        source: APPLE_SOURCE,
        sourceKey: sourceKeys.lab(lab.sourceKey),
        dateKey: lab.effectiveAt.slice(0, 10),
        effectiveAt: lab.effectiveAt,
        displayName: lab.displayName,
        loinc: lab.loinc,
        rawValue: lab.rawValue,
        rawUnit: lab.rawUnit,
        canonicalValue: lab.canonicalValue,
        canonicalUnit: lab.canonicalUnit,
        valueText: lab.valueText,
        rangeStatus: lab.rangeStatus,
        providers: lab.provider ? [lab.provider] : [],
        fhirReleases: [lab.fhirRelease],
      } satisfies NewRecord<LabRecord> & { sourceKey: string })),
    );
    bump(receipt.created, 'labRecords', result.created);
    bump(receipt.updated, 'labRecords', result.updated);
    receipt.skipped += result.skipped;
    written += result.created + result.updated;
    for (const lab of batch.labs) note(receipt, lab.effectiveAt.slice(0, 10));
  }

  return written;
}

/** Widen the receipt's date range to include a day. */
function note(receipt: ImportReceipt, dateKey: string): void {
  receipt.dateRange.from = minDateKey(receipt.dateRange.from, dateKey);
  receipt.dateRange.to = maxDateKey(receipt.dateRange.to, dateKey);
}

/**
 * Record the import in the audit trail.
 *
 * The log is a history, not a dedupe key: two imports of the same file are two
 * events and both are worth showing, even though the second wrote nothing new.
 *
 * @param receipt the completed receipt
 * @param batchKey optional content hash used to deduplicate a Shortcut payload
 */
export async function logImport(receipt: ImportReceipt, batchKey?: string): Promise<void> {
  const created = Object.values(receipt.created).reduce((a, b) => a + b, 0);
  const updated = Object.values(receipt.updated).reduce((a, b) => a + b, 0);
  const byTable: Record<string, number> = {};
  for (const [table, n] of Object.entries(receipt.created)) byTable[table] = n;
  for (const [table, n] of Object.entries(receipt.updated)) {
    byTable[table] = (byTable[table] ?? 0) + n;
  }

  const sourceKey = batchKey ?? `${receipt.channel}:${receipt.finishedAt}`;
  await ingestLog.record(sourceKey, {
    source: APPLE_SOURCE,
    sourceKey,
    dateKey: receipt.finishedAt.slice(0, 10),
    channel: receipt.channel,
    provider: 'apple-health',
    recordCount: receipt.rawSamplesSeen,
    appliedCount: created + updated,
    skippedCount: receipt.skipped,
    status: receipt.failures > 0 ? 'partial' : 'applied',
    error: null,
    byTable,
  });
}
