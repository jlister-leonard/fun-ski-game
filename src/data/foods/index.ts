/**
 * Bundled seed food database — public entry point.
 *
 * Merges the per-category JSON files into one frozen array plus an id index.
 * Everything here is synchronous and dependency-free: `import { SEED_FOODS }`
 * and search works offline, on a plane, with the radio off.
 *
 * LICENCE / PROVENANCE — this matters, see docs/kg/specs/food-database.md §2.
 * Nutrient values were authored from USDA FoodData Central (SR Legacy /
 * Foundation Foods) figures and from manufacturers' published labels. USDA data
 * are US federal government work and carry no downstream obligations. NOTHING in
 * this dataset is derived from Open Food Facts, whose ODbL 1.0 licence is
 * share-alike and would attach obligations to the shipped bundle. OFF is queried
 * at runtime for barcodes only, and those results are cached in the user's own
 * vault — never redistributed.
 */

import type { FoodCategory, FoodItem } from './types';

import bakedGood from './json/baked-good.json';
import alcohol from './json/alcohol.json';
import beverage from './json/beverage.json';
import bread from './json/bread.json';
import cereal from './json/cereal.json';
import condiment from './json/condiment.json';
import dairyAlt from './json/dairy-alt.json';
import dairy from './json/dairy.json';
import egg from './json/egg.json';
import fatOil from './json/fat-oil.json';
import fruit from './json/fruit.json';
import grain from './json/grain.json';
import herbSpice from './json/herb-spice.json';
import legume from './json/legume.json';
import meat from './json/meat.json';
import nutSeed from './json/nut-seed.json';
import pasta from './json/pasta.json';
import poultry from './json/poultry.json';
import prepared from './json/prepared.json';
import restaurant from './json/restaurant.json';
import sauce from './json/sauce.json';
import seafood from './json/seafood.json';
import snack from './json/snack.json';
import soup from './json/soup.json';
import supplement from './json/supplement.json';
import sweetener from './json/sweetener.json';
import vegetable from './json/vegetable.json';

export * from './types';

/**
 * The JSON files are validated by `validate.mjs` against exactly this shape, so
 * the assertion is load-bearing but checked — by a stricter gate than the type
 * system would give us. Casting through `unknown` also keeps `tsc` from
 * inferring 1,557 literal object types, which is the difference between a
 * ~2 s and a ~40 s typecheck.
 */
const asFoods = (rows: unknown): readonly FoodItem[] => rows as readonly FoodItem[];

/** Every seed food, ordered by category then by file order. */
export const SEED_FOODS: readonly FoodItem[] = Object.freeze([
  ...asFoods(bakedGood),
  ...asFoods(alcohol),
  ...asFoods(beverage),
  ...asFoods(bread),
  ...asFoods(cereal),
  ...asFoods(condiment),
  ...asFoods(dairy),
  ...asFoods(dairyAlt),
  ...asFoods(egg),
  ...asFoods(fatOil),
  ...asFoods(fruit),
  ...asFoods(grain),
  ...asFoods(herbSpice),
  ...asFoods(legume),
  ...asFoods(meat),
  ...asFoods(nutSeed),
  ...asFoods(pasta),
  ...asFoods(poultry),
  ...asFoods(prepared),
  ...asFoods(restaurant),
  ...asFoods(sauce),
  ...asFoods(seafood),
  ...asFoods(snack),
  ...asFoods(soup),
  ...asFoods(supplement),
  ...asFoods(sweetener),
  ...asFoods(vegetable),
]);

/** O(1) lookup by stable slug. Log entries store this id. */
export const SEED_FOODS_BY_ID: ReadonlyMap<string, FoodItem> = new Map(
  SEED_FOODS.map((food) => [food.id, food]),
);

export const SEED_FOOD_COUNT = SEED_FOODS.length;

/** Provenance string for the app's About screen. */
export const SEED_DB_LICENSE =
  'Nutrient values derived from USDA FoodData Central (public domain) and from '
  + 'manufacturers’ published labels. Contains no Open Food Facts data.';

/** Bump on any change to the seed data; used to invalidate cached indexes. */
export const SEED_DB_VERSION = 1;

export function getSeedFood(id: string): FoodItem | undefined {
  return SEED_FOODS_BY_ID.get(id);
}

/** Counts by category — cheap enough to compute once at module load. */
export const SEED_FOOD_COUNTS_BY_CATEGORY: ReadonlyMap<FoodCategory, number> = (() => {
  const counts = new Map<FoodCategory, number>();
  for (const food of SEED_FOODS) {
    counts.set(food.category, (counts.get(food.category) ?? 0) + 1);
  }
  return counts;
})();
