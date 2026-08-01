'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { settings } from '@/lib/db/repos';
import { subscribe as subscribeVault } from '@/lib/vault';
import { NUTRITION_SAFETY_DEFAULTS } from './copy';

/**
 * @file Nutrition display preferences, and the one that is a safety affordance.
 *
 * ## `hideCalories` is not an ordinary preference
 *
 * `docs/kg/specs/nutrition-personalization.md` §3.4 requirement 2: the whole
 * product must work with the energy numbers switched off, with protein and
 * micronutrient adequacy still fully functional. The spec calls it "the single
 * highest-value affordance in the list ... trivially cheap to build if designed
 * for from the start and very expensive to retrofit."
 *
 * So it is a first-class input to every component that could render a kcal
 * figure, threaded from here rather than bolted on. A component that renders
 * energy without consulting this hook is a bug, and the test suite asserts
 * that no nutrition component formats a kcal value outside `EnergyValue`.
 *
 * ## Requirement 9: re-offerable, never one-shot
 *
 * "A setting offered once and buried is a setting that does not exist."
 * Two mechanisms, both here:
 *
 * 1. The settings sheet is reachable from a permanently visible row on the
 *    diary screen. Not behind a global settings tab, not behind onboarding.
 * 2. `safetyReOfferDismissedAt` gates a single, quiet re-offer that the diary
 *    surfaces when under-eating findings appear — the moment the spec names as
 *    worth asking again. Dismissing it is respected; it does not nag on a
 *    timer, because a prompt that reappears gets learned as noise.
 *
 * The preference is stored in `AppSettings.ui`, which is inside the encrypted
 * vault like everything else. There is no unencrypted preference store.
 */

/** Namespaced keys inside `AppSettings.ui`. */
export const HIDE_CALORIES_KEY = 'nutrition.hideCalories';
/** Epoch ms the one-time safety re-offer was dismissed, or absent. */
export const SAFETY_REOFFER_DISMISSED_KEY = 'nutrition.safetyReOfferDismissedAt';

export interface NutritionPrefs {
  /** Energy numbers hidden everywhere in the diary. */
  hideCalories: boolean;
  /** Epoch ms the safety re-offer was dismissed, or `null`. */
  safetyReOfferDismissedAt: number | null;
}

const DEFAULTS: NutritionPrefs = Object.freeze({
  hideCalories: NUTRITION_SAFETY_DEFAULTS.hideCalories,
  safetyReOfferDismissedAt: null,
});

type Listener = () => void;

const listeners = new Set<Listener>();
let current: NutritionPrefs = DEFAULTS;
let loaded = false;
let vaultUnsubscribe: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Read the stored preferences into the module cache.
 *
 * Uses `load()` rather than `ensure()` on purpose: opening the Food tab must
 * not write a settings row into the vault. Any failure — locked, no
 * IndexedDB, prerender — leaves the defaults in place, which is a correct
 * answer rather than an error state.
 */
async function refresh(): Promise<void> {
  try {
    const ui = (await settings.load())?.ui ?? {};
    const hideCalories = ui[HIDE_CALORIES_KEY] === true;
    const dismissedRaw = ui[SAFETY_REOFFER_DISMISSED_KEY];
    const safetyReOfferDismissedAt =
      typeof dismissedRaw === 'number' && Number.isFinite(dismissedRaw) ? dismissedRaw : null;
    loaded = true;
    if (
      hideCalories !== current.hideCalories ||
      safetyReOfferDismissedAt !== current.safetyReOfferDismissedAt
    ) {
      current = { hideCalories, safetyReOfferDismissedAt };
      emit();
    }
  } catch {
    loaded = false;
  }
}

function subscribePrefs(listener: Listener): () => void {
  listeners.add(listener);
  if (!loaded) void refresh();

  if (!vaultUnsubscribe) {
    vaultUnsubscribe = subscribeVault(() => {
      loaded = false;
      void refresh();
    });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && vaultUnsubscribe) {
      vaultUnsubscribe();
      vaultUnsubscribe = null;
    }
  };
}

/**
 * Switch energy numbers off or on.
 *
 * Applied optimistically so the screen changes on the same frame as the tap.
 * Switching it back on is exactly as easy as switching it off — a safety
 * setting the user cannot reverse is a trap, not a safeguard.
 */
export async function setHideCalories(next: boolean): Promise<void> {
  if (next !== current.hideCalories) {
    current = { ...current, hideCalories: next };
    emit();
  }
  await settings.setUiPreference(HIDE_CALORIES_KEY, next);
}

/** Record that the one-time safety re-offer was dismissed. Never reversed. */
export async function dismissSafetyReOffer(at: number = Date.now()): Promise<void> {
  current = { ...current, safetyReOfferDismissedAt: at };
  emit();
  await settings.setUiPreference(SAFETY_REOFFER_DISMISSED_KEY, at);
}

export interface NutritionPrefsBinding extends NutritionPrefs {
  /** True once the stored values have actually been read. */
  ready: boolean;
  setHideCalories: (next: boolean) => Promise<void>;
  dismissSafetyReOffer: () => Promise<void>;
}

/** The live nutrition preferences. */
export function useNutritionPrefs(): NutritionPrefsBinding {
  const prefs = useSyncExternalStore(
    subscribePrefs,
    () => current,
    () => DEFAULTS,
  );
  const ready = useSyncExternalStore(
    subscribePrefs,
    () => loaded,
    () => false,
  );

  return {
    ...prefs,
    ready,
    setHideCalories: useCallback((next: boolean) => setHideCalories(next), []),
    dismissSafetyReOffer: useCallback(() => dismissSafetyReOffer(), []),
  };
}
