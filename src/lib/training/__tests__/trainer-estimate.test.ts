/**
 * The trainer estimator. The properties asserted here are the ones that make
 * the model *safe* rather than merely plausible:
 *
 * - a session the athlete never reports still counts, at full value;
 * - the budget always subtracts an upper bound, never the mean;
 * - the uncertainty has a floor, so confirmations can never turn a guess into
 *   a claimed measurement;
 * - confidence is capped, for the same reason.
 */

import { describe, expect, it } from 'vitest';

import {
  ALPHA,
  estimateFromReport,
  meanMrvCost,
  MRV_COST,
  observedSets,
  SEED_CONFIDENCE,
  DEFAULT_TRAINER_PRIOR,
  priorFromFocus,
  regionEffortFromFocus,
  scaleToTotal,
  trainerLoadFor,
  updateConfidence,
  updateEstimate,
  weeklySd,
  zFor,
} from '../trainer-estimate';
import type { TrainerSessionReport } from '../types';

function report(over: Partial<TrainerSessionReport> = {}): TrainerSessionReport {
  return {
    durationMin: 60,
    regionEffort: {},
    hardSetsTotal: null,
    perceivedRir: null,
    sledMeters: null,
    exerciseNames: [],
    confirmed: false,
    estimate: DEFAULT_TRAINER_PRIOR,
    ...over,
  };
}

describe('local trainer-focus prior', () => {
  it('maps encrypted free text to regions without embedding a profile', () => {
    const effort = regionEffortFromFocus('posterior chain, rows and pull-ups');
    expect(effort.hips).toBe(2);
    expect(effort.mid_back).toBe(2);
    expect(effort.lats).toBe(2);
    expect(effort.pressing).toBe(0);
  });

  it('uses a neutral non-zero prior when local context is missing', () => {
    const prior = priorFromFocus('');
    expect(prior.glutes?.meanSets).toBeGreaterThan(0);
    expect(prior.chest?.meanSets).toBeGreaterThan(0);
  });
});

describe('weeklySd — correlated sessions', () => {
  it('sits between independent and identical for three sessions', () => {
    const independent = 1.2 * Math.sqrt(3); // ~2.08
    const identical = 1.2 * 3; // 3.6
    const actual = weeklySd(1.2, 3);
    expect(actual).toBeGreaterThan(independent);
    expect(actual).toBeLessThan(identical);
  });

  it('is sd × 2.45 at rho 0.5, n 3 — the number the spec quotes', () => {
    expect(weeklySd(1, 3)).toBeCloseTo(2.449, 3);
  });

  it('collapses to zero with no sessions', () => {
    expect(weeklySd(2, 0)).toBe(0);
  });
});

describe('zFor — caution that relaxes with evidence', () => {
  it('is ~0.87 at the seed confidence', () => {
    expect(zFor(SEED_CONFIDENCE)).toBeCloseTo(0.865, 3);
  });

  it('falls to ~0.26 once confidence reaches its 0.90 cap', () => {
    expect(zFor(0.9)).toBeCloseTo(0.26, 3);
  });

  it('never goes to zero, however confident the model gets', () => {
    expect(zFor(1)).toBeGreaterThanOrEqual(0.25);
    expect(zFor(10)).toBeGreaterThanOrEqual(0.25);
  });
});

describe('observedSets', () => {
  it('spreads a region over the muscles it actually loads', () => {
    const sets = observedSets({ lats: 2 });
    // Slider 2 = 4 hard sets, distributed by the region map.
    expect(sets.lats).toBeCloseTo(4 * 0.65, 6);
    expect(sets.biceps).toBeCloseTo(4 * 0.22, 6);
    expect(sets.chest).toBeUndefined();
  });

  it('treats an untouched region as zero, not as unknown', () => {
    expect(observedSets({ lats: 0 })).toEqual({});
    expect(observedSets({})).toEqual({});
  });

  it('accumulates across regions that share a muscle', () => {
    const both = observedSets({ lats: 2, arms: 2 });
    expect(both.biceps).toBeCloseTo(4 * 0.22 + 4 * 0.5, 6);
  });
});

describe('scaleToTotal — the power-user override', () => {
  it('keeps the distribution and rescales the magnitude', () => {
    const base = observedSets({ hips: 2, lats: 2 });
    const scaled = scaleToTotal(base, 20);
    const ratio = scaled.lats! / base.lats!;
    expect(scaled.glutes! / base.glutes!).toBeCloseTo(ratio, 6);
    expect(ratio).toBeGreaterThan(1);
  });

  it('ignores a zero or missing total rather than zeroing the session', () => {
    const base = observedSets({ hips: 2 });
    expect(scaleToTotal(base, null)).toEqual(base);
    expect(scaleToTotal(base, 0)).toEqual(base);
  });
});

describe('updateEstimate', () => {
  it('moves the mean toward the observation by ALPHA', () => {
    const next = updateEstimate({ meanSets: 4, sdSets: 1.2 }, 8);
    expect(next.meanSets).toBeCloseTo(4 + ALPHA * 4, 6);
  });

  it('never lets sigma fall below 1.0', () => {
    let estimate = { meanSets: 3, sdSets: 1.2 };
    for (let i = 0; i < 50; i++) estimate = updateEstimate(estimate, 3);
    expect(estimate.sdSets).toBeGreaterThanOrEqual(1.0);
  });

  it('never lets sigma fall below a quarter of the mean', () => {
    let estimate = { meanSets: 12, sdSets: 2 };
    for (let i = 0; i < 50; i++) estimate = updateEstimate(estimate, 12);
    expect(estimate.sdSets).toBeGreaterThanOrEqual(0.25 * estimate.meanSets);
  });
});

describe('updateConfidence', () => {
  it('caps at 0.90 — the app never claims to know what it did not see', () => {
    let c = SEED_CONFIDENCE;
    for (let i = 0; i < 100; i++) c = updateConfidence(c, true);
    expect(c).toBeLessThanOrEqual(0.9);
  });

  it('floors at 0.30 when sessions go unconfirmed', () => {
    let c = SEED_CONFIDENCE;
    for (let i = 0; i < 100; i++) c = updateConfidence(c, false);
    expect(c).toBeGreaterThanOrEqual(0.3);
  });
});

describe('estimateFromReport', () => {
  it('counts the seed prior at FULL value when nothing was confirmed', () => {
    // The inversion this whole system exists to prevent: an unreported trainer
    // session must never be treated as zero volume.
    const estimate = estimateFromReport({
      regionEffort: {},
      hardSetsTotal: null,
      confirmed: false,
    });
    expect(estimate.upper_back?.meanSets).toBe(DEFAULT_TRAINER_PRIOR.upper_back!.meanSets);
    expect(estimate.glutes?.meanSets).toBe(DEFAULT_TRAINER_PRIOR.glutes!.meanSets);
  });

  it('learns from a confirmed report', () => {
    const estimate = estimateFromReport({
      regionEffort: { lats: 3 },
      hardSetsTotal: null,
      confirmed: true,
    });
    expect(estimate.lats!.meanSets).toBeGreaterThan(DEFAULT_TRAINER_PRIOR.lats!.meanSets);
  });

  it('pulls a muscle down when the athlete says it was skipped', () => {
    const estimate = estimateFromReport({
      regionEffort: { lats: 0, hips: 0, mid_back: 0 },
      hardSetsTotal: null,
      confirmed: true,
    });
    expect(estimate.glutes!.meanSets).toBeLessThan(DEFAULT_TRAINER_PRIOR.glutes!.meanSets);
    // …but not to zero in one step, and the uncertainty stays honest.
    expect(estimate.glutes!.sdSets).toBeGreaterThanOrEqual(1);
  });
});

describe('the fatigue ledger', () => {
  it('charges sled work at the concentric-only rate', () => {
    const heavySled = meanMrvCost('quads', { sledMeters: 400 });
    expect(heavySled).toBeCloseTo(MRV_COST.concentric_only, 6);
  });

  it('charges a session with no sled as eccentric compound work', () => {
    expect(meanMrvCost('quads', { sledMeters: null })).toBe(MRV_COST.compound_eccentric);
    expect(meanMrvCost('lats', { sledMeters: 400 })).toBe(MRV_COST.compound_eccentric);
  });
});

describe('trainerLoadFor', () => {
  const week = [report({ confirmed: false }), report({ confirmed: false }), report()];

  it('always budgets above the mean, never at it', () => {
    const load = trainerLoadFor(week, 'upper_back', SEED_CONFIDENCE);
    expect(load.stimulusUpperBound).toBeGreaterThan(load.stimulusMean);
    expect(load.sessions).toBe(3);
  });

  it('narrows as confidence rises — that is the reward for confirming', () => {
    const cautious = trainerLoadFor(week, 'upper_back', 0.35);
    const confident = trainerLoadFor(week, 'upper_back', 0.9);
    expect(confident.stimulusUpperBound).toBeLessThan(cautious.stimulusUpperBound);
    expect(cautious.stimulusUpperBound - confident.stimulusUpperBound).toBeGreaterThan(1);
  });

  it('charges less fatigue than stimulus when the trainer used a sled', () => {
    const sledWeek = week.map((r) => report({ ...r, sledMeters: 400 }));
    const load = trainerLoadFor(sledWeek, 'quads', SEED_CONFIDENCE);
    expect(load.fatigueMean).toBeLessThan(load.stimulusMean);
    expect(load.fatigueUpperBound).toBeLessThan(load.stimulusUpperBound);
  });

  it('is zero for a week with no trainer sessions', () => {
    const load = trainerLoadFor([], 'lats', SEED_CONFIDENCE);
    expect(load.stimulusUpperBound).toBe(0);
    expect(load.sessions).toBe(0);
  });
});
