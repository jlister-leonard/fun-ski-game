/**
 * Volume accounting and the budget.
 *
 * The behaviour under test is the one the whole trainer model exists to
 * produce: after several trainer sessions, the app
 * must have **nothing left to prescribe** for those muscles — and must still
 * have room on the ones the trainer never touches.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWeek,
  classifyVolume,
  coveredByTrainer,
  INDIRECT_SET_WEIGHT,
  LANDMARKS,
  loggedSetsByMuscle,
  remainingBudget,
  type TrainerWeekLoad,
} from '../volume';
import { exerciseBySlug } from '../library';
import { priorFromFocus, SEED_CONFIDENCE, trainerLoadFor } from '../trainer-estimate';
import type { LibraryExercise, TrainerSessionReport } from '../types';

const library = new Map<string, LibraryExercise>(
  (['barbell-row', 'barbell-bench-press', 'lateral-raise'] as const)
    .map((slug) => exerciseBySlug(slug))
    .filter((e): e is LibraryExercise => e !== null)
    .map((e) => [e.slug, e]),
);

function unconfirmedSession(): TrainerSessionReport {
  return {
    durationMin: 60,
    regionEffort: {},
    hardSetsTotal: null,
    perceivedRir: null,
    sledMeters: null,
    exerciseNames: [],
    confirmed: false,
    estimate: priorFromFocus('posterior chain, rows and pull-ups'),
  };
}

describe('classifyVolume', () => {
  const lm = LANDMARKS.chest;
  it('bands a count against the landmarks', () => {
    expect(classifyVolume(2, lm)).toBe('under_mev');
    expect(classifyVolume(11, lm)).toBe('mev_to_mav');
    expect(classifyVolume(15, lm)).toBe('in_mav');
    expect(classifyVolume(21, lm)).toBe('above_mav');
    expect(classifyVolume(30, lm)).toBe('above_mrv');
  });
});

describe('loggedSetsByMuscle', () => {
  const slug = 'barbell-bench-press';
  const bench = library.get(slug)!;

  it('counts primaries at 1.0 and secondaries at 0.5', () => {
    const counts = loggedSetsByMuscle(
      [{ warmup: false }, { warmup: false }],
      library,
      () => slug,
    );
    expect(counts.chest).toBe(2);
    for (const secondary of bench.secondary_muscles) {
      expect(counts[secondary]).toBe(2 * INDIRECT_SET_WEIGHT);
    }
  });

  it('excludes warm-ups', () => {
    const counts = loggedSetsByMuscle(
      [{ warmup: true }, { warmup: true }, { warmup: false }],
      library,
      () => slug,
    );
    expect(counts.chest).toBe(1);
  });

  it('ignores sets whose exercise cannot be resolved', () => {
    expect(loggedSetsByMuscle([{ warmup: false }], library, () => null)).toEqual({});
    expect(loggedSetsByMuscle([{ warmup: false }], library, () => 'nope')).toEqual({});
  });
});

describe('the budget', () => {
  /** Three unconfirmed synthetic trainer sessions. */
  function trainerWeek(): Partial<Record<string, TrainerWeekLoad>> {
    const reports = [unconfirmedSession(), unconfirmedSession(), unconfirmedSession()];
    const out: Record<string, TrainerWeekLoad> = {};
    for (const muscle of ['upper_back', 'glutes', 'lats', 'side_delts', 'chest'] as const) {
      const load = trainerLoadFor(reports, muscle, SEED_CONFIDENCE);
      out[muscle] = {
        stimulusMean: load.stimulusMean,
        stimulusUpperBound: load.stimulusUpperBound,
        fatigueUpperBound: load.fatigueUpperBound,
      };
    }
    return out;
  }

  it('leaves nothing to prescribe on the muscles the trainer hammers', () => {
    const week = buildWeek({}, trainerWeek());
    const upperBack = week.find((w) => w.muscle === 'upper_back')!;
    const glutes = week.find((w) => w.muscle === 'glutes')!;

    expect(upperBack.trainerUpperBound).toBeGreaterThan(10);
    expect(remainingBudget(upperBack).sets).toBe(0);
    expect(remainingBudget(glutes).sets).toBe(0);
  });

  it('still has room on the muscles the trainer barely touches', () => {
    const week = buildWeek({}, trainerWeek());
    const sideDelts = week.find((w) => w.muscle === 'side_delts')!;
    expect(remainingBudget(sideDelts).sets).toBeGreaterThan(5);
  });

  it('budgets against the upper bound, so the mean alone would over-prescribe', () => {
    const trainer = trainerWeek();
    const atMean = buildWeek(
      {},
      { upper_back: { ...trainer.upper_back!, stimulusUpperBound: trainer.upper_back!.stimulusMean } },
    ).find((w) => w.muscle === 'upper_back')!;
    const atBound = buildWeek({}, trainer).find((w) => w.muscle === 'upper_back')!;
    expect(atBound.totalUpperBound).toBeGreaterThan(atMean.totalUpperBound);
  });

  it('shrinks the app budget as the athlete logs their own sets', () => {
    const empty = buildWeek({}, {}).find((w) => w.muscle === 'side_delts')!;
    const worked = buildWeek({ side_delts: 10 }, {}).find((w) => w.muscle === 'side_delts')!;
    expect(remainingBudget(worked).sets).toBeLessThan(remainingBudget(empty).sets);
  });

  it('keeps the unclamped value, because negative is diagnostic', () => {
    const over = buildWeek({ glutes: 40 }, {}).find((w) => w.muscle === 'glutes')!;
    const budget = remainingBudget(over);
    expect(budget.sets).toBe(0);
    expect(budget.unclamped).toBeLessThan(0);
  });

  it('names the muscles the trainer has covered', () => {
    const week = buildWeek({}, trainerWeek());
    const covered = coveredByTrainer(week).map((w) => w.muscle);
    expect(covered).toContain('upper_back');
    expect(covered).toContain('glutes');
    expect(covered).not.toContain('side_delts');
  });
});

describe('buildWeek', () => {
  it('orders muscles by how close they are to their ceiling', () => {
    const week = buildWeek({ glutes: 14, chest: 2 }, {});
    const glutesIndex = week.findIndex((w) => w.muscle === 'glutes');
    const chestIndex = week.findIndex((w) => w.muscle === 'chest');
    expect(glutesIndex).toBeLessThan(chestIndex);
  });

  it('flags the muscles whose landmarks are extrapolated rather than published', () => {
    const week = buildWeek({}, {});
    expect(week.find((w) => w.muscle === 'tibialis')!.lowConfidence).toBe(true);
    expect(week.find((w) => w.muscle === 'chest')!.lowConfidence).toBe(false);
  });

  it('covers all 22 muscles of the frozen vocabulary', () => {
    expect(buildWeek({}, {})).toHaveLength(22);
  });
});
