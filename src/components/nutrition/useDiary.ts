'use client';

import { useMemo } from 'react';
import {
  addDays,
  foodLogs,
  foods,
  toDateKey,
  type NewRecord,
} from '@/lib/db/repos';
import type { Food, FoodLog, MealSlot, Nutrients } from '@/lib/db/types';
import { getSeedFood, type FoodItem, type Per100g } from '@/data/foods';
import { useLiveQuery, type LiveState } from './live';
import { nutrientsForGrams, per100gToNutrients, vaultFoodToItem } from './model';

/**
 * @file The diary's reads and writes.
 *
 * Reads are Dexie live queries, so logging a food re-renders the day view, the
 * totals, the adequacy panel and the search ranking without any of them
 * knowing that it did.
 *
 * Writes are plain repository calls. Nothing here touches keys, IVs or
 * ciphertext — per `docs/kg/channel/020-vault.md`, a screen that finds itself
 * importing from `@/lib/db/codec` has found a missing repository method, and
 * the right response is to ask for one rather than to reach around.
 */

const NO_LOGS: readonly FoodLog[] = Object.freeze([]);
const NO_ITEMS: readonly FoodItem[] = Object.freeze([]);

/** Today, as a local calendar day. Never `toISOString().slice(0, 10)`. */
export function todayKey(): string {
  return toDateKey(new Date());
}

/** A day's entries, slot-ordered then chronological, live. */
export function useDayLogs(dateKey: string): LiveState<readonly FoodLog[]> {
  return useLiveQuery<readonly FoodLog[]>(
    `foodLogs:day:${dateKey}`,
    () => foodLogs.getForDate(dateKey),
    NO_LOGS,
  );
}

/** Seven days ending on the selected diary date, live. */
export function useWeekLogs(endingDate: string): LiveState<readonly FoodLog[]> {
  const from = addDays(endingDate, -6);
  return useLiveQuery<readonly FoodLog[]>(
    `foodLogs:week:${from}..${endingDate}`,
    () => foodLogs.getForRange(from, endingDate),
    NO_LOGS,
  );
}

/**
 * Entries over a trailing window, live.
 *
 * Feeds three things at once: the search engine's frequency boost, the recent
 * list, and the under-eating detector. One subscription rather than three.
 *
 * @param days how far back, inclusive of today
 */
export function useRecentLogs(days = 60): LiveState<readonly FoodLog[]> {
  const { from, to } = useMemo(() => {
    const today = todayKey();
    return { from: addDays(today, -(days - 1)), to: today };
  }, [days]);

  return useLiveQuery<readonly FoodLog[]>(
    `foodLogs:range:${from}..${to}`,
    () => foodLogs.getForRange(from, to),
    NO_LOGS,
  );
}

/**
 * Foods stored in the vault — the user's own entries and any barcode lookups —
 * shaped for the search index.
 *
 * The bundled seed database is a static asset searched before the vault is
 * consulted, so this list stays in the hundreds rather than the thousands.
 * That assumption is load-bearing for the vault's design: names live inside
 * the ciphertext, so a name search is a full-table decrypt.
 */
export function useUserFoods(): LiveState<readonly FoodItem[]> {
  return useLiveQuery<readonly FoodItem[]>(
    'foods:all',
    async () => (await foods.listAll()).map(vaultFoodToItem),
    NO_ITEMS,
  );
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface LogFoodParams {
  dateKey: string;
  slot: MealSlot;
  item: FoodItem;
  grams: number;
  /** Optional serving description, kept on the entry for legibility. */
  note?: string | null;
}

/**
 * Add an entry to the diary.
 *
 * The nutrients are **pre-multiplied and stored on the entry**, not referenced
 * from the food. That is the vault schema's choice and it is the right one:
 * correcting a food's figures later must not silently rewrite what the diary
 * says you ate three weeks ago.
 *
 * `foodId` carries the seed database's stable slug for a bundled food, or the
 * vault row id for a custom one. Per `docs/kg/channel/040-food-db.md` risk 7,
 * those slugs are a permanent contract and are never renamed or reused.
 */
export async function logFoodItem(params: LogFoodParams): Promise<FoodLog> {
  const entry = await foodLogs.create({
    dateKey: params.dateKey,
    loggedAt: Date.now(),
    slot: params.slot,
    foodId: params.item.id,
    recipeId: null,
    label: params.item.brand
      ? `${params.item.name} (${params.item.brand})`
      : params.item.name,
    grams: params.grams,
    nutrients: nutrientsForGrams(params.item, params.grams),
    note: params.note ?? null,
    source: 'manual',
    sourceKey: null,
  });

  // Usage counters only exist for vault-stored foods. A seed food has no row
  // to bump, and its ranking comes from the log history instead.
  if (!getSeedFood(params.item.id)) {
    try {
      await foods.noteUsed(params.item.id);
    } catch {
      // Not a vault food either — a barcode result not yet cached. Harmless.
    }
  }

  return entry;
}

/** Change how much of an already-logged food was eaten. */
export async function updateLogQuantity(
  log: FoodLog,
  item: FoodItem,
  grams: number,
): Promise<void> {
  await foodLogs.update(log.id, {
    grams,
    nutrients: nutrientsForGrams(item, grams),
  });
}

/** Change which meal an entry belongs to. */
export async function moveLogToSlot(log: FoodLog, slot: MealSlot): Promise<void> {
  await foodLogs.update(log.id, { slot });
}

/**
 * Remove an entry.
 *
 * Soft delete, like everything in the vault: a re-import must not resurrect
 * something the user removed.
 */
export async function removeLog(id: string): Promise<void> {
  await foodLogs.softDelete(id);
}

/**
 * Copy every entry from one day onto another.
 *
 * Copies the stored nutrients verbatim rather than re-deriving them from the
 * catalogue, so repeating a day reproduces exactly what was logged — including
 * a custom food whose figures were later corrected.
 *
 * @returns how many entries were copied
 */
export async function repeatDay(fromDateKey: string, toDateKey_: string): Promise<number> {
  const source = await foodLogs.getForDate(fromDateKey);
  const now = Date.now();
  for (const [index, log] of source.entries()) {
    await foodLogs.create({
      dateKey: toDateKey_,
      // Preserve the within-day ordering without pretending to know the times.
      loggedAt: now + index,
      slot: log.slot,
      foodId: log.foodId,
      recipeId: log.recipeId,
      label: log.label,
      grams: log.grams,
      nutrients: { ...log.nutrients },
      note: log.note,
      source: 'manual',
      sourceKey: null,
    });
  }
  return source.length;
}

export interface CustomFoodInput {
  name: string;
  brand: string | null;
  /** Everything per 100 g, matching the rest of the app's canonical basis. */
  per100g: Per100g;
  /** Optional named serving, e.g. one packet. */
  serving: { label: string; grams: number } | null;
}

/**
 * Save a food the user typed in themselves.
 *
 * Stored in the vault as a real catalogue row so it is searchable from then
 * on, which is the difference between a custom food and a one-off quick-add.
 *
 * The micronutrient panel is unknown by construction — see `vaultFoodToItem`.
 * The user typed a macro panel off a packet; they did not type a retinol
 * figure, and pretending they did would break the upper-limit check.
 */
export async function createCustomFood(input: CustomFoodInput): Promise<FoodItem> {
  const per100gNutrients: Nutrients = per100gToNutrients(input.per100g);
  const record: NewRecord<Food> = {
    name: input.name.trim(),
    brand: input.brand?.trim() || null,
    barcode: null,
    per100g: per100gNutrients,
    servings: input.serving
      ? [{ id: 'custom', label: input.serving.label, grams: input.serving.grams }]
      : [],
    userCreated: true,
    useCount: 0,
    lastUsedAt: null,
    source: 'manual',
    sourceKey: null,
  };
  return vaultFoodToItem(await foods.create(record));
}
