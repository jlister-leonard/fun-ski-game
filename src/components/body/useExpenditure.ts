"use client";

import { useMemo, useSyncExternalStore } from "react";
import { foodLogs, profiles, subscribeQuery, weights } from "@/lib/db/repos";
import type { Profile, WeightEntry } from "@/lib/db/types";
import {
  assessDataSufficiency,
  coldStartTdee,
  estimateExpenditure,
  type DataSufficiency,
  type ExpenditureDay,
  type ExpenditureEstimate,
  type TrendPoint,
} from "@/lib/algorithms";

/**
 * Adaptive expenditure for the Body screen.
 *
 * ## Why this is a screen-level hook and not a repo query
 *
 * Expenditure is a *join*: the smoothed weight trend on one side, logged food
 * energy on the other, over the same days. Neither repository owns both, and
 * the estimator wants a contiguous daily series with `null` — never `0` — on
 * the days the user did not log. A zero would tell the estimator the user ate
 * nothing that day, which fabricates a deficit that never happened; the repo
 * layer already refuses to emit one (`getDailyIntakeSeries` omits unlogged
 * days) and this hook preserves that distinction across the join.
 *
 * ## One subscription, not three
 *
 * Intake, the latest weigh-in and the profile are read inside a single Dexie
 * live query. Dexie tracks every table the querier touched, so the composite
 * re-runs when any of them changes — one subscription, one snapshot, no
 * chance of the three falling out of step mid-render.
 */

/** Kilograms and kcal throughout. Conversion is a display concern. */
export interface ExpenditureView {
  /**
   * The posterior estimate, or `null` when there is not yet a single day with
   * both a trend weight and a logged intake. `null` is the honest answer on
   * day one — the card renders what is missing rather than a number.
   */
  estimate: ExpenditureEstimate | null;
  /** Whether a cold-start prior could be built from the profile at all. */
  hasPrior: boolean;
  /** Logging sufficiency over the last seven days. */
  sufficiency: DataSufficiency | null;
  /** Days in the window with a logged intake. */
  intakeDays: number;
  /** Days in the window with a real weigh-in. */
  weighInDays: number;
  /** False until the first emission from the vault. */
  ready: boolean;
}

const EMPTY: ExpenditureView = {
  estimate: null,
  hasPrior: false,
  sufficiency: null,
  intakeDays: 0,
  weighInDays: 0,
  ready: false,
};

interface Snapshot {
  intake: Array<{ date: string; intakeKcal: number | null }>;
  latest: WeightEntry | null;
  profile: Profile | null;
}

/**
 * One live subscription per window, shared by every consumer of that window.
 *
 * The `useSyncExternalStore` shape rather than `useState` + `useEffect`
 * because `getSnapshot` must return a referentially stable value between
 * emissions — and because resetting state from inside an effect is a
 * cascading render, which the lint rules correctly refuse. Mirrors
 * `src/lib/hooks/useWeightSeries.ts`.
 */
interface RangeEntry {
  snapshot: Snapshot | null;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}

const registry = new Map<string, RangeEntry>();

function publish(key: string, next: Snapshot | null): void {
  const entry = registry.get(key);
  if (!entry) return;
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
}

function subscribeRange(
  key: string,
  from: string,
  to: string,
  listener: () => void,
): () => void {
  let entry = registry.get(key);
  if (!entry) {
    entry = { snapshot: null, listeners: new Set(), stop: null };
    registry.set(key, entry);
  }
  entry.listeners.add(listener);

  if (!entry.stop) {
    entry.stop = subscribeQuery<Snapshot>(
      async () => {
        const [intake, latest, profile] = await Promise.all([
          foodLogs.getDailyIntakeSeries(from, to),
          weights.getLatest(),
          profiles.load(),
        ]);
        return { intake, latest, profile };
      },
      (value) => publish(key, value),
      // A locked vault is an expected state — the gate is already showing the
      // lock screen. Keep the last honest answer: nothing.
      () => publish(key, null),
    );
  }

  return () => {
    const current = registry.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.stop?.();
      registry.delete(key);
    }
  };
}

/**
 * Join the trend series to logged intake.
 *
 * @param trend one row per calendar day, from `computeWeightTrend`
 * @param intake days that have a food log; days without one are absent
 * @returns a contiguous daily series shaped for `estimateExpenditure`
 */
export function buildExpenditureDays(
  trend: readonly TrendPoint[],
  intake: ReadonlyArray<{ date: string; intakeKcal: number | null }>,
): ExpenditureDay[] {
  const byDate = new Map<string, number>();
  for (const day of intake) {
    if (day.intakeKcal !== null && Number.isFinite(day.intakeKcal)) {
      byDate.set(day.date, day.intakeKcal);
    }
  }
  return trend.map((point) => ({
    date: point.date,
    trendKg: point.trendKg,
    // The perturbation-corrected series. Creatine water is not stored energy;
    // feeding it to an energy-balance calculation is exactly the bug that
    // makes the estimator cut a working plan's calories.
    energyTrendKg: point.energyTrendKg,
    perturbationActive: point.perturbationActive,
    intakeKcal: byDate.get(point.date) ?? null,
  }));
}

/**
 * The cold-start prior, or `null` when the profile cannot support one.
 *
 * Returning `null` matters: `estimateExpenditure` with no prior and no data
 * reports a TDEE of zero, and the card keys off that to say "not yet" instead
 * of printing a number nobody should read.
 *
 * @param profile the stored profile, or `null`
 * @param weightKg current trend weight
 * @param bodyFatPct body fat from a smart scale, when it has one
 */
export function coldStartPrior(
  profile: Profile | null,
  weightKg: number | null,
  bodyFatPct: number | null,
): { prior: { tdeeKcal: number; sdKcal: number }; bmrKcal: number } | null {
  if (!profile || weightKg === null) return null;
  if (!profile.sex || profile.heightCm === null || !profile.activityLevel) return null;
  if (!profile.birthDate) return null;

  const [y, m, d] = profile.birthDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const now = new Date();
  let ageYears = now.getFullYear() - y;
  const monthDiff = now.getMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d)) ageYears -= 1;
  if (ageYears <= 0 || ageYears > 120) return null;

  const cold = coldStartTdee({
    sex: profile.sex,
    weightKg,
    heightCm: profile.heightCm,
    ageYears,
    activityLevel: profile.activityLevel,
    ...(bodyFatPct !== null ? { bodyFatPct } : {}),
  });

  return {
    prior: { tdeeKcal: cold.tdeeKcal, sdKcal: cold.sdKcal },
    bmrKcal: cold.bmrKcal,
  };
}

/**
 * Live expenditure for a trend window.
 *
 * @param trend output of `computeWeightTrend`, kilograms
 * @param from inclusive `YYYY-MM-DD` start of the window
 * @param to inclusive `YYYY-MM-DD` end of the window
 * @returns the estimate and everything the card needs to explain it
 */
export function useExpenditure(
  trend: readonly TrendPoint[],
  from: string,
  to: string,
): ExpenditureView {
  const key = `${from}..${to}`;
  const snapshot = useSyncExternalStore(
    useMemo(
      () => (listener: () => void) => subscribeRange(key, from, to, listener),
      [key, from, to],
    ),
    () => registry.get(key)?.snapshot ?? null,
    () => null,
  );

  return useMemo(() => {
    if (snapshot === null) return EMPTY;

    const days = buildExpenditureDays(trend, snapshot.intake);
    const intakeDays = days.filter((d) => d.intakeKcal !== null).length;
    const weighInDays = trend.filter((p) => p.observed).length;
    const sufficiency = assessDataSufficiency(days);

    if (days.length === 0 || intakeDays === 0) {
      return {
        estimate: null,
        hasPrior: false,
        sufficiency,
        intakeDays,
        weighInDays,
        ready: true,
      };
    }

    const seed = coldStartPrior(
      snapshot.profile,
      days[days.length - 1].trendKg,
      snapshot.latest?.bodyFatPct ?? null,
    );

    const estimate = estimateExpenditure(days, {
      ...(seed ? { prior: seed.prior, bmrKcal: seed.bmrKcal } : {}),
    });

    return {
      estimate,
      hasPrior: seed !== null,
      sufficiency,
      intakeDays,
      weighInDays,
      ready: true,
    };
  }, [snapshot, trend]);
}
