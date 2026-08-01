"use client";

import { useCallback, useEffect, useState } from "react";
import { settings } from "@/lib/db/repos";
import type {
  MedicationEntry,
  SupplementEntry,
} from "@/lib/algorithms/medication-interactions";

/**
 * @file Where the medication list and supplement stack live.
 *
 * ## Why `AppSettings.ui` and not a table
 *
 * There is no `medications` table in the vault, and adding one is the vault
 * agent's call rather than this screen's — `docs/kg/specs/vault-schema.md`
 * owns the plaintext-index justification for every table, and inventing one
 * here would side-step that review. So both lists are stored as JSON strings
 * under namespaced keys in `AppSettings.ui`, which is *inside* the encrypted
 * settings row like every other preference. Nothing about them is plaintext.
 *
 * When a table does land, migrating is a read from here and a write to there.
 *
 * ## The shapes are the algorithm's, not this screen's
 *
 * `MedicationEntry` and `SupplementEntry` come from
 * `@/lib/algorithms/medication-interactions`, so what the settings screen
 * stores is exactly what `checkStack()` consumes. A second, screen-local shape
 * would need a translation layer, and translation layers are where the
 * `startedOn` date that makes `isActiveOn()` work gets quietly dropped.
 */

/** Namespaced key inside `AppSettings.ui` holding the medication list. */
export const MEDICATIONS_KEY = "profile.medications";
/** Namespaced key inside `AppSettings.ui` holding the supplement stack. */
export const SUPPLEMENTS_KEY = "profile.supplements";

/** What the user takes. */
export interface Stack {
  medications: MedicationEntry[];
  supplements: SupplementEntry[];
}

/** An empty stack. */
export const EMPTY_STACK: Stack = Object.freeze({
  medications: [],
  supplements: [],
});

/**
 * Parse a stored JSON array, tolerating anything.
 *
 * A malformed value returns an empty list rather than throwing: a preference
 * that cannot be read must never be able to stop the settings screen from
 * rendering, which is the one place the user could fix it.
 */
function parseList<T>(value: unknown): T[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Read the stack from the vault.
 *
 * @returns the stored lists, or empty ones when nothing has been saved
 */
export async function loadStack(): Promise<Stack> {
  const ui = (await settings.load())?.ui ?? {};
  return {
    medications: parseList<MedicationEntry>(ui[MEDICATIONS_KEY]),
    supplements: parseList<SupplementEntry>(ui[SUPPLEMENTS_KEY]),
  };
}

/**
 * Persist the medication list.
 *
 * @param medications the complete list, replacing what was stored
 */
export async function saveMedications(
  medications: readonly MedicationEntry[],
): Promise<void> {
  await settings.setUiPreference(MEDICATIONS_KEY, JSON.stringify(medications));
}

/**
 * Persist the supplement stack.
 *
 * @param supplements the complete stack, replacing what was stored
 */
export async function saveSupplements(
  supplements: readonly SupplementEntry[],
): Promise<void> {
  await settings.setUiPreference(SUPPLEMENTS_KEY, JSON.stringify(supplements));
}

/** The stack, loaded once and updated locally as the user edits it. */
export function useStack(): {
  stack: Stack;
  ready: boolean;
  setMedications: (next: MedicationEntry[]) => void;
  setSupplements: (next: SupplementEntry[]) => void;
} {
  const [stack, setStack] = useState<Stack>(EMPTY_STACK);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadStack()
      .then((loaded) => {
        if (cancelled) return;
        setStack(loaded);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMedications = useCallback((next: MedicationEntry[]) => {
    setStack((prior) => ({ ...prior, medications: next }));
    void saveMedications(next);
  }, []);

  const setSupplements = useCallback((next: SupplementEntry[]) => {
    setStack((prior) => ({ ...prior, supplements: next }));
    void saveSupplements(next);
  }, []);

  return { stack, ready, setMedications, setSupplements };
}
