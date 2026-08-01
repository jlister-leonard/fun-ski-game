/**
 * @file Filtering the library by a gym, and explaining the gaps.
 *
 * Two properties are load-bearing and are asserted here rather than assumed:
 *
 * 1. **No profile is ever empty.** A hotel with a band in a suitcase still
 *    yields a session. If this ever fails, the training surface shows a blank
 *    screen on the road, which is the worst moment for it to happen.
 * 2. **Every omission is explainable.** `availableExercises` and
 *    `whyUnavailable` are two views of one decision; a movement that is absent
 *    from the first and unexplained by the second is indistinguishable from a
 *    bug.
 */

import { describe, expect, it } from 'vitest';
import { EXERCISE_LIBRARY } from '@/lib/training/library';
import {
  COMMERCIAL_SEED,
  HOME_SEED,
  TRAINER_SEED,
  TRAVEL_PROFILE,
  availableExercises,
  availableSlugs,
  coverageOf,
  createProfile,
  duplicateProfile,
  hasEquipment,
  isAvailable,
  itemsFor,
  powerCapableEquipment,
  seedFor,
  tagsFor,
  whyUnavailable,
  withEquipment,
  withoutEquipment,
  type EquipmentSelection,
  type GymProfile,
} from '../profiles';
import { REQUIREMENT_OVERRIDES, requirementFor } from '../requirements';

/** A bare profile with exactly the given equipment. */
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

const pick = (...ids: readonly string[]): EquipmentSelection[] =>
  ids.map((id) => ({ id }) as EquipmentSelection);

const COMMERCIAL = gym('Main gym', COMMERCIAL_SEED);
const TRAINER = gym("Trainer's studio", TRAINER_SEED);
const HOME = gym('Home', HOME_SEED);

describe('bodyweight is never taken away', () => {
  it('leaves push-ups available at an entirely empty profile', () => {
    const nothing = gym('Nowhere', []);
    expect(isAvailable('push-up', nothing)).toBe(true);
    expect(tagsFor(nothing).has('bodyweight')).toBe(true);
  });

  it('yields a real session in a hotel room', () => {
    const slugs = availableSlugs(TRAVEL_PROFILE);
    expect(slugs.length).toBeGreaterThan(30);
    // Enough to build a session with, not just planks:
    for (const slug of ['push-up', 'split-squat', 'plank', 'pallof-press', 'jump-rope']) {
      expect(slugs).toContain(slug);
    }
  });

  it('never returns an empty list for any built-in template', () => {
    for (const kind of ['commercial', 'trainer', 'home', 'travel', 'other'] as const) {
      const profile = gym(kind, seedFor(kind));
      expect(availableExercises(profile).length).toBeGreaterThan(10);
    }
  });
});

describe('filtering by equipment', () => {
  it('opens up most of the library at a full commercial gym', () => {
    const coverage = coverageOf(COMMERCIAL);
    expect(coverage.total).toBe(EXERCISE_LIBRARY.length);
    expect(coverage.percent).toBeGreaterThanOrEqual(90);
  });

  it('ranks the four templates in the order common sense expects', () => {
    const commercial = coverageOf(COMMERCIAL).available;
    const trainer = coverageOf(TRAINER).available;
    const home = coverageOf(HOME).available;
    const travel = coverageOf(TRAVEL_PROFILE).available;
    expect(commercial).toBeGreaterThan(trainer);
    expect(trainer).toBeGreaterThan(home);
    expect(home).toBeGreaterThan(travel);
  });

  it('needs both the bar and the bench for a barbell bench press', () => {
    expect(isAvailable('barbell-bench-press', gym('a', pick('barbell_olympic')))).toBe(false);
    expect(isAvailable('barbell-bench-press', gym('b', pick('bench_flat')))).toBe(false);
    expect(
      isAvailable('barbell-bench-press', gym('c', pick('barbell_olympic', 'bench_flat'))),
    ).toBe(true);
  });

  it('accepts any one implement where the library lists alternatives', () => {
    // upright-row is ["barbell","ez_bar","cable"] — one of, not all of.
    expect(isAvailable('upright-row', gym('a', pick('barbell_olympic')))).toBe(true);
    expect(isAvailable('upright-row', gym('b', pick('barbell_ez')))).toBe(true);
    expect(isAvailable('upright-row', gym('c', pick('cable_crossover')))).toBe(true);
    expect(isAvailable('upright-row', gym('d', pick('bench_flat')))).toBe(false);
  });

  it('treats a machine and a band as two routes to an assisted pull-up', () => {
    expect(
      isAvailable('assisted-pull-up', gym('a', pick('machine_assisted_dip_pullup'))),
    ).toBe(true);
    expect(isAvailable('assisted-pull-up', gym('b', pick('pull_up_bar', 'bands_loop')))).toBe(
      true,
    );
    expect(isAvailable('assisted-pull-up', gym('c', pick('pull_up_bar')))).toBe(false);
  });

  it('does not put a hack squat on the card because the gym owns a leg press', () => {
    const legPressOnly = gym('Small gym', pick('machine_leg_press'));
    expect(isAvailable('leg-press', legPressOnly)).toBe(true);
    expect(isAvailable('hack-squat', legPressOnly)).toBe(false);
  });

  it('lets the generic-machine fallback stand in for an unitemised circuit', () => {
    const lazy = gym('Big box', pick('machine_generic'));
    expect(isAvailable('hack-squat', lazy)).toBe(true);
    expect(isAvailable('pec-deck', lazy)).toBe(true);
    // …but it is a machine fallback, not a universal one.
    expect(isAvailable('barbell-bench-press', lazy)).toBe(false);
    expect(isAvailable('sled-push-forward', lazy)).toBe(false);
  });

  it('falls through from a failed machine refinement to a non-machine route', () => {
    // preacher-curl is machine OR (bench + a curl bar). The gym below has
    // machines but no preacher machine; the bench route must still win.
    const profile = gym('Free-weight gym', pick('machine_leg_press', 'bench_flat', 'barbell_ez'));
    expect(isAvailable('preacher-curl', profile)).toBe(true);
  });

  it('lets a specific item grant a movement its tags cannot express', () => {
    // A Skillmill has a sled mode but is not a sled, and satisfies no `sled` tag.
    const skillmill = gym('Boutique', pick('technogym_skillmill'));
    expect(tagsFor(skillmill).has('sled')).toBe(false);
    expect(isAvailable('sled-push-forward', skillmill)).toBe(true);
  });

  it('keeps user-created movements available — the app knows nothing about them', () => {
    expect(isAvailable('my-invented-lift', gym('a', []))).toBe(true);
    expect(whyUnavailable('my-invented-lift', gym('a', []))).toBeNull();
  });
});

describe('explaining a gap', () => {
  it('returns null for anything that is available', () => {
    for (const exercise of availableExercises(COMMERCIAL)) {
      expect(whyUnavailable(exercise.slug, COMMERCIAL)).toBeNull();
    }
  });

  it('explains every single movement it filters out', () => {
    for (const profile of [COMMERCIAL, TRAINER, HOME, TRAVEL_PROFILE]) {
      const available = new Set(availableSlugs(profile));
      for (const exercise of EXERCISE_LIBRARY) {
        if (available.has(exercise.slug)) continue;
        const why = whyUnavailable(exercise.slug, profile);
        expect(why, `${exercise.slug} at ${profile.name}`).not.toBeNull();
        expect(why?.message.length ?? 0).toBeGreaterThan(0);
        expect(why?.kind === 'missing_equipment' || why?.kind === 'missing_machine').toBe(true);
      }
    }
  });

  it('names the missing thing, and something that would fix it', () => {
    const why = whyUnavailable('sled-push-forward', HOME);
    expect(why?.kind).toBe('missing_equipment');
    expect(why?.missingTags).toContain('sled');
    expect(why?.message).toContain('a sled');
    expect(why?.message).toContain('Home');
    expect(why?.suggestions.map((s) => s.id)).toContain('sled_push');
  });

  it('distinguishes "no machines" from "not that machine"', () => {
    const noMachines = gym('Garage', pick('barbell_olympic', 'plates_standard', 'power_rack'));
    expect(whyUnavailable('hack-squat', noMachines)?.kind).toBe('missing_equipment');

    const someMachines = gym('Small gym', pick('machine_leg_press'));
    const why = whyUnavailable('hack-squat', someMachines);
    expect(why?.kind).toBe('missing_machine');
    expect(why?.message).toContain('Small gym');
    expect(why?.suggestions.map((s) => s.id)).toContain('machine_hack_squat');
  });

  it('offers substitutes that are actually available here', () => {
    const why = whyUnavailable('barbell-bench-press', HOME);
    expect(why).not.toBeNull();
    for (const slug of why?.alternatives ?? []) {
      expect(isAvailable(slug, HOME)).toBe(true);
    }
    expect(why?.alternatives).toContain('dumbbell-bench-press');
  });
});

describe('requirement resolution', () => {
  it('resolves a requirement for all 220 library entries', () => {
    for (const exercise of EXERCISE_LIBRARY) {
      const requirement = requirementFor(exercise.slug);
      expect(requirement, exercise.slug).not.toBeNull();
      expect(requirement?.alternatives.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('only overrides slugs that exist', () => {
    const slugs = new Set(EXERCISE_LIBRARY.map((e) => e.slug));
    for (const slug of Object.keys(REQUIREMENT_OVERRIDES)) {
      expect(slugs.has(slug), slug).toBe(true);
    }
  });

  it('never invents a tag where the structural default applies', () => {
    for (const exercise of EXERCISE_LIBRARY) {
      if (exercise.slug in REQUIREMENT_OVERRIDES) continue;
      const listed = new Set<string>(exercise.equipment);
      const used = new Set(requirementFor(exercise.slug)?.alternatives.flat() ?? []);
      for (const tag of used) expect(listed.has(tag), `${exercise.slug}: ${tag}`).toBe(true);
    }
  });

  it('adds a tag only in the two places the library under-specified', () => {
    // `assisted-dip` is tagged ["machine","band"] and `assisted-pull-up` the
    // same — but a band is only an assistance method if there is something to
    // hang off. The overrides supply the missing fixture. Nothing else adds a
    // tag, and this test is what stops a third case slipping in unnoticed.
    const added: string[] = [];
    for (const [slug, groups] of Object.entries(REQUIREMENT_OVERRIDES)) {
      const listed = new Set<string>(
        EXERCISE_LIBRARY.find((e) => e.slug === slug)?.equipment ?? [],
      );
      for (const tag of new Set(groups.flat())) {
        if (!listed.has(tag)) added.push(`${slug}:${tag}`);
      }
    }
    expect(added.sort()).toEqual(['assisted-dip:dip_bar', 'assisted-pull-up:pull_up_bar']);
  });
});

describe('profile editing', () => {
  it('seeds a new profile from its kind', () => {
    const profile = createProfile('Second location', 'commercial', 'id-1', 1000);
    expect(profile.items.length).toBe(COMMERCIAL_SEED.length);
    expect(profile.builtIn).toBe(false);
    expect(profile.createdAt).toBe(1000);
  });

  it('duplicates equipment but never the photo', () => {
    const source: GymProfile = {
      ...COMMERCIAL,
      photos: [{ dataUrl: 'data:image/jpeg;base64,x', capturedAt: 5, label: 'rack' }],
    };
    const copy = duplicateProfile(source, 'Other branch', 'id-2', 2000);
    expect(copy.items.map((i) => i.id)).toEqual(source.items.map((i) => i.id));
    expect(copy.photos).toEqual([]);
    expect(copy.name).toBe('Other branch');
    expect(copy.builtIn).toBe(false);
    // The source is untouched.
    expect(source.photos.length).toBe(1);
  });

  it('adds, replaces and removes without mutating the input', () => {
    const before = gym('a', pick('bench_flat'));
    const added = withEquipment(before, { id: 'barbell_olympic' }, 10);
    expect(hasEquipment(added, 'barbell_olympic')).toBe(true);
    expect(hasEquipment(before, 'barbell_olympic')).toBe(false);
    expect(added.updatedAt).toBe(10);

    const overridden = withEquipment(added, { id: 'barbell_olympic', increment: 1 }, 11);
    expect(overridden.items.filter((i) => i.id === 'barbell_olympic').length).toBe(1);

    const removed = withoutEquipment(overridden, 'barbell_olympic', 12);
    expect(hasEquipment(removed, 'barbell_olympic')).toBe(false);
    expect(hasEquipment(overridden, 'barbell_olympic')).toBe(true);
  });

  it('ignores equipment ids it does not recognise rather than throwing', () => {
    const fromTheFuture = gym('a', [{ id: 'quantum-squat-rack' } as unknown as EquipmentSelection]);
    expect(() => availableExercises(fromTheFuture)).not.toThrow();
    expect(itemsFor(fromTheFuture)).toEqual([]);
  });
});

describe('power-capable equipment is findable', () => {
  it("surfaces the trainer studio's Keiser kit", () => {
    const ids = powerCapableEquipment(TRAINER).map((e) => e.id);
    expect(ids).toContain('keiser_m3_bike');
    expect(ids).toContain('keiser_functional_trainer');
    expect(ids).toContain('keiser_air_leg_press');
  });

  it('finds nothing in a hotel room, honestly', () => {
    expect(powerCapableEquipment(TRAVEL_PROFILE)).toEqual([]);
  });
});
