/**
 * @file System repositories: third-party integrations, coaching insights, and
 * the ingest audit log.
 */

import type {
  DateKey,
  IngestLogEntry,
  Insight,
  InsightType,
  Integration,
  IntegrationProvider,
} from '../types';
import { Repo, type NewRecord } from './base';
import { toDateKey } from './health';
import { encodeRow, sourceHashFor } from '../codec';

/**
 * Third-party credentials and sync state.
 *
 * **The most sensitive table in the vault.** A leaked Oura token is a live
 * read handle on the user's biometrics at the vendor, independent of this
 * device — losing it is worse than losing a copy of the data. Tokens live
 * inside the ciphertext; only the blind-indexed provider name is queryable.
 */
export class IntegrationRepo extends Repo<Integration> {
  constructor() {
    super('integrations');
  }

  /**
   * Look up an integration by provider.
   *
   * @param provider the vendor
   * @returns the integration, or `null` when not connected
   */
  async getByProvider(provider: IntegrationProvider): Promise<Integration | null> {
    return this.findBySourceKey(provider);
  }

  /**
   * Connect or reconnect a provider, replacing any existing credentials.
   *
   * @param provider the vendor
   * @param input the credentials and metadata
   * @returns the stored integration
   */
  async connect(
    provider: IntegrationProvider,
    input: Omit<NewRecord<Integration>, 'provider'>,
  ): Promise<Integration> {
    const result = await this.upsertBySourceKey(provider, {
      ...input,
      provider,
    } as NewRecord<Integration>);
    return result.record;
  }

  /**
   * Disconnect a provider, destroying its tokens.
   *
   * Hard-deletes rather than soft-deletes: a tombstoned row would keep the
   * ciphertext, and the point of disconnecting is that the token is gone. The
   * sync history in `ingestLog` is untouched.
   *
   * @param provider the vendor
   */
  async disconnect(provider: IntegrationProvider): Promise<void> {
    const existing = await this.getByProvider(provider);
    if (existing) await this.hardDelete(existing.id);
  }

  /**
   * Record the outcome of a sync attempt.
   *
   * @param provider the vendor
   * @param patch the fields to update — typically `lastSyncedAt` and `cursor`
   */
  async noteSync(provider: IntegrationProvider, patch: Partial<Integration>): Promise<void> {
    const existing = await this.getByProvider(provider);
    if (existing) await this.update(existing.id, patch);
  }

  /**
   * Every connected provider.
   *
   * @returns the integrations
   */
  async listConnected(): Promise<Integration[]> {
    return (await this.listAll()).filter((i) => i.status === 'connected');
  }
}

/** Ranked coaching outputs from the rules engine. */
export class InsightRepo extends Repo<Insight> {
  private readonly ruleWrites = new Map<string, Promise<Insight>>();

  constructor() {
    super('insights');
  }

  /**
   * Live insights for one day, ranked.
   *
   * Ordered by severity then by score, and **guardrail failures are filtered
   * out entirely** — `ARCHITECTURE.md` §6 rule 4 says nothing reaches the user
   * without passing `guardrails.ts`, so this layer enforces it too rather than
   * trusting the caller.
   *
   * @param dateKey `YYYY-MM-DD`
   * @param options.includeDismissed keep insights the user dismissed
   * @returns the ranked insights
   */
  async getForDate(
    dateKey: DateKey,
    options: { includeDismissed?: boolean } = {},
  ): Promise<Insight[]> {
    const rows = await this.listByDate(dateKey);
    const severityRank: Record<string, number> = {
      critical: 0,
      warning: 1,
      suggestion: 2,
      info: 3,
    };
    return rows
      .filter((i) => i.guardrailPassed)
      .filter((i) => options.includeDismissed || i.dismissedAt === null)
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.score - a.score);
  }

  /**
   * Today's insights.
   *
   * @returns the ranked insights for the current local day
   */
  async getToday(): Promise<Insight[]> {
    return this.getForDate(toDateKey(new Date()));
  }

  /**
   * Insights of one type over a range — the weekly review's raw material.
   *
   * @param type the insight category
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   */
  async getByType(type: InsightType, from: DateKey, to: DateKey): Promise<Insight[]> {
    const rows = await this.rows()
      .where('[type+dateKey]')
      .between([type, from], [type, to], true, true)
      .toArray();
    const records = await this.decode(rows.filter((r) => r.deleted === 0));
    return records.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  }

  /**
   * Replace the output of one rule for one day.
   *
   * Rules are re-evaluated whenever new data lands, so this is the normal
   * write path: the same `ruleId` on the same day supersedes itself instead of
   * piling up duplicates.
   *
   * @param ruleId the rule's stable identifier
   * @param dateKey the day the insight is about
   * @param input the insight body
   * @returns the stored insight
   */
  async upsertRuleOutput(
    ruleId: string,
    dateKey: DateKey,
    input: NewRecord<Insight>,
  ): Promise<Insight> {
    const key = `${ruleId}\u0000${dateKey}`;
    const prior = this.ruleWrites.get(key) ?? Promise.resolve(null);
    const pending = prior
      .catch(() => null)
      .then(() => this.upsertRuleOutputUnlocked(ruleId, dateKey, input));
    this.ruleWrites.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.ruleWrites.get(key) === pending) this.ruleWrites.delete(key);
    }
  }

  private async upsertRuleOutputUnlocked(
    ruleId: string,
    dateKey: DateKey,
    input: NewRecord<Insight>,
  ): Promise<Insight> {
    const normalized = { ...input, ruleId, dateKey } as NewRecord<Insight>;
    const existing = (await this.listByDate(dateKey)).find((i) => i.ruleId === ruleId);
    if (existing) {
      // Re-running the coach may refresh its wording and score, but it must not
      // erase a choice the user already made about this occurrence.
      const output = {
        type: normalized.type,
        dateKey: normalized.dateKey,
        severity: normalized.severity,
        title: normalized.title,
        body: normalized.body,
        ruleId: normalized.ruleId,
        score: normalized.score,
        guardrailPassed: normalized.guardrailPassed,
        evidence: normalized.evidence,
      };
      const unchanged = ([
        'type',
        'dateKey',
        'severity',
        'title',
        'body',
        'ruleId',
        'score',
        'guardrailPassed',
      ] as const).every((key) => existing[key] === output[key])
        && JSON.stringify(existing.evidence) === JSON.stringify(output.evidence);
      if (unchanged) return existing;
      // Deliberately omit response timestamps from the patch. Repo.update's
      // optimistic retry then preserves a simultaneous button tap or another
      // window's choice instead of replaying stale values over it.
      const updated = await this.update(existing.id, output as Partial<Insight>);
      if (updated) return updated;
    }

    // The primary key is an opaque keyed hash, not the plaintext rule/date.
    // `add` is the concurrency primitive: two effects/tabs may both observe a
    // miss, but only one can insert this id. The loser rereads the winner rather
    // than overwriting a response timestamp with stale nulls.
    const keys = this.keys();
    const id = `coach-${await sourceHashFor(keys, 'insights', `${ruleId}\u0000${dateKey}`)}`;
    const ts = Date.now();
    const record = {
      ...(normalized as object),
      id,
      createdAt: normalized.createdAt ?? ts,
      updatedAt: ts,
      deletedAt: null,
    } as Insight;
    try {
      await this.rows().add(await encodeRow(keys, 'insights', record));
      return record;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConstraintError') throw error;
      // Another writer won. Re-enter the update path, which deliberately omits
      // dismissedAt/acknowledgedAt and therefore preserves its response state.
      return this.upsertRuleOutputUnlocked(ruleId, dateKey, normalized);
    }
  }

  /**
   * Mark an insight dismissed.
   *
   * @param id the insight
   */
  async dismiss(id: string): Promise<void> {
    await this.update(id, { dismissedAt: Date.now() } as Partial<Insight>);
  }

  /**
   * Mark an insight acted upon — the coach's memory of what the user did.
   *
   * @param id the insight
   */
  async acknowledge(id: string): Promise<void> {
    await this.update(id, { acknowledgedAt: Date.now() } as Partial<Insight>);
  }
}

/** The ingest audit trail. */
export class IngestLogRepo extends Repo<IngestLogEntry> {
  constructor() {
    super('ingestLog');
  }

  /**
   * Whether a batch has already been applied.
   *
   * Node I2 calls this **before** doing any work: the same Shortcut clipboard
   * output can be tapped twice, and re-parsing it only to discard it is wasted
   * battery.
   *
   * @param batchKey a content hash of the payload
   * @returns true when this exact batch has been seen
   */
  async hasSeen(batchKey: string): Promise<boolean> {
    return (await this.findBySourceKey(batchKey)) !== null;
  }

  /**
   * Record the outcome of an ingest batch, idempotently.
   *
   * @param batchKey a content hash of the payload
   * @param input the outcome
   * @returns the stored entry
   */
  async record(batchKey: string, input: NewRecord<IngestLogEntry>): Promise<IngestLogEntry> {
    const result = await this.upsertBySourceKey(batchKey, { ...input, sourceKey: batchKey });
    return result.record;
  }

  /**
   * The most recent ingest batches, newest first.
   *
   * @param limit maximum entries. Default 25.
   */
  async recent(limit = 25): Promise<IngestLogEntry[]> {
    return this.listAll({ reverse: true, limit });
  }

  /**
   * When a provider last delivered data.
   *
   * @param provider the vendor
   * @returns epoch ms of the last applied batch, or `null`
   */
  async lastSuccessAt(provider: IntegrationProvider): Promise<number | null> {
    const rows = await this.listAll({ reverse: true, limit: 200 });
    const hit = rows.find((r) => r.provider === provider && r.status === 'applied');
    return hit?.updatedAt ?? null;
  }
}

/** Third-party integration repository. */
export const integrations = new IntegrationRepo();
/** Coaching-insight repository. */
export const insights = new InsightRepo();
/** Ingest audit-log repository. */
export const ingestLog = new IngestLogRepo();
