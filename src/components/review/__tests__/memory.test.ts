import { describe, expect, it, vi } from 'vitest';
import type { CoachInsight } from '@/lib/algorithms';
import type { Insight } from '@/lib/db/types';
import {
  memoryForRule,
  persistCoachInsights,
  toStoredInsight,
  visibleCoachInsights,
  visibleReviewHeadline,
} from '../memory';

const GENERATED: CoachInsight = {
  id: 'adequacy-protein',
  domain: 'adequacy',
  severity: 'suggestion',
  headline: 'Protein is below the useful floor',
  detail: 'The logged average was below the current floor.',
  action: 'Add a protein serving.',
  caveat: null,
  inputs: [{ label: 'Mean protein', value: 118, unit: 'g' }],
  confidence: 'reasonable-inference',
  tier: 2,
  findings: [],
  suppressesAlarm: false,
  score: 0.72,
};

function stored(dateKey: string, over: Partial<Insight> = {}): Insight {
  return {
    id: `row-${dateKey}`,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...toStoredInsight(GENERATED, dateKey),
    ...over,
  };
}

describe('coach memory adapter', () => {
  it('maps the pure output without dropping its action or evidence', () => {
    const row = toStoredInsight(GENERATED, '2026-08-01');
    expect(row.ruleId).toBe('adequacy-protein');
    expect(row.type).toBe('nutrition');
    expect(row.guardrailPassed).toBe(true);
    expect(row.evidence.action).toBe('Add a protein serving.');
    expect(row.evidence['input.0.value']).toBe(118);
    expect(row.dismissedAt).toBeNull();
    expect(row.acknowledgedAt).toBeNull();
  });

  it('persists only the generated list through rule/date upserts', async () => {
    const upsertRuleOutput = vi.fn(async (_rule, date, input) => stored(date, input));
    await persistCoachInsights({ upsertRuleOutput }, '2026-08-01', [GENERATED]);
    expect(upsertRuleOutput).toHaveBeenCalledTimes(1);
    expect(upsertRuleOutput).toHaveBeenCalledWith(
      'adequacy-protein',
      '2026-08-01',
      expect.objectContaining({ ruleId: 'adequacy-protein', guardrailPassed: true }),
    );
  });

  it('identifies repeats only from stored earlier dates', () => {
    const memory = memoryForRule('adequacy-protein', '2026-08-01', [
      stored('2026-07-18', { acknowledgedAt: 100 }),
      stored('2026-07-25'),
      stored('2026-08-01'),
      stored('2026-08-08'),
      stored('2026-07-11', { ruleId: 'some-other-rule' }),
    ]);
    expect(memory.priorOccurrences).toBe(2);
    expect(memory.priorActedOn).toBe(1);
    expect(memory.current?.dateKey).toBe('2026-08-01');
  });

  it('does not fabricate history when no earlier row exists', () => {
    expect(memoryForRule(GENERATED.id, '2026-08-01', [stored('2026-08-01')])).toEqual({
      current: expect.objectContaining({ dateKey: '2026-08-01' }),
      priorOccurrences: 0,
      priorActedOn: 0,
    });
  });

  it('preserves rank after dismissal and keeps the headline aligned', () => {
    const second = { ...GENERATED, id: 'adequacy-fibre', headline: 'Fibre is low', score: 0.5 };
    const current = stored('2026-08-01', { dismissedAt: 100 });
    const memory = new Map([
      [GENERATED.id, { current, priorOccurrences: 0, priorActedOn: 0 }],
    ]);
    const visible = visibleCoachInsights([GENERATED, second], memory);
    expect(visible.map((row) => row.id)).toEqual(['adequacy-fibre']);
    expect(visibleReviewHeadline({
      weekEndingDate: '2026-08-01',
      headline: GENERATED.headline,
      insights: [GENERATED, second],
      suppressed: [],
      dataGaps: [],
      findings: [],
      referral: null,
      numericTargetsSuppressed: false,
      disclaimer: 'Not medical advice.',
    }, visible)).toBe('Fibre is low');
  });
});
