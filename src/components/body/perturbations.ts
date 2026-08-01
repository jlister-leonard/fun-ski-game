"use client";

import { useCallback, useEffect, useState } from "react";
import { settings } from "@/lib/db/repos";
import {
  PERTURBATION_DEFAULTS,
  type PerturbationEvent,
  type PerturbationType,
} from "@/lib/algorithms";

/**
 * Logged non-energetic events — the creatine defence.
 *
 * ## Why this exists at all
 *
 * The user takes 5 g of creatine a day. That pulls roughly 1.5 kg of water
 * into muscle over about four weeks. The scale flattens; nothing about their
 * fat loss has changed. Left unlogged, three modules that are each correct in
 * isolation compose into a harmful answer: the expenditure estimator reads the
 * flat scale as ~275 kcal/day of missing expenditure, the weekly check-in cuts
 * the target to compensate, and the trend filter's CUSUM *accelerates* its
 * adoption of the false plateau. See `channel/012` §creatine and
 * `channel/050` §3.
 *
 * Logging the event eliminates the spiral entirely — measured at a 0 kcal
 * target drop versus 100 kcal unprotected. Automatic detection does not: over
 * 200 simulated runs it caught a slow creatine ramp 18% of the time against a
 * 9% false-positive rate, which is no better than guessing. So the only
 * accurate path is to ask, and this is the affordance that asks.
 *
 * ## Where it is stored, and why that is temporary
 *
 * `athlete-profile.md` §1 puts these on `AthleteProfile.supplements[]`, and
 * that is where they belong. That record does not exist yet, so they live in
 * `settings.ui['body.perturbations']` as JSON — inside the encrypted settings
 * row like everything else, namespaced to this screen, which is exactly what
 * `SettingsRepo.setUiPreference` is for. Migrating them into the athlete
 * profile is a read of this key and a write of that record; nothing else in
 * this screen depends on the location.
 */

/** Namespaced key inside `AppSettings.ui`. */
export const PERTURBATIONS_UI_KEY = "body.perturbations";

/**
 * How long after the start date an event is still settling, per type.
 *
 * Creatine gets 42 days — 28 to saturate plus 14 to settle, per
 * `athlete-profile.md` §6.5. Past that the offset is already in the baseline
 * and the estimator is unbiased, which is why the question the UI asks is
 * *when* they started, not *whether*.
 */
export function settlingWindowDays(type: PerturbationType): number {
  const base = PERTURBATION_DEFAULTS[type].settlingDays;
  return type === "creatine-start" || type === "creatine-stop" ? base + 14 : base + 4;
}

/** The types this screen offers. The full union is wider; these are the ones a user recognises. */
export const LOGGABLE_TYPES: ReadonlyArray<{
  type: PerturbationType;
  label: string;
  detail: string;
}> = [
  {
    type: "creatine-start",
    label: "Started creatine",
    detail: "About +1.5 kg of water into muscle over four weeks. Not fat.",
  },
  {
    type: "creatine-stop",
    label: "Stopped creatine",
    detail: "The same water leaves again over about four weeks.",
  },
  {
    type: "carb-load",
    label: "Carb load or refeed",
    detail: "Glycogen carries water with it. Reverses within a week.",
  },
  {
    type: "sodium-spike",
    label: "Salty day",
    detail: "A day or two of extra fluid, then gone.",
  },
  {
    type: "travel",
    label: "Travel",
    detail: "Flights, unfamiliar food and less movement all shift fluid.",
  },
  {
    type: "illness",
    label: "Illness",
    detail: "Usually a drop in fluid rather than a drop in fat.",
  },
  {
    type: "new-training-block",
    label: "New training block",
    detail: "More work means more stored glycogen, and water with it.",
  },
];

const TYPES = new Set<string>(Object.keys(PERTURBATION_DEFAULTS));

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Parse the stored JSON, discarding anything malformed.
 *
 * A corrupt entry silently drops rather than throwing: a bad row in a UI
 * preference must never take the Body screen down, and a missing perturbation
 * degrades to the unprotected-but-honest behaviour rather than to a crash.
 */
export function parsePerturbations(raw: unknown): PerturbationEvent[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: PerturbationEvent[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (!isIsoDate(record.startDate)) continue;
    if (typeof record.type !== "string" || !TYPES.has(record.type)) continue;
    const event: PerturbationEvent = {
      startDate: record.startDate,
      type: record.type as PerturbationType,
    };
    if (typeof record.label === "string") event.label = record.label;
    out.push(event);
  }
  return out.sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
}

/** Read the logged events. Returns `[]` when the vault is locked or empty. */
export async function loadPerturbations(): Promise<PerturbationEvent[]> {
  try {
    return parsePerturbations((await settings.load())?.ui[PERTURBATIONS_UI_KEY]);
  } catch {
    return [];
  }
}

/** Replace the logged events. */
export async function savePerturbations(events: readonly PerturbationEvent[]): Promise<void> {
  await settings.setUiPreference(PERTURBATIONS_UI_KEY, JSON.stringify(events));
}

export interface PerturbationsBinding {
  events: PerturbationEvent[];
  ready: boolean;
  add: (event: PerturbationEvent) => Promise<void>;
  remove: (startDate: string, type: PerturbationType) => Promise<void>;
}

/**
 * The logged perturbation events, with add/remove.
 *
 * Plain state rather than a live query: this is a single settings row that
 * only this screen writes, so a subscription would buy nothing.
 */
export function usePerturbations(): PerturbationsBinding {
  const [events, setEvents] = useState<PerturbationEvent[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadPerturbations().then((loaded) => {
      if (cancelled) return;
      setEvents(loaded);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const add = useCallback(
    async (event: PerturbationEvent) => {
      const next = [...events.filter((e) => !(e.startDate === event.startDate && e.type === event.type)), event].sort(
        (a, b) => (a.startDate < b.startDate ? -1 : 1)
      );
      setEvents(next);
      await savePerturbations(next);
    },
    [events]
  );

  const remove = useCallback(
    async (startDate: string, type: PerturbationType) => {
      const next = events.filter((e) => !(e.startDate === startDate && e.type === type));
      setEvents(next);
      await savePerturbations(next);
    },
    [events]
  );

  return { events, ready, add, remove };
}
