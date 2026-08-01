import 'fake-indexeddb/auto';

import { beforeAll, describe, expect, it } from 'vitest';
import { toStoredInsight } from '@/components/review/memory';
import type { CoachInsight } from '@/lib/algorithms';
import { insights } from '@/lib/db/repos';
import { initializeVault } from '@/lib/vault';

const GENERATED: CoachInsight = {
  id: 'concurrent-rule', domain: 'recovery', severity: 'warning',
  headline: 'Recovery needs attention', detail: 'A stable rule output.',
  action: 'Take an easier day.', caveat: null, inputs: [], confidence: 'well-established',
  tier: 1, findings: [], suppressesAlarm: false, score: 0.9,
};

describe('coach rule/day concurrency', () => {
  beforeAll(async () => {
    await initializeVault('correct horse battery staple', {
      iterations: 1000,
      issueRecoveryCode: false,
    });
  });

  it('atomically creates one row and never loses response state', async () => {
    const dateKey = '2026-08-01';
    const input = toStoredInsight(GENERATED, dateKey);
    const rows = await Promise.all(
      Array.from({ length: 12 }, () => insights.upsertRuleOutput(GENERATED.id, dateKey, input)),
    );
    expect(new Set(rows.map((row) => row.id))).toHaveLength(1);
    expect((await insights.listByDate(dateKey)).filter((row) => row.ruleId === GENERATED.id))
      .toHaveLength(1);

    await Promise.all([
      insights.dismiss(rows[0].id),
      ...Array.from({ length: 8 }, () => insights.upsertRuleOutput(GENERATED.id, dateKey, {
        ...input,
        body: 'A refreshed stable rule output.',
      })),
    ]);
    const current = (await insights.listByDate(dateKey)).find((row) => row.ruleId === GENERATED.id);
    expect(current?.dismissedAt).not.toBeNull();
    expect(current?.body).toBe('A refreshed stable rule output.');
  });
});
