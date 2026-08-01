/**
 * The progression engine (A5).
 *
 * The behaviours worth pinning down are the ones that are easy to get subtly
 * wrong and expensive when you do: the ramp must stop *short* of MRV, the RIR
 * ramp must fall, the early-deload trigger must fire before a block grinds
 * itself into the ground, and no readiness path may ever raise a load.
 */

import { describe, expect, it } from 'vitest';

import {
  applyReadiness,
  BEGINNER_MEV_FLOOR,
  carryOverLandmarks,
  ceilingFor,
  CONDITIONING_HAIRCUT,
  DEFAULT_MESO,
  deloadSets,
  earlyDeloadCheck,
  FEEDBACK_SET_CHANGE,
  HARD_CONDITIONING_HAIRCUT_MINUTES,
  isDeloadWeek,
  MAX_LANDMARK_DRIFT,
  mesocycleWeeks,
  mesoLength,
  METHODOLOGY_MESO,
  minFrequency,
  needsResensitization,
  nextWeekSets,
  progressTopSet,
  rampTargets,
  rawTarget,
  recordStall,
  scaleLandmarks,
  stallResponse,
  targetRir,
  TRAINING_AGE_SCALE,
  weekOneFloor,
} from '../mesocycle';
import { ALL_MUSCLES, LANDMARKS } from '../volume';

describe('block shape', () => {
  it('runs 3 accumulation weeks plus a deload for this athlete', () => {
    expect(mesoLength(DEFAULT_MESO)).toBe(4);
    expect(DEFAULT_MESO.rirRamp).toEqual([3, 2, 1]);
  });

  it('keeps the textbook 4+1 block available unchanged', () => {
    expect(mesoLength(METHODOLOGY_MESO)).toBe(5);
    expect(METHODOLOGY_MESO.rirRamp).toEqual([4, 3, 2, 1]);
  });

  it('falls in RIR across accumulation and resets on the deload', () => {
    expect([1, 2, 3, 4].map((w) => targetRir(w, DEFAULT_MESO))).toEqual([3, 2, 1, 4]);
    expect([1, 2, 3, 4, 5].map((w) => targetRir(w, METHODOLOGY_MESO))).toEqual([4, 3, 2, 1, 4]);
  });

  it('marks only the trailing weeks as a deload', () => {
    expect(isDeloadWeek(3, DEFAULT_MESO)).toBe(false);
    expect(isDeloadWeek(4, DEFAULT_MESO)).toBe(true);
  });

  it('enumerates the block', () => {
    expect(mesocycleWeeks(DEFAULT_MESO)).toEqual([
      { week: 1, isDeload: false, targetRir: 3 },
      { week: 2, isDeload: false, targetRir: 2 },
      { week: 3, isDeload: false, targetRir: 1 },
      { week: 4, isDeload: true, targetRir: 4 },
    ]);
  });
});

describe('landmark scaling', () => {
  it('never scales MV', () => {
    for (const muscle of ALL_MUSCLES) {
      const scaled = scaleLandmarks(LANDMARKS[muscle], muscle, 'beginner');
      expect(scaled.mv).toBe(LANDMARKS[muscle].mv);
    }
  });

  it('applies the published multipliers', () => {
    const chest = scaleLandmarks(LANDMARKS.chest, 'chest', 'advanced');
    expect(chest.mrv).toBeCloseTo(LANDMARKS.chest.mrv * TRAINING_AGE_SCALE.advanced);
  });

  it('floors beginner MEV on large muscles so novices are not under-dosed to zero', () => {
    const quads = scaleLandmarks(LANDMARKS.quads, 'quads', 'beginner');
    expect(quads.mev).toBeGreaterThanOrEqual(BEGINNER_MEV_FLOOR);
  });

  it('does not invent MEV for muscles whose MEV is genuinely zero', () => {
    const traps = scaleLandmarks(LANDMARKS.traps, 'traps', 'beginner');
    expect(traps.mev).toBe(0);
  });

  it('keeps the landmarks ordered after scaling', () => {
    for (const muscle of ALL_MUSCLES) {
      for (const age of ['beginner', 'intermediate', 'advanced'] as const) {
        const s = scaleLandmarks(LANDMARKS[muscle], muscle, age);
        expect(s.mev).toBeLessThanOrEqual(s.mavLow);
        expect(s.mavLow).toBeLessThanOrEqual(s.mavHigh);
        expect(s.mavHigh).toBeLessThanOrEqual(s.mrv);
      }
    }
  });
});

describe('ceilings', () => {
  it('caps at MAV in a deficit rather than aiming at MRV', () => {
    const ceiling = ceilingFor(LANDMARKS.chest, 'chest', { deficit: true });
    expect(ceiling).toBe(LANDMARKS.chest.mavHigh);
    expect(ceiling).toBeLessThan(LANDMARKS.chest.mrv);
  });

  it('uses MRV when the athlete is not in a deficit', () => {
    expect(ceilingFor(LANDMARKS.chest, 'chest', { deficit: false })).toBe(LANDMARKS.chest.mrv);
  });

  it('takes 10% off lower-body ceilings past an hour of hard conditioning', () => {
    const base = ceilingFor(LANDMARKS.quads, 'quads', { deficit: true });
    const cut = ceilingFor(LANDMARKS.quads, 'quads', {
      deficit: true,
      hardConditioningMinutes: HARD_CONDITIONING_HAIRCUT_MINUTES + 1,
    });
    expect(cut).toBeCloseTo(base * CONDITIONING_HAIRCUT);
  });

  it('leaves upper body alone, and leaves lower body alone at this block’s dose', () => {
    const chest = ceilingFor(LANDMARKS.chest, 'chest', {
      deficit: true,
      hardConditioningMinutes: 90,
    });
    expect(chest).toBe(LANDMARKS.chest.mavHigh);
    // The programmed dose is ~16 min/wk of Z5 — the haircut must not fire.
    expect(ceilingFor(LANDMARKS.quads, 'quads', { deficit: true, hardConditioningMinutes: 16 }))
      .toBe(LANDMARKS.quads.mavHigh);
  });
});

describe('the volume ramp', () => {
  it('anchors week 1 at MEV for muscles that have one', () => {
    expect(weekOneFloor(LANDMARKS.chest)).toBe(LANDMARKS.chest.mev);
  });

  it('lifts week 1 off zero for the MEV-0 muscles', () => {
    // front_delts, traps, abs, obliques and neck all have MEV 0. Ramping from
    // literal zero produces a large jump in week 2; the floor removes it.
    for (const muscle of ['front_delts', 'traps', 'abs', 'obliques'] as const) {
      expect(LANDMARKS[muscle].mev).toBe(0);
      expect(weekOneFloor(LANDMARKS[muscle])).toBeGreaterThan(0);
    }
  });

  it('reproduces the worked example’s week-1 and week-3 chest targets', () => {
    const chest = LANDMARKS.chest;
    expect(rawTarget(chest, chest.mavHigh, 1, DEFAULT_MESO)).toBeCloseTo(10);
    expect(rawTarget(chest, chest.mavHigh, 3, DEFAULT_MESO)).toBeCloseTo(19.5);
  });

  it('stops short of MRV — MRV is a limit, not a target', () => {
    for (const muscle of ALL_MUSCLES) {
      const lm = LANDMARKS[muscle];
      for (const target of rampTargets(lm, lm.mrv, METHODOLOGY_MESO)) {
        expect(target).toBeLessThanOrEqual(lm.mrv);
      }
      const last = rampTargets(lm, lm.mrv, METHODOLOGY_MESO)[METHODOLOGY_MESO.accumulationWeeks - 1];
      if (lm.mrv > lm.mev) expect(last).toBeLessThan(lm.mrv);
    }
  });

  it('never climbs more than the slew cap in a week', () => {
    const targets = rampTargets(LANDMARKS.side_delts, LANDMARKS.side_delts.mavHigh, DEFAULT_MESO);
    for (let i = 1; i < DEFAULT_MESO.accumulationWeeks; i += 1) {
      expect(targets[i] - targets[i - 1]).toBeLessThanOrEqual(DEFAULT_MESO.setSlewCap + 1e-9);
    }
  });

  it('drops to maintenance on the deload week', () => {
    const targets = rampTargets(LANDMARKS.chest, LANDMARKS.chest.mavHigh, DEFAULT_MESO);
    expect(targets[3]).toBe(deloadSets(LANDMARKS.chest));
    expect(targets[3]).toBeLessThan(targets[2]);
  });

  it('never prescribes below MV on the deload', () => {
    for (const muscle of ALL_MUSCLES) {
      expect(deloadSets(LANDMARKS[muscle])).toBeGreaterThanOrEqual(LANDMARKS[muscle].mv);
    }
  });

  it('derives frequency from volume, capped per session', () => {
    expect(minFrequency(0, 'chest')).toBe(0);
    expect(minFrequency(8, 'chest')).toBe(1);
    expect(minFrequency(16, 'chest')).toBe(2);
    expect(minFrequency(20, 'side_delts')).toBe(2);
  });
});

describe('within-block progression', () => {
  const range = [8, 12] as const;

  it('adds load when the top of the range is cleared at or under the target RIR', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: 1, previousReps: 11 },
      { repRange: range, targetRir: 2, upperBody: false },
    );
    expect(step?.move).toBe('add_load');
    expect(step?.weightKg).toBeCloseTo(105);
    expect(step?.reps).toBe(8);
  });

  it('uses the smaller jump for upper body', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: 1, previousReps: 11 },
      { repRange: range, targetRir: 2, upperBody: true },
    );
    expect(step?.weightKg).toBeCloseTo(102.5);
  });

  it('adds a rep at the same load when reps held but the range is not topped out', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 9, achievedRir: 2, previousReps: 9 },
      { repRange: range, targetRir: 2 },
    );
    expect(step?.move).toBe('add_rep');
    expect(step?.weightKg).toBe(100);
    expect(step?.reps).toBe(10);
  });

  it('repeats and flags a stall when reps regress', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 8, achievedRir: 1, previousReps: 11 },
      { repRange: range, targetRir: 2 },
    );
    expect(step?.move).toBe('repeat');
    expect(step?.stalled).toBe(true);
  });

  it('holds the load in a deficit rather than manufacturing a false stall', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: 1, previousReps: 12 },
      { repRange: range, targetRir: 2, holdLoad: true },
    );
    expect(step?.move).toBe('repeat');
    expect(step?.weightKg).toBe(100);
    expect(step?.stalled).toBe(false);
  });

  it('never progresses anything while pain is flagged', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: 0, previousReps: 8 },
      { repRange: range, targetRir: 2, painFlag: true },
    );
    expect(step?.move).toBe('hold');
    expect(step?.weightKg).toBe(100);
    expect(step?.reps).toBe(12);
  });

  it('has nothing to say on a first exposure', () => {
    expect(progressTopSet(null, { repRange: range, targetRir: 2 })).toBeNull();
  });
});

describe('stalls and the early deload', () => {
  it('escalates repeat → cut a set → end the block', () => {
    expect(stallResponse(0)).toBe('none');
    expect(stallResponse(1)).toBe('repeat');
    expect(stallResponse(2)).toBe('cut_one_set');
    expect(stallResponse(3)).toBe('end_mesocycle');
  });

  it('resets the counter when a lift recovers', () => {
    let ledger = recordStall({}, 'hack-squat', true);
    ledger = recordStall(ledger, 'hack-squat', true);
    expect(ledger['hack-squat']).toBe(2);
    ledger = recordStall(ledger, 'hack-squat', false);
    expect(ledger['hack-squat']).toBeUndefined();
  });

  it('ends the block after three consecutive stalls on one lift', () => {
    const check = earlyDeloadCheck({ 'hack-squat': 3 });
    expect(check.trigger).toBe(true);
    expect(check.findings[0].code).toBe('meso.early_deload_stalls');
  });

  it('ends the block when three lifts go backwards in one session', () => {
    const check = earlyDeloadCheck({}, ['a', 'b', 'c']);
    expect(check.trigger).toBe(true);
  });

  it('does not fire on two stalled lifts', () => {
    expect(earlyDeloadCheck({ a: 2 }, ['a', 'b']).trigger).toBe(false);
  });
});

describe('the between-week feedback rule', () => {
  it('maps the four answers to the published set changes', () => {
    expect(FEEDBACK_SET_CHANGE).toEqual({
      no_disruption: 2,
      moderate: 1,
      high_soreness: 0,
      excessive: -1,
    });
  });

  it('adds sets when nothing was disrupted, bounded by the ceiling', () => {
    const lm = LANDMARKS.side_delts;
    expect(nextWeekSets(10, 'no_disruption', lm, lm.mavHigh)).toBe(12);
  });

  it('holds when the muscle is still sore', () => {
    const lm = LANDMARKS.chest;
    expect(nextWeekSets(12, 'high_soreness', lm, lm.mavHigh)).toBe(12);
  });

  it('pulls back when performance is down and joints ache', () => {
    const lm = LANDMARKS.chest;
    expect(nextWeekSets(12, 'excessive', lm, lm.mavHigh)).toBe(11);
  });

  it('never exceeds 95% of the ceiling however good the feedback', () => {
    const lm = LANDMARKS.chest;
    const ceiling = lm.mavHigh;
    expect(nextWeekSets(ceiling, 'no_disruption', lm, ceiling)).toBeLessThanOrEqual(ceiling * 0.95);
  });

  it('never falls below MV however bad the feedback', () => {
    const lm = LANDMARKS.chest;
    expect(nextWeekSets(lm.mv, 'excessive', lm, lm.mavHigh)).toBe(lm.mv);
  });
});

describe('block to block', () => {
  it('raises the floor after a block that finished with performance rising', () => {
    const carry = carryOverLandmarks(LANDMARKS.chest, {
      endedEarly: false,
      performanceRising: true,
    });
    expect(carry.mevDelta).toBeGreaterThan(0);
    expect(carry.mrvDelta).toBe(0);
    expect(carry.landmarks.mev).toBeGreaterThan(LANDMARKS.chest.mev);
  });

  it('lowers the ceiling, not the floor, after an early deload', () => {
    const carry = carryOverLandmarks(LANDMARKS.chest, {
      endedEarly: true,
      performanceRising: false,
    });
    expect(carry.mevDelta).toBe(0);
    expect(carry.mrvDelta).toBeLessThan(0);
  });

  it('caps drift so an estimate cannot run away', () => {
    let lm = LANDMARKS.chest;
    for (let block = 0; block < 10; block += 1) {
      const carry = carryOverLandmarks(lm, { endedEarly: false, performanceRising: true });
      expect(Math.abs(carry.mevDelta)).toBeLessThanOrEqual(MAX_LANDMARK_DRIFT);
      lm = carry.landmarks;
    }
  });

  it('keeps landmarks ordered through repeated carry-over', () => {
    let lm = LANDMARKS.glutes;
    for (let block = 0; block < 12; block += 1) {
      lm = carryOverLandmarks(lm, { endedEarly: block % 2 === 0, performanceRising: true })
        .landmarks;
      expect(lm.mev).toBeLessThanOrEqual(lm.mavLow);
      expect(lm.mavLow).toBeLessThanOrEqual(lm.mavHigh);
      expect(lm.mavHigh).toBeLessThanOrEqual(lm.mrv);
    }
  });

  it('schedules a resensitization phase every few blocks', () => {
    expect(needsResensitization(2)).toBe(false);
    expect(needsResensitization(3)).toBe(true);
  });
});

describe('readiness, bounded (§8.5)', () => {
  it('never raises a prescribed load, in any band', () => {
    for (const band of ['high', 'normal', 'low', 'poor'] as const) {
      expect(applyReadiness(band, 4).loadDelta).toBeLessThanOrEqual(0);
    }
  });

  it('gives a high band a green light and at most one extra set on the last exercise', () => {
    const adjusted = applyReadiness('high', 4);
    expect(adjusted.sets).toBe(4);
    expect(adjusted.extraSetOnLastExercise).toBe(true);
    expect(adjusted.loadDelta).toBe(0);
  });

  it('runs the plan unchanged on a normal day', () => {
    const adjusted = applyReadiness('normal', 4);
    expect(adjusted).toMatchObject({ sets: 4, rirDelta: 0, loadDelta: 0 });
    expect(adjusted.findings).toEqual([]);
  });

  it('trims a set and leaves a rep in the tank when recovery is down', () => {
    const adjusted = applyReadiness('low', 4);
    expect(adjusted.sets).toBe(3);
    expect(adjusted.rirDelta).toBe(1);
    expect(adjusted.loadDelta).toBeLessThan(0);
  });

  it('makes a poor day a technique day without dropping below two sets', () => {
    const adjusted = applyReadiness('poor', 4);
    expect(adjusted.sets).toBeGreaterThanOrEqual(2);
    expect(adjusted.sets).toBeLessThan(4);
    expect(adjusted.rirDelta).toBe(2);
  });

  it('keeps every adjustment inside the §8.5 bounds', () => {
    for (const band of ['high', 'normal', 'low', 'poor'] as const) {
      for (const sets of [1, 2, 3, 5, 8, 12]) {
        const adjusted = applyReadiness(band, sets);
        expect(adjusted.rirDelta).toBeGreaterThanOrEqual(-1);
        expect(adjusted.rirDelta).toBeLessThanOrEqual(2);
        expect(adjusted.loadDelta).toBeGreaterThanOrEqual(-0.2);
        expect(adjusted.sets).toBeGreaterThanOrEqual(Math.min(2, sets));
        expect(adjusted.sets).toBeLessThanOrEqual(sets);
      }
    }
  });

  it('stops adjusting after three consecutive reductions and asks for a deload', () => {
    const adjusted = applyReadiness('poor', 4, { consecutiveReductions: 3 });
    expect(adjusted.sets).toBe(4);
    expect(adjusted.loadDelta).toBe(0);
    expect(adjusted.findings[0].code).toBe('readiness.stop_adjusting');
    expect(adjusted.findings[0].level).toBe('warn');
  });
});

describe('the athlete chose to push hard on ambiguous days', () => {
  const range = [8, 12] as const;

  it('proposes a load increase at the top of the range even with no RIR recorded', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: null, previousReps: 12 },
      { repRange: range, targetRir: 2 },
    );
    expect(step?.move).toBe('add_load');
    expect(step?.proposed).toBe(true);
  });

  it('proposes it even when they left more in the tank than prescribed', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: 4, previousReps: 12 },
      { repRange: range, targetRir: 2 },
    );
    expect(step?.move).toBe('add_load');
  });

  it('holds under the conservative bias in the same situation', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: null, previousReps: 12 },
      { repRange: range, targetRir: 2, bias: 'conservative' },
    );
    expect(step?.move).toBe('repeat');
    expect(step?.proposed).toBe(false);
  });

  it('marks the increase as something to decline, never as something applied', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: 1, previousReps: 11 },
      { repRange: range, targetRir: 2 },
    );
    expect(step?.proposed).toBe(true);
    expect(step?.reason).toContain('Knock it back');
  });

  it('still treats a genuine regression as a stall — push is not override', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 8, achievedRir: 0, previousReps: 12 },
      { repRange: range, targetRir: 2 },
    );
    expect(step?.move).toBe('repeat');
    expect(step?.stalled).toBe(true);
    expect(step?.proposed).toBe(false);
  });

  it('still freezes on pain, whatever the bias', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: null, previousReps: 12 },
      { repRange: range, targetRir: 2, painFlag: true },
    );
    expect(step?.move).toBe('hold');
    expect(step?.weightKg).toBe(100);
  });

  it('still holds load in a deficit, where load is the last thing to move', () => {
    const step = progressTopSet(
      { weightKg: 100, reps: 12, achievedRir: null, previousReps: 12 },
      { repRange: range, targetRir: 2, holdLoad: true },
    );
    expect(step?.move).toBe('repeat');
    expect(step?.weightKg).toBe(100);
  });

  it('treats an unanswered feedback question as a normal session, not a bad one', () => {
    const lm = LANDMARKS.side_delts;
    expect(nextWeekSets(10, null, lm, lm.mavHigh)).toBe(11);
    expect(nextWeekSets(10, null, lm, lm.mavHigh, DEFAULT_MESO, 'conservative')).toBe(10);
  });

  it('is still bounded by the ceiling when pushing', () => {
    const lm = LANDMARKS.chest;
    expect(nextWeekSets(lm.mavHigh, null, lm, lm.mavHigh)).toBeLessThanOrEqual(
      lm.mavHigh * 0.95,
    );
  });
});
