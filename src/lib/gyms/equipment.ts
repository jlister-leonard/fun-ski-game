/**
 * @file The equipment taxonomy — the vocabulary a gym profile is built from.
 *
 * Pure, zero-dependency, no I/O. Two things live here:
 *
 * 1. **{@link EquipmentItem}** — one nameable piece of kit, with the fact that
 *    actually matters for programming: *how it is loaded*. A pair of dumbbells
 *    that stops at 50 lb and a rack that runs to 150 lb are not the same
 *    equipment, and a Keiser press whose dial reads air pressure in pounds is
 *    not a plate-loaded press. See {@link LoadUnit}.
 * 2. **The bridge to the exercise library.** Every one of the 220 entries in
 *    `exercise-library.json` carries an `equipment` array drawn from a
 *    31-value vocabulary ({@link LibraryEquipmentTag}). Each item here declares
 *    which of those tags owning it satisfies. `__tests__/equipment.test.ts`
 *    fails if any library tag has no item behind it — a tag with no item is an
 *    exercise that silently becomes unavailable at every gym, which is the
 *    exact failure this file exists to prevent.
 *
 * ## Why `LoadUnit` is not just "kilograms"
 *
 * `AGENTS.md` is right that storage is SI. It is also right that the unit is
 * part of the datum when the machine's own dial is the source of truth:
 *
 * - A **plate-loaded** bar is a number of pounds you can actually build. What
 *   is programmable is the *increment* — micro-plates turn a 5 lb jump into a
 *   1 lb jump, and that changes which progressions are possible at all.
 * - A **selectorised stack** moves in the stack's own steps — 10 lb on most
 *   US commercial machines, 5 lb on some lines. There is no 137 lb.
 * - A **Keiser** is pneumatic. The resistance is air pressure, displayed in
 *   pounds, adjustable in ~1 lb steps under load, with a force curve unlike a
 *   plate at any point in the range. Recording it as "the same 100 lb" as a
 *   plate stack would corrupt the progression history.
 * - Several pieces — the Keiser Functional Trainer, the Keiser M3 bike, a
 *   Concept2, an Assault/Echo bike — report **watts**. For the VO2 max goal
 *   watts is a strictly better progression variable than reps, because it is
 *   the physiological quantity rather than a proxy for it.
 *
 * So an item declares its unit and its increment, and both flow through to
 * {@link LoadPrescription}, which is what the workout generator prescribes in
 * and what the set logger writes down.
 *
 * ## About the default numbers
 *
 * Ranges, ceilings and increments here are the **typical commercial values**,
 * not claims about any specific gym. They exist so the capture flow is mostly
 * confirming rather than typing. Every one of them is overridable per profile
 * via `EquipmentSelection` in `profiles.ts` — that is the point of the walk-
 * through. Where a default is a guess rather than a standard it says so.
 */

// ---------------------------------------------------------------------------
// Load units
// ---------------------------------------------------------------------------

/**
 * How a piece of equipment is loaded — the unit a set on it is prescribed and
 * logged in.
 *
 * | Value | What the number means | Example |
 * |---|---|---|
 * | `plates` | Total pounds you can physically assemble from discrete pieces | Olympic bar, fixed dumbbells, kettlebells, plate-loaded Hammer Strength |
 * | `stack_lb` | The pin position on a selectorised weight stack, in pounds | Leg extension, cable crossover |
 * | `pneumatic_lb` | Air pressure, displayed in pounds | Keiser A-series, Keiser Functional Trainer |
 * | `bodyweight` | No external load; the number is reps or seconds | Push-up, L-sit |
 * | `band` | A band colour/tension, not a scalar in pounds | Loop bands, mini bands |
 * | `watts` | Mechanical power output | Concept2, Assault bike, Keiser M3 |
 * | `none` | The item enables movements but carries no load axis | Plyo box, wall, foam roller |
 *
 * **`plates` covers fixed dumbbells and kettlebells deliberately.** They are
 * not plate-loaded, but they share the property that matters: the achievable
 * loads are a discrete set of pounds, and what the generator needs to know is
 * the step between them. Splitting "fixed free weight" into its own unit would
 * add a case to every switch for no behavioural difference.
 *
 * Adding a value here is a breaking change for the workout generator and the
 * set logger. Post in this channel first.
 */
export type LoadUnit =
  | 'plates'
  | 'pneumatic_lb'
  | 'stack_lb'
  | 'bodyweight'
  | 'band'
  | 'watts'
  | 'none';

/** Every {@link LoadUnit}, for iteration and exhaustiveness tests. */
export const LOAD_UNITS: readonly LoadUnit[] = Object.freeze([
  'plates',
  'pneumatic_lb',
  'stack_lb',
  'bodyweight',
  'band',
  'watts',
  'none',
] as const);

/**
 * The display suffix for a load unit.
 *
 * Pounds for the three pound-denominated units — that is what the dial, the
 * plate and the pin all read in a US gym, and re-labelling them would make the
 * app disagree with the equipment in front of the user. Watts for power.
 *
 * @param unit the load unit
 * @returns a short suffix, or the empty string where a number alone is wrong
 */
export function loadUnitSuffix(unit: LoadUnit): string {
  switch (unit) {
    case 'plates':
    case 'stack_lb':
    case 'pneumatic_lb':
      return 'lb';
    case 'watts':
      return 'W';
    case 'bodyweight':
    case 'band':
    case 'none':
      return '';
  }
}

/**
 * Whether a load unit's number is denominated in pounds.
 *
 * The three that are share a scale, so a 100 lb stack and a 100 lb dumbbell
 * are comparable magnitudes even though they are not interchangeable stimuli.
 *
 * @param unit the load unit
 * @returns true for `plates`, `stack_lb` and `pneumatic_lb`
 */
export function isPoundDenominated(unit: LoadUnit): boolean {
  return unit === 'plates' || unit === 'stack_lb' || unit === 'pneumatic_lb';
}

/** Human label for a load unit, for the capture flow and the logger. */
export function loadUnitLabel(unit: LoadUnit): string {
  switch (unit) {
    case 'plates':
      return 'Free weight (lb)';
    case 'stack_lb':
      return 'Weight stack (lb)';
    case 'pneumatic_lb':
      return 'Pneumatic (lb of air)';
    case 'bodyweight':
      return 'Bodyweight';
    case 'band':
      return 'Band tension';
    case 'watts':
      return 'Power (watts)';
    case 'none':
      return 'No load';
  }
}

// ---------------------------------------------------------------------------
// Zones and brands
// ---------------------------------------------------------------------------

/**
 * The area of a gym an item lives in.
 *
 * These are the steps of the capture walk-through, in order. They are physical
 * zones rather than taxonomic categories on purpose: someone standing in their
 * gym answers "what is on the turf?" far faster than "which of these are
 * plate-loaded?", because they can look at it.
 */
export type EquipmentZone =
  | 'free_weights'
  | 'racks_benches'
  | 'cables'
  | 'machines'
  | 'sled_turf'
  | 'cardio'
  | 'bodyweight_rig';

/** Zone metadata for the walk-through. `order` is the step sequence. */
export interface ZoneInfo {
  readonly id: EquipmentZone;
  readonly order: number;
  readonly label: string;
  /** One line under the heading — what the user should be looking at. */
  readonly blurb: string;
}

/** The zones, in walk-through order. */
export const ZONES: readonly ZoneInfo[] = Object.freeze([
  {
    id: 'free_weights',
    order: 1,
    label: 'Free weights',
    blurb: 'Bars, plates, dumbbells, kettlebells.',
  },
  {
    id: 'racks_benches',
    order: 2,
    label: 'Racks & benches',
    blurb: 'What you can squat, press and lie down on.',
  },
  {
    id: 'cables',
    order: 3,
    label: 'Cables',
    blurb: 'Cable columns, functional trainers, and the handles for them.',
  },
  {
    id: 'machines',
    order: 4,
    label: 'Machines',
    blurb: 'Pin-loaded, plate-loaded and pneumatic. Tick what you have seen.',
  },
  {
    id: 'sled_turf',
    order: 5,
    label: 'Sled & turf',
    blurb: 'Push, drag, carry.',
  },
  {
    id: 'cardio',
    order: 6,
    label: 'Cardio',
    blurb: 'The VO2 max work lives here.',
  },
  {
    id: 'bodyweight_rig',
    order: 7,
    label: 'Bodyweight & bands',
    blurb: 'Bars, rings, boxes, bands. This is what travels with you.',
  },
] as const);

/** Look a zone's metadata up by id. */
export function zoneInfo(id: EquipmentZone): ZoneInfo {
  const found = ZONES.find((z) => z.id === id);
  // Unreachable for a well-typed id; the fallback exists so a stale profile
  // written by a future build can never crash the settings screen.
  return found ?? ZONES[0];
}

/**
 * Manufacturers modelled by name.
 *
 * **When a brand gets its own {@link EquipmentItem}, and when it is just a
 * label.** A brand earns its own item when the brand *changes the load model*:
 * Keiser is pneumatic and reads in air pounds, Hammer Strength is plate-loaded
 * where the equivalent selectorised machine is a stack, Concept2 and
 * Assault/Echo report watts, Woodway is a curved manual belt with no motor and
 * therefore no speed setting. Those are different numbers on the screen.
 *
 * Where the brand changes only the badge — a Life Fitness leg extension versus
 * a Cybex one, both stacks, both 10 lb pins — the item stays generic and the
 * brand rides along on the profile's selection (`EquipmentSelection.brand`).
 * Inventing an item per brand × machine would multiply the checklist by six
 * and tell the generator nothing it did not already know.
 */
export type EquipmentBrand =
  | 'generic'
  | 'keiser'
  | 'hammer_strength'
  | 'cybex'
  | 'life_fitness'
  | 'technogym'
  | 'concept2'
  | 'assault'
  | 'woodway'
  | 'rogue'
  | 'precor'
  | 'nautilus'
  | 'other';

/** Every brand, for the "who made it?" picker. */
export const EQUIPMENT_BRANDS: readonly EquipmentBrand[] = Object.freeze([
  'generic',
  'keiser',
  'hammer_strength',
  'cybex',
  'life_fitness',
  'technogym',
  'concept2',
  'assault',
  'woodway',
  'rogue',
  'precor',
  'nautilus',
  'other',
] as const);

/** Display name for a brand. */
export function brandLabel(brand: EquipmentBrand): string {
  switch (brand) {
    case 'generic':
      return 'Unbranded / not sure';
    case 'keiser':
      return 'Keiser';
    case 'hammer_strength':
      return 'Hammer Strength';
    case 'cybex':
      return 'Cybex';
    case 'life_fitness':
      return 'Life Fitness';
    case 'technogym':
      return 'Technogym';
    case 'concept2':
      return 'Concept2';
    case 'assault':
      return 'Assault / Echo';
    case 'woodway':
      return 'Woodway';
    case 'rogue':
      return 'Rogue';
    case 'precor':
      return 'Precor';
    case 'nautilus':
      return 'Nautilus';
    case 'other':
      return 'Other';
  }
}

// ---------------------------------------------------------------------------
// The library's own equipment vocabulary
// ---------------------------------------------------------------------------

/**
 * The 31 `equipment` strings used across `exercise-library.json`.
 *
 * This union is *derived from the data*, not invented: it was read off all 220
 * entries. `__tests__/equipment.test.ts` re-derives it from the bundled library
 * and fails if the two ever disagree, so a library update that adds a 32nd tag
 * shows up as a red test rather than as exercises quietly vanishing.
 *
 * The taxonomy above is a **superset**: it draws finer distinctions (a Keiser
 * press and a pin-loaded press are both `machine` to the library) but never a
 * coarser one.
 */
export type LibraryEquipmentTag =
  | 'ab_wheel'
  | 'band'
  | 'barbell'
  | 'bench'
  | 'bike'
  | 'bodyweight'
  | 'box'
  | 'cable'
  | 'dip_bar'
  | 'dumbbell'
  | 'ez_bar'
  | 'foam_roller'
  | 'jump_rope'
  | 'kettlebell'
  | 'landmine'
  | 'machine'
  | 'medicine_ball'
  | 'neck_harness'
  | 'nordic_bench'
  | 'plate'
  | 'pool'
  | 'pull_up_bar'
  | 'rings'
  | 'rower'
  | 'sled'
  | 'smith_machine'
  | 'stair_climber'
  | 'tib_bar'
  | 'treadmill'
  | 'trap_bar'
  | 'wall';

/** Every library tag, sorted. */
export const LIBRARY_EQUIPMENT_TAGS: readonly LibraryEquipmentTag[] = Object.freeze([
  'ab_wheel',
  'band',
  'barbell',
  'bench',
  'bike',
  'bodyweight',
  'box',
  'cable',
  'dip_bar',
  'dumbbell',
  'ez_bar',
  'foam_roller',
  'jump_rope',
  'kettlebell',
  'landmine',
  'machine',
  'medicine_ball',
  'neck_harness',
  'nordic_bench',
  'plate',
  'pool',
  'pull_up_bar',
  'rings',
  'rower',
  'sled',
  'smith_machine',
  'stair_climber',
  'tib_bar',
  'treadmill',
  'trap_bar',
  'wall',
] as const);

/**
 * Tags that are satisfied by having a body and a patch of floor.
 *
 * `bodyweight` is in every profile including the hotel one, by construction —
 * `availableExercises` treats it as always met. A profile that could make
 * `push-up` unavailable would be a bug in the model, not a fact about a gym.
 */
export const ALWAYS_SATISFIED_TAGS: readonly LibraryEquipmentTag[] =
  Object.freeze(['bodyweight'] as const);

/** Plain-English name for a library tag, for "you don't have a …" copy. */
export function tagLabel(tag: LibraryEquipmentTag): string {
  const labels: Record<LibraryEquipmentTag, string> = {
    ab_wheel: 'an ab wheel',
    band: 'resistance bands',
    barbell: 'a barbell',
    bench: 'a bench',
    bike: 'a bike',
    bodyweight: 'your bodyweight',
    box: 'a box or step',
    cable: 'a cable machine',
    dip_bar: 'dip bars',
    dumbbell: 'dumbbells',
    ez_bar: 'an EZ bar',
    foam_roller: 'a foam roller',
    jump_rope: 'a jump rope',
    kettlebell: 'kettlebells',
    landmine: 'a landmine',
    machine: 'a machine',
    medicine_ball: 'a medicine ball',
    neck_harness: 'a neck harness',
    nordic_bench: 'a nordic bench or GHD',
    plate: 'weight plates',
    pool: 'a pool',
    pull_up_bar: 'a pull-up bar',
    rings: 'rings or a suspension trainer',
    rower: 'a rower',
    sled: 'a sled',
    smith_machine: 'a Smith machine',
    stair_climber: 'a stair climber',
    tib_bar: 'a tib bar',
    treadmill: 'a treadmill',
    trap_bar: 'a trap bar',
    wall: 'a clear wall',
  };
  return labels[tag];
}

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

/**
 * One nameable piece of equipment.
 *
 * `id` is the stable key. It is written into the user's vault inside a gym
 * profile, so **ids are permanent** — renaming one orphans a profile. Adding
 * one is free.
 */
export interface EquipmentItem {
  readonly id: EquipmentId;
  readonly label: string;
  readonly zone: EquipmentZone;
  readonly brand: EquipmentBrand;
  /** How a set on this is loaded. Drives {@link LoadPrescription}. */
  readonly loadUnit: LoadUnit;
  /**
   * Smallest step between two achievable loads, in the item's own unit
   * (pounds, or watts). `null` where the unit has no scalar step.
   *
   * For `watts` this is a **prescription granularity**, not a hardware detent:
   * you cannot dial 215 W on a rower, you hold it. 5 W is the smallest step
   * worth writing on a program.
   */
  readonly increment: number | null;
  /** Lightest achievable load, in the item's own unit. `null` if unbounded/NA. */
  readonly minLoad: number | null;
  /** Heaviest achievable load. `null` when the item has no meaningful ceiling. */
  readonly maxLoad: number | null;
  /**
   * Discrete achievable loads, when they are not an arithmetic series —
   * kettlebells climb 18/26/35/44… not in fives. `null` means "use
   * min/increment/max".
   */
  readonly sizes: readonly number[] | null;
  /** Library tags that owning this item satisfies. */
  readonly satisfies: readonly LibraryEquipmentTag[];
  /**
   * Library slugs this item specifically provides.
   *
   * The library's `machine` tag is one word for thirty different machines. A
   * gym with a leg press and nothing else satisfies `machine`, which would make
   * `hack-squat` look available. `covers` is the refinement: a slug listed in
   * {@link SPECIFIC_EQUIPMENT} needs one of the items that covers it, not just
   * the tag. See `requirements.ts`.
   */
  readonly covers: readonly string[];
  /** True for cable handles — they gate nothing, they are a packing list. */
  readonly attachment: boolean;
  /** True when the item displays power, so watt-based work is possible on it. */
  readonly reportsPower: boolean;
  /** Search synonyms for the capture flow. */
  readonly aka: readonly string[];
  /** One line the UI can show under the label. */
  readonly note: string;
}

/**
 * Every equipment id.
 *
 * Grouped by zone in source order, which is also the order the walk-through
 * lists them in — commonest first inside each zone, so the first screenful is
 * the one most people just confirm.
 */
export type EquipmentId =
  // free weights
  | 'barbell_olympic'
  | 'barbell_training'
  | 'plates_standard'
  | 'plates_micro'
  | 'barbell_ez'
  | 'barbell_trap'
  | 'barbell_safety_squat'
  | 'barbell_cambered'
  | 'barbell_multi_grip'
  | 'barbell_tib'
  | 'landmine'
  | 'dumbbells_fixed'
  | 'dumbbells_adjustable'
  | 'kettlebells'
  | 'medicine_balls'
  | 'slam_balls'
  | 'neck_harness'
  | 'weight_vest'
  | 'dip_belt'
  // racks & benches
  | 'power_rack'
  | 'half_rack'
  | 'squat_stand'
  | 'bench_flat'
  | 'bench_adjustable'
  | 'bench_decline'
  | 'preacher_bench'
  | 'smith_machine'
  | 'nordic_bench'
  | 'ghd'
  | 'hyperextension_45'
  | 'reverse_hyper'
  | 'captains_chair'
  // cables
  | 'cable_crossover'
  | 'cable_column_single'
  | 'functional_trainer'
  | 'keiser_functional_trainer'
  | 'lat_pulldown_station'
  | 'seated_row_station'
  | 'attach_rope'
  | 'attach_straight_bar'
  | 'attach_lat_bar'
  | 'attach_v_handle'
  | 'attach_d_handles'
  | 'attach_ankle_strap'
  // machines
  | 'machine_chest_press'
  | 'machine_incline_press'
  | 'machine_pec_deck'
  | 'machine_rear_delt'
  | 'machine_shoulder_press'
  | 'machine_lateral_raise'
  | 'machine_row'
  | 'machine_pullover'
  | 'machine_assisted_dip_pullup'
  | 'machine_preacher_curl'
  | 'machine_triceps'
  | 'machine_leg_press'
  | 'machine_hack_squat'
  | 'machine_pendulum_squat'
  | 'machine_belt_squat'
  | 'machine_leg_extension'
  | 'machine_leg_curl_lying'
  | 'machine_leg_curl_seated'
  | 'machine_leg_curl_standing'
  | 'machine_adductor'
  | 'machine_abductor'
  | 'machine_calf_standing'
  | 'machine_calf_seated'
  | 'machine_sissy_squat'
  | 'machine_t_bar_row'
  | 'machine_generic'
  | 'hs_iso_chest_press'
  | 'hs_iso_incline_press'
  | 'hs_iso_row'
  | 'hs_iso_high_row'
  | 'hs_iso_shoulder_press'
  | 'hs_plate_leg_press'
  | 'keiser_air_chest_press'
  | 'keiser_air_row'
  | 'keiser_air_lat_pulldown'
  | 'keiser_air_shoulder_press'
  | 'keiser_air_leg_press'
  | 'keiser_air_leg_extension'
  | 'keiser_air_leg_curl'
  | 'keiser_air_hip'
  // sled & turf
  | 'sled_push'
  | 'sled_drag_harness'
  | 'turf_lane'
  | 'battle_ropes'
  | 'farmers_handles'
  | 'sandbag'
  // cardio
  | 'treadmill_motorized'
  | 'woodway_curve'
  | 'assault_runner'
  | 'technogym_skillmill'
  | 'bike_upright'
  | 'bike_spin'
  | 'keiser_m3_bike'
  | 'assault_air_bike'
  | 'concept2_bikeerg'
  | 'rower_generic'
  | 'concept2_rowerg'
  | 'concept2_skierg'
  | 'stair_climber'
  | 'elliptical'
  | 'arc_trainer'
  | 'pool'
  | 'jump_rope'
  // bodyweight & rig
  | 'floor_space'
  | 'wall_space'
  | 'pull_up_bar'
  | 'dip_station'
  | 'parallettes'
  | 'rings_suspension'
  | 'ab_wheel'
  | 'plyo_box'
  | 'bands_loop'
  | 'bands_mini'
  | 'bands_tube'
  | 'foam_roller'
  | 'yoga_mat';

/** Terse constructor so the table below stays readable. */
function item(
  id: EquipmentId,
  label: string,
  zone: EquipmentZone,
  loadUnit: LoadUnit,
  satisfies: readonly LibraryEquipmentTag[],
  extra: Partial<Omit<EquipmentItem, 'id' | 'label' | 'zone' | 'loadUnit' | 'satisfies'>> = {},
): EquipmentItem {
  return Object.freeze({
    id,
    label,
    zone,
    loadUnit,
    satisfies: Object.freeze([...satisfies]),
    brand: extra.brand ?? 'generic',
    increment: extra.increment ?? null,
    minLoad: extra.minLoad ?? null,
    maxLoad: extra.maxLoad ?? null,
    sizes: extra.sizes ? Object.freeze([...extra.sizes]) : null,
    covers: Object.freeze([...(extra.covers ?? [])]),
    attachment: extra.attachment ?? false,
    reportsPower: extra.reportsPower ?? false,
    aka: Object.freeze([...(extra.aka ?? [])]),
    note: extra.note ?? '',
  });
}

/**
 * The catalogue.
 *
 * Loads are in **pounds** throughout, because that is what the dial, the plate
 * and the pin read in a US gym — see the file header. Watts are watts.
 */
export const EQUIPMENT: readonly EquipmentItem[] = Object.freeze([
  // --- free weights --------------------------------------------------------
  item('barbell_olympic', 'Olympic barbell', 'free_weights', 'plates', ['barbell'], {
    increment: 5,
    minLoad: 45,
    aka: ['bar', '45 lb bar', 'straight bar'],
    note: 'Empty bar is 45 lb. Jumps are 5 lb — a pair of 2.5s.',
  }),
  item('barbell_training', 'Training / technique bar', 'free_weights', 'plates', ['barbell'], {
    increment: 5,
    minLoad: 15,
    aka: ['womens bar', 'light bar'],
    note: '15–35 lb. Matters for pressing when 45 lb is already the working weight.',
  }),
  item('plates_standard', 'Weight plates', 'free_weights', 'plates', ['plate'], {
    increment: 5,
    aka: ['bumpers', 'iron'],
    note: '2.5 lb up. A pair of 2.5s is the standard 5 lb jump.',
  }),
  item('plates_micro', 'Micro-plates', 'free_weights', 'plates', [], {
    increment: 1,
    aka: ['fractional plates', 'change plates', '1.25s'],
    note: '0.5–1.25 lb. These are what make a 1 lb jump on a press possible at all.',
  }),
  item('barbell_ez', 'EZ curl bar', 'free_weights', 'plates', ['ez_bar'], {
    increment: 5,
    minLoad: 20,
    aka: ['curl bar', 'w bar'],
  }),
  item('barbell_trap', 'Trap / hex bar', 'free_weights', 'plates', ['trap_bar'], {
    increment: 5,
    minLoad: 45,
    aka: ['hex bar', 'deadlift bar'],
  }),
  item('barbell_safety_squat', 'Safety squat bar', 'free_weights', 'plates', [], {
    increment: 5,
    minLoad: 60,
    aka: ['ssb', 'yoke bar'],
    note: 'Squatting without loading the shoulder into external rotation.',
  }),
  item('barbell_cambered', 'Cambered bar', 'free_weights', 'plates', [], {
    increment: 5,
    minLoad: 55,
  }),
  item('barbell_multi_grip', 'Multi-grip / football bar', 'free_weights', 'plates', [], {
    increment: 5,
    minLoad: 45,
    aka: ['swiss bar', 'football bar'],
    note: 'Neutral-grip pressing. Usually the shoulder-friendly option.',
  }),
  item('barbell_tib', 'Tib bar', 'free_weights', 'plates', ['tib_bar'], {
    increment: 5,
    minLoad: 10,
    covers: ['tib-bar-raise'],
    aka: ['tibialis bar', 'atg tib bar'],
  }),
  item('landmine', 'Landmine', 'free_weights', 'plates', ['landmine'], {
    increment: 5,
    aka: ['corner', 'viking attachment'],
    note: 'A sleeve, or a bar wedged in a corner. Either counts.',
  }),
  item('dumbbells_fixed', 'Dumbbell rack', 'free_weights', 'plates', ['dumbbell'], {
    increment: 5,
    minLoad: 5,
    maxLoad: 100,
    aka: ['dbs', 'dumbbells'],
    note: 'Set the real top of the rack — "dumbbells" with no ceiling cannot be programmed against.',
  }),
  item('dumbbells_adjustable', 'Adjustable dumbbells', 'free_weights', 'plates', ['dumbbell'], {
    increment: 5,
    minLoad: 5,
    maxLoad: 50,
    aka: ['powerblock', 'bowflex', 'spinlock'],
    note: 'Home sets usually stop at 50 lb. That ceiling shapes the whole program.',
  }),
  item('kettlebells', 'Kettlebells', 'free_weights', 'plates', ['kettlebell'], {
    sizes: [18, 26, 35, 44, 53, 62, 70],
    increment: 9,
    minLoad: 18,
    maxLoad: 70,
    note: 'Sized from kilos, so the pounds land at 18/26/35/44/53. Big jumps.',
  }),
  item('medicine_balls', 'Medicine balls', 'free_weights', 'plates', ['medicine_ball'], {
    increment: 2,
    minLoad: 4,
    maxLoad: 30,
  }),
  item('slam_balls', 'Slam balls', 'free_weights', 'plates', ['medicine_ball'], {
    increment: 5,
    minLoad: 10,
    maxLoad: 50,
    note: 'Dead-bounce. The one you can throw at the floor.',
  }),
  item('neck_harness', 'Neck harness', 'free_weights', 'plates', ['neck_harness'], {
    increment: 2.5,
    covers: ['neck-harness-extension'],
  }),
  item('weight_vest', 'Weight vest', 'free_weights', 'plates', [], {
    increment: 2.5,
    maxLoad: 40,
    note: 'Loads pull-ups, dips, carries and ruck walks.',
  }),
  item('dip_belt', 'Dip belt', 'free_weights', 'plates', [], {
    increment: 5,
    note: 'What makes weighted dips and weighted pull-ups a load progression.',
  }),

  // --- racks & benches -----------------------------------------------------
  item('power_rack', 'Power rack', 'racks_benches', 'none', [], {
    aka: ['cage', 'squat rack'],
    note: 'Safeties mean you can fail a squat alone. Tick the pull-up bar separately.',
  }),
  item('half_rack', 'Half rack', 'racks_benches', 'none', []),
  item('squat_stand', 'Squat stands', 'racks_benches', 'none', [], {
    note: 'No safeties — the generator keeps the top sets more conservative.',
  }),
  item('bench_flat', 'Flat bench', 'racks_benches', 'none', ['bench']),
  item('bench_adjustable', 'Adjustable bench', 'racks_benches', 'none', ['bench'], {
    aka: ['incline bench'],
    note: 'Incline pressing at ~30° needs this one specifically.',
  }),
  item('bench_decline', 'Decline bench', 'racks_benches', 'none', ['bench']),
  item('preacher_bench', 'Preacher bench', 'racks_benches', 'none', ['bench'], {
    covers: ['preacher-curl'],
  }),
  item('smith_machine', 'Smith machine', 'racks_benches', 'plates', ['smith_machine'], {
    increment: 5,
    covers: ['smith-machine-squat', 'smith-machine-incline-press'],
    note: 'Bar weight varies by make — counterbalanced ones can be near zero.',
  }),
  item('nordic_bench', 'Nordic bench', 'racks_benches', 'bodyweight', ['nordic_bench'], {
    covers: ['nordic-hamstring-curl', 'nordic-hamstring-curl-eccentric', 'assisted-nordic-curl'],
    aka: ['nordic curl pad'],
  }),
  item('ghd', 'Glute-ham developer', 'racks_benches', 'bodyweight', ['nordic_bench', 'machine'], {
    covers: [
      'glute-ham-raise',
      'nordic-hamstring-curl',
      'nordic-hamstring-curl-eccentric',
      'assisted-nordic-curl',
    ],
    aka: ['ghd', 'glute ham raise'],
  }),
  item('hyperextension_45', '45° back extension', 'racks_benches', 'bodyweight', ['machine'], {
    covers: ['45-degree-back-extension'],
    aka: ['roman chair', 'hyper bench'],
  }),
  item('reverse_hyper', 'Reverse hyper', 'racks_benches', 'plates', ['machine'], {
    increment: 5,
    covers: ['reverse-hyperextension'],
  }),
  item('captains_chair', "Captain's chair", 'racks_benches', 'bodyweight', ['machine'], {
    covers: ['captains-chair-knee-raise'],
    aka: ['knee raise station', 'vertical knee raise'],
  }),

  // --- cables --------------------------------------------------------------
  item('cable_crossover', 'Cable crossover', 'cables', 'stack_lb', ['cable'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
    aka: ['dual pulley', 'crossover'],
    note: 'Two adjustable columns. The most versatile thing in most gyms.',
  }),
  item('cable_column_single', 'Single cable column', 'cables', 'stack_lb', ['cable'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
  }),
  item('functional_trainer', 'Functional trainer', 'cables', 'stack_lb', ['cable'], {
    increment: 5,
    minLoad: 5,
    maxLoad: 200,
    note: 'Usually 2:1, so the pin number is not the load at the handle.',
  }),
  item(
    'keiser_functional_trainer',
    'Keiser Functional Trainer',
    'cables',
    'pneumatic_lb',
    ['cable'],
    {
      brand: 'keiser',
      increment: 1,
      minLoad: 0,
      maxLoad: 300,
      reportsPower: true,
      aka: ['keiser performance trainer', 'keiser cable'],
      note: 'Air, not plates: 1 lb steps, adjustable mid-set, and it reads power in watts. Log the watts — that is the number that tracks the VO2 goal.',
    },
  ),
  item('lat_pulldown_station', 'Lat pulldown', 'cables', 'stack_lb', ['cable', 'machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['lat-pulldown', 'neutral-grip-lat-pulldown'],
  }),
  item('seated_row_station', 'Seated cable row', 'cables', 'stack_lb', ['cable', 'machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['seated-cable-row'],
  }),
  item('attach_rope', 'Rope', 'cables', 'none', [], { attachment: true }),
  item('attach_straight_bar', 'Straight bar', 'cables', 'none', [], { attachment: true }),
  item('attach_lat_bar', 'Wide lat bar', 'cables', 'none', [], { attachment: true }),
  item('attach_v_handle', 'V-handle', 'cables', 'none', [], {
    attachment: true,
    aka: ['close grip handle'],
  }),
  item('attach_d_handles', 'Single D-handles', 'cables', 'none', [], {
    attachment: true,
    note: 'A pair. Unilateral cable work needs these.',
  }),
  item('attach_ankle_strap', 'Ankle strap', 'cables', 'none', [], {
    attachment: true,
    covers: ['standing-single-leg-curl'],
  }),

  // --- machines ------------------------------------------------------------
  item('machine_chest_press', 'Chest press', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['machine-chest-press'],
  }),
  item('machine_incline_press', 'Incline press machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['incline-machine-press'],
  }),
  item('machine_pec_deck', 'Pec deck', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
    covers: ['pec-deck'],
    aka: ['chest fly machine'],
  }),
  item('machine_rear_delt', 'Reverse pec deck', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
    covers: ['reverse-pec-deck'],
    aka: ['rear delt machine'],
  }),
  item('machine_shoulder_press', 'Shoulder press machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
    covers: ['machine-shoulder-press'],
  }),
  item('machine_lateral_raise', 'Lateral raise machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 150,
    covers: ['machine-lateral-raise'],
  }),
  item('machine_row', 'Chest-supported row machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['machine-row', 'chest-supported-row'],
  }),
  item('machine_pullover', 'Pullover machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
    covers: ['machine-pullover'],
    note: 'Rare, and one of the few machines that loads the lats in a stretch.',
  }),
  item(
    'machine_assisted_dip_pullup',
    'Assisted dip / pull-up',
    'machines',
    'stack_lb',
    ['machine'],
    {
      increment: 10,
      minLoad: 10,
      maxLoad: 200,
      covers: ['assisted-dip', 'assisted-pull-up'],
      note: 'The stack number is assistance — more is easier. The logger inverts it.',
    },
  ),
  item('machine_preacher_curl', 'Preacher curl machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 150,
    covers: ['preacher-curl'],
  }),
  item('machine_triceps', 'Triceps extension machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
  }),
  item('machine_leg_press', 'Leg press', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 20,
    maxLoad: 400,
    covers: ['leg-press', 'leg-press-calf-raise'],
  }),
  item('machine_hack_squat', 'Hack squat', 'machines', 'plates', ['machine'], {
    increment: 5,
    covers: ['hack-squat'],
    note: 'Plate-loaded on a sled. Carriage weight is not zero — record it once.',
  }),
  item('machine_pendulum_squat', 'Pendulum squat', 'machines', 'plates', ['machine'], {
    increment: 5,
    covers: ['pendulum-squat'],
  }),
  item('machine_belt_squat', 'Belt squat', 'machines', 'plates', ['machine'], {
    increment: 5,
    covers: ['belt-squat'],
    note: 'Loads the legs with nothing on the spine. Good on a heavy-hip week.',
  }),
  item('machine_leg_extension', 'Leg extension', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['leg-extension'],
  }),
  item('machine_leg_curl_lying', 'Lying leg curl', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 200,
    covers: ['lying-leg-curl'],
  }),
  item('machine_leg_curl_seated', 'Seated leg curl', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['seated-leg-curl'],
  }),
  item('machine_leg_curl_standing', 'Standing leg curl', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 150,
    covers: ['standing-single-leg-curl'],
  }),
  item('machine_adductor', 'Adductor machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['adductor-machine'],
    aka: ['inner thigh'],
  }),
  item('machine_abductor', 'Abductor machine', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    covers: ['abductor-machine'],
    aka: ['outer thigh', 'hip abduction'],
  }),
  item('machine_calf_standing', 'Standing calf raise', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 20,
    maxLoad: 400,
    covers: ['standing-calf-raise'],
  }),
  item('machine_calf_seated', 'Seated calf raise', 'machines', 'plates', ['machine'], {
    increment: 5,
    covers: ['seated-calf-raise'],
    note: 'Bent knee, so it is the soleus. Not a substitute for the standing one.',
  }),
  item('machine_sissy_squat', 'Sissy squat bench', 'machines', 'bodyweight', ['machine'], {
    covers: ['sissy-squat'],
  }),
  item('machine_t_bar_row', 'T-bar row', 'machines', 'plates', ['machine'], {
    increment: 5,
    covers: ['t-bar-row'],
  }),
  item('machine_generic', 'Other machines', 'machines', 'stack_lb', ['machine'], {
    increment: 10,
    minLoad: 10,
    maxLoad: 250,
    note: 'The catch-all. Tick this if the gym has a full machine circuit you have not itemised — it stops movements being hidden just because you did not list the machine by name.',
  }),

  item('hs_iso_chest_press', 'Hammer Strength chest press', 'machines', 'plates', ['machine'], {
    brand: 'hammer_strength',
    increment: 5,
    covers: ['machine-chest-press'],
    aka: ['iso-lateral chest press'],
    note: 'Plate-loaded and independent arms, so load each side honestly.',
  }),
  item('hs_iso_incline_press', 'Hammer Strength incline press', 'machines', 'plates', ['machine'], {
    brand: 'hammer_strength',
    increment: 5,
    covers: ['incline-machine-press'],
  }),
  item('hs_iso_row', 'Hammer Strength row', 'machines', 'plates', ['machine'], {
    brand: 'hammer_strength',
    increment: 5,
    covers: ['machine-row', 'chest-supported-row'],
    aka: ['iso-lateral row'],
  }),
  item('hs_iso_high_row', 'Hammer Strength high row', 'machines', 'plates', ['machine'], {
    brand: 'hammer_strength',
    increment: 5,
    covers: ['machine-row'],
    note: 'A lat movement rather than a mid-back one, despite the name.',
  }),
  item('hs_iso_shoulder_press', 'Hammer Strength shoulder press', 'machines', 'plates', [
    'machine',
  ], {
    brand: 'hammer_strength',
    increment: 5,
    covers: ['machine-shoulder-press'],
  }),
  item('hs_plate_leg_press', 'Plate-loaded leg press', 'machines', 'plates', ['machine'], {
    brand: 'hammer_strength',
    increment: 5,
    covers: ['leg-press', 'leg-press-calf-raise'],
    note: 'The 45° sled. Carriage weight is typically 75–125 lb before any plates.',
  }),

  item('keiser_air_chest_press', 'Keiser chest press', 'machines', 'pneumatic_lb', ['machine'], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 300,
    reportsPower: true,
    covers: ['machine-chest-press'],
    note: 'Air pressure in pounds, 1 lb steps, changeable mid-rep. Not comparable to the same number on a stack.',
  }),
  item('keiser_air_row', 'Keiser row', 'machines', 'pneumatic_lb', ['machine'], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 300,
    reportsPower: true,
    covers: ['machine-row', 'chest-supported-row'],
  }),
  item('keiser_air_lat_pulldown', 'Keiser lat pulldown', 'machines', 'pneumatic_lb', [
    'machine',
    'cable',
  ], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 300,
    reportsPower: true,
    covers: ['lat-pulldown', 'neutral-grip-lat-pulldown'],
  }),
  item('keiser_air_shoulder_press', 'Keiser shoulder press', 'machines', 'pneumatic_lb', [
    'machine',
  ], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 250,
    reportsPower: true,
    covers: ['machine-shoulder-press'],
  }),
  item('keiser_air_leg_press', 'Keiser leg press', 'machines', 'pneumatic_lb', ['machine'], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 600,
    reportsPower: true,
    covers: ['leg-press', 'leg-press-calf-raise'],
    note: 'The one that makes real power testing possible on a lower-body press.',
  }),
  item('keiser_air_leg_extension', 'Keiser leg extension', 'machines', 'pneumatic_lb', ['machine'], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 250,
    reportsPower: true,
    covers: ['leg-extension'],
  }),
  item('keiser_air_leg_curl', 'Keiser leg curl', 'machines', 'pneumatic_lb', ['machine'], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 250,
    reportsPower: true,
    covers: ['seated-leg-curl', 'lying-leg-curl'],
  }),
  item('keiser_air_hip', 'Keiser hip abduction / adduction', 'machines', 'pneumatic_lb', [
    'machine',
  ], {
    brand: 'keiser',
    increment: 1,
    minLoad: 0,
    maxLoad: 250,
    reportsPower: true,
    covers: ['abductor-machine', 'adductor-machine'],
    note: 'Pneumatic resistance can be useful for controlled hip work.',
  }),

  // --- sled & turf ---------------------------------------------------------
  item('sled_push', 'Sled / prowler', 'sled_turf', 'plates', ['sled'], {
    increment: 5,
    covers: ['sled-push-forward', 'sled-drag-backward'],
    aka: ['prowler', 'push sled'],
    note: 'Sled weight itself is 50–90 lb before a plate goes on. Plates load one at a time, so the real step is one plate.',
  }),
  item('sled_drag_harness', 'Drag harness / strap', 'sled_turf', 'plates', ['sled'], {
    increment: 5,
    covers: ['sled-drag-backward'],
  }),
  item('turf_lane', 'Turf lane', 'sled_turf', 'none', [], {
    note: 'Set the length — sled work is prescribed in yards, and a 15 yd lane and a 40 yd lane are different sessions.',
  }),
  item('battle_ropes', 'Battle ropes', 'sled_turf', 'none', []),
  item('farmers_handles', "Farmer's handles", 'sled_turf', 'plates', [], { increment: 5 }),
  item('sandbag', 'Sandbag', 'sled_turf', 'plates', [], { increment: 10 }),

  // --- cardio --------------------------------------------------------------
  item('treadmill_motorized', 'Treadmill', 'cardio', 'none', ['treadmill'], {
    covers: ['zone2-incline-walk', 'vo2max-intervals-run', 'backward-walk-treadmill'],
    note: 'Check it inclines to 12–15% — the Zone 2 incline walk depends on it.',
  }),
  item('woodway_curve', 'Woodway Curve', 'cardio', 'none', ['treadmill'], {
    brand: 'woodway',
    covers: ['vo2max-intervals-run', 'zone2-incline-walk'],
    note: 'Curved, motorless, self-paced. Slatted belt is much kinder to the knee than a motorised deck.',
  }),
  item('assault_runner', 'Assault Runner', 'cardio', 'none', ['treadmill'], {
    brand: 'assault',
    covers: ['vo2max-intervals-run'],
  }),
  item('technogym_skillmill', 'Technogym Skillmill', 'cardio', 'watts', ['treadmill'], {
    brand: 'technogym',
    increment: 5,
    reportsPower: true,
    covers: ['vo2max-intervals-run', 'sled-push-forward'],
    note: 'Curved and it reads watts. Its sled mode is a real substitute when there is no turf.',
  }),
  item('bike_upright', 'Upright / recumbent bike', 'cardio', 'none', ['bike'], {
    covers: ['zone2-cycling'],
  }),
  item('bike_spin', 'Spin bike', 'cardio', 'none', ['bike'], { covers: ['zone2-cycling'] }),
  item('keiser_m3_bike', 'Keiser M3 bike', 'cardio', 'watts', ['bike'], {
    brand: 'keiser',
    increment: 5,
    reportsPower: true,
    covers: ['zone2-cycling', 'assault-bike-intervals'],
    note: 'Displays watts directly. Prescribe Zone 2 as a watt band, not a gear — the gear drifts with cadence, the watts do not.',
  }),
  item('assault_air_bike', 'Assault / Echo bike', 'cardio', 'watts', ['bike'], {
    brand: 'assault',
    increment: 5,
    reportsPower: true,
    covers: ['assault-bike-intervals', 'zone2-cycling'],
    note: 'Fan resistance rises with the cube of speed, so watts is the only stable target.',
  }),
  item('concept2_bikeerg', 'Concept2 BikeErg', 'cardio', 'watts', ['bike'], {
    brand: 'concept2',
    increment: 5,
    reportsPower: true,
    covers: ['zone2-cycling', 'assault-bike-intervals'],
  }),
  item('rower_generic', 'Rowing machine', 'cardio', 'none', ['rower'], {
    covers: ['zone2-row', 'rower-intervals'],
  }),
  item('concept2_rowerg', 'Concept2 RowErg', 'cardio', 'watts', ['rower'], {
    brand: 'concept2',
    increment: 5,
    reportsPower: true,
    covers: ['zone2-row', 'rower-intervals'],
    note: 'The reference erg. Pace and watts are the same number in different clothes; log watts.',
  }),
  item('concept2_skierg', 'Concept2 SkiErg', 'cardio', 'watts', [], {
    brand: 'concept2',
    increment: 5,
    reportsPower: true,
    note: 'No library movement uses it yet — captured so a session on it is loggable.',
  }),
  item('stair_climber', 'Stair climber', 'cardio', 'none', ['stair_climber'], {
    covers: ['zone2-stair-climber'],
    aka: ['stairmaster', 'stepmill'],
  }),
  item('elliptical', 'Elliptical', 'cardio', 'none', []),
  item('arc_trainer', 'Arc trainer', 'cardio', 'none', [], { brand: 'cybex' }),
  item('pool', 'Pool', 'cardio', 'none', ['pool'], { covers: ['zone2-swim'] }),
  item('jump_rope', 'Jump rope', 'cardio', 'none', ['jump_rope'], { covers: ['jump-rope'] }),

  // --- bodyweight & rig ----------------------------------------------------
  item('floor_space', 'Floor space', 'bodyweight_rig', 'bodyweight', ['bodyweight'], {
    note: 'Always on. Every profile has it, including the hotel one.',
  }),
  item('wall_space', 'Clear wall', 'bodyweight_rig', 'none', ['wall'], {
    covers: ['wall-sit', 'wall-slide', 'handstand-push-up', 'tibialis-raise'],
  }),
  item('pull_up_bar', 'Pull-up bar', 'bodyweight_rig', 'bodyweight', ['pull_up_bar'], {
    note: 'Rack-mounted, doorway or standalone — all count.',
  }),
  item('dip_station', 'Dip bars', 'bodyweight_rig', 'bodyweight', ['dip_bar'], {
    covers: ['chest-dip', 'triceps-dip', 'weighted-dip', 'l-sit'],
  }),
  item('parallettes', 'Parallettes', 'bodyweight_rig', 'bodyweight', ['dip_bar'], {
    covers: ['l-sit'],
    note: 'Travels. Covers L-sits and floor dips in a hotel room.',
  }),
  item('rings_suspension', 'Rings / suspension trainer', 'bodyweight_rig', 'bodyweight', ['rings'], {
    covers: ['inverted-row'],
    aka: ['trx', 'gymnastic rings'],
  }),
  item('ab_wheel', 'Ab wheel', 'bodyweight_rig', 'bodyweight', ['ab_wheel'], {
    covers: ['ab-wheel-rollout'],
  }),
  item('plyo_box', 'Box / step', 'bodyweight_rig', 'none', ['box'], {
    aka: ['plyo box', 'step'],
    note: 'Also the elevation for split squats, step-ups and Patrick steps.',
  }),
  item('bands_loop', 'Loop bands', 'bodyweight_rig', 'band', ['band'], {
    aka: ['power bands', 'pull-up bands'],
    note: 'The big continuous loops. Assistance, and load where nothing else travels.',
  }),
  item('bands_mini', 'Mini bands', 'bodyweight_rig', 'band', ['band'], {
    note: 'Hip and cuff work. Cheap prehab that fits in a pocket.',
  }),
  item('bands_tube', 'Tube bands with handles', 'bodyweight_rig', 'band', ['band'], {
    covers: ['face-pull', 'pallof-press', 'cable-external-rotation'],
    note: 'With a door anchor these stand in for a cable column on the road.',
  }),
  item('foam_roller', 'Foam roller', 'bodyweight_rig', 'none', ['foam_roller'], {
    covers: ['thoracic-extension-foam-roll'],
  }),
  item('yoga_mat', 'Mat', 'bodyweight_rig', 'none', []),
] as const);

/** Every id, in catalogue order. */
export const EQUIPMENT_IDS: readonly EquipmentId[] = Object.freeze(
  EQUIPMENT.map((e) => e.id),
);

const BY_ID: ReadonlyMap<EquipmentId, EquipmentItem> = new Map(
  EQUIPMENT.map((e) => [e.id, e]),
);

/**
 * Look one item up.
 *
 * @param id the equipment id
 * @returns the item, or `null` for an id this build does not know — a profile
 *   written by a newer version must degrade, not throw.
 */
export function equipmentById(id: string): EquipmentItem | null {
  return BY_ID.get(id as EquipmentId) ?? null;
}

/** Whether a string is a known equipment id. */
export function isEquipmentId(id: string): id is EquipmentId {
  return BY_ID.has(id as EquipmentId);
}

/** The items in one zone, in catalogue order. */
export function itemsInZone(zone: EquipmentZone): readonly EquipmentItem[] {
  return EQUIPMENT.filter((e) => e.zone === zone);
}

const BY_TAG: ReadonlyMap<LibraryEquipmentTag, readonly EquipmentItem[]> = (() => {
  const map = new Map<LibraryEquipmentTag, EquipmentItem[]>();
  for (const tag of LIBRARY_EQUIPMENT_TAGS) map.set(tag, []);
  for (const e of EQUIPMENT) {
    for (const tag of e.satisfies) map.get(tag)?.push(e);
  }
  return map;
})();

/**
 * Every item that satisfies a library tag.
 *
 * The inverse of `EquipmentItem.satisfies`. Used to answer "you'd need one of
 * these" in {@link import('./profiles').whyUnavailable}.
 *
 * @param tag a library equipment tag
 * @returns the items, possibly empty (never for a tag in the shipped library —
 *   a test enforces that)
 */
export function itemsSatisfying(tag: LibraryEquipmentTag): readonly EquipmentItem[] {
  return BY_TAG.get(tag) ?? [];
}

/**
 * Slugs that have at least one item claiming to specifically provide them.
 *
 * A slug in this set is checked against `covers` as well as against its tags —
 * see `requirements.ts` for why the coarse `machine` tag is not enough on its
 * own.
 */
export const SPECIFIC_EQUIPMENT: ReadonlyMap<string, readonly EquipmentId[]> = (() => {
  const map = new Map<string, EquipmentId[]>();
  for (const e of EQUIPMENT) {
    for (const slug of e.covers) {
      const list = map.get(slug);
      if (list) list.push(e.id);
      else map.set(slug, [e.id]);
    }
  }
  return map;
})();

/**
 * The universal fallback.
 *
 * A profile holding this satisfies every `covers` refinement. It is the honest
 * representation of "this is a full commercial gym and I am not going to tick
 * thirty boxes" — without it, being thorough would be punished by having
 * movements disappear.
 */
export const GENERIC_MACHINE: EquipmentId = 'machine_generic';

// ---------------------------------------------------------------------------
// Load prescription
// ---------------------------------------------------------------------------

/**
 * What a set on a specific piece of equipment can be loaded to.
 *
 * This is the object the workout generator prescribes against and the set
 * logger renders its keypad from. It is deliberately concrete: not "add 5 lb"
 * but "the achievable loads are these".
 */
export interface LoadPrescription {
  readonly equipmentId: EquipmentId;
  readonly label: string;
  readonly unit: LoadUnit;
  /** Suffix to render after the number: `lb`, `W`, or empty. */
  readonly suffix: string;
  /** Smallest achievable step, in the unit's own scale. */
  readonly increment: number | null;
  readonly minLoad: number | null;
  readonly maxLoad: number | null;
  /** Explicit achievable loads where they are not an arithmetic series. */
  readonly sizes: readonly number[] | null;
  /** True when the item can report power, so a watt target is loggable. */
  readonly reportsPower: boolean;
}

/**
 * Build a prescription from an item plus any per-profile overrides.
 *
 * @param item the equipment
 * @param override optional per-gym facts — this rack really does stop at 75 lb
 * @returns the prescription
 */
export function prescriptionFor(
  item: EquipmentItem,
  override: {
    increment?: number | null;
    minLoad?: number | null;
    maxLoad?: number | null;
    sizes?: readonly number[] | null;
  } = {},
): LoadPrescription {
  return {
    equipmentId: item.id,
    label: item.label,
    unit: item.loadUnit,
    suffix: loadUnitSuffix(item.loadUnit),
    increment: override.increment ?? item.increment,
    minLoad: override.minLoad ?? item.minLoad,
    maxLoad: override.maxLoad ?? item.maxLoad,
    sizes: override.sizes ?? item.sizes,
    reportsPower: item.reportsPower,
  };
}

/**
 * The nearest load this equipment can actually be set to.
 *
 * The generator works in continuous numbers — "82.5% of a 240 lb press" — and
 * the gym does not. Prescribing 198 lb on a 10 lb stack is a prescription the
 * user cannot follow, so it gets snapped here, once, at the boundary.
 *
 * Ties round **down**: overshooting a target load costs a rep, undershooting
 * costs almost nothing.
 *
 * @param p the prescription
 * @param desired the load the algorithm wants, in the prescription's own unit
 * @returns the achievable load, or `null` when the unit has no scalar loads
 */
export function snapLoad(p: LoadPrescription, desired: number): number | null {
  if (p.unit === 'bodyweight' || p.unit === 'band' || p.unit === 'none') return null;
  if (!Number.isFinite(desired)) return null;

  if (p.sizes && p.sizes.length > 0) {
    let best = p.sizes[0];
    let bestGap = Math.abs(best - desired);
    for (const size of p.sizes) {
      const gap = Math.abs(size - desired);
      // `<` not `<=`, so an exact tie keeps the earlier — i.e. lighter — size.
      if (gap < bestGap) {
        best = size;
        bestGap = gap;
      }
    }
    return best;
  }

  const step = p.increment ?? 1;
  const floor = p.minLoad ?? 0;
  // `-Math.round(-x)` rounds a .5 tie **down**, where `Math.round` rounds up.
  const steps = -Math.round(-(desired - floor) / step);
  const stepped = floor + steps * step;
  // Guard against float dust: 47.500000000000004 must render as 47.5.
  const clean = Math.round(stepped * 1000) / 1000;
  const lowerBounded = p.minLoad === null ? clean : Math.max(p.minLoad, clean);
  return p.maxLoad === null ? lowerBounded : Math.min(p.maxLoad, lowerBounded);
}

/**
 * Every load this equipment offers, lightest first.
 *
 * Bounded to `limit` entries so an unbounded item cannot generate a
 * million-element array behind a picker.
 *
 * @param p the prescription
 * @param limit maximum entries. Default 200.
 * @returns the achievable loads, or an empty array for a non-scalar unit
 */
export function loadOptions(p: LoadPrescription, limit = 200): readonly number[] {
  if (p.sizes && p.sizes.length > 0) return [...p.sizes].sort((a, b) => a - b);
  if (p.unit === 'bodyweight' || p.unit === 'band' || p.unit === 'none') return [];
  const step = p.increment;
  if (step === null || step <= 0) return [];
  const from = p.minLoad ?? step;
  const to = p.maxLoad ?? from + step * (limit - 1);
  const out: number[] = [];
  for (let load = from; load <= to + 1e-9 && out.length < limit; load += step) {
    out.push(Math.round(load * 1000) / 1000);
  }
  return out;
}

/**
 * A load as it was actually performed, carrying its own unit.
 *
 * The unit travels with the number because it is part of the datum: 150 on a
 * Keiser and 150 on a stack are not the same set, and 220 on a rower is not a
 * weight at all. `AGENTS.md` requires SI storage, and
 * {@link loadToWeightKg} is the one place that conversion happens — for the
 * three pound-denominated units only, and never for watts.
 */
export interface PerformedLoad {
  readonly unit: LoadUnit;
  readonly value: number;
  readonly equipmentId: EquipmentId | null;
}

/**
 * The SI weight to write into `WorkoutSet.weightKg`.
 *
 * @param load what was performed
 * @returns kilograms for a pound-denominated load, `null` for watts, bands,
 *   bodyweight and unloaded work — where a kilogram figure would be a lie
 *   rather than a conversion
 */
export function loadToWeightKg(load: PerformedLoad): number | null {
  if (!isPoundDenominated(load.unit)) return null;
  // 0.45359237 kg/lb, exact by definition. Deliberately not imported from
  // `@/lib/units` — this module is relative-import-only so it unit-tests
  // standalone, and the constant is exact, not a tuning parameter.
  return load.value * 0.45359237;
}

/**
 * How a performed load reads on screen.
 *
 * @param load what was performed
 * @returns e.g. `"150 lb"`, `"212 W"`, `"bodyweight"`, `"band"`
 */
export function formatPerformedLoad(load: PerformedLoad): string {
  switch (load.unit) {
    case 'bodyweight':
      return 'bodyweight';
    case 'band':
      return 'band';
    case 'none':
      return '—';
    default: {
      const n = Math.round(load.value * 10) / 10;
      return `${n} ${loadUnitSuffix(load.unit)}`.trim();
    }
  }
}
