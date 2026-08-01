/**
 * §8.5 is normative. These are the rules as executable assertions.
 *
 * The two that matter most, and that are easiest to violate by accident:
 * a readiness score may never *raise* a prescribed load, and nothing may ever
 * counsel training through pain.
 */

import { describe, expect, it } from 'vitest';

import { hasBlock } from '../../algorithms/guardrails';
import {
  ADJUSTMENT_LIMITS,
  checkLoggedSet,
  clampAdjustment,
  painFindings,
  PAIN_COPY,
  suggestNextSet,
  volumeFindings,
} from '../guardrails';
import type { LoggedSet } from '../types';

type Previous = Pick<LoggedSet, 'weightKg' | 'unitValue' | 'repUnit' | 'effort' | 'effortKind'>;

function previous(over: Partial<Previous> = {}): Previous {
  return {
    weightKg: 100,
    unitValue: 8,
    repUnit: 'reps',
    effort: 2,
    effortKind: 'rir',
    ...over,
  };
}

describe('bounded adjustments (§8.5 rule 1)', () => {
  it('clamps volume, RIR and load to the published bounds', () => {
    expect(clampAdjustment('volume', -0.9)).toBe(ADJUSTMENT_LIMITS.volume.min);
    expect(clampAdjustment('volume', 0.8)).toBe(ADJUSTMENT_LIMITS.volume.max);
    expect(clampAdjustment('rir', -5)).toBe(ADJUSTMENT_LIMITS.rir.min);
    expect(clampAdjustment('rir', 9)).toBe(ADJUSTMENT_LIMITS.rir.max);
    expect(clampAdjustment('load', -0.9)).toBe(ADJUSTMENT_LIMITS.load.min);
  });

  it('never permits a positive load adjustment, whatever is proposed', () => {
    expect(clampAdjustment('load', 0.25)).toBe(0);
    expect(ADJUSTMENT_LIMITS.load.max).toBe(0);
  });
});

describe('suggestNextSet', () => {
  it('returns nothing on a first-ever exposure rather than inventing a number', () => {
    expect(suggestNextSet(null, { repRange: [6, 10] })).toBeNull();
  });

  it('adds load and resets reps when the top of the range was hit at low RIR', () => {
    const s = suggestNextSet(previous({ unitValue: 10, effort: 1 }), {
      repRange: [6, 10],
      upperBody: true,
    })!;
    expect(s.weightKg).toBeGreaterThan(100);
    expect(s.weightKg).toBeCloseTo(102.5, 6);
    expect(s.unitValue).toBe(6);
  });

  it('adds a rep at the same load inside the range', () => {
    const s = suggestNextSet(previous({ unitValue: 8 }), { repRange: [6, 10] })!;
    expect(s.weightKg).toBe(100);
    expect(s.unitValue).toBe(9);
  });

  it('repeats rather than progresses when the unit is not reps', () => {
    const s = suggestNextSet(
      previous({ repUnit: 'seconds', unitValue: 1800, weightKg: 0 }),
      { repRange: [1800, 3600] },
    )!;
    expect(s.unitValue).toBe(1800);
    expect(s.weightKg).toBe(0);
  });

  it('NEVER raises the load because readiness is high', () => {
    const base = suggestNextSet(previous({ unitValue: 8 }), { repRange: [6, 10] })!;
    const primed = suggestNextSet(previous({ unitValue: 8 }), {
      repRange: [6, 10],
      readiness: 'high',
    })!;
    expect(primed.weightKg).toBe(base.weightKg);
    expect(primed.findings.some((f) => f.code === 'training.readiness_no_increase')).toBe(
      true,
    );
  });

  it('trims load and leaves a rep in the tank when readiness is low', () => {
    const s = suggestNextSet(previous({ unitValue: 8 }), {
      repRange: [6, 10],
      readiness: 'low',
    })!;
    expect(s.weightKg).toBeLessThan(100);
    expect(s.weightKg).toBeGreaterThan(100 * (1 + ADJUSTMENT_LIMITS.load.min));
    expect(s.targetRir).toBeGreaterThanOrEqual(ADJUSTMENT_LIMITS.minRirWhenSuppressed);
  });

  it('never prescribes below 3 RIR when readiness is suppressed', () => {
    for (const band of ['low', 'poor'] as const) {
      const s = suggestNextSet(previous({ effort: 0 }), {
        repRange: [6, 10],
        readiness: band,
      })!;
      expect(s.targetRir!).toBeGreaterThanOrEqual(3);
    }
  });

  it('cuts load by no more than 20% even at the worst readiness', () => {
    const s = suggestNextSet(previous(), { repRange: [6, 10], readiness: 'poor' })!;
    expect(s.weightKg / 100).toBeGreaterThanOrEqual(1 + ADJUSTMENT_LIMITS.load.min);
  });

  it('explains itself — an opaque adjustment is a rule violation (§8.5 rule 10)', () => {
    const s = suggestNextSet(previous(), { repRange: [6, 10], readiness: 'low' })!;
    expect(s.reason.length).toBeGreaterThan(20);
  });

  it('describes HRV as a recovery range, never as a health finding (§8.5 rule 6)', () => {
    const s = suggestNextSet(previous(), { repRange: [6, 10], readiness: 'poor' })!;
    const text = `${s.reason} ${s.findings.map((f) => f.message).join(' ')}`.toLowerCase();
    for (const word of ['diagnose', 'treat', 'cure', 'heal', 'illness', 'condition']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('pain (§8.5 rule 4)', () => {
  it('blocks progression outright and shows the required copy', () => {
    const findings = painFindings({ hasSubstitutes: true });
    expect(hasBlock(findings)).toBe(true);
    expect(findings.some((f) => f.message === PAIN_COPY)).toBe(true);
  });

  it('frames a substitution as an alternative, never as a treatment', () => {
    const message = painFindings({ hasSubstitutes: true }).find(
      (f) => f.code === 'training.substitution_offered',
    )!.message;
    expect(message).toMatch(/not a treatment/i);
  });

  it('repeats the last set rather than progressing it', () => {
    const s = suggestNextSet(previous({ unitValue: 10, effort: 0 }), {
      repRange: [6, 10],
      painFlag: true,
    })!;
    expect(s.weightKg).toBe(100);
    expect(s.unitValue).toBe(10);
    expect(hasBlock(s.findings)).toBe(true);
  });
});

describe('checkLoggedSet', () => {
  it('says nothing about an ordinary set', () => {
    expect(
      checkLoggedSet({ weightKg: 100, unitValue: 8, repUnit: 'reps', effort: 2 }),
    ).toEqual([]);
  });

  it('never blocks — a log is a record of what happened, not a proposal', () => {
    const findings = checkLoggedSet({
      weightKg: 500,
      unitValue: 200,
      repUnit: 'reps',
      effort: 2,
      bodyweightKg: 80,
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(hasBlock(findings)).toBe(false);
  });

  it('catches an empty set and an out-of-range effort', () => {
    const findings = checkLoggedSet({
      weightKg: 60,
      unitValue: 0,
      repUnit: 'reps',
      effort: 44,
    });
    expect(findings.map((f) => f.code)).toContain('set.empty_count');
    expect(findings.map((f) => f.code)).toContain('set.effort_range');
  });

  it('does not complain about a 30-minute effort logged in seconds', () => {
    expect(
      checkLoggedSet({ weightKg: 0, unitValue: 1800, repUnit: 'seconds', effort: null }),
    ).toEqual([]);
  });
});

describe('volumeFindings (§3.7)', () => {
  const base = { muscleLabel: 'Lats', consecutiveWeeksOver: 0, confirmations: 0 };

  it('says nothing while there is room left', () => {
    expect(volumeFindings({ ...base, unclamped: 4 })).toEqual([]);
  });

  it('reports coverage plainly when the trainer has filled the budget', () => {
    const f = volumeFindings({ ...base, unclamped: 0.4 });
    expect(f[0].code).toBe('volume.covered_by_trainer');
    expect(f[0].level).toBe('info');
  });

  it('escalates only after two weeks AND two confirmations', () => {
    const oneWeek = volumeFindings({ ...base, unclamped: -3, consecutiveWeeksOver: 1 });
    expect(oneWeek[0].level).toBe('info');

    const sustained = volumeFindings({
      ...base,
      unclamped: -3,
      consecutiveWeeksOver: 2,
      confirmations: 2,
    });
    expect(sustained[0].level).toBe('warn');
  });

  it('never blames the trainer, and offers options rather than instructions', () => {
    const message = volumeFindings({
      ...base,
      unclamped: -3,
      consecutiveWeeksOver: 3,
      confirmations: 4,
    })[0].message;
    expect(message).toMatch(/could easily be wrong/i);
    expect(message).toMatch(/options/i);
  });
});
