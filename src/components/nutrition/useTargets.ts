'use client';

import { useMemo } from 'react';
import {
  addDays,
  goals,
  profiles,
  toDateKey,
  weights,
  type WeightSeriesPoint,
} from '@/lib/db/repos';
import type { ActivityLevel, Goal, Profile } from '@/lib/db/types';
import {
  actionable,
  assessDataSufficiency,
  coldStartTdee,
  computeMacroTargets,
  computeWeightTrend,
  estimateExpenditure,
  hasBlock,
  mifflinStJeorBmr,
  summarizeTrend,
  validateTargets,
  type ExpenditureDay,
  type Finding,
  type MacroTargets,
  type TrainingLoad,
  type UserProfile,
} from '@/lib/algorithms';
import { useLiveQuery, type LiveState } from './live';

/**
 * @file Where the day's targets come from — and when the app refuses to invent
 * one.
 *
 * ## The rule this module exists to enforce
 *
 * A target that is fabricated from nothing is worse than no target, because it
 * looks exactly like a real one. `macro-targets.ts` needs a height, an age, a
 * sex, a trend bodyweight and an expenditure estimate; if any of those is
 * genuinely absent, the honest answer is "not yet", and this hook returns
 * `status: 'insufficient'` with the specific list of what is missing.
 *
 * ## And the rule that outranks it
 *
 * `macro-targets.ts` *proposes*; `guardrails.ts` *disposes*. Per the
 * integration contract in `docs/kg/channel/012-nutrition-algorithms.md`, a
 * `level: 'block'` finding is fatal: **do not render the target**. So the
 * proposal is always run through `validateTargets()` before it is allowed out
 * of this module, and a blocked result returns `status: 'blocked'` with the
 * findings rather than the numbers.
 *
 * ## What this module never does
 *
 * It never lowers a target in response to a low food log. `guardrails.ts`
 * already encodes that rule, and it is restated here because it is the one
 * most likely to be undone by a well-meaning refactor: a run of low days is at
 * least as likely to be under-logging as under-eating, and lowering the target
 * is the wrong response to both. Nothing in this file reads the diary and
 * subtracts.
 */

/** How far back the weight trend and expenditure estimator look. */
const WINDOW_DAYS = 180;

const NO_POINTS: readonly WeightSeriesPoint[] = Object.freeze([]);

/**
 * Everything the target computation needs, read as one live snapshot.
 *
 * Bundled into a single query because a partially-loaded input set produces a
 * transiently wrong "not enough data" message, which is precisely the message
 * that must be trustworthy.
 */
export interface TargetInputs {
  profile: Profile | null;
  /**
   * Age in whole years, resolved when the snapshot was read.
   *
   * Computed here rather than during render because the current date is not a
   * pure input: a component that calls `Date.now()` while rendering produces a
   * result that changes without a state change, and React's purity lint
   * rightly rejects it.
   */
  ageYears: number | null;
  goal: Goal | null;
  weightSeries: readonly WeightSeriesPoint[];
  intakeByDate: ReadonlyMap<string, number>;
}

const EMPTY_INPUTS: TargetInputs = Object.freeze({
  profile: null,
  ageYears: null,
  goal: null,
  weightSeries: NO_POINTS,
  intakeByDate: new Map<string, number>(),
});

/** Live profile, goal and weight series. */
export function useTargetInputs(
  intakeByDate: ReadonlyMap<string, number>,
): LiveState<TargetInputs> & { intakeByDate: ReadonlyMap<string, number> } {
  const { from, to } = useMemo(() => {
    const today = toDateKey(new Date());
    return { from: addDays(today, -(WINDOW_DAYS - 1)), to: today };
  }, []);

  const state = useLiveQuery<TargetInputs>(
    `targets:inputs:${from}..${to}`,
    async () => {
      // All three reads must be issued in the same tick.
      //
      // Dexie's liveQuery only registers the tables touched before the first
      // `await` resolves: our repositories decrypt with `crypto.subtle`, which
      // settles on a different task source and drops the querier out of the
      // observability zone. Awaited in sequence, only `profiles` was tracked —
      // so logging a weight or changing a goal left the targets stale until a
      // reload. See docs/kg/channel/095-recovery.md, where this was found in a
      // browser rather than deduced.
      const [profile, goal, weightSeries] = await Promise.all([
        profiles.load(),
        goals.getActive(),
        weights.getSeries(from, to),
      ]);
      return {
        profile,
        ageYears: ageYearsFrom(profile?.birthDate ?? null),
        goal,
        weightSeries,
        intakeByDate: new Map<string, number>(),
      };
    },
    EMPTY_INPUTS,
  );

  return { ...state, intakeByDate };
}

/* ------------------------------------------------------------------ */
/* Pure computation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Carbohydrate allocation is biased by training load, and the diary has no
 * training data of its own. Deriving it from the profile's activity level is
 * a documented approximation rather than a measurement; it moves carbs and
 * fat within an already-safe envelope and never moves the energy target.
 */
const TRAINING_LOAD_BY_ACTIVITY: Readonly<Record<ActivityLevel, TrainingLoad>> = {
  sedentary: 'none',
  lightly_active: 'light',
  moderately_active: 'moderate',
  very_active: 'high',
  extremely_active: 'veryHigh',
};

export type TargetStatus = 'ready' | 'insufficient' | 'blocked' | 'loading' | 'locked';

export interface TargetResult {
  status: TargetStatus;
  targets: MacroTargets | null;
  /** Plain-language list of what is still needed, for `insufficient`. */
  missing: string[];
  /** Guardrail findings. Non-empty is normal; `blocked` is not. */
  findings: Finding[];
  /** `'cold-start'` until there is enough logged data to estimate expenditure. */
  basis: 'cold-start' | 'estimated' | null;
  /** Confidence label from the expenditure estimator, when there is one. */
  confidence: string | null;
  /** Estimated BMR, kcal/day. Used for the energy floor. */
  bmrKcal: number | null;
}

/**
 * Whole years since `birthDate`.
 *
 * Exported so the screen can derive a `PersonContext` from the same snapshot
 * rather than recomputing the current date during render.
 */
export function ageYearsFrom(birthDate: string | null, at = new Date()): number | null {
  if (!birthDate) return null;
  const born = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(born.getTime())) return null;
  let age = at.getFullYear() - born.getFullYear();
  const monthDiff = at.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getDate() < born.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Compute the day's targets, or explain why there are none.
 *
 * Pure: every input is an argument, so the test suite can drive the
 * "not enough data" branches directly.
 */
export function computeTargets(inputs: TargetInputs): TargetResult {
  const { profile, ageYears, goal, weightSeries, intakeByDate } = inputs;

  const missing: string[] = [];
  if (!profile?.sex) missing.push('your sex, for the metabolic equation');
  if (!profile?.heightCm) missing.push('your height');
  if (ageYears === null) missing.push('your date of birth');
  if (weightSeries.length === 0) missing.push('at least one weigh-in');

  if (missing.length > 0 || !profile || !profile.sex || !profile.heightCm || ageYears === null) {
    return {
      status: 'insufficient',
      targets: null,
      missing,
      findings: [],
      basis: null,
      confidence: null,
      bmrKcal: null,
    };
  }

  const trend = computeWeightTrend(
    weightSeries.map((p) => ({ date: p.date, kg: p.kg })),
  );
  const summary = summarizeTrend(trend);
  if (!summary) {
    return {
      status: 'insufficient',
      targets: null,
      missing: ['a weigh-in the trend filter can use'],
      findings: [],
      basis: null,
      confidence: null,
      bmrKcal: null,
    };
  }

  const bodyweightKg = summary.trendKg;
  const activityLevel: ActivityLevel = profile.activityLevel ?? 'moderately_active';

  const cold = coldStartTdee({
    sex: profile.sex,
    weightKg: bodyweightKg,
    heightCm: profile.heightCm,
    ageYears,
    activityLevel,
  });
  const bmrKcal = mifflinStJeorBmr(profile.sex, bodyweightKg, profile.heightCm, ageYears);

  // Days with no logged intake come through as `null`, never as 0. "Did not
  // log" and "ate nothing" are completely different facts and conflating them
  // corrupts the expenditure estimate.
  const days: ExpenditureDay[] = trend.map((point) => ({
    date: point.date,
    trendKg: point.trendKg,
    energyTrendKg: point.energyTrendKg,
    perturbationActive: point.perturbationActive,
    intakeKcal: intakeByDate.get(point.date) ?? null,
  }));

  const sufficiency = assessDataSufficiency(days);
  const estimate = estimateExpenditure(days, {
    prior: { tdeeKcal: cold.tdeeKcal, sdKcal: cold.sdKcal },
    bmrKcal,
  });
  const basis: 'cold-start' | 'estimated' = estimate.source === 'prior' ? 'cold-start' : 'estimated';

  const direction = goal?.direction ?? 'maintain';
  // A goal's rate is stored in kg/week; the target generator wants it as a
  // signed percentage of bodyweight per week. Omitting it lets the generator
  // pick its own default, which is the right behaviour when no goal is set.
  const targetRatePctBwPerWeek =
    goal && Number.isFinite(goal.targetRateKgPerWeek) && goal.targetRateKgPerWeek !== 0
      ? (goal.targetRateKgPerWeek / bodyweightKg) * 100
      : undefined;

  const targets = computeMacroTargets({
    sex: profile.sex,
    ageYears,
    heightCm: profile.heightCm,
    bodyweightKg,
    goal: direction,
    targetRatePctBwPerWeek,
    tdeeKcal: estimate.tdeeKcal,
    bmrKcal,
    trainingLoad: TRAINING_LOAD_BY_ACTIVITY[activityLevel],
  });

  const userProfile: UserProfile = {
    sex: profile.sex,
    ageYears,
    heightCm: profile.heightCm,
    bodyweightKg,
    goal: direction,
    goalWeightKg: goal?.targetWeightKg ?? undefined,
    goalBodyFatPct: goal?.targetBodyFatPct ?? undefined,
  };

  const findings = validateTargets(
    {
      kcal: targets.kcal,
      proteinG: targets.proteinG,
      carbG: targets.carbG,
      fatG: targets.fatG,
      targetRatePctBwPerWeek: targets.targetRatePctBwPerWeek,
    },
    { profile: userProfile, bmrKcal },
  );

  if (hasBlock(findings)) {
    return {
      status: 'blocked',
      targets: null,
      missing: [],
      findings: actionable(findings),
      basis,
      confidence: estimate.confidenceLabel,
      bmrKcal,
    };
  }

  return {
    status: 'ready',
    targets,
    missing: [],
    findings: actionable(findings),
    basis,
    confidence: sufficiency.canUpdate ? estimate.confidenceLabel : 'holding',
    bmrKcal,
  };
}

const LOADING_RESULT: TargetResult = Object.freeze({
  status: 'loading' as const,
  targets: null,
  missing: [],
  findings: [],
  basis: null,
  confidence: null,
  bmrKcal: null,
});

/** The day's targets, live. */
export function useTargets(intakeByDate: ReadonlyMap<string, number>): TargetResult {
  const state = useTargetInputs(intakeByDate);

  return useMemo(() => {
    if (state.status === 'loading') return LOADING_RESULT;
    if (state.status !== 'ready') return { ...LOADING_RESULT, status: 'locked' as const };
    return computeTargets({ ...state.data, intakeByDate });
  }, [state.status, state.data, intakeByDate]);
}
