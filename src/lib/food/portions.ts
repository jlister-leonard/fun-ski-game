/**
 * portions.ts — conversions between servings, grams and millilitres, and
 * scaling of a nutrient panel to an arbitrary quantity.
 *
 * Pure functions. No I/O, no globals, no dependencies. Every function here is
 * exercised by `src/lib/food/verify.mjs`.
 *
 * DESIGN RULE: grams are the canonical quantity everywhere in the app. A log
 * entry stores grams. Servings and millilitres are *input affordances* that get
 * resolved to grams at entry time and are never the stored truth — because a
 * manufacturer can change what "1 bar" weighs, and a historical log must not
 * silently change with it.
 */

import type { FoodItem, FoodServing, Micronutrients, Per100g } from '@/data/foods/types';

/** The eight numbers we track. Keys match `Per100g` so scaling is mechanical. */
export type MacroTotals = Per100g;

export const ZERO_MACROS: Readonly<MacroTotals> = Object.freeze({
  kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
  sugar_g: 0,
  satfat_g: 0,
  sodium_mg: 0,
});

const MACRO_KEYS = [
  'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'satfat_g', 'sodium_mg',
] as const;

/** A quantity the user entered, in whichever unit they entered it. */
export type Quantity =
  | { unit: 'g'; amount: number }
  | { unit: 'ml'; amount: number }
  /** `amount` is the number of *servings*, e.g. 1.5 bananas. */
  | { unit: 'serving'; amount: number; servingLabel: string };

export class PortionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortionError';
  }
}

// ---------------------------------------------------------------------------
// Servings
// ---------------------------------------------------------------------------

/**
 * The serving the UI should preselect. Falls back to the first serving if no
 * default is marked — `validate.mjs` guarantees exactly one for seed foods, but
 * a user-created custom food may not have been through that gate.
 */
export function defaultServing(food: FoodItem): FoodServing {
  const marked = food.servings.find((s) => s.isDefault === true);
  if (marked) return marked;
  const first = food.servings[0];
  if (!first) throw new PortionError(`Food "${food.id}" has no servings`);
  return first;
}

export function findServing(food: FoodItem, label: string): FoodServing | undefined {
  return food.servings.find((s) => s.label === label);
}

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

export function mlToGrams(ml: number, densityGPerMl: number | null): number {
  if (densityGPerMl === null) {
    throw new PortionError('Cannot convert millilitres to grams without a density');
  }
  if (!(densityGPerMl > 0)) {
    throw new PortionError(`Density must be positive, got ${densityGPerMl}`);
  }
  return ml * densityGPerMl;
}

export function gramsToMl(grams: number, densityGPerMl: number | null): number {
  if (densityGPerMl === null) {
    throw new PortionError('Cannot convert grams to millilitres without a density');
  }
  if (!(densityGPerMl > 0)) {
    throw new PortionError(`Density must be positive, got ${densityGPerMl}`);
  }
  return grams / densityGPerMl;
}

/** True when this food can be entered by volume. */
export function supportsVolume(food: FoodItem): boolean {
  return food.density_g_per_ml !== null && food.density_g_per_ml > 0;
}

/**
 * Resolve any user-entered quantity to grams — the single funnel every logging
 * path goes through.
 */
export function quantityToGrams(food: FoodItem, quantity: Quantity): number {
  if (!Number.isFinite(quantity.amount)) {
    throw new PortionError(`Quantity amount must be a finite number, got ${quantity.amount}`);
  }
  if (quantity.amount < 0) {
    throw new PortionError(`Quantity amount must not be negative, got ${quantity.amount}`);
  }

  switch (quantity.unit) {
    case 'g':
      return quantity.amount;
    case 'ml':
      return mlToGrams(quantity.amount, food.density_g_per_ml);
    case 'serving': {
      const serving = findServing(food, quantity.servingLabel);
      if (!serving) {
        throw new PortionError(
          `Food "${food.id}" has no serving labelled "${quantity.servingLabel}"`,
        );
      }
      return quantity.amount * serving.grams;
    }
  }
}

/**
 * How many of `servingLabel` a gram weight corresponds to — for rendering
 * "138 g ≈ 1.2 medium bananas" and for pre-filling an edit form.
 */
export function gramsToServings(food: FoodItem, grams: number, servingLabel: string): number {
  const serving = findServing(food, servingLabel);
  if (!serving) {
    throw new PortionError(`Food "${food.id}" has no serving labelled "${servingLabel}"`);
  }
  return grams / serving.grams;
}

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

/**
 * Scale a per-100 g panel to `grams`.
 *
 * Deliberately does NOT round: rounding here and again when summing a day is
 * how a diary drifts by 40 kcal. Round once, at the render layer.
 */
export function scaleMacros(per100g: Per100g, grams: number): MacroTotals {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new PortionError(`Grams must be a non-negative finite number, got ${grams}`);
  }
  const factor = grams / 100;
  const out = { ...ZERO_MACROS } as MacroTotals;
  for (const key of MACRO_KEYS) out[key] = per100g[key] * factor;
  return out;
}

/** Macros for a user-entered quantity of a food. The main entry point. */
export function macrosForQuantity(food: FoodItem, quantity: Quantity): MacroTotals {
  return scaleMacros(food.per100g, quantityToGrams(food, quantity));
}

/** Macros for one of the food's named servings. */
export function macrosForServing(food: FoodItem, serving: FoodServing): MacroTotals {
  return scaleMacros(food.per100g, serving.grams);
}

/**
 * Scale a micronutrient panel to `grams`.
 *
 * NULL PROPAGATES. An unknown value stays unknown at every quantity — it is
 * never coerced to 0. A consumer that treats `null` as zero will understate
 * retinol and folic acid, which is precisely the failure this split exists to
 * prevent.
 */
export function scaleMicronutrients(micro: Micronutrients, grams: number): Micronutrients {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new PortionError(`Grams must be a non-negative finite number, got ${grams}`);
  }
  const factor = grams / 100;
  const at = (value: number | null): number | null => (value === null ? null : value * factor);
  return {
    vitamin_a_retinol_mcg: at(micro.vitamin_a_retinol_mcg),
    vitamin_a_carotenoid_mcg_rae: at(micro.vitamin_a_carotenoid_mcg_rae),
    folate_food_mcg: at(micro.folate_food_mcg),
    folic_acid_mcg: at(micro.folic_acid_mcg),
    folate_dfe_mcg: at(micro.folate_dfe_mcg),
  };
}

/**
 * Micronutrients for a user-entered quantity of a food.
 *
 * Returns `undefined` when the food carries no micronutrient panel. That is a
 * meaningful answer, not a failure: callers must suppress adequacy and
 * upper-limit checks for this food rather than treating the absence as zero.
 * Treating unknown as zero is how a genuinely high-retinol food slips past a
 * UL check.
 */
export function micronutrientsForQuantity(
  food: FoodItem,
  quantity: Quantity
): Micronutrients | undefined {
  if (!food.micronutrients) return undefined;
  return scaleMicronutrients(food.micronutrients, quantityToGrams(food, quantity));
}

/**
 * Invert `scaleMacros`: given totals for `grams`, recover the per-100 g panel.
 * Used when a user types a whole package's numbers off a label.
 */
export function unscaleToPer100g(totals: MacroTotals, grams: number): Per100g {
  if (!(grams > 0)) {
    throw new PortionError(`Grams must be positive to derive a per-100 g panel, got ${grams}`);
  }
  const factor = 100 / grams;
  const out = { ...ZERO_MACROS } as Per100g;
  for (const key of MACRO_KEYS) out[key] = totals[key] * factor;
  return out;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Sensible display rounding, applied once at the edge. */
export function roundMacrosForDisplay(totals: MacroTotals): MacroTotals {
  return {
    kcal: Math.round(totals.kcal),
    protein_g: Math.round(totals.protein_g * 10) / 10,
    carbs_g: Math.round(totals.carbs_g * 10) / 10,
    fat_g: Math.round(totals.fat_g * 10) / 10,
    fiber_g: Math.round(totals.fiber_g * 10) / 10,
    sugar_g: Math.round(totals.sugar_g * 10) / 10,
    satfat_g: Math.round(totals.satfat_g * 10) / 10,
    sodium_mg: Math.round(totals.sodium_mg),
  };
}

/**
 * "1 medium (118 g) — 89 kcal" style summary for a serving picker row.
 * Kept here rather than in a component so it is unit-testable.
 */
export function describeServing(food: FoodItem, serving: FoodServing): string {
  const kcal = Math.round((food.per100g.kcal * serving.grams) / 100);
  return `${serving.label} — ${kcal} kcal`;
}

/**
 * Pick the serving whose gram weight is closest to `grams`, so an edit form can
 * open on "≈2 slices" instead of "180 g". Returns the count alongside it.
 */
export function closestServing(
  food: FoodItem,
  grams: number,
): { serving: FoodServing; count: number } | undefined {
  if (food.servings.length === 0) return undefined;
  let best: FoodServing | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const serving of food.servings) {
    const count = grams / serving.grams;
    // Prefer servings that land near a whole number in the 0.25-6 range.
    if (count < 0.2 || count > 8) continue;
    const score = Math.abs(count - Math.round(count));
    if (score < bestScore) {
      bestScore = score;
      best = serving;
    }
  }
  if (!best) return undefined;
  return { serving: best, count: grams / best.grams };
}
