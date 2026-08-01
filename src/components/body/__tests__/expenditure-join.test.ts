import { describe, expect, it } from "vitest";
import { computeWeightTrend } from "@/lib/algorithms";
import type { Profile } from "@/lib/db/types";
import { buildExpenditureDays, coldStartPrior } from "../useExpenditure";

/**
 * The join between the weight trend and the food diary.
 *
 * These are the two failure modes that would silently corrupt every
 * expenditure number on the Body screen, so they are asserted rather than
 * assumed: an unlogged day must stay `null` (a zero invents a deficit that
 * never happened and drags the estimate down), and the estimator must receive
 * the perturbation-corrected series (or creatine water gets counted as burned
 * fat, which is the exact spiral `channel/012` measured).
 */

function profile(patch: Partial<Profile> = {}): Profile {
  return {
    id: "profile",
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    displayName: null,
    birthDate: "1990-06-01",
    sex: "male",
    heightCm: 180,
    activityLevel: "moderately_active",
    timeZone: "America/New_York",
    unitPreference: "imperial",
    ...patch,
  };
}

describe("buildExpenditureDays", () => {
  const trend = computeWeightTrend([
    { date: "2026-07-01", kg: 88.0 },
    { date: "2026-07-02", kg: 87.8 },
    { date: "2026-07-03", kg: 87.9 },
    { date: "2026-07-04", kg: 87.6 },
  ]);

  it("emits null, never zero, for a day with no food log", () => {
    const days = buildExpenditureDays(trend, [
      { date: "2026-07-01", intakeKcal: 2400 },
      { date: "2026-07-03", intakeKcal: 2500 },
    ]);
    expect(days.map((d) => d.intakeKcal)).toEqual([2400, null, 2500, null]);
  });

  it("aligns one row per trend day, in order", () => {
    const days = buildExpenditureDays(trend, []);
    expect(days.map((d) => d.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
  });

  it("passes the perturbation-corrected series to the estimator", () => {
    const withCreatine = computeWeightTrend(
      [
        { date: "2026-07-01", kg: 88.0 },
        { date: "2026-07-02", kg: 88.4 },
        { date: "2026-07-03", kg: 88.7 },
        { date: "2026-07-04", kg: 88.9 },
      ],
      { perturbations: [{ startDate: "2026-07-01", type: "creatine-start" }] },
    );
    const days = buildExpenditureDays(withCreatine, []);
    const last = days[days.length - 1];
    expect(last.perturbationActive).toBe(true);
    // The corrected series must sit below the displayed trend: the modelled
    // water is removed from the number the energy regression consumes.
    expect(last.energyTrendKg).toBeLessThan(last.trendKg);
  });

  it("ignores intake rows outside the trend window", () => {
    const days = buildExpenditureDays(trend, [
      { date: "2026-06-30", intakeKcal: 2200 },
      { date: "2026-07-02", intakeKcal: 2300 },
    ]);
    expect(days).toHaveLength(4);
    expect(days[1].intakeKcal).toBe(2300);
  });
});

describe("coldStartPrior", () => {
  it("returns null when the profile cannot support an equation", () => {
    expect(coldStartPrior(null, 88, null)).toBeNull();
    expect(coldStartPrior(profile({ sex: null }), 88, null)).toBeNull();
    expect(coldStartPrior(profile({ heightCm: null }), 88, null)).toBeNull();
    expect(coldStartPrior(profile({ activityLevel: null }), 88, null)).toBeNull();
    expect(coldStartPrior(profile({ birthDate: null }), 88, null)).toBeNull();
    expect(coldStartPrior(profile(), null, null)).toBeNull();
  });

  it("translates the stored activity vocabulary into the estimator's", () => {
    const sedentary = coldStartPrior(profile({ activityLevel: "sedentary" }), 88, null);
    const extreme = coldStartPrior(profile({ activityLevel: "extremely_active" }), 88, null);
    expect(sedentary).not.toBeNull();
    expect(extreme).not.toBeNull();
    expect(extreme!.prior.tdeeKcal).toBeGreaterThan(sedentary!.prior.tdeeKcal);
    // Same BMR either way — only the activity multiplier differs.
    expect(extreme!.bmrKcal).toBe(sedentary!.bmrKcal);
  });

  it("carries a wide standard deviation, because a predictive equation is a guess", () => {
    expect(coldStartPrior(profile(), 88, null)!.prior.sdKcal).toBeGreaterThan(300);
  });
});
