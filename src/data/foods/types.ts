/**
 * Seed food database — canonical types.
 *
 * These types are the contract between the bundled seed data, the search engine
 * (`src/lib/food/search.ts`), and any UI that logs food. They are also the shape
 * a *user-created* custom food must satisfy, so that seed foods and custom foods
 * are interchangeable everywhere downstream.
 *
 * Zero dependencies. Safe to import from a Web Worker.
 */

/**
 * Controlled category vocabulary. One JSON file per category lives in
 * `src/data/foods/json/<category>.json`.
 *
 * Adding a category is a breaking change for any UI that renders a fixed
 * category filter — post to the channel before adding one.
 */
export const FOOD_CATEGORIES = [
  'meat',
  'poultry',
  'seafood',
  'egg',
  'dairy',
  'dairy-alt',
  'grain',
  'bread',
  'pasta',
  'cereal',
  'legume',
  'nut-seed',
  'fruit',
  'vegetable',
  'fat-oil',
  'condiment',
  'sauce',
  'sweetener',
  'snack',
  'baked-good',
  'prepared',
  'soup',
  'restaurant',
  'beverage',
  'alcohol',
  'supplement',
  'herb-spice',
] as const;

export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

/** Human-readable labels for the category vocabulary. */
export const FOOD_CATEGORY_LABELS: Readonly<Record<FoodCategory, string>> = {
  meat: 'Meat',
  poultry: 'Poultry',
  seafood: 'Fish & seafood',
  egg: 'Eggs',
  dairy: 'Dairy',
  'dairy-alt': 'Dairy alternatives',
  grain: 'Grains & flours',
  bread: 'Bread & tortillas',
  pasta: 'Pasta & noodles',
  cereal: 'Breakfast cereal',
  legume: 'Beans & legumes',
  'nut-seed': 'Nuts & seeds',
  fruit: 'Fruit',
  vegetable: 'Vegetables',
  'fat-oil': 'Fats & oils',
  condiment: 'Condiments',
  sauce: 'Sauces & dressings',
  sweetener: 'Sweeteners',
  snack: 'Snacks & sweets',
  'baked-good': 'Baked goods',
  prepared: 'Prepared dishes',
  soup: 'Soups',
  restaurant: 'Restaurant & fast food',
  beverage: 'Drinks',
  alcohol: 'Alcohol',
  supplement: 'Supplements & sports nutrition',
  'herb-spice': 'Herbs & spices',
};

/**
 * Macronutrients per 100 grams of the food *as described by `name`*.
 *
 * "as described" is load-bearing: `chicken-breast-cooked` is per 100 g of
 * cooked meat, not per 100 g of raw meat that was then cooked. Cooking drives
 * off water and concentrates everything, so the two differ by ~50%.
 */
export interface Per100g {
  /** Kilocalories. The label figure, not a recomputed Atwater estimate. */
  kcal: number;
  protein_g: number;
  /** TOTAL carbohydrate, inclusive of fibre (US label convention). */
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  /** Total sugars, inclusive of naturally-occurring sugars. */
  sugar_g: number;
  /** Saturated fat. */
  satfat_g: number;
  sodium_mg: number;
}

/**
 * A named portion with a real gram weight.
 *
 * Every food has at least one, and exactly one is marked `isDefault`. This list
 * is what makes logging fast — a tracker that only accepts grams is unusable.
 */
export interface FoodServing {
  /** e.g. "1 medium (118 g)", "1 cup cooked", "1 scoop". */
  label: string;
  /** Weight of one of this serving, in grams. Must be > 0. */
  grams: number;
  /** Exactly one serving per food sets this to true. */
  isDefault?: boolean;
}

/**
 * Micronutrients that CANNOT be safely modelled as a single number.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FIVE FIELDS AND NOT TWO
 * ---------------------------------------------------------------------------
 * Vitamin A and folate each have a tolerable upper intake level (UL) that
 * applies to only ONE chemical form. Collapsing each into a single total makes
 * an upper-limit check wrong in both directions, and the failure modes are not
 * symmetric nuisances — one of them is dangerous:
 *
 *   - Vitamin A's UL applies to PREFORMED RETINOL only. Provitamin-A
 *     carotenoids (beta-carotene et al.) are converted on demand and are
 *     essentially non-toxic at dietary intakes. A single "vitamin A RAE" number
 *     means a sweet-potato-heavy day false-alarms — while 85 g of beef liver,
 *     roughly twice the retinol UL, passes silently. That is the wrong way
 *     round for a check whose entire purpose is safety.
 *
 *   - Folate's UL applies to SYNTHETIC FOLIC ACID (enriched grains, cereals,
 *     supplements), not to naturally occurring food folate. Lentils cannot
 *     cause the masked-B12-deficiency risk the UL exists to prevent; a bowl of
 *     fortified cereal plus a multivitamin can.
 *
 * USDA FoodData Central carries all five separately (`Retinol`, `Carotene,
 * beta`, `Folate, food`, `Folic acid`, `Folate, DFE`), so the provenance exists
 * at source.
 *
 * ---------------------------------------------------------------------------
 * UNITS AND CONVENTIONS — read before consuming any of this
 * ---------------------------------------------------------------------------
 *   - All values are PER 100 GRAMS, matching `per100g`.
 *   - `vitamin_a_retinol_mcg` is micrograms of preformed retinol.
 *   - `vitamin_a_carotenoid_mcg_rae` is the provitamin-A carotenoid
 *     contribution ALREADY EXPRESSED IN RETINOL ACTIVITY EQUIVALENTS, so that
 *     total vitamin A = retinol + carotenoid_rae. It is NOT raw micrograms of
 *     beta-carotene (which would be ~12x larger). Use `totalVitaminARae`.
 *   - `folate_food_mcg` and `folic_acid_mcg` are RAW micrograms of each form.
 *   - `folate_dfe_mcg` is dietary folate equivalents, where
 *     `DFE = food folate + 1.7 x folic acid`. DFE and raw micrograms are NOT
 *     interchangeable. `validate.mjs` enforces this identity whenever all three
 *     are present.
 *
 * ---------------------------------------------------------------------------
 * `null` MEANS UNKNOWN. IT DOES NOT MEAN ZERO.
 * ---------------------------------------------------------------------------
 * A consumer must SUPPRESS the corresponding check for a food whose field is
 * `null`, never treat it as 0. Most of the seed database is `null` here: we
 * populated the foods where the distinction changes a safety decision (organ
 * meats, fortified grains and cereals, dairy fat, and the major carotenoid
 * vegetables) and refused to guess for the rest.
 *
 * An explicit `0` is a positive assertion. `sweet-potato-baked` has
 * `vitamin_a_retinol_mcg: 0` — that is a claim that it contains no preformed
 * retinol at all, which is exactly what stops it from false-alarming.
 */
export interface Micronutrients {
  /** Preformed retinol, mcg/100 g. THE UL APPLIES TO THIS FIELD. */
  vitamin_a_retinol_mcg: number | null;
  /** Provitamin-A carotenoids expressed in mcg RAE/100 g. No UL applies. */
  vitamin_a_carotenoid_mcg_rae: number | null;
  /** Naturally occurring food folate, raw mcg/100 g. No UL applies. */
  folate_food_mcg: number | null;
  /** Synthetic folic acid, raw mcg/100 g. THE UL APPLIES TO THIS FIELD. */
  folic_acid_mcg: number | null;
  /** Dietary folate equivalents, mcg/100 g. `= food + 1.7 x folic acid`. */
  folate_dfe_mcg: number | null;
}

/** The multiplier turning raw folic acid micrograms into DFE. */
export const FOLIC_ACID_TO_DFE = 1.7;

export const UNKNOWN_MICRONUTRIENTS: Readonly<Micronutrients> = Object.freeze({
  vitamin_a_retinol_mcg: null,
  vitamin_a_carotenoid_mcg_rae: null,
  folate_food_mcg: null,
  folic_acid_mcg: null,
  folate_dfe_mcg: null,
});

/**
 * Total vitamin A in RAE. Returns `null` when either component is unknown —
 * a partial total would be silently wrong.
 *
 * DO NOT compare this against the vitamin A UL. Use
 * `preformedRetinolMcg` for that; see the `Micronutrients` docs.
 */
export function totalVitaminARae(m: Micronutrients): number | null {
  if (m.vitamin_a_retinol_mcg === null || m.vitamin_a_carotenoid_mcg_rae === null) return null;
  return m.vitamin_a_retinol_mcg + m.vitamin_a_carotenoid_mcg_rae;
}

/** The only vitamin A figure a UL check may use. `null` = suppress the check. */
export function preformedRetinolMcg(m: Micronutrients): number | null {
  return m.vitamin_a_retinol_mcg;
}

/** The only folate figure a UL check may use. `null` = suppress the check. */
export function folicAcidMcg(m: Micronutrients): number | null {
  return m.folic_acid_mcg;
}

/**
 * DFE, preferring the stored value and falling back to the identity when both
 * components are known. `null` when it cannot be determined.
 */
export function folateDfeMcg(m: Micronutrients): number | null {
  if (m.folate_dfe_mcg !== null) return m.folate_dfe_mcg;
  if (m.folate_food_mcg === null || m.folic_acid_mcg === null) return null;
  return m.folate_food_mcg + FOLIC_ACID_TO_DFE * m.folic_acid_mcg;
}

export interface FoodItem {
  /** Stable kebab-case slug. Never reused, never renamed — it is a log foreign key. */
  id: string;
  name: string;
  /** Manufacturer or restaurant, or null for generic/whole foods. */
  brand: string | null;
  /** Extra search terms: synonyms, regionalisms, common misnomers. */
  aliases: string[];
  category: FoodCategory;
  per100g: Per100g;
  servings: FoodServing[];
  /**
   * Vitamin A and folate, split by chemical form because their upper limits
   * apply to only one form each. Always present; individual fields are `null`
   * when unknown, which means SUPPRESS the check, not zero. See
   * `Micronutrients` for the full rationale and unit conventions.
   */
  /**
   * REQUIRED. The backfill is complete: all 27 category files carry the block,
   * and `validate.mjs` fails the build if any food is missing it.
   *
   * The block is always present; individual FIELDS are `null` when unknown,
   * which means SUPPRESS the check — never assume zero, which would let a
   * genuinely high-retinol food pass an upper-limit check silently. Keeping the
   * block required and the fields nullable is the distinction that matters: a
   * caller can never forget to handle the unknown case, because it is the
   * common case.
   */
  micronutrients: Micronutrients;
  /**
   * Grams per millilitre, for foods a user measures by volume.
   * Required for anything liquid (see `LIQUID_CATEGORIES`). `null` when the
   * food is not sensibly measured by volume.
   */
  density_g_per_ml: number | null;
  /**
   * `true` only when the figures were taken from a named reference entry
   * (USDA FoodData Central / a manufacturer's published label).
   * `false` means "author's best estimate" — the UI should say so.
   */
  verified: boolean;
  /** Provenance string, e.g. "USDA FoodData Central (SR Legacy)". */
  source: string;
}

/**
 * Categories whose members are liquids and therefore MUST carry a density so
 * that millilitre/cup/fl-oz servings can be converted to grams.
 * Enforced by `validate.mjs`.
 */
export const LIQUID_CATEGORIES: readonly FoodCategory[] = [
  'beverage',
  'alcohol',
  'fat-oil',
];

/** Narrowing helper — useful when reading user-supplied/custom food records. */
export function isFoodCategory(value: string): value is FoodCategory {
  return (FOOD_CATEGORIES as readonly string[]).includes(value);
}
