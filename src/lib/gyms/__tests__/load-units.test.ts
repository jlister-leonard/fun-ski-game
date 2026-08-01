/**
 * @file Load units, increments, and what the generator is allowed to prescribe.
 *
 * The thing being defended here is that **a prescription must be a load the
 * user can actually set**. An algorithm working in continuous numbers will
 * happily ask for 197.3 lb on a machine whose stack goes 190, 200, 210 — and
 * the user then has to guess, every set, forever. Snapping happens once, at
 * this boundary, against the equipment's own increments.
 *
 * The second thing being defended is that pounds stay pounds. A Keiser dial
 * reads air pressure in pounds; converting it to kilograms on the way in and
 * back on the way out is two roundings on a number the user reads off a
 * screen.
 */

import { describe, expect, it } from 'vitest';
import {
  equipmentById,
  formatPerformedLoad,
  isPoundDenominated,
  loadOptions,
  loadToWeightKg,
  prescriptionFor,
  snapLoad,
  type EquipmentItem,
  type LoadPrescription,
} from '../equipment';
import {
  COMMERCIAL_SEED,
  HOME_SEED,
  TRAINER_SEED,
  TRAVEL_PROFILE,
  prescriptionForEquipment,
  prescriptionForExercise,
  withEquipment,
  type EquipmentSelection,
  type GymProfile,
} from '../profiles';

function gym(name: string, items: readonly EquipmentSelection[]): GymProfile {
  return {
    id: name,
    name,
    kind: 'other',
    items,
    photos: [],
    note: '',
    builtIn: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

const need = (id: string): EquipmentItem => {
  const item = equipmentById(id);
  if (item === null) throw new Error(`no such equipment: ${id}`);
  return item;
};

const COMMERCIAL = gym('Main gym', COMMERCIAL_SEED);
const TRAINER = gym("Trainer's studio", TRAINER_SEED);
const HOME = gym('Home', HOME_SEED);

describe('a prescription carries the unit the equipment is loaded in', () => {
  it('is a weight stack in pounds on a selectorised machine', () => {
    const p = prescriptionForEquipment(COMMERCIAL, 'machine_leg_extension');
    expect(p?.unit).toBe('stack_lb');
    expect(p?.suffix).toBe('lb');
    expect(p?.increment).toBe(10);
  });

  it('is pneumatic pounds on a Keiser, in 1 lb steps', () => {
    const p = prescriptionForEquipment(TRAINER, 'keiser_air_leg_press');
    expect(p?.unit).toBe('pneumatic_lb');
    expect(p?.suffix).toBe('lb');
    expect(p?.increment).toBe(1);
    expect(p?.reportsPower).toBe(true);
  });

  it('is watts on the M3 bike, not a gear number', () => {
    const p = prescriptionForEquipment(TRAINER, 'keiser_m3_bike');
    expect(p?.unit).toBe('watts');
    expect(p?.suffix).toBe('W');
    expect(p?.reportsPower).toBe(true);
  });

  it('is plates on a bar, in the 5 lb step a pair of 2.5s gives', () => {
    const p = prescriptionForEquipment(COMMERCIAL, 'barbell_olympic');
    expect(p?.unit).toBe('plates');
    expect(p?.increment).toBe(5);
    expect(p?.minLoad).toBe(45);
  });

  it('is a band, with no scalar load at all', () => {
    const p = prescriptionForEquipment(TRAVEL_PROFILE, 'bands_loop');
    expect(p?.unit).toBe('band');
    expect(p?.suffix).toBe('');
    expect(loadOptions(p as LoadPrescription)).toEqual([]);
  });
});

describe('per-gym overrides beat the catalogue default', () => {
  it("honours this gym's dumbbell ceiling", () => {
    const commercial = prescriptionForEquipment(COMMERCIAL, 'dumbbells_fixed');
    expect(commercial?.maxLoad).toBe(100);
    const home = prescriptionForEquipment(HOME, 'dumbbells_adjustable');
    expect(home?.maxLoad).toBe(50);
  });

  it('lets micro-plates turn a 5 lb jump into a 1 lb jump', () => {
    const without = prescriptionForEquipment(COMMERCIAL, 'barbell_olympic');
    expect(snapLoad(without as LoadPrescription, 136)).toBe(135);

    const withMicros = withEquipment(
      COMMERCIAL,
      { id: 'barbell_olympic', increment: 1 },
      1,
    );
    const p = prescriptionForEquipment(withMicros, 'barbell_olympic');
    expect(p?.increment).toBe(1);
    expect(snapLoad(p as LoadPrescription, 136)).toBe(136);
  });

  it("uses only the kettlebells this gym owns", () => {
    const p = prescriptionForEquipment(HOME, 'kettlebells');
    expect(p?.sizes).toEqual([35, 53]);
    expect(snapLoad(p as LoadPrescription, 44)).toBe(35);
    expect(loadOptions(p as LoadPrescription)).toEqual([35, 53]);
  });
});

describe('snapping to what the equipment can do', () => {
  const stack = prescriptionFor(need('machine_chest_press'));
  const keiser = prescriptionFor(need('keiser_air_chest_press'));

  it('lands on a real pin position, never between two', () => {
    expect(snapLoad(stack, 137)).toBe(140);
    expect(snapLoad(stack, 134)).toBe(130);
    for (const wanted of [11, 57, 99, 183, 244]) {
      const snapped = snapLoad(stack, wanted) ?? 0;
      expect((snapped - (stack.minLoad ?? 0)) % (stack.increment ?? 1)).toBe(0);
    }
  });

  it('rounds a tie down — overshooting a top set costs a rep', () => {
    expect(snapLoad(stack, 135)).toBe(130);
  });

  it('respects the ceiling and the floor', () => {
    expect(snapLoad(stack, 9999)).toBe(stack.maxLoad);
    expect(snapLoad(stack, -50)).toBe(stack.minLoad);
  });

  it('gives the Keiser a finer landing than the stack for the same target', () => {
    expect(snapLoad(keiser, 137)).toBe(137);
    expect(snapLoad(stack, 137)).toBe(140);
  });

  it('picks the nearest kettlebell, preferring the lighter on a tie', () => {
    const bells = prescriptionFor(need('kettlebells'));
    expect(snapLoad(bells, 40)).toBe(44);
    expect(snapLoad(bells, 30)).toBe(26);
    expect(snapLoad(bells, 22)).toBe(18);
  });

  it('returns null where there is no scalar load to snap to', () => {
    expect(snapLoad(prescriptionFor(need('bands_loop')), 50)).toBeNull();
    expect(snapLoad(prescriptionFor(need('floor_space')), 50)).toBeNull();
    expect(snapLoad(prescriptionFor(need('plyo_box')), 50)).toBeNull();
  });

  it('refuses a non-finite target rather than producing NaN', () => {
    expect(snapLoad(stack, Number.NaN)).toBeNull();
    expect(snapLoad(stack, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('leaves no floating-point dust on a fractional increment', () => {
    const harness = prescriptionFor(need('neck_harness'));
    for (const target of [7.4, 12.6, 33.1]) {
      const snapped = snapLoad(harness, target) ?? 0;
      expect(snapped).toBe(Math.round(snapped * 10) / 10);
    }
  });
});

describe('the loads a picker can offer', () => {
  it('lists a bounded stack exhaustively', () => {
    const options = loadOptions(prescriptionFor(need('machine_pec_deck')));
    expect(options[0]).toBe(10);
    expect(options[options.length - 1]).toBe(200);
    expect(options.length).toBe(20);
  });

  it('never runs away on an unbounded item', () => {
    const options = loadOptions(prescriptionFor(need('plates_standard')), 25);
    expect(options.length).toBe(25);
  });

  it('sorts explicit sizes ascending', () => {
    const p = prescriptionFor(need('kettlebells'), { sizes: [53, 18, 35] });
    expect(loadOptions(p)).toEqual([18, 35, 53]);
  });
});

describe('choosing the right prescription for a movement at a gym', () => {
  it('prefers the machine that specifically covers the movement', () => {
    const p = prescriptionForExercise('leg-press', COMMERCIAL);
    expect(p?.equipmentId).toBe('machine_leg_press');
    expect(p?.unit).toBe('stack_lb');
  });

  it('gives the same movement a different unit at a different gym', () => {
    const commercial = prescriptionForExercise('leg-press', COMMERCIAL);
    const trainer = prescriptionForExercise('leg-press', TRAINER);
    expect(commercial?.unit).toBe('stack_lb');
    expect(trainer?.unit).toBe('pneumatic_lb');
    expect(trainer?.increment).toBe(1);
    // Same slug, same algorithm, two genuinely different prescriptions.
    expect(commercial?.equipmentId).not.toBe(trainer?.equipmentId);
  });

  it('falls back to the implement that satisfies the movement', () => {
    const p = prescriptionForExercise('dumbbell-bench-press', HOME);
    expect(p?.equipmentId).toBe('dumbbells_adjustable');
    expect(p?.maxLoad).toBe(50);
  });

  it('reports bodyweight for a movement with no load axis', () => {
    const p = prescriptionForExercise('push-up', TRAVEL_PROFILE);
    expect(p?.unit).toBe('bodyweight');
    expect(loadOptions(p as LoadPrescription)).toEqual([]);
  });

  it('returns null for a movement this gym cannot do at all', () => {
    expect(prescriptionForExercise('sled-push-forward', HOME)).toBeNull();
  });

  it('prescribes the Zone 2 ride in watts at the studio', () => {
    const p = prescriptionForExercise('zone2-cycling', TRAINER);
    expect(p?.unit).toBe('watts');
    expect(p?.reportsPower).toBe(true);
    expect(p?.suffix).toBe('W');
  });
});

describe('crossing into SI storage', () => {
  it('converts the three pound-denominated units, exactly', () => {
    expect(loadToWeightKg({ unit: 'plates', value: 100, equipmentId: null })).toBeCloseTo(
      45.359237,
      6,
    );
    expect(loadToWeightKg({ unit: 'stack_lb', value: 100, equipmentId: null })).toBeCloseTo(
      45.359237,
      6,
    );
    expect(
      loadToWeightKg({ unit: 'pneumatic_lb', value: 100, equipmentId: null }),
    ).toBeCloseTo(45.359237, 6);
  });

  it('refuses to pretend watts are a weight', () => {
    expect(loadToWeightKg({ unit: 'watts', value: 220, equipmentId: null })).toBeNull();
    expect(loadToWeightKg({ unit: 'band', value: 3, equipmentId: null })).toBeNull();
    expect(loadToWeightKg({ unit: 'bodyweight', value: 0, equipmentId: null })).toBeNull();
    expect(loadToWeightKg({ unit: 'none', value: 0, equipmentId: null })).toBeNull();
  });

  it('agrees with isPoundDenominated', () => {
    for (const unit of ['plates', 'stack_lb', 'pneumatic_lb'] as const) {
      expect(isPoundDenominated(unit)).toBe(true);
    }
    for (const unit of ['watts', 'band', 'bodyweight', 'none'] as const) {
      expect(isPoundDenominated(unit)).toBe(false);
    }
  });

  it('renders a performed load with its own unit beside it', () => {
    expect(formatPerformedLoad({ unit: 'stack_lb', value: 140, equipmentId: null })).toBe(
      '140 lb',
    );
    expect(formatPerformedLoad({ unit: 'pneumatic_lb', value: 137, equipmentId: null })).toBe(
      '137 lb',
    );
    expect(formatPerformedLoad({ unit: 'watts', value: 212, equipmentId: null })).toBe('212 W');
    expect(formatPerformedLoad({ unit: 'bodyweight', value: 0, equipmentId: null })).toBe(
      'bodyweight',
    );
    expect(formatPerformedLoad({ unit: 'band', value: 0, equipmentId: null })).toBe('band');
    expect(formatPerformedLoad({ unit: 'none', value: 0, equipmentId: null })).toBe('—');
  });
});
