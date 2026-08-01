/**
 * @file The diary's pure layer: conversions, day arithmetic, adequacy.
 *
 * No React, no I/O, no vault access. Everything here is a function of its
 * arguments, which is what lets the test suite assert the safety-relevant
 * behaviour — suppressed adequacy checks, upper-limit lower bounds, the
 * "eaten" framing — without standing up IndexedDB.
 *
 * ## The two type systems this file bridges
 *
 * The bundled food database (`@/data/foods`) speaks `FoodItem` / `Per100g`,
 * with snake_case gram fields and a five-field `Micronutrients` block. The
 * vault (`@/lib/db/types`) speaks `Food` / `Nutrients`, with camelCase and no
 * micronutrients at all. Both are fixed contracts owned by other agents, so
 * the diary converts rather than negotiating.
 *
 * The conversion is lossy in exactly one direction and that matters: a vault
 * `Food` has no micronutrient panel, so a food that round-trips through the
 * vault comes back with `UNKNOWN_MICRONUTRIENTS`. Unknown, not zero — which is
 * why every adequacy check in this file suppresses on unknown rather than
 * treating a missing value as an absence.
 */

import {
  UNKNOWN_MICRONUTRIENTS,
  getSeedFood,
  type FoodItem,
  type Micronutrients,
  type Per100g,
} from '@/data/foods';
import { scaleMacros, scaleMicronutrients } from '@/lib/food/portions';
import { sumMicronutrients } from '@/lib/food/nutrition-math';
import {
  assessNutrient,
  type AdequacyAssessment,
  type NutrientDefinition,
  type NutrientIntake,
  type PersonContext,
} from '@/lib/algorithms';
import type { Food, FoodLog, MealSlot, Nutrients } from '@/lib/db/types';
import { ASSESSABLE_FROM_FOOD_LOG, FOLATE, VITAMIN_A } from './micronutrient-db';
import type { LiveStatus } from './live';

/* ------------------------------------------------------------------ */
/* Nutrient block conversion                                           */
/* ------------------------------------------------------------------ */

/** Seed-database macros → vault macros. Total, not per-100 g: pre-scale first. */
export function per100gToNutrients(p: Per100g): Nutrients {
  return {
    kcal: p.kcal,
    proteinG: p.protein_g,
    carbG: p.carbs_g,
    fatG: p.fat_g,
    fiberG: p.fiber_g,
    sugarG: p.sugar_g,
    satFatG: p.satfat_g,
    sodiumMg: p.sodium_mg,
  };
}

/**
 * Vault macros → seed-database macros.
 *
 * The optional fields become `0` rather than staying absent, because `Per100g`
 * has no representation for "unknown". That is a real loss of fidelity and it
 * is confined to user-created foods, where the user typed the numbers and an
 * omitted fibre figure genuinely does mean they did not enter one. It must
 * never be applied to a seed food, which is why nothing here calls it on one.
 */
export function nutrientsToPer100g(n: Nutrients): Per100g {
  return {
    kcal: n.kcal,
    protein_g: n.proteinG,
    carbs_g: n.carbG,
    fat_g: n.fatG,
    fiber_g: n.fiberG ?? 0,
    sugar_g: n.sugarG ?? 0,
    satfat_g: n.satFatG ?? 0,
    sodium_mg: n.sodiumMg ?? 0,
  };
}

/**
 * A vault-stored (user-created or barcode-cached) food, shaped for the search
 * index and the portion picker.
 *
 * `micronutrients` is `UNKNOWN_MICRONUTRIENTS` by construction. The vault
 * schema carries no micronutrient panel, and inventing zeroes here would let a
 * user-created "cod liver oil" pass a retinol upper-limit check silently.
 */
export function vaultFoodToItem(food: Food): FoodItem {
  return {
    id: food.id,
    name: food.name,
    brand: food.brand,
    aliases: [],
    category: 'prepared',
    per100g: nutrientsToPer100g(food.per100g),
    servings:
      food.servings.length > 0
        ? food.servings.map((s, i) => ({
            label: s.label,
            grams: s.grams,
            isDefault: i === 0,
          }))
        : [{ label: '100 g', grams: 100, isDefault: true }],
    micronutrients: { ...UNKNOWN_MICRONUTRIENTS },
    density_g_per_ml: null,
    verified: false,
    source: food.userCreated ? 'user entry' : food.source,
  };
}

/** Macros for `grams` of a food, in the vault's shape. */
export function nutrientsForGrams(food: FoodItem, grams: number): Nutrients {
  return per100gToNutrients(scaleMacros(food.per100g, grams));
}

/* ------------------------------------------------------------------ */
/* Day arithmetic                                                      */
/* ------------------------------------------------------------------ */

/** Zero totals, used as a reduction seed and as the empty-day answer. */
export const ZERO_DAY: Nutrients = Object.freeze({
  kcal: 0,
  proteinG: 0,
  carbG: 0,
  fatG: 0,
  fiberG: 0,
  sugarG: 0,
  satFatG: 0,
  sodiumMg: 0,
});

/**
 * Total what has been eaten.
 *
 * Sum first, round last — rounding each entry and again at the total is how a
 * diary drifts tens of kcal a day.
 */
export function totalEaten(logs: readonly FoodLog[]): Nutrients {
  const out: Nutrients = { ...ZERO_DAY };
  for (const log of logs) {
    out.kcal += log.nutrients.kcal;
    out.proteinG += log.nutrients.proteinG;
    out.carbG += log.nutrients.carbG;
    out.fatG += log.nutrients.fatG;
    out.fiberG = (out.fiberG ?? 0) + (log.nutrients.fiberG ?? 0);
    out.sugarG = (out.sugarG ?? 0) + (log.nutrients.sugarG ?? 0);
    out.satFatG = (out.satFatG ?? 0) + (log.nutrients.satFatG ?? 0);
    out.sodiumMg = (out.sodiumMg ?? 0) + (log.nutrients.sodiumMg ?? 0);
  }
  return out;
}

export interface WeekDiaryRow {
  dateKey: string;
  label: string;
  logged: boolean;
  entries: number;
  total: Nutrients;
}

/** The visible period must be governed by its own query, never a sibling's. */
export function diaryPeriodStatus(
  view: 'day' | 'week',
  dayStatus: LiveStatus,
  weekStatus: LiveStatus,
): LiveStatus {
  return view === 'week' ? weekStatus : dayStatus;
}

/** Seven ascending days ending on `endingDate`, with missing kept distinct from zero. */
export function weekDiaryRows(
  endingDate: string,
  logs: readonly FoodLog[],
): WeekDiaryRow[] {
  const byDate = new Map<string, FoodLog[]>();
  for (const log of logs) {
    const current = byDate.get(log.dateKey);
    if (current) current.push(log);
    else byDate.set(log.dateKey, [log]);
  }

  const [year, month, day] = endingDate.split('-').map(Number);
  const ending = Date.UTC(year, month - 1, day);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(ending - (6 - index) * 86_400_000);
    const dateKey = date.toISOString().slice(0, 10);
    const entries = byDate.get(dateKey) ?? [];
    return {
      dateKey,
      label: date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      logged: entries.length > 0,
      entries: entries.length,
      total: totalEaten(entries),
    };
  });
}

/** Group a day's entries by meal slot, preserving the repository's ordering. */
export function groupBySlot(logs: readonly FoodLog[]): Map<MealSlot, FoodLog[]> {
  const out = new Map<MealSlot, FoodLog[]>();
  for (const log of logs) {
    const bucket = out.get(log.slot);
    if (bucket) bucket.push(log);
    else out.set(log.slot, [log]);
  }
  return out;
}

/**
 * The meal slot a log added *now* most likely belongs to.
 *
 * Saves a tap in the common case and is trivially overridable. The boundaries
 * are ordinary US mealtimes; there is nothing clever here and nothing that
 * needs to be right, only defaults that are usually right.
 */
export function defaultSlotForHour(hour: number): MealSlot {
  if (hour < 4) return 'snack';
  if (hour < 11) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 17) return 'snack';
  if (hour < 21) return 'dinner';
  return 'snack';
}

/* ------------------------------------------------------------------ */
/* Search ranking inputs                                               */
/* ------------------------------------------------------------------ */

/** How often each food id has been logged, for the search engine's boost. */
export function frequencyFromLogs(logs: readonly FoodLog[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const log of logs) {
    if (!log.foodId) continue;
    out.set(log.foodId, (out.get(log.foodId) ?? 0) + 1);
  }
  return out;
}

/** Distinct food ids, most recently logged first. */
export function recentIdsFromLogs(logs: readonly FoodLog[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const log of [...logs].sort((a, b) => b.loggedAt - a.loggedAt)) {
    if (!log.foodId || seen.has(log.foodId)) continue;
    seen.add(log.foodId);
    out.push(log.foodId);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Micronutrient adequacy                                              */
/* ------------------------------------------------------------------ */

/**
 * One nutrient, as the diary renders it.
 *
 * `adequacySuppressed` is the field that matters. The bundled food database
 * carries a micronutrient panel for 126 of its 1,557 foods; the rest are
 * explicitly `null`, meaning unknown. Summing the known part and comparing it
 * against an RDA would tell almost every user they are deficient in almost
 * everything, which is both false and — for a user with restrictive eating —
 * actively harmful. So adequacy is switched off whenever any logged item
 * lacked a value, and the UI says why.
 *
 * The upper-limit status is **not** suppressed. `known` is a strict lower
 * bound, so `known > UL` is a true positive no matter how much is missing.
 * Suppressing it is the failure mode where 85 g of beef liver — twice the
 * preformed-retinol upper limit on its own — passes without comment.
 */
export interface NutrientPanel {
  assessment: AdequacyAssessment;
  /** True when at least one logged item had no value for this nutrient. */
  adequacySuppressed: boolean;
  /** How many logged items were missing a value. */
  unknownEntries: number;
  /** Grams of food whose value was unknown. */
  unknownGrams: number;
}

/** The day's micronutrient picture, and how much of it could be assessed. */
export interface MicronutrientDay {
  panels: NutrientPanel[];
  /** True when nothing logged carried any micronutrient data at all. */
  noData: boolean;
  /** Entries in the day, for the "n items have no data" copy. */
  totalEntries: number;
}

/** A logged entry paired with the catalogue item it came from. */
export interface ResolvedLog {
  log: FoodLog;
  /** `undefined` when the food is not resolvable — a deleted custom food. */
  item: FoodItem | undefined;
}

/**
 * Pair each log with its catalogue entry.
 *
 * @param logs the day's entries
 * @param userFoods vault-stored foods (custom entries, barcode lookups)
 */
export function resolveLogs(
  logs: readonly FoodLog[],
  userFoods: readonly FoodItem[],
): ResolvedLog[] {
  const byId = new Map(userFoods.map((f) => [f.id, f]));
  return logs.map((log) => ({
    log,
    item: log.foodId ? (getSeedFood(log.foodId) ?? byId.get(log.foodId)) : undefined,
  }));
}

/** The micronutrient panel of a logged entry, scaled to what was eaten. */
function micronutrientsOf(resolved: ResolvedLog): Micronutrients {
  if (!resolved.item) return { ...UNKNOWN_MICRONUTRIENTS };
  return scaleMicronutrients(resolved.item.micronutrients, resolved.log.grams);
}

/**
 * Assess the two nutrients a food log can actually speak to.
 *
 * ## Why the intake is assembled by hand rather than via `computeIntake()`
 *
 * `computeIntake()` derives both the adequacy total and the upper-limit total
 * from one list of contributions. For folate that is impossible to do
 * correctly in a single pass: the RDA is expressed in **dietary folate
 * equivalents** (`food + 1.7 × folic acid`) while the upper limit is expressed
 * in **raw micrograms of synthetic folic acid**. Feeding both a DFE
 * contribution and a folic-acid contribution double-counts the synthetic
 * portion in the adequacy total; feeding only raw micrograms understates
 * enriched grains by up to 70%.
 *
 * So the diary builds the `NutrientIntake` directly, with `total` on the
 * reference's basis and `countingTowardUpperLimit` on the limit's basis, and
 * hands it to `assessNutrient()`. That function is the shared judgement; only
 * the aggregation differs.
 */
/**
 * The age/sex context used purely to resolve upper-limit bands when the
 * profile is incomplete.
 *
 * Both limits this module checks — 3,000 mcg preformed retinol and 1,000 mcg
 * folic acid — are identical for adult men and women, so the *limit* side is
 * unaffected by the placeholder. The *adequacy* side is not: the vitamin A RDA
 * differs by sex. So a null person forces every adequacy check off rather than
 * comparing intake against a reference invented for a person we do not know.
 */
const ADULT_LIMIT_CONTEXT: PersonContext = { sex: 'male', ageYears: 30 };

export function assessMicronutrients(
  resolved: readonly ResolvedLog[],
  person: PersonContext | null,
): MicronutrientDay {
  const context = person ?? ADULT_LIMIT_CONTEXT;
  const entries = resolved.map((r) => ({
    grams: r.log.grams,
    micronutrients: micronutrientsOf(r),
  }));
  const totals = sumMicronutrients(entries);

  const contributorsFor = (
    pick: (m: Micronutrients) => number | null,
  ): { id: string; label: string; amount: number }[] =>
    resolved
      .map((r, i) => {
        const value = pick(entries[i].micronutrients);
        return { id: r.log.id, label: r.log.label, amount: value ?? 0 };
      })
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);

  const vitaminAIntake: NutrientIntake = {
    nutrientId: VITAMIN_A.id,
    // Reference basis: total retinol activity equivalents.
    total: totals.vitamin_a_retinol_mcg.known + totals.vitamin_a_carotenoid_mcg_rae.known,
    fromFood: totals.vitamin_a_retinol_mcg.known + totals.vitamin_a_carotenoid_mcg_rae.known,
    fromFortified: 0,
    fromSupplement: 0,
    // Limit basis: preformed retinol only. Carotenoids never count.
    countingTowardUpperLimit: totals.vitamin_a_retinol_mcg.known,
    contributors: contributorsFor(
      (m) =>
        m.vitamin_a_retinol_mcg === null && m.vitamin_a_carotenoid_mcg_rae === null
          ? null
          : (m.vitamin_a_retinol_mcg ?? 0) + (m.vitamin_a_carotenoid_mcg_rae ?? 0),
    ),
  };

  const folateIntake: NutrientIntake = {
    nutrientId: FOLATE.id,
    // Reference basis: dietary folate equivalents.
    total: totals.folate_dfe_mcg.known,
    fromFood: totals.folate_food_mcg.known,
    fromFortified: totals.folic_acid_mcg.known,
    fromSupplement: 0,
    // Limit basis: synthetic folic acid, raw micrograms. Never DFE.
    countingTowardUpperLimit: totals.folic_acid_mcg.known,
    contributors: contributorsFor((m) => m.folate_dfe_mcg),
  };

  const intakes: Record<string, NutrientIntake> = {
    [VITAMIN_A.id]: vitaminAIntake,
    [FOLATE.id]: folateIntake,
  };

  // Adequacy is suppressed on the *reference* basis fields, which are the ones
  // the comparison actually uses.
  const unknownFor: Record<string, { entries: number; grams: number }> = {
    [VITAMIN_A.id]: {
      entries: Math.max(
        totals.vitamin_a_retinol_mcg.unknownEntries,
        totals.vitamin_a_carotenoid_mcg_rae.unknownEntries,
      ),
      grams: Math.max(
        totals.vitamin_a_retinol_mcg.unknownGrams,
        totals.vitamin_a_carotenoid_mcg_rae.unknownGrams,
      ),
    },
    [FOLATE.id]: {
      entries: totals.folate_dfe_mcg.unknownEntries,
      grams: totals.folate_dfe_mcg.unknownGrams,
    },
  };

  const panels: NutrientPanel[] = ASSESSABLE_FROM_FOOD_LOG.map(
    (def: NutrientDefinition): NutrientPanel => {
      const unknown = unknownFor[def.id] ?? { entries: 0, grams: 0 };
      return {
        assessment: assessNutrient(def, intakes[def.id], context),
        // No profile means no reference worth comparing against, so adequacy
        // is off even when every food carried data.
        adequacySuppressed: unknown.entries > 0 || person === null,
        unknownEntries: unknown.entries,
        unknownGrams: unknown.grams,
      };
    },
  );

  return {
    panels,
    // Nothing logged, or nothing logged that carries any data. Both are
    // "there is nothing to assess", which is a different statement from
    // "you are short", and the copy says so.
    noData:
      resolved.length === 0 ||
      panels.every((p) => p.adequacySuppressed && p.assessment.intake === 0),
    totalEntries: resolved.length,
  };
}

/* ------------------------------------------------------------------ */
/* Macro floors                                                        */
/* ------------------------------------------------------------------ */

/**
 * A floor worth reaching, and how far along the day is.
 *
 * Framed as a floor rather than a budget throughout. `eaten` and `floor` are
 * the only two numbers; there is deliberately no `remaining` field, because a
 * field is an invitation to render it.
 */
export interface FloorProgress {
  label: string;
  eaten: number;
  floor: number | null;
  /** 0..1+, uncapped. A value above 1 is not an error state. */
  fraction: number | null;
  met: boolean;
  /** How far below the floor, or `null` when met or when there is no floor. */
  shortBy: number | null;
}

/**
 * Progress toward a floor.
 *
 * @param label what to call it
 * @param eaten how much has been eaten today
 * @param floor the floor, or `null` when there is not enough data to set one
 */
export function floorProgress(
  label: string,
  eaten: number,
  floor: number | null,
): FloorProgress {
  if (floor === null || !(floor > 0)) {
    return { label, eaten, floor: null, fraction: null, met: false, shortBy: null };
  }
  const met = eaten >= floor;
  return {
    label,
    eaten,
    floor,
    fraction: eaten / floor,
    met,
    shortBy: met ? null : floor - eaten,
  };
}
