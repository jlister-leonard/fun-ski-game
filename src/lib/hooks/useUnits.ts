"use client";

import { useCallback, useSyncExternalStore } from "react";
import { profiles, settings } from "@/lib/db/repos";
import { subscribe as subscribeVault } from "@/lib/vault";
import { DEFAULT_UNIT_SYSTEM, type UnitSystem } from "@/lib/units";

/**
 * The user's display-unit preference.
 *
 * Storage is always SI — kilograms, centimetres, millilitres. This is a
 * *display* setting and nothing else; flipping it must never rewrite a stored
 * value. See `src/lib/units/index.ts` for why that separation is load-bearing.
 *
 * The product default is imperial. A saved local preference always wins.
 *
 * ## Where it is stored, and one inconsistency worth knowing about
 *
 * The source of truth is `settings.ui['units.system']`. `Profile.unitPreference`
 * holds the same fact and is mirrored on write, but it is *not* read here,
 * because `ProfileRepo.ensure()` seeds it to `'metric'` — a default that
 * contradicts the product display default. Reading it would silently show
 * kilograms to a user who never chose them. When that seed default flips, this
 * hook can read straight from the profile and the mirror can go.
 */

/** Namespaced key inside `AppSettings.ui`. */
export const UNIT_SYSTEM_UI_KEY = "units.system";

type Listener = () => void;

const listeners = new Set<Listener>();
let current: UnitSystem = DEFAULT_UNIT_SYSTEM;
let loaded = false;
let vaultUnsubscribe: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function isUnitSystem(value: unknown): value is UnitSystem {
  return value === "metric" || value === "imperial";
}

/**
 * Read the stored preference into the module cache.
 *
 * Deliberately uses `load()` rather than `ensure()`: merely *looking* at a
 * screen should not write a settings row into the vault. Any failure — locked
 * vault, no IndexedDB, prerender — leaves the default in place, which is a
 * correct answer rather than an error state.
 */
async function refresh(): Promise<void> {
  try {
    const stored = (await settings.load())?.ui[UNIT_SYSTEM_UI_KEY];
    const next = isUnitSystem(stored) ? stored : DEFAULT_UNIT_SYSTEM;
    loaded = true;
    if (next !== current) {
      current = next;
      emit();
    }
  } catch {
    // Locked or unavailable. Keep the default and try again on the next
    // vault event.
    loaded = false;
  }
}

function subscribeUnits(listener: Listener): () => void {
  listeners.add(listener);

  if (!loaded) void refresh();

  // Unlocking makes the settings row readable, so re-read on every vault
  // transition rather than caching a value read while locked.
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
 * Persist a new display-unit preference.
 *
 * Applied optimistically so the UI flips on the same frame as the tap, then
 * written to the vault. Also mirrored onto `Profile.unitPreference` when a
 * profile already exists, so the two cannot disagree — but never *creates* a
 * profile, because that is onboarding's job.
 *
 * @param next the system to display in
 */
export async function setUnitSystem(next: UnitSystem): Promise<void> {
  if (next !== current) {
    current = next;
    emit();
  }
  await settings.setUiPreference(UNIT_SYSTEM_UI_KEY, next);
  try {
    const profile = await profiles.load();
    if (profile && profile.unitPreference !== next) {
      await profiles.save({ unitPreference: next });
    }
  } catch {
    // The mirror is a convenience for other readers, not the source of truth.
  }
}

export interface UnitsBinding {
  /** What to display in. Imperial until told otherwise. */
  system: UnitSystem;
  /** True once the stored preference has actually been read. */
  ready: boolean;
  /** Persist a change. Optimistic — the returned promise is the write. */
  setSystem: (next: UnitSystem) => Promise<void>;
}

/**
 * The live display-unit preference.
 *
 * A `useSyncExternalStore` binding over a module-level cache, so every screen
 * reads the same value and a change in Settings updates all of them without a
 * context provider. Returns the default during the static prerender, where
 * there is no IndexedDB to read.
 */
export function useUnits(): UnitsBinding {
  const system = useSyncExternalStore(
    subscribeUnits,
    () => current,
    () => DEFAULT_UNIT_SYSTEM
  );
  const ready = useSyncExternalStore(
    subscribeUnits,
    () => loaded,
    () => false
  );
  const setSystem = useCallback(
    (next: UnitSystem) => setUnitSystem(next),
    []
  );

  return { system, ready, setSystem };
}
