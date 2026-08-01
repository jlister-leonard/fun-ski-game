/**
 * @file Cache-first barcode resolution.
 *
 * The order is a privacy contract: normalize -> encrypted cache -> optional
 * direct OFF request -> encrypted cache. Nothing in this file can prefetch.
 */

import { UNKNOWN_MICRONUTRIENTS, type FoodItem } from '@/data/foods';
import { foods, type NewRecord } from '@/lib/db/repos';
import type { Food } from '@/lib/db/types';
import {
  describeFailure,
  lookupBarcode,
  normalizeBarcode,
  type OffFailureReason,
} from './open-food-facts';

export type BarcodeFoodResult =
  | { ok: true; item: FoodItem; source: 'encrypted-cache' | 'open-food-facts' }
  | { ok: false; reason: 'network-consent-required' | OffFailureReason; message: string };

function recordFor(item: FoodItem): NewRecord<Food> {
  return {
    name: item.name,
    brand: item.brand,
    barcode: null,
    per100g: {
      kcal: item.per100g.kcal,
      proteinG: item.per100g.protein_g,
      carbG: item.per100g.carbs_g,
      fatG: item.per100g.fat_g,
      fiberG: item.per100g.fiber_g,
      sugarG: item.per100g.sugar_g,
      satFatG: item.per100g.satfat_g,
      sodiumMg: item.per100g.sodium_mg,
    },
    servings: item.servings.map((serving, index) => ({
      id: `off-${index}`,
      label: serving.label,
      grams: serving.grams,
    })),
    userCreated: false,
    useCount: 0,
    lastUsedAt: null,
    source: 'open-food-facts',
    sourceKey: null,
  };
}

function cachedToItem(food: Food): FoodItem {
  return {
    id: food.id,
    name: food.name,
    brand: food.brand,
    aliases: [],
    category: 'prepared',
    per100g: {
      kcal: food.per100g.kcal,
      protein_g: food.per100g.proteinG,
      carbs_g: food.per100g.carbG,
      fat_g: food.per100g.fatG,
      fiber_g: food.per100g.fiberG ?? 0,
      sugar_g: food.per100g.sugarG ?? 0,
      satfat_g: food.per100g.satFatG ?? 0,
      sodium_mg: food.per100g.sodiumMg ?? 0,
    },
    servings: food.servings.length > 0
      ? food.servings.map((serving, index) => ({
          label: serving.label,
          grams: serving.grams,
          isDefault: index === 0,
        }))
      : [{ label: '100 g', grams: 100, isDefault: true }],
    micronutrients: { ...UNKNOWN_MICRONUTRIENTS },
    density_g_per_ml: null,
    verified: false,
    source: food.source === 'open-food-facts' && food.barcode
      ? `Open Food Facts (barcode ${food.barcode})`
      : food.source,
  };
}

/** Resolve one explicitly supplied barcode; never performs more than one request. */
export async function resolveBarcodeFood(
  raw: string,
  options: { allowNetwork: boolean; signal?: AbortSignal },
): Promise<BarcodeFoodResult> {
  if (options.signal?.aborted) {
    return { ok: false, reason: 'cancelled', message: describeFailure('cancelled') };
  }
  const normalized = normalizeBarcode(raw);
  if (!normalized.ok) {
    return {
      ok: false,
      reason: normalized.reason,
      message: describeFailure(normalized.reason),
    };
  }

  const cached = await foods.getByBarcode(normalized.code);
  if (options.signal?.aborted) {
    return { ok: false, reason: 'cancelled', message: describeFailure('cancelled') };
  }
  if (cached) return { ok: true, item: cachedToItem(cached), source: 'encrypted-cache' };

  if (!options.allowNetwork) {
    return {
      ok: false,
      reason: 'network-consent-required',
      message: 'This barcode is not in your encrypted cache. Online lookup is optional.',
    };
  }

  const result = await lookupBarcode(normalized.code, {
    appName: 'Keel',
    appVersion: '0.1.0',
  }, undefined, options.signal);
  if (!result.ok) {
    return { ok: false, reason: result.reason, message: describeFailure(result.reason) };
  }

  if (options.signal?.aborted) {
    return { ok: false, reason: 'cancelled', message: describeFailure('cancelled') };
  }

  const stored = await foods.cacheFromLookup(normalized.code, recordFor(result.food));
  return { ok: true, item: cachedToItem(stored), source: 'open-food-facts' };
}
