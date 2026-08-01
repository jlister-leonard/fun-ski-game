/**
 * Rendering. The headline assertion is the one the `rep_unit` field exists for:
 * a Zone 2 ride must never be described in reps.
 */

import { describe, expect, it } from 'vitest';

import {
  countAllowsDecimal,
  countForEditing,
  countFromEditing,
  countUnitLabel,
  formatCount,
  formatDuration,
  formatEffort,
  formatRom,
  formatSet,
  muscleLabel,
  regionLabel,
} from '../format';
import type { LoggedSet } from '../types';

function set(over: Partial<LoggedSet> = {}): LoggedSet {
  return {
    id: 's1',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    source: 'manual',
    sourceKey: null,
    sessionId: 'sess',
    exerciseId: 'ex',
    order: 0,
    weightKg: 0,
    magnitude: { repUnit: 'reps', reps: 0 },
    effortKind: 'none',
    effort: null,
    warmup: false,
    technique: 'straight',
    restSeconds: null,
    note: null,
    estimated1rmKg: null,
    repUnit: 'reps',
    unitValue: 0,
    rom: null,
    ...over,
  };
}

describe('formatCount', () => {
  it('renders 30 minutes of Zone 2 as a duration, not as 1800 reps', () => {
    const rendered = formatCount(1800, 'seconds', 'imperial');
    expect(rendered).toBe('30:00');
    expect(rendered).not.toMatch(/rep/);
  });

  it('keeps short holds in plain seconds', () => {
    expect(formatCount(45, 'seconds', 'imperial')).toBe('45s');
  });

  it('renders sled distance in yards for a US user', () => {
    expect(formatCount(50, 'meters', 'imperial')).toMatch(/yd$/);
    expect(formatCount(50, 'meters', 'metric')).toMatch(/m$/);
  });

  it('renders steps as steps', () => {
    expect(formatCount(20, 'steps', 'imperial')).toBe('20 steps');
    expect(formatCount(1, 'steps', 'imperial')).toBe('1 step');
  });

  it('singularises a single rep', () => {
    expect(formatCount(1, 'reps', 'imperial')).toBe('1 rep');
    expect(formatCount(8, 'reps', 'imperial')).toBe('8 reps');
  });
});

describe('the keypad boundary', () => {
  it('round-trips metres through yards without drift', () => {
    const stored = 50;
    const edited = countForEditing(stored, 'meters', 'imperial');
    expect(edited).toBe(55);
    expect(countFromEditing(edited, 'meters', 'imperial')).toBeCloseTo(50.29, 1);
  });

  it('leaves seconds alone in both systems — 1800 is unambiguous, 30:00 is not', () => {
    expect(countForEditing(1800, 'seconds', 'imperial')).toBe(1800);
    expect(countFromEditing(1800, 'seconds', 'imperial')).toBe(1800);
  });

  it('labels the field in the units the user reads', () => {
    expect(countUnitLabel('meters', 'imperial')).toBe('yd');
    expect(countUnitLabel('meters', 'metric')).toBe('m');
    expect(countUnitLabel('seconds', 'imperial')).toBe('sec');
  });

  it('only allows a decimal point where fractions mean something', () => {
    expect(countAllowsDecimal('reps')).toBe(false);
    expect(countAllowsDecimal('steps')).toBe(false);
    expect(countAllowsDecimal('meters')).toBe(true);
  });
});

describe('formatSet', () => {
  it('shows pounds to a US user and kilograms to everyone else', () => {
    const s = set({
      weightKg: 100,
      magnitude: { repUnit: 'reps', reps: 5 },
      unitValue: 5,
      effortKind: 'rir',
      effort: 2,
    });
    expect(formatSet(s, 'imperial')).toBe('220.5 lb × 5 reps · 2 RIR');
    expect(formatSet(s, 'metric')).toBe('100 kg × 5 reps · 2 RIR');
  });

  it('omits the load entirely for bodyweight work rather than printing 0 lb', () => {
    const s = set({ weightKg: 0, unitValue: 12 });
    expect(formatSet(s, 'imperial')).toBe('12 reps');
  });

  it('leads with depth on a ROM-tracked movement', () => {
    const s = set({
      unitValue: 6,
      rom: { value: 4, unit: 'in', note: 'hamstring on calf' },
    });
    expect(formatSet(s, 'imperial')).toBe('Depth 4 in × 6 reps');
  });

  it('renders a conditioning set without inventing reps', () => {
    const s = set({ repUnit: 'seconds', magnitude: { repUnit: 'seconds', seconds: 2400 }, unitValue: 2400 });
    expect(formatSet(s, 'imperial')).toBe('40:00');
  });

  it('renders a sled drag in yards', () => {
    const s = set({
      repUnit: 'meters',
      magnitude: { repUnit: 'meters', meters: 45 },
      unitValue: 45,
      weightKg: 60,
    });
    expect(formatSet(s, 'imperial')).toMatch(/lb × \d+ yd$/);
  });
});

describe('small helpers', () => {
  it('formats durations either side of the 90-second boundary', () => {
    expect(formatDuration(89)).toBe('89s');
    expect(formatDuration(90)).toBe('1:30');
    expect(formatDuration(3661)).toBe('61:01');
  });

  it('drops effort when it was not recorded', () => {
    expect(formatEffort('none', null)).toBe('');
    expect(formatEffort('rpe', 8)).toBe('8 RPE');
  });

  it('prints a ROM measurement in its own stored unit', () => {
    expect(formatRom({ value: 32.44, unit: 'deg', note: '' })).toBe('32.4 deg');
  });

  it('humanises the frozen snake_case vocabularies', () => {
    expect(muscleLabel('spinal_erectors')).toBe('Spinal Erectors');
    expect(regionLabel('mid_back')).toBe('Mid-back');
    expect(regionLabel('calves_lower_leg')).toBe('Calves & lower leg');
  });
});
