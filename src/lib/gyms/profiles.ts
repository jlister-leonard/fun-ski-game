/**
 * @file Gym profiles — a named place with a known set of equipment.
 *
 * People may train in several places: a trainer's facility, a commercial gym,
 * home, and hotels.
 * A single global "what equipment do you have?" answer is wrong for all four.
 * So equipment belongs to a *location*, one location is active at a time, and
 * switching is one tap.
 *
 * Everything here is pure. Persistence lives in `store.ts`; this module never
 * touches the vault, so the filtering can be unit-tested without IndexedDB.
 *
 * ## The three questions this file answers
 *
 * - `availableExercises(profile)` — what can I do here?
 * - `whyUnavailable(slug, profile)` — why is that not on the list?
 * - `prescriptionForExercise(slug, profile)` — in what unit, and in what steps,
 *   do I load it here?
 *
 * The second one is not a nicety. A generator that quietly omits a movement is
 * indistinguishable from a generator with a bug, and the user has no way to
 * tell which they are looking at. Every omission has to be explainable.
 */

import { EXERCISE_LIBRARY, exerciseBySlug } from '../training/library';
import type { LibraryExercise } from '../training/types';
import {
  ALWAYS_SATISFIED_TAGS,
  EQUIPMENT,
  equipmentById,
  itemsSatisfying,
  prescriptionFor as prescriptionForItem,
  tagLabel,
  type EquipmentBrand,
  type EquipmentId,
  type EquipmentItem,
  type LibraryEquipmentTag,
  type LoadPrescription,
} from './equipment';
import { checkRequirement, requirementFor } from './requirements';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One piece of equipment at one gym, with whatever this gym's version of it
 * differs by.
 *
 * The overrides are the whole reason a selection is an object rather than a
 * bare id. "Dumbbells" is not a fact you can program against; "dumbbells,
 * 5–100 lb, in fives" is. A rack that stops at 50 lb and one that stops at 150
 * lb produce different programs from the same algorithm.
 *
 * Loads are in **pounds** — the unit written on the equipment. See the note on
 * {@link import('./equipment').LoadUnit}.
 */
export interface EquipmentSelection {
  readonly id: EquipmentId;
  /** Who made this one, when it differs from the catalogue default. */
  readonly brand?: EquipmentBrand;
  /** Smallest achievable step, overriding the catalogue default. */
  readonly increment?: number | null;
  readonly minLoad?: number | null;
  readonly maxLoad?: number | null;
  /** Explicit achievable loads — the kettlebells this gym actually owns. */
  readonly sizes?: readonly number[] | null;
  /**
   * Length of a lane or track, in **metres**.
   *
   * SI, unlike the loads, because this is a distance and distances are stored
   * in metres everywhere in this app (`WorkoutSet` magnitudes included). It is
   * shown in yards by `@/lib/units`.
   */
  readonly spanM?: number | null;
  readonly note?: string;
}

/**
 * A photo of the gym, kept as a memory aid.
 *
 * Stored inside the encrypted vault with everything else. **Never uploaded,
 * never analysed, never sent anywhere** — there is nowhere for it to go: the
 * app has no backend and makes no same-origin request carrying user data. The
 * capture UI says this in as many words, because a request for a photo in a
 * health app that did not say it would be a reasonable thing to distrust.
 */
export interface GymPhoto {
  /** A downscaled JPEG data URL. The capture flow caps the long edge. */
  readonly dataUrl: string;
  readonly capturedAt: number;
  /** What it is a picture of — "the machine wall", "the rack". */
  readonly label: string;
}

/** What kind of place this is. Only affects copy and the seed template. */
export type GymKind = 'commercial' | 'trainer' | 'home' | 'travel' | 'other';

/** A named location and its equipment. */
export interface GymProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: GymKind;
  readonly items: readonly EquipmentSelection[];
  readonly photos: readonly GymPhoto[];
  readonly note: string;
  /** True for profiles this app ships. Editable, but never deletable. */
  readonly builtIn: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Display name for a kind. */
export function gymKindLabel(kind: GymKind): string {
  switch (kind) {
    case 'commercial':
      return 'Commercial gym';
    case 'trainer':
      return "Trainer's studio";
    case 'home':
      return 'Home';
    case 'travel':
      return 'Travel / hotel';
    case 'other':
      return 'Other';
  }
}

// ---------------------------------------------------------------------------
// Seed templates
// ---------------------------------------------------------------------------

const sel = (id: EquipmentId, extra: Omit<EquipmentSelection, 'id'> = {}): EquipmentSelection =>
  Object.freeze({ id, ...extra });

/**
 * A plausible US commercial gym, ticked.
 *
 * This is the "quick setup" payload. The design bet is that **subtracting is
 * far faster than adding**: a big-box gym has most of this, so the user scans
 * a list and unticks the three things their gym lacks, instead of hunting
 * through 120 items for the forty they own.
 *
 * `machine_generic` is in here deliberately — it says "there is a machine
 * circuit here beyond what I itemised", which stops thoroughness from being
 * punished with missing movements.
 */
export const COMMERCIAL_SEED: readonly EquipmentSelection[] = Object.freeze([
  sel('barbell_olympic'),
  sel('plates_standard'),
  sel('barbell_ez'),
  sel('barbell_trap'),
  sel('landmine'),
  sel('dumbbells_fixed', { minLoad: 5, maxLoad: 100, increment: 5 }),
  sel('kettlebells'),
  sel('medicine_balls'),
  sel('dip_belt'),
  sel('power_rack'),
  sel('bench_flat'),
  sel('bench_adjustable'),
  sel('bench_decline'),
  sel('preacher_bench'),
  sel('smith_machine'),
  sel('hyperextension_45'),
  sel('captains_chair'),
  sel('cable_crossover'),
  sel('cable_column_single'),
  sel('functional_trainer'),
  sel('lat_pulldown_station'),
  sel('seated_row_station'),
  sel('attach_rope'),
  sel('attach_straight_bar'),
  sel('attach_lat_bar'),
  sel('attach_v_handle'),
  sel('attach_d_handles'),
  sel('attach_ankle_strap'),
  sel('machine_chest_press'),
  sel('machine_pec_deck'),
  sel('machine_rear_delt'),
  sel('machine_shoulder_press'),
  sel('machine_lateral_raise'),
  sel('machine_row'),
  sel('machine_assisted_dip_pullup'),
  sel('machine_leg_press'),
  sel('machine_hack_squat'),
  sel('machine_leg_extension'),
  sel('machine_leg_curl_lying'),
  sel('machine_leg_curl_seated'),
  sel('machine_adductor'),
  sel('machine_abductor'),
  sel('machine_calf_standing'),
  sel('machine_calf_seated'),
  sel('machine_generic'),
  sel('sled_push'),
  sel('turf_lane', { spanM: 18 }),
  sel('treadmill_motorized'),
  sel('bike_upright'),
  sel('bike_spin'),
  sel('rower_generic'),
  sel('stair_climber'),
  sel('elliptical'),
  sel('floor_space'),
  sel('wall_space'),
  sel('pull_up_bar'),
  sel('dip_station'),
  sel('rings_suspension'),
  sel('plyo_box'),
  sel('ab_wheel'),
  sel('bands_loop'),
  sel('bands_mini'),
  sel('bands_tube'),
  sel('jump_rope'),
  sel('foam_roller'),
  sel('yoga_mat'),
]);

/**
 * A generic performance-studio starting point. Existing encrypted gym profiles
 * are never replaced by this editable quick-start list.
 */
export const TRAINER_SEED: readonly EquipmentSelection[] = Object.freeze([
  sel('floor_space'),
  sel('wall_space'),
  sel('turf_lane', { spanM: 18 }),
  sel('sled_push'),
  sel('sled_drag_harness'),
  sel('barbell_olympic'),
  sel('plates_standard'),
  sel('landmine'),
  sel('dumbbells_fixed', { minLoad: 5, maxLoad: 100, increment: 5 }),
  sel('kettlebells'),
  sel('medicine_balls'),
  sel('slam_balls'),
  sel('power_rack'),
  sel('bench_flat'),
  sel('bench_adjustable'),
  sel('ghd'),
  sel('keiser_functional_trainer'),
  sel('keiser_air_leg_press'),
  sel('keiser_air_hip'),
  sel('keiser_air_row'),
  sel('keiser_air_chest_press'),
  sel('keiser_m3_bike'),
  sel('cable_crossover'),
  sel('attach_rope'),
  sel('attach_d_handles'),
  sel('attach_ankle_strap'),
  sel('pull_up_bar'),
  sel('plyo_box'),
  sel('bands_loop'),
  sel('bands_mini'),
  sel('bands_tube'),
  sel('foam_roller'),
]);

/** A home setup: adjustable dumbbells, a bench, a bar, bands. */
export const HOME_SEED: readonly EquipmentSelection[] = Object.freeze([
  sel('floor_space'),
  sel('wall_space'),
  sel('yoga_mat'),
  sel('dumbbells_adjustable', { minLoad: 5, maxLoad: 50, increment: 5 }),
  sel('kettlebells', { sizes: [35, 53] }),
  sel('bench_adjustable'),
  sel('pull_up_bar'),
  sel('plyo_box'),
  sel('bands_loop'),
  sel('bands_mini'),
  sel('bands_tube'),
  sel('ab_wheel'),
  sel('foam_roller'),
  sel('jump_rope'),
]);

/**
 * The floor of a hotel room, and whatever fits in a bag.
 *
 * Bodyweight plus bands, and that is the entire point: this profile exists so
 * that a night in a hotel produces a session rather than an empty screen. It
 * is built in and cannot be deleted, so there is always a floor to fall back
 * to when the user is somewhere they have not profiled.
 */
export const TRAVEL_SEED: readonly EquipmentSelection[] = Object.freeze([
  sel('floor_space'),
  sel('wall_space'),
  sel('bands_loop'),
  sel('bands_mini'),
  sel('bands_tube'),
  sel('jump_rope'),
  sel('foam_roller'),
]);

/** Seed selections for a kind of gym, for "quick setup" and new profiles. */
export function seedFor(kind: GymKind): readonly EquipmentSelection[] {
  switch (kind) {
    case 'commercial':
      return COMMERCIAL_SEED;
    case 'trainer':
      return TRAINER_SEED;
    case 'home':
      return HOME_SEED;
    case 'travel':
      return TRAVEL_SEED;
    case 'other':
      return Object.freeze([sel('floor_space'), sel('wall_space')]);
  }
}

/** The id of the built-in travel profile. Stable; other modules key off it. */
export const TRAVEL_PROFILE_ID = 'builtin-travel';

/**
 * The built-in minimal profile.
 *
 * Always present, never deletable. `createdAt`/`updatedAt` are 0 rather than
 * `Date.now()` so this constant is referentially stable and tests are not
 * time-dependent.
 */
export const TRAVEL_PROFILE: GymProfile = Object.freeze({
  id: TRAVEL_PROFILE_ID,
  name: 'Travel / hotel',
  kind: 'travel',
  items: TRAVEL_SEED,
  photos: Object.freeze([]),
  note: 'Bodyweight and bands. The fallback when you are somewhere new.',
  builtIn: true,
  createdAt: 0,
  updatedAt: 0,
});

/**
 * A new, empty-ish profile.
 *
 * @param name what the user called it
 * @param kind which template to seed from
 * @param id a unique id — the caller supplies it so this stays pure
 * @param now epoch ms
 * @returns the profile
 */
export function createProfile(
  name: string,
  kind: GymKind,
  id: string,
  now: number,
): GymProfile {
  return {
    id,
    name,
    kind,
    items: seedFor(kind),
    photos: [],
    note: '',
    builtIn: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Copy a profile under a new name.
 *
 * Two gyms in the same chain differ by three machines, and re-walking six
 * zones to express that is the kind of friction that stops a second profile
 * from ever being created. Photos are **not** copied — they are a memory aid
 * for a specific room, and a duplicated photo would be actively misleading.
 *
 * @param source what to copy
 * @param name the new name
 * @param id a unique id
 * @param now epoch ms
 * @returns the copy
 */
export function duplicateProfile(
  source: GymProfile,
  name: string,
  id: string,
  now: number,
): GymProfile {
  return {
    id,
    name,
    kind: source.kind,
    items: source.items.map((s) => ({ ...s })),
    photos: [],
    note: source.note,
    builtIn: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Querying a profile
// ---------------------------------------------------------------------------

/** Whether this gym has an item. */
export function hasEquipment(profile: GymProfile, id: EquipmentId): boolean {
  return profile.items.some((s) => s.id === id);
}

/** This gym's selection for an item, with its overrides. */
export function selectionOf(
  profile: GymProfile,
  id: EquipmentId,
): EquipmentSelection | null {
  return profile.items.find((s) => s.id === id) ?? null;
}

/**
 * Add an item, or replace its overrides if it is already there.
 *
 * `now` defaults to the wall clock. The default lives here rather than at the
 * call sites because the call sites are React components, and reading the
 * clock during a render is exactly the impurity the lint rules forbid — the
 * timestamp would change on every re-render and the compiler could not treat
 * the result as stable.
 *
 * @returns a new profile; the input is not mutated
 */
export function withEquipment(
  profile: GymProfile,
  selection: EquipmentSelection,
  now: number = Date.now(),
): GymProfile {
  const without = profile.items.filter((s) => s.id !== selection.id);
  return { ...profile, items: [...without, selection], updatedAt: now };
}

/** Remove an item. */
export function withoutEquipment(
  profile: GymProfile,
  id: EquipmentId,
  now: number = Date.now(),
): GymProfile {
  return {
    ...profile,
    items: profile.items.filter((s) => s.id !== id),
    updatedAt: now,
  };
}

/**
 * Patch a profile's own fields, stamping `updatedAt`.
 *
 * Same reason as above: a screen must never spread `{ updatedAt: Date.now() }`
 * inline in JSX.
 *
 * @param profile the profile
 * @param patch the fields to change
 * @param now epoch ms, defaulted
 * @returns a new profile
 */
export function updateProfile(
  profile: GymProfile,
  patch: Partial<Omit<GymProfile, 'id' | 'createdAt' | 'builtIn'>>,
  now: number = Date.now(),
): GymProfile {
  return { ...profile, ...patch, updatedAt: now };
}

/**
 * Every library tag this gym satisfies.
 *
 * {@link ALWAYS_SATISFIED_TAGS} is unioned in unconditionally: `bodyweight` is
 * not equipment, and a profile that could make `push-up` unavailable would be
 * modelling a fact about the world that is not true.
 */
export function tagsFor(profile: GymProfile): ReadonlySet<LibraryEquipmentTag> {
  const tags = new Set<LibraryEquipmentTag>(ALWAYS_SATISFIED_TAGS);
  for (const selection of profile.items) {
    const item = equipmentById(selection.id);
    if (item === null) continue; // an id from a newer build — ignore, never throw
    for (const tag of item.satisfies) tags.add(tag);
  }
  return tags;
}

/** Every catalogue item this gym holds, in catalogue order. */
export function itemsFor(profile: GymProfile): readonly EquipmentItem[] {
  const ids = new Set(profile.items.map((s) => s.id));
  return EQUIPMENT.filter((e) => ids.has(e.id));
}

/**
 * Can this movement be done here?
 *
 * @param slug a library slug
 * @param profile the gym
 * @returns true when it can. Unknown slugs — user-created movements — return
 *   true: the app knows nothing about their equipment, and hiding something
 *   the user invented would be indefensible.
 */
export function isAvailable(slug: string, profile: GymProfile): boolean {
  const requirement = requirementFor(slug);
  if (requirement === null) return true;
  const tags = tagsFor(profile);
  return checkRequirement(
    requirement,
    (tag) => tags.has(tag),
    (id) => hasEquipment(profile, id),
  ).ok;
}

/**
 * Everything the library offers that this gym can actually deliver.
 *
 * Library order is preserved, which is the order the library itself curated.
 *
 * @param profile the gym
 * @returns the available movements
 */
export function availableExercises(profile: GymProfile): readonly LibraryExercise[] {
  const tags = tagsFor(profile);
  const has = (tag: LibraryEquipmentTag) => tags.has(tag);
  const holds = (id: EquipmentId) => hasEquipment(profile, id);
  return EXERCISE_LIBRARY.filter((exercise) => {
    const requirement = requirementFor(exercise.slug);
    return requirement === null || checkRequirement(requirement, has, holds).ok;
  });
}

/** Just the slugs — the shape the generator wants. */
export function availableSlugs(profile: GymProfile): readonly string[] {
  return availableExercises(profile).map((e) => e.slug);
}

/**
 * How much of the library this gym opens up.
 *
 * Shown live in the capture flow, because a number that moves as you tick
 * boxes is the fastest way to see that ticking boxes is worth doing.
 */
export interface Coverage {
  readonly available: number;
  readonly total: number;
  /** 0–100, rounded. */
  readonly percent: number;
}

/** {@link Coverage} for a profile. */
export function coverageOf(profile: GymProfile): Coverage {
  const available = availableExercises(profile).length;
  const total = EXERCISE_LIBRARY.length;
  return {
    available,
    total,
    percent: total === 0 ? 0 : Math.round((available / total) * 100),
  };
}

/**
 * Why a movement is not on the list here.
 *
 * The whole point of the equipment model is that a gap is *explainable*. An
 * exercise that just is not there looks identical to a bug.
 */
export interface UnavailableReason {
  readonly slug: string;
  readonly name: string;
  /**
   * `missing_equipment` — a tag is not satisfied at all.
   * `missing_machine` — everything is here except the specific machine.
   * `unknown_exercise` — not in the library.
   */
  readonly kind: 'missing_equipment' | 'missing_machine' | 'unknown_exercise';
  readonly missingTags: readonly LibraryEquipmentTag[];
  /** Items that would fix it, best-known first. */
  readonly suggestions: readonly EquipmentItem[];
  /** A sentence for the UI. */
  readonly message: string;
  /**
   * Movements that *are* available here and train the same thing — the
   * library's own regressions and progressions, filtered by this gym.
   */
  readonly alternatives: readonly string[];
}

/**
 * Explain a gap.
 *
 * @param slug a library slug
 * @param profile the gym
 * @returns `null` when the movement is available — so the call site reads
 *   `const why = whyUnavailable(...); if (why) …`
 */
export function whyUnavailable(
  slug: string,
  profile: GymProfile,
): UnavailableReason | null {
  const exercise = exerciseBySlug(slug);
  const requirement = requirementFor(slug);
  if (requirement === null || exercise === null) {
    // Unknown slugs are available (see `isAvailable`), so there is nothing to
    // explain. Returning null keeps the two functions consistent.
    return null;
  }

  const tags = tagsFor(profile);
  const check = checkRequirement(
    requirement,
    (tag) => tags.has(tag),
    (id) => hasEquipment(profile, id),
  );
  if (check.ok) return null;

  const alternatives = [...exercise.regressions, ...exercise.progressions].filter(
    (other) => isAvailable(other, profile),
  );

  if (check.blockedOnSpecificMachine) {
    const suggestions = requirement.specific
      .map((id) => equipmentById(id))
      .filter((i): i is EquipmentItem => i !== null);
    const names = suggestions.slice(0, 2).map((i) => i.label).join(' or ');
    return {
      slug,
      name: exercise.name,
      kind: 'missing_machine',
      missingTags: [],
      suggestions,
      message: `${profile.name} has machines, but none of them is a ${names || exercise.name}.`,
      alternatives,
    };
  }

  const missingTags = check.missingTags;
  const suggestions = missingTags.flatMap((tag) => itemsSatisfying(tag));
  const phrase =
    missingTags.length === 0
      ? 'the right equipment'
      : missingTags.length === 1
        ? tagLabel(missingTags[0])
        : `${missingTags.slice(0, -1).map(tagLabel).join(', ')} and ${tagLabel(
            missingTags[missingTags.length - 1],
          )}`;

  return {
    slug,
    name: exercise.name,
    kind: 'missing_equipment',
    missingTags,
    suggestions,
    message: `Needs ${phrase}, which ${profile.name} does not have.`,
    alternatives,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The prescription for one item at this gym, with the gym's own overrides. */
export function prescriptionForEquipment(
  profile: GymProfile,
  id: EquipmentId,
): LoadPrescription | null {
  const item = equipmentById(id);
  if (item === null) return null;
  const selection = selectionOf(profile, id);
  return prescriptionForItem(item, {
    increment: selection?.increment,
    minLoad: selection?.minLoad,
    maxLoad: selection?.maxLoad,
    sizes: selection?.sizes,
  });
}

/**
 * How this movement is loaded **at this gym**.
 *
 * The same movement is a different prescription in different rooms: a chest
 * press is a 10 lb pin at the commercial gym, a 5 lb plate jump on a Hammer
 * Strength, and a 1 lb air adjustment with a watt readout on a Keiser. The
 * generator asks this instead of assuming, and the logger renders its keypad
 * from the answer.
 *
 * Preference order: an item that specifically covers the movement, then the
 * implement that satisfies the load tag of whichever alternative was met.
 * Catalogue order breaks ties, which puts the plainest equipment first.
 *
 * @param slug a library slug
 * @param profile the gym
 * @returns the prescription, or `null` when the movement is unavailable here
 *   or carries no external load
 */
export function prescriptionForExercise(
  slug: string,
  profile: GymProfile,
): LoadPrescription | null {
  const requirement = requirementFor(slug);
  if (requirement === null) return null;

  const tags = tagsFor(profile);
  const check = checkRequirement(
    requirement,
    (tag) => tags.has(tag),
    (id) => hasEquipment(profile, id),
  );
  if (!check.ok) return null;

  const held = itemsFor(profile);

  for (const item of held) {
    if (item.covers.includes(slug)) return prescriptionForEquipment(profile, item.id);
  }

  // Two passes over the satisfied group, because a group lists its fixture
  // before its implement — `["bench", "dumbbell"]` — and it is the dumbbell
  // that carries the load. Asking a bench how much it weighs is the bug.
  const group = check.satisfiedBy ?? [];
  const carriesLoad = (item: EquipmentItem) =>
    item.loadUnit !== 'none' && item.loadUnit !== 'bodyweight';

  for (const tag of group) {
    if (tag === 'bodyweight') continue;
    const candidate = held.find((item) => item.satisfies.includes(tag) && carriesLoad(item));
    if (candidate) return prescriptionForEquipment(profile, candidate.id);
  }
  for (const tag of group) {
    if (tag === 'bodyweight') continue;
    const candidate = held.find((item) => item.satisfies.includes(tag));
    if (candidate) return prescriptionForEquipment(profile, candidate.id);
  }

  // Available, but through `bodyweight` alone — a push-up has no load axis.
  const bodyweight = held.find((item) => item.satisfies.includes('bodyweight'));
  return bodyweight ? prescriptionForEquipment(profile, bodyweight.id) : null;
}

/**
 * Every piece of equipment here that reports power in watts.
 *
 * Surfaced on its own because watts is the progression variable that serves
 * the VO2 max goal directly, and because it is the one number the user might
 * not know their gym can give them.
 */
export function powerCapableEquipment(profile: GymProfile): readonly EquipmentItem[] {
  return itemsFor(profile).filter((item) => item.reportsPower);
}
