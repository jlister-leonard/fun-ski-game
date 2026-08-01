/**
 * @file What a movement actually needs, resolved from the library's tags.
 *
 * ## The problem this file solves
 *
 * `exercise-library.json` gives each movement a flat `equipment` array. The
 * array means different things in different entries:
 *
 * ```
 * barbell-bench-press  ["barbell", "bench"]              a bar AND a bench
 * upright-row          ["barbell", "ez_bar", "cable"]    any ONE of the three
 * assisted-pull-up     ["machine", "band"]               a machine, OR a bar and a band
 * atg-split-squat      ["dumbbell", "box", "bodyweight"] a box; the dumbbell is optional
 * ```
 *
 * Reading it as a conjunction makes 20-odd movements silently unavailable —
 * exactly the failure the brief warns about. Reading it as a disjunction makes
 * `barbell-bench-press` available to anyone who owns a bench. Neither is
 * acceptable, so requirements are resolved in two steps:
 *
 * 1. **A structural default.** Tags are classified as *stations* (a thing you
 *    need to be standing at) or *loads* (a thing that makes it heavy). A
 *    movement needs every station it lists, plus at least one of its loads.
 *    That single rule gets ~190 of the 220 right, including every AND case and
 *    every "any one of these implements" case.
 * 2. **{@link REQUIREMENT_OVERRIDES}** for the rest, each with the reason it
 *    is there. There are 28. They are the movements where two *stations* are
 *    alternatives to one another (a lat pulldown is a machine or a cable, not
 *    both) and the movements where the listed load is genuinely optional (a
 *    bodyweight walking lunge is a walking lunge).
 *
 * ## Why `machine` needs a second pass
 *
 * `machine` is one tag for thirty different machines. A gym with a leg press
 * and nothing else satisfies it, which would put `hack-squat` on the card. So
 * a movement whose requirement is met *through the `machine` tag* must also be
 * met by a specific item that claims to cover it — or by
 * {@link GENERIC_MACHINE}, the "yes, it's a full commercial gym" fallback.
 *
 * Crucially the check is per-alternative, not per-movement: `preacher-curl`
 * can be satisfied by the machine group *or* by bench + dumbbells, and failing
 * the machine refinement must fall through to the second route rather than
 * failing the movement.
 *
 * Pure. No I/O, no React, no vault.
 */

import { EXERCISE_LIBRARY } from '../training/library';
import type { LibraryExercise } from '../training/types';
import {
  GENERIC_MACHINE,
  SPECIFIC_EQUIPMENT,
  type EquipmentId,
  type LibraryEquipmentTag,
} from './equipment';

/** Tags that must **all** be present. AND within a group. */
export type TagGroup = readonly LibraryEquipmentTag[];

/**
 * The resolved requirement for one movement.
 *
 * `alternatives` is an OR of ANDs: the movement is possible if every tag in at
 * least one group is available.
 */
export interface ExerciseRequirement {
  readonly slug: string;
  readonly alternatives: readonly TagGroup[];
  /** Items claiming to specifically provide this movement. Empty if none do. */
  readonly specific: readonly EquipmentId[];
}

/**
 * Tags naming a fixture you stand at, lie on, or step onto.
 *
 * A movement needs **all** of these that it lists. `bodyweight` is here rather
 * than with the loads because it is not an alternative to a dumbbell — it is
 * the statement "this is a bodyweight movement", and it is always available.
 */
const STATION_TAGS: ReadonlySet<LibraryEquipmentTag> = new Set([
  'ab_wheel',
  'bench',
  'bike',
  'bodyweight',
  'box',
  'dip_bar',
  'foam_roller',
  'jump_rope',
  'landmine',
  'machine',
  'neck_harness',
  'nordic_bench',
  'pool',
  'pull_up_bar',
  'rings',
  'rower',
  'sled',
  'smith_machine',
  'stair_climber',
  'tib_bar',
  'treadmill',
  'wall',
]);

/**
 * Tags naming something that supplies resistance.
 *
 * A movement needs **one** of these. `cable` is a load rather than a station
 * because in every entry that pairs it with a real fixture it is the implement
 * — `seated-cable-fly` is a bench plus a cable, and `face-pull` is a cable or
 * a band.
 */
const LOAD_TAGS: ReadonlySet<LibraryEquipmentTag> = new Set([
  'band',
  'barbell',
  'cable',
  'dumbbell',
  'ez_bar',
  'kettlebell',
  'medicine_ball',
  'plate',
  'trap_bar',
]);

/**
 * The 28 movements the structural default gets wrong, and why.
 *
 * Two kinds. **Alternative stations** — the library lists two fixtures that
 * are routes to the same movement, not both needed. **Optional load** — the
 * library lists an implement for the loaded version of a movement that is
 * perfectly real without it; without these the travel profile loses most of
 * its lower body, and a hotel session that comes back empty is the one
 * outcome this whole feature exists to prevent.
 */
export const REQUIREMENT_OVERRIDES: Readonly<Record<string, readonly TagGroup[]>> =
  Object.freeze({
    // --- alternative stations ---------------------------------------------
    /** The machine, or a dip station with a band looped under the knee. */
    'assisted-dip': [['machine'], ['dip_bar', 'band']],
    /** Same, on a bar. */
    'assisted-pull-up': [['machine'], ['pull_up_bar', 'band']],
    /** A pulldown station is a machine or a cable column — one apparatus, two words. */
    'lat-pulldown': [['machine'], ['cable']],
    'neutral-grip-lat-pulldown': [['machine'], ['cable']],
    'seated-cable-row': [['machine'], ['cable']],
    /** A row machine, or dumbbells on an incline bench. */
    'chest-supported-row': [['machine'], ['dumbbell', 'bench']],
    /** A dedicated T-bar, or a bar in a landmine. */
    't-bar-row': [['machine'], ['landmine', 'barbell']],
    /** A curl machine, or a preacher bench with either bar. */
    'preacher-curl': [['machine'], ['bench', 'ez_bar'], ['bench', 'dumbbell']],
    /** The bench makes it easier, the floor and a rack upright do not stop it. */
    'sissy-squat': [['machine'], ['bodyweight']],
    /** The machine, or a dumbbell in one hand. */
    'standing-calf-raise': [['machine'], ['dumbbell']],
    /** The machine, or a cable with an ankle strap. */
    'standing-single-leg-curl': [['machine'], ['cable']],
    /** Rings, or a bar set low in a rack. */
    'inverted-row': [['rings'], ['barbell']],
    /** A treadmill makes intervals precise; a road makes them possible. */
    'vo2max-intervals-run': [['treadmill'], ['bodyweight']],
    /** Parallel bars, or the floor. */
    'l-sit': [['dip_bar'], ['bodyweight']],
    /** A wall or a bench — whichever the room has. */
    'couch-stretch': [['wall'], ['bench']],

    // --- optional load ------------------------------------------------------
    /** All of these are complete movements with nothing in the hands. */
    'split-squat': [['bodyweight']],
    'walking-lunge': [['bodyweight']],
    'reverse-lunge': [['bodyweight']],
    'lateral-lunge': [['bodyweight']],
    'cossack-squat': [['bodyweight']],
    'single-leg-calf-raise': [['bodyweight']],
    'neck-isometric-hold': [['bodyweight']],
    'russian-twist': [['bodyweight']],
    /** These need their fixture; the implement is the loaded version. */
    'atg-split-squat': [['box']],
    'poliquin-step-up': [['box']],
    'step-up': [['box']],
    'knees-over-toes-calf-raise': [['box', 'bodyweight']],
    'bulgarian-split-squat': [['bench']],
    'single-leg-hip-thrust': [['bench']],
  } as const);

/** Build the structural default for one entry. */
function derive(exercise: LibraryExercise): readonly TagGroup[] {
  const tags = exercise.equipment as readonly LibraryEquipmentTag[];
  const stations = tags.filter((t) => STATION_TAGS.has(t));
  const loads = tags.filter((t) => LOAD_TAGS.has(t));

  if (loads.length === 0) return [Object.freeze([...stations])];
  return Object.freeze(
    loads.map((load) => Object.freeze([...stations, load]) as TagGroup),
  );
}

const CACHE = new Map<string, ExerciseRequirement | null>();

/**
 * What a movement needs.
 *
 * @param slug a library slug
 * @returns the requirement, or `null` for a slug outside the bundled library —
 *   a user-created movement has no equipment model and is treated as always
 *   available by {@link import('./profiles').availableExercises}
 */
export function requirementFor(slug: string): ExerciseRequirement | null {
  const cached = CACHE.get(slug);
  if (cached !== undefined) return cached;

  const exercise = EXERCISE_LIBRARY.find((e) => e.slug === slug) ?? null;
  if (exercise === null) {
    CACHE.set(slug, null);
    return null;
  }

  const override = REQUIREMENT_OVERRIDES[slug];
  const requirement: ExerciseRequirement = Object.freeze({
    slug,
    alternatives: override ?? derive(exercise),
    specific: SPECIFIC_EQUIPMENT.get(slug) ?? [],
  });
  CACHE.set(slug, requirement);
  return requirement;
}

/** Every requirement, one per library entry. Used by the coverage tests. */
export function allRequirements(): readonly ExerciseRequirement[] {
  return EXERCISE_LIBRARY.map((e) => requirementFor(e.slug)).filter(
    (r): r is ExerciseRequirement => r !== null,
  );
}

/**
 * How a movement's requirement is met — or why it is not.
 *
 * `satisfiedBy` is the group that worked, so the UI can say *which* route is
 * open ("cable version") rather than just "available".
 */
export interface RequirementCheck {
  readonly ok: boolean;
  readonly satisfiedBy: TagGroup | null;
  /**
   * The tags missing from the *closest* group — the one needing fewest
   * additions. Empty when the block was the machine refinement rather than a
   * missing tag.
   */
  readonly missingTags: readonly LibraryEquipmentTag[];
  /**
   * True when every tag was available but no specific machine covered it.
   * The difference matters: "you have no machines" and "your gym has no hack
   * squat" are different sentences.
   */
  readonly blockedOnSpecificMachine: boolean;
}

/**
 * Test a requirement against what a gym has.
 *
 * The machine refinement is applied **per alternative**, not to the movement
 * as a whole — see the file header. A group that mentions `machine` and has no
 * covering item falls through to the next group instead of failing outright.
 *
 * @param requirement from {@link requirementFor}
 * @param hasTag whether the gym satisfies a library tag
 * @param hasEquipment whether the gym holds a specific item
 * @returns the verdict, with enough detail to explain it
 */
export function checkRequirement(
  requirement: ExerciseRequirement,
  hasTag: (tag: LibraryEquipmentTag) => boolean,
  hasEquipment: (id: EquipmentId) => boolean,
): RequirementCheck {
  // A specific item that claims to provide this movement grants it outright.
  // That is what lets a Technogym Skillmill cover a sled push at a gym with no
  // turf: the item knows something the tag vocabulary cannot express.
  for (const id of requirement.specific) {
    if (hasEquipment(id)) {
      return {
        ok: true,
        satisfiedBy: null,
        missingTags: [],
        blockedOnSpecificMachine: false,
      };
    }
  }

  let closest: readonly LibraryEquipmentTag[] | null = null;
  let blockedOnMachine = false;

  for (const group of requirement.alternatives) {
    const missing = group.filter((tag) => !hasTag(tag));
    if (missing.length > 0) {
      if (closest === null || missing.length < closest.length) closest = missing;
      continue;
    }
    if (group.includes('machine') && requirement.specific.length > 0) {
      // Every tag is there, but nothing in the gym is the machine in question.
      // Not a failure yet — another alternative may not need a machine at all.
      if (!hasEquipment(GENERIC_MACHINE)) {
        blockedOnMachine = true;
        continue;
      }
    }
    return {
      ok: true,
      satisfiedBy: group,
      missingTags: [],
      blockedOnSpecificMachine: false,
    };
  }

  return {
    ok: false,
    satisfiedBy: null,
    missingTags: blockedOnMachine && closest === null ? [] : (closest ?? []),
    blockedOnSpecificMachine: blockedOnMachine,
  };
}
