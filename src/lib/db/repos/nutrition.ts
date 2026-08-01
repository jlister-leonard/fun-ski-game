/**
 * @file Nutrition repositories: the food catalogue, the diary, recipes, meals.
 */

import type {
  DateKey,
  Food,
  FoodLog,
  Meal,
  MealSlot,
  Nutrients,
  Recipe,
} from '../types';
import { Repo, type NewRecord } from './base';

/** An empty nutrient total, used as a reduction seed. */
export const ZERO_NUTRIENTS: Nutrients = { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 };

/**
 * Sum nutrient blocks.
 *
 * Optional micronutrients are summed only when at least one input defines
 * them, so "no fibre data" stays distinguishable from "zero fibre".
 *
 * @param parts the blocks to add
 * @returns the total
 */
export function sumNutrients(parts: readonly Nutrients[]): Nutrients {
  const total: Nutrients = { ...ZERO_NUTRIENTS };
  const optional: Array<keyof Nutrients> = [
    'fiberG',
    'sugarG',
    'satFatG',
    'sodiumMg',
    'potassiumMg',
  ];
  for (const p of parts) {
    total.kcal += p.kcal;
    total.proteinG += p.proteinG;
    total.carbG += p.carbG;
    total.fatG += p.fatG;
    for (const key of optional) {
      const v = p[key];
      if (typeof v === 'number') total[key] = (total[key] ?? 0) + v;
    }
  }
  return total;
}

/**
 * Scale a per-100 g nutrient block to an arbitrary mass.
 *
 * @param per100g the food's canonical basis
 * @param grams the mass consumed
 * @returns the nutrients in `grams` of the food
 */
export function scaleNutrients(per100g: Nutrients, grams: number): Nutrients {
  const f = grams / 100;
  const out: Nutrients = {
    kcal: per100g.kcal * f,
    proteinG: per100g.proteinG * f,
    carbG: per100g.carbG * f,
    fatG: per100g.fatG * f,
  };
  for (const key of ['fiberG', 'sugarG', 'satFatG', 'sodiumMg', 'potassiumMg'] as const) {
    const v = per100g[key];
    if (typeof v === 'number') out[key] = v * f;
  }
  return out;
}

/**
 * The food catalogue: the bundled seed database plus anything cached from an
 * Open Food Facts lookup or typed in by the user.
 */
export class FoodRepo extends Repo<Food> {
  constructor() {
    super('foods');
  }

  /**
   * Look up a cached food by barcode.
   *
   * Uses the blind index, so the barcode never appears in plaintext on disk.
   * A miss means "not cached", and node I8 should then hit Open Food Facts.
   *
   * @param barcode the EAN/UPC
   * @returns the cached food, or `null`
   */
  async getByBarcode(barcode: string): Promise<Food | null> {
    return this.findBySourceKey(`off:${barcode}`);
  }

  /**
   * Cache a food fetched from Open Food Facts, idempotently.
   *
   * @param barcode the EAN/UPC that produced it
   * @param input the food record
   * @returns the stored food
   */
  async cacheFromLookup(barcode: string, input: NewRecord<Food>): Promise<Food> {
    // OFF uses `off:<barcode>` as a transport/UI identity. Stored row ids are
    // plaintext, so this repository boundary must always replace it.
    const result = await this.upsertBySourceKey(`off:${barcode}`, {
      ...input,
      id: undefined,
      barcode,
      sourceKey: `off:${barcode}`,
    });
    return result.record;
  }

  /**
   * Substring search over food names and brands.
   *
   * **In-memory by necessity**: names are inside the ciphertext, so there is
   * no index to scan. This is fine for the cached/user-created catalogue,
   * which is hundreds of rows, not the bundled seed DB — node I8 searches that
   * as a static asset before ever touching the vault.
   *
   * @param query free text; case- and accent-insensitive on the first pass
   * @param limit maximum results. Default 25.
   * @returns matches ranked by usage, then by name length
   */
  async search(query: string, limit = 25): Promise<Food[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all = await this.listAll();
    return all
      .filter(
        (f) =>
          f.name.toLowerCase().includes(q) || (f.brand?.toLowerCase().includes(q) ?? false),
      )
      .sort((a, b) => b.useCount - a.useCount || a.name.length - b.name.length)
      .slice(0, limit);
  }

  /**
   * The foods the user logs most often — the diary's default suggestions.
   *
   * @param limit maximum results. Default 20.
   * @returns foods ordered by recency then frequency
   */
  async recent(limit = 20): Promise<Food[]> {
    const all = await this.listAll();
    return all
      .filter((f) => f.lastUsedAt !== null)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, limit);
  }

  /**
   * Bump a food's usage counters after it is logged.
   *
   * @param id the food that was logged
   */
  async noteUsed(id: string): Promise<void> {
    const food = await this.get(id);
    if (!food) return;
    await this.update(id, { useCount: food.useCount + 1, lastUsedAt: Date.now() });
  }
}

/** The nutrition diary. */
export class FoodLogRepo extends Repo<FoodLog> {
  constructor() {
    super('foodLogs');
  }

  /**
   * Everything logged on one day, in slot then chronological order.
   *
   * @param dateKey `YYYY-MM-DD`
   * @returns the day's entries
   */
  async getForDate(dateKey: DateKey): Promise<FoodLog[]> {
    const rows = await this.listByDate(dateKey);
    const slotOrder: Record<MealSlot, number> = {
      breakfast: 0,
      preworkout: 1,
      lunch: 2,
      postworkout: 3,
      dinner: 4,
      snack: 5,
    };
    return rows.sort(
      (a, b) => slotOrder[a.slot] - slotOrder[b.slot] || a.loggedAt - b.loggedAt,
    );
  }

  /**
   * Entries for a date range — the week view.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns the entries, ascending by day then by time
   */
  async getForRange(from: DateKey, to: DateKey): Promise<FoodLog[]> {
    const rows = await this.listByDateRange(from, to);
    return rows.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : a.loggedAt - b.loggedAt));
  }

  /**
   * Total nutrients consumed on one day.
   *
   * @param dateKey `YYYY-MM-DD`
   * @returns the day's totals; all zeroes when nothing was logged
   */
  async getDayTotals(dateKey: DateKey): Promise<Nutrients> {
    return sumNutrients((await this.listByDate(dateKey)).map((l) => l.nutrients));
  }

  /**
   * Per-slot totals for one day, for the diary's section headers.
   *
   * @param dateKey `YYYY-MM-DD`
   * @returns a sparse map of slot → totals
   */
  async getSlotTotals(dateKey: DateKey): Promise<Partial<Record<MealSlot, Nutrients>>> {
    const rows = await this.listByDate(dateKey);
    const out: Partial<Record<MealSlot, Nutrients>> = {};
    for (const row of rows) {
      out[row.slot] = sumNutrients([out[row.slot] ?? ZERO_NUTRIENTS, row.nutrients]);
    }
    return out;
  }

  /**
   * Daily kcal totals across a range — the input to the TDEE estimator.
   *
   * Days with **no** entries are returned as `null` rather than `0`, because
   * `estimateExpenditure` treats "did not log" and "ate nothing" completely
   * differently and conflating them corrupts the estimate.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns one entry per day that has any data
   */
  async getDailyIntakeSeries(
    from: DateKey,
    to: DateKey,
  ): Promise<Array<{ date: DateKey; intakeKcal: number | null }>> {
    const rows = await this.listByDateRange(from, to);
    const byDay = new Map<DateKey, number>();
    for (const r of rows) byDay.set(r.dateKey, (byDay.get(r.dateKey) ?? 0) + r.nutrients.kcal);
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, kcal]) => ({ date, intakeKcal: kcal }));
  }

  /**
   * Log a food, scaling its per-100 g nutrients to the quantity eaten.
   *
   * @param params.dateKey the local day
   * @param params.slot which meal
   * @param params.food the catalogue entry
   * @param params.grams the quantity
   * @param params.loggedAt epoch ms; defaults to now
   * @returns the stored entry
   */
  async logFood(params: {
    dateKey: DateKey;
    slot: MealSlot;
    food: Food;
    grams: number;
    loggedAt?: number;
  }): Promise<FoodLog> {
    return this.create({
      dateKey: params.dateKey,
      loggedAt: params.loggedAt ?? Date.now(),
      slot: params.slot,
      foodId: params.food.id,
      recipeId: null,
      label: params.food.name,
      grams: params.grams,
      nutrients: scaleNutrients(params.food.per100g, params.grams),
      note: null,
      source: 'manual',
      sourceKey: null,
    });
  }
}

/** Saved recipes. */
export class RecipeRepo extends Repo<Recipe> {
  constructor() {
    super('recipes');
  }

  /**
   * Nutrients in one serving of a recipe.
   *
   * @param recipe the recipe
   * @returns per-serving nutrients
   */
  perServing(recipe: Recipe): Nutrients {
    // scaleNutrients divides by 100, so `100 / servings` yields total / servings.
    return scaleNutrients(recipe.totalNutrients, 100 / Math.max(recipe.servings, 1));
  }

  /**
   * Recipes ordered by how often they are used.
   *
   * @param limit maximum results. Default 20.
   */
  async mostUsed(limit = 20): Promise<Recipe[]> {
    const all = await this.listAll();
    return all.sort((a, b) => b.useCount - a.useCount).slice(0, limit);
  }
}

/** Saved meals — reusable bundles of diary entries. */
export class MealRepo extends Repo<Meal> {
  constructor() {
    super('meals');
  }

  /**
   * Saved meals for one slot, most-used first.
   *
   * @param slot which meal slot
   * @param limit maximum results. Default 20.
   */
  async forSlot(slot: MealSlot, limit = 20): Promise<Meal[]> {
    const all = await this.listAll();
    return all
      .filter((m) => m.slot === slot)
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, limit);
  }
}

/** Food catalogue repository. */
export const foods = new FoodRepo();
/** Nutrition diary repository. */
export const foodLogs = new FoodLogRepo();
/** Recipe repository. */
export const recipes = new RecipeRepo();
/** Saved-meal repository. */
export const meals = new MealRepo();
