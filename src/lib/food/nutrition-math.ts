/**
 * nutrition-math.ts — summing logged entries and computing recipe macros.
 *
 * Pure functions, no dependencies. Verified by `src/lib/food/verify.mjs`.
 *
 * The invariant this file exists to protect: **sum first, round last.** Every
 * function takes and returns unrounded numbers. Rounding is applied exactly once,
 * by the render layer, via `roundMacrosForDisplay`.
 */

import type { Micronutrients, Per100g } from '@/data/foods/types';
import { PortionError, ZERO_MACROS, type MacroTotals } from './portions';

const MACRO_KEYS = [
  'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'satfat_g', 'sodium_mg',
] as const;

/**
 * The macro snapshot frozen onto a log entry at the moment it was logged.
 * Denormalised on purpose: if the seed DB corrects a food next month, history
 * must not silently rewrite itself.
 */
export interface LoggedMacros {
  readonly grams: number;
  readonly macros: MacroTotals;
}

// ---------------------------------------------------------------------------
// Summation
// ---------------------------------------------------------------------------

export function addMacros(a: MacroTotals, b: MacroTotals): MacroTotals {
  const out = { ...ZERO_MACROS } as MacroTotals;
  for (const key of MACRO_KEYS) out[key] = a[key] + b[key];
  return out;
}

export function subtractMacros(a: MacroTotals, b: MacroTotals): MacroTotals {
  const out = { ...ZERO_MACROS } as MacroTotals;
  for (const key of MACRO_KEYS) out[key] = a[key] - b[key];
  return out;
}

export function multiplyMacros(macros: MacroTotals, factor: number): MacroTotals {
  if (!Number.isFinite(factor)) {
    throw new PortionError(`Factor must be a finite number, got ${factor}`);
  }
  const out = { ...ZERO_MACROS } as MacroTotals;
  for (const key of MACRO_KEYS) out[key] = macros[key] * factor;
  return out;
}

/** Total across any number of logged entries. Empty input yields all zeroes. */
export function sumMacros(entries: readonly { readonly macros: MacroTotals }[]): MacroTotals {
  const out = { ...ZERO_MACROS } as MacroTotals;
  for (const entry of entries) {
    for (const key of MACRO_KEYS) out[key] += entry.macros[key];
  }
  return out;
}

/**
 * Group and sum by an arbitrary key — meal, day, food category.
 * Returns a Map so insertion order is stable and callers can sort as they like.
 */
export function sumMacrosBy<TEntry extends { readonly macros: MacroTotals }, TKey>(
  entries: readonly TEntry[],
  keyOf: (entry: TEntry) => TKey,
): Map<TKey, MacroTotals> {
  const out = new Map<TKey, MacroTotals>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const running = out.get(key) ?? ({ ...ZERO_MACROS } as MacroTotals);
    for (const macroKey of MACRO_KEYS) running[macroKey] += entry.macros[macroKey];
    out.set(key, running);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Targets and remaining
// ---------------------------------------------------------------------------

export interface MacroTargets {
  readonly kcal: number;
  readonly protein_g: number;
  readonly carbs_g: number;
  readonly fat_g: number;
}

export interface MacroProgress {
  readonly consumed: number;
  readonly target: number;
  /** May be negative when the target has been exceeded. */
  readonly remaining: number;
  /** 0-1+, unclamped so the UI can show an over-target ring. */
  readonly fraction: number;
}

/** Per-macro progress against the day's targets. */
export function macroProgress(
  consumed: MacroTotals,
  targets: MacroTargets,
): Record<keyof MacroTargets, MacroProgress> {
  const build = (c: number, t: number): MacroProgress => ({
    consumed: c,
    target: t,
    remaining: t - c,
    fraction: t > 0 ? c / t : 0,
  });
  return {
    kcal: build(consumed.kcal, targets.kcal),
    protein_g: build(consumed.protein_g, targets.protein_g),
    carbs_g: build(consumed.carbs_g, targets.carbs_g),
    fat_g: build(consumed.fat_g, targets.fat_g),
  };
}

/**
 * Share of energy contributed by each macronutrient, as fractions summing to
 * ~1. Computed from the macro grams (not from `kcal`) so the split is internally
 * consistent; alcohol shows up as the shortfall, which is why `other` exists.
 */
export function energySplit(macros: MacroTotals): {
  protein: number;
  carbs: number;
  fat: number;
  other: number;
} {
  const fromProtein = macros.protein_g * 4;
  const fromCarbs = macros.carbs_g * 4;
  const fromFat = macros.fat_g * 9;
  const accounted = fromProtein + fromCarbs + fromFat;
  const total = macros.kcal > 0 ? macros.kcal : accounted;
  if (total <= 0) return { protein: 0, carbs: 0, fat: 0, other: 0 };
  return {
    protein: fromProtein / total,
    carbs: fromCarbs / total,
    fat: fromFat / total,
    other: Math.max(0, (total - accounted) / total),
  };
}

// ---------------------------------------------------------------------------
// Micronutrients — partial-knowledge summation
// ---------------------------------------------------------------------------

const MICRO_KEYS = [
  'vitamin_a_retinol_mcg', 'vitamin_a_carotenoid_mcg_rae',
  'folate_food_mcg', 'folic_acid_mcg', 'folate_dfe_mcg',
] as const;

/**
 * The result of summing a nutrient across a day when some foods do not carry a
 * value for it.
 *
 * This is deliberately NOT a bare number, because a bare number forces the
 * caller to pick between two wrong answers: treat unknowns as zero (and
 * understate) or discard the day (and never check anything). Neither is
 * acceptable for a safety check.
 */
export interface MicronutrientTotal {
  /**
   * Sum over the entries whose value was known. This is a strict LOWER BOUND on
   * the true total, because every unknown entry can only add to it.
   */
  readonly known: number;
  /** How many entries carried `null` for this nutrient. */
  readonly unknownEntries: number;
  /** Grams of food whose value was unknown — how much is actually missing. */
  readonly unknownGrams: number;
}

export type MicronutrientTotals = Readonly<Record<keyof Micronutrients, MicronutrientTotal>>;

/**
 * Sum micronutrients across logged entries, tracking what was unknown.
 *
 * HOW TO USE THE RESULT — this is the whole point of the type:
 *
 *   UPPER-LIMIT (safety) checks — use `known` directly. It is a lower bound, so
 *   `known > UL` is a TRUE POSITIVE regardless of how much is unknown. Never
 *   suppress a UL check because some foods were unknown; that is the failure
 *   mode where 85 g of beef liver passes silently.
 *
 *   ADEQUACY / DEFICIENCY checks — SUPPRESS when `unknownEntries > 0`. You
 *   cannot conclude someone is short of folate from a partial sum; most of the
 *   seed database is `null` here and you would flag everyone.
 *
 *   And remember WHICH FIELD each limit applies to: the vitamin A UL applies to
 *   `vitamin_a_retinol_mcg` only, and the folate UL to `folic_acid_mcg` only.
 *   Do not run a limit against a total or against DFE.
 */
export function sumMicronutrients(
  entries: readonly { readonly grams: number; readonly micronutrients: Micronutrients }[],
): MicronutrientTotals {
  const out = {} as Record<keyof Micronutrients, { known: number; unknownEntries: number; unknownGrams: number }>;
  for (const key of MICRO_KEYS) out[key] = { known: 0, unknownEntries: 0, unknownGrams: 0 };

  for (const entry of entries) {
    for (const key of MICRO_KEYS) {
      const value = entry.micronutrients[key];
      if (value === null || !Number.isFinite(value)) {
        out[key].unknownEntries += 1;
        out[key].unknownGrams += entry.grams;
      } else {
        out[key].known += value;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface RecipeIngredient {
  /** Food id — seed slug, `off:<barcode>`, or a custom-food uuid. */
  readonly foodId: string;
  readonly name: string;
  readonly grams: number;
  /** The ingredient's own per-100 g panel. */
  readonly per100g: Per100g;
}

export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly ingredients: readonly RecipeIngredient[];
  /**
   * How many portions the finished dish is divided into. Must be > 0.
   */
  readonly servings: number;
  /**
   * Optional measured weight of the FINISHED dish in grams. Supply this when
   * the recipe loses water (a reduced sauce, roasted meat, a baked loaf) and
   * you want a per-100 g panel that is correct for the cooked product. When
   * absent we fall back to the summed raw ingredient weight, which is right for
   * cold assemblies (a smoothie, a salad) and wrong for anything roasted.
   */
  readonly cookedWeightGrams?: number;
}

export interface RecipeMacros {
  /** Everything the recipe contains, in total. */
  readonly total: MacroTotals;
  /** `total / servings`. This is what a user logs when they eat one portion. */
  readonly perServing: MacroTotals;
  /** Grams of finished dish in one portion. */
  readonly gramsPerServing: number;
  /** Panel for the finished dish, so a portion can be logged by weight. */
  readonly per100g: Per100g;
  /** Sum of the raw ingredient weights. */
  readonly rawWeightGrams: number;
  /** The weight the per-100 g panel is based on. */
  readonly finishedWeightGrams: number;
  /**
   * True when `cookedWeightGrams` was supplied. When false, a cooked recipe's
   * per-100 g panel will UNDERSTATE density because evaporated water is still
   * counted — surface this in the UI.
   */
  readonly cookedWeightMeasured: boolean;
}

/**
 * Compute a recipe's totals, per-serving macros, and a per-100 g panel for the
 * finished dish.
 */
export function computeRecipeMacros(recipe: Recipe): RecipeMacros {
  if (!(recipe.servings > 0) || !Number.isFinite(recipe.servings)) {
    throw new PortionError(`Recipe "${recipe.id}" must have servings > 0, got ${recipe.servings}`);
  }

  const total = { ...ZERO_MACROS } as MacroTotals;
  let rawWeightGrams = 0;

  for (const ingredient of recipe.ingredients) {
    if (!Number.isFinite(ingredient.grams) || ingredient.grams < 0) {
      throw new PortionError(
        `Ingredient "${ingredient.name}" in recipe "${recipe.id}" has invalid grams: ${ingredient.grams}`,
      );
    }
    const factor = ingredient.grams / 100;
    for (const key of MACRO_KEYS) total[key] += ingredient.per100g[key] * factor;
    rawWeightGrams += ingredient.grams;
  }

  const cookedWeightMeasured =
    typeof recipe.cookedWeightGrams === 'number' && recipe.cookedWeightGrams > 0;
  const finishedWeightGrams = cookedWeightMeasured
    ? (recipe.cookedWeightGrams as number)
    : rawWeightGrams;

  const perServing = multiplyMacros(total, 1 / recipe.servings);

  const per100g = { ...ZERO_MACROS } as Per100g;
  if (finishedWeightGrams > 0) {
    const factor = 100 / finishedWeightGrams;
    for (const key of MACRO_KEYS) per100g[key] = total[key] * factor;
  }

  return {
    total,
    perServing,
    gramsPerServing: finishedWeightGrams / recipe.servings,
    per100g,
    rawWeightGrams,
    finishedWeightGrams,
    cookedWeightMeasured,
  };
}

/**
 * Rescale a recipe to a different number of servings, keeping ingredient
 * proportions. Used by the "make 6 instead of 4" control.
 */
export function scaleRecipe(recipe: Recipe, newServings: number): Recipe {
  if (!(newServings > 0) || !Number.isFinite(newServings)) {
    throw new PortionError(`newServings must be > 0, got ${newServings}`);
  }
  const factor = newServings / recipe.servings;
  return {
    ...recipe,
    servings: newServings,
    ingredients: recipe.ingredients.map((i) => ({ ...i, grams: i.grams * factor })),
    cookedWeightGrams:
      typeof recipe.cookedWeightGrams === 'number'
        ? recipe.cookedWeightGrams * factor
        : undefined,
  };
}

/**
 * Rank ingredients by their contribution to a chosen macro. Powers "what made
 * this meal 900 kcal?" — the single most useful thing a diary can tell someone.
 */
export function rankIngredientContributions(
  recipe: Recipe,
  macro: keyof MacroTotals = 'kcal',
): Array<{ name: string; foodId: string; value: number; share: number }> {
  const rows = recipe.ingredients.map((i) => ({
    name: i.name,
    foodId: i.foodId,
    value: (i.per100g[macro] * i.grams) / 100,
  }));
  const total = rows.reduce((acc, r) => acc + r.value, 0);
  return rows
    .map((r) => ({ ...r, share: total > 0 ? r.value / total : 0 }))
    .sort((a, b) => b.value - a.value);
}
