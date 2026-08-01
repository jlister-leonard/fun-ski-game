/**
 * @file The taxonomy has to *reconcile* with the exercise library, not merely
 * resemble it. These tests are the reconciliation.
 *
 * The failure mode they exist to catch is silent: a library tag with no
 * equipment behind it does not throw, it just means a movement is unavailable
 * at every gym in the world, forever, and nobody notices until a program comes
 * back short.
 */

import { describe, expect, it } from 'vitest';
import { EXERCISE_LIBRARY } from '@/lib/training/library';
import {
  EQUIPMENT,
  EQUIPMENT_IDS,
  GENERIC_MACHINE,
  LIBRARY_EQUIPMENT_TAGS,
  LOAD_UNITS,
  SPECIFIC_EQUIPMENT,
  ZONES,
  brandLabel,
  equipmentById,
  isEquipmentId,
  itemsInZone,
  itemsSatisfying,
  loadUnitLabel,
  loadUnitSuffix,
  tagLabel,
  type LibraryEquipmentTag,
} from '../equipment';

/** Every distinct `equipment` string used anywhere in the bundled library. */
const TAGS_IN_LIBRARY: readonly string[] = [
  ...new Set(EXERCISE_LIBRARY.flatMap((e) => e.equipment)),
].sort();

describe('the taxonomy covers the library', () => {
  it('knows every equipment value the 220 exercises use', () => {
    expect(TAGS_IN_LIBRARY).toEqual([...LIBRARY_EQUIPMENT_TAGS].sort());
  });

  it('has at least one item behind every library tag', () => {
    const orphans = LIBRARY_EQUIPMENT_TAGS.filter(
      (tag) => itemsSatisfying(tag).length === 0,
    );
    expect(orphans).toEqual([]);
  });

  it('names every library tag in plain English', () => {
    for (const tag of LIBRARY_EQUIPMENT_TAGS) {
      expect(tagLabel(tag).length).toBeGreaterThan(0);
    }
  });

  it('claims no tag the library does not use', () => {
    const known = new Set<string>(TAGS_IN_LIBRARY);
    const invented = EQUIPMENT.flatMap((e) => e.satisfies).filter((t) => !known.has(t));
    expect(invented).toEqual([]);
  });

  it('only claims to cover slugs that exist', () => {
    const slugs = new Set(EXERCISE_LIBRARY.map((e) => e.slug));
    const bogus = EQUIPMENT.flatMap((e) => e.covers).filter((s) => !slugs.has(s));
    expect(bogus).toEqual([]);
  });

  it('covers every machine-tagged movement with a specific machine', () => {
    // The `machine` tag is one word for thirty machines. Every movement that
    // uses it needs a namable piece of equipment behind it, or the refinement
    // in requirements.ts has nothing to check against.
    const machineMovements = EXERCISE_LIBRARY.filter((e) =>
      (e.equipment as readonly string[]).includes('machine'),
    );
    const uncovered = machineMovements
      .filter((e) => !SPECIFIC_EQUIPMENT.has(e.slug))
      .map((e) => e.slug);
    expect(uncovered).toEqual([]);
  });
});

describe('the catalogue is internally consistent', () => {
  it('has unique ids', () => {
    expect(new Set(EQUIPMENT_IDS).size).toBe(EQUIPMENT_IDS.length);
  });

  it('resolves every id, and rejects ids it does not know', () => {
    for (const id of EQUIPMENT_IDS) {
      expect(equipmentById(id)?.id).toBe(id);
      expect(isEquipmentId(id)).toBe(true);
    }
    expect(equipmentById('a-machine-from-2031')).toBeNull();
    expect(isEquipmentId('a-machine-from-2031')).toBe(false);
  });

  it('puts every item in exactly one declared zone', () => {
    const zoneIds = new Set(ZONES.map((z) => z.id));
    for (const item of EQUIPMENT) expect(zoneIds.has(item.zone)).toBe(true);
    const counted = ZONES.reduce((n, z) => n + itemsInZone(z.id).length, 0);
    expect(counted).toBe(EQUIPMENT.length);
  });

  it('leaves no zone empty — every walk-through step has something on it', () => {
    for (const zone of ZONES) expect(itemsInZone(zone.id).length).toBeGreaterThan(0);
  });

  it('gives every item a label and a known load unit', () => {
    for (const item of EQUIPMENT) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(LOAD_UNITS).toContain(item.loadUnit);
      expect(loadUnitLabel(item.loadUnit).length).toBeGreaterThan(0);
    }
  });

  it('gives a positive increment to everything with a scalar load', () => {
    for (const item of EQUIPMENT) {
      if (item.loadUnit === 'bodyweight' || item.loadUnit === 'band' || item.loadUnit === 'none') {
        continue;
      }
      expect(item.increment).not.toBeNull();
      expect(item.increment ?? 0).toBeGreaterThan(0);
    }
  });

  it('keeps min below max wherever both are declared', () => {
    for (const item of EQUIPMENT) {
      if (item.minLoad !== null && item.maxLoad !== null) {
        expect(item.maxLoad).toBeGreaterThan(item.minLoad);
      }
    }
  });

  it('marks attachments as loadless — a rope gates nothing', () => {
    for (const item of EQUIPMENT.filter((e) => e.attachment)) {
      expect(item.loadUnit).toBe('none');
      expect(item.satisfies).toEqual([]);
    }
  });

  it('ships the generic machine fallback', () => {
    const generic = equipmentById(GENERIC_MACHINE);
    expect(generic?.satisfies).toContain('machine');
    expect(generic?.zone).toBe('machines');
  });

  it('labels every brand', () => {
    for (const item of EQUIPMENT) expect(brandLabel(item.brand).length).toBeGreaterThan(0);
  });
});

describe('named brands are first-class where the load model differs', () => {
  const idsOf = (brand: string) => EQUIPMENT.filter((e) => e.brand === brand).map((e) => e.id);

  it('models Keiser as pneumatic pounds, not plates', () => {
    const keiser = EQUIPMENT.filter((e) => e.brand === 'keiser');
    expect(keiser.length).toBeGreaterThan(5);
    for (const item of keiser) {
      // The M3 bike is the exception: it is a power meter, not a resistance dial.
      expect(['pneumatic_lb', 'watts']).toContain(item.loadUnit);
    }
  });

  it('gives Keiser 1 lb steps — finer than any weight stack', () => {
    const press = equipmentById('keiser_air_chest_press');
    expect(press?.loadUnit).toBe('pneumatic_lb');
    expect(press?.increment).toBe(1);
    const stack = equipmentById('machine_chest_press');
    expect(stack?.loadUnit).toBe('stack_lb');
    expect(stack?.increment).toBe(10);
  });

  it('has Keiser and the ergs report watts', () => {
    for (const id of ['keiser_m3_bike', 'keiser_functional_trainer', 'concept2_rowerg', 'assault_air_bike'] as const) {
      expect(equipmentById(id)?.reportsPower).toBe(true);
    }
  });

  it('models Hammer Strength as plate-loaded, unlike its selectorised twin', () => {
    const hs = EQUIPMENT.filter((e) => e.brand === 'hammer_strength');
    expect(hs.length).toBeGreaterThan(0);
    for (const item of hs) expect(item.loadUnit).toBe('plates');
  });

  it('covers the brands the brief named', () => {
    for (const brand of [
      'keiser',
      'hammer_strength',
      'life_fitness',
      'technogym',
      'concept2',
      'assault',
      'woodway',
      'cybex',
    ]) {
      // Life Fitness and Cybex ride on the generic items as a per-gym label
      // rather than their own catalogue entries — see EquipmentBrand's docs —
      // so what is asserted here is that the brand is *nameable*.
      expect(brandLabel(brand as never).length).toBeGreaterThan(0);
    }
    expect(idsOf('keiser').length).toBeGreaterThan(0);
    expect(idsOf('concept2').length).toBeGreaterThan(0);
    expect(idsOf('woodway').length).toBeGreaterThan(0);
  });
});

describe('load unit vocabulary', () => {
  it('renders pounds for all three pound-denominated units', () => {
    expect(loadUnitSuffix('plates')).toBe('lb');
    expect(loadUnitSuffix('stack_lb')).toBe('lb');
    expect(loadUnitSuffix('pneumatic_lb')).toBe('lb');
  });

  it('renders watts for power and nothing for the unitless ones', () => {
    expect(loadUnitSuffix('watts')).toBe('W');
    expect(loadUnitSuffix('bodyweight')).toBe('');
    expect(loadUnitSuffix('band')).toBe('');
    expect(loadUnitSuffix('none')).toBe('');
  });

  it('has exactly the seven agreed values', () => {
    expect([...LOAD_UNITS].sort()).toEqual(
      ['band', 'bodyweight', 'none', 'plates', 'pneumatic_lb', 'stack_lb', 'watts'].sort(),
    );
  });
});

describe('tag coverage is not accidentally lopsided', () => {
  it('has more items than the library has tags — it is a superset', () => {
    expect(EQUIPMENT.length).toBeGreaterThan(LIBRARY_EQUIPMENT_TAGS.length);
  });

  it('maps the rarest tags to something specific', () => {
    const rare: readonly LibraryEquipmentTag[] = [
      'tib_bar',
      'neck_harness',
      'nordic_bench',
      'pool',
      'ab_wheel',
      'jump_rope',
      'foam_roller',
      'rings',
      'landmine',
      'trap_bar',
    ];
    for (const tag of rare) {
      expect(itemsSatisfying(tag).length).toBeGreaterThan(0);
    }
  });
});
