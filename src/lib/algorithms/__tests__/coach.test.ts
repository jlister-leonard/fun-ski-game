/**
 * coach.test.ts — the A7 rules engine, as executable requirements.
 *
 * The organising principle matches `readiness.test.ts`: a rule that is only
 * enforced by the code that happens to exist today is not a rule. So the
 * properties that carry a safety or product meaning are swept or asserted
 * directly rather than spot-checked through a happy path:
 *
 * - **Adequacy outranks deficit progress** (`nutrition-personalization.md` §3.4
 *   requirement 1) — swept over every domain/severity pair, not tested on one
 *   example, because the failure mode is a single severity bump.
 * - **Nothing escapes the guardrails.** Copy lints, the ED numeric gate and
 *   `hasBlock()` are tested by pushing violating drafts through the real
 *   pipeline, not by inspecting the constants.
 * - **The engine never celebrates loss and never rewards a bigger deficit.**
 *   Asserted over the output of a fast-loss week, which is the exact input a
 *   naive implementation congratulates.
 * - **Suppressing a false alarm is visible output**, not a silent filter.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  COACH_FORBIDDEN_COPY,
  COACH_LIMITS,
  DOMAIN_RANK,
  dataGaps,
  guardInsight,
  hasSuppressedAlarms,
  honestCalendarWeeks,
  insightScore,
  muscleBudget,
  reviewWeek,
  type CoachInput,
  type CoachInsight,
  type InsightDomain,
  type InsightSeverity,
  type MuscleWeek,
} from '../coach';
import { hasBlock, type Finding, type UserProfile } from '../guardrails';
import type { MicronutrientDatabase, PersonContext } from '../micronutrients';
import type { TrendSummary } from '../weight-trend';
import type { ExpenditureEstimate } from '../expenditure';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const dbPath = fileURLToPath(new URL('../../../../docs/kg/specs/micronutrients.json', import.meta.url));
const MICRONUTRIENT_DB = JSON.parse(readFileSync(dbPath, 'utf8')) as MicronutrientDatabase;

/** Synthetic athlete used to exercise a multi-goal cutting scenario. */
const PROFILE: UserProfile = {
  sex: 'male',
  ageYears: 35,
  heightCm: 177,
  bodyweightKg: 83,
  bodyFatPct: 24,
  goal: 'cut',
  goalBodyFatPct: 18,
};

const PERSON: PersonContext = { sex: 'male', ageYears: 35, energyKcal: 2300 };

function trend(over: Partial<TrendSummary> = {}): TrendSummary {
  return {
    trendKg: 83,
    weeklyChangeKg: -0.55,
    weeklyChangePctBw: -0.65,
    weeklyChangeCi95: [-0.75, -0.35],
    weighInsLast14d: 12,
    adherence14d: 0.86,
    perturbationActive: false,
    stepSuspected: false,
    rateIsActionable: true,
    date: '2026-07-26',
    ...over,
  };
}

function expenditure(over: Partial<ExpenditureEstimate> = {}): ExpenditureEstimate {
  return {
    tdeeKcal: 2850,
    sdKcal: 110,
    ci95: [2634, 3066],
    dataTdeeKcal: 2870,
    dataSdKcal: 130,
    dataWeight: 0.78,
    source: 'blended',
    confidence: 0.8,
    confidenceLabel: 'high',
    daysUsed: 42,
    imputedDays: 0,
    effectiveSampleSize: 28,
    meanIntakeKcal: 2280,
    observedWeeklyChangeKg: -0.55,
    clamped: false,
    perturbationDays: 0,
    unexplainedStepKg: 0,
    slopeChangeKcal: 0,
    regimeChangeSuspected: false,
    userPrompt: null,
    suppressAdjustment: false,
    notes: [],
    ...over,
  };
}

/** Seven days at target, so the adequacy rules stay quiet unless asked. */
function week(kcal: number, target = 2300) {
  return Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-${String(20 + i).padStart(2, '0')}`,
    kcal,
    targetKcal: target,
  }));
}

function baseInput(over: Partial<CoachInput> = {}): CoachInput {
  return {
    weekEndingDate: '2026-07-26',
    profile: PROFILE,
    goals: { targetRatePctBwPerWeek: -0.65, targetBodyFatPct: 18, startBodyFatPct: 24, weeksElapsed: 6 },
    trend: trend(),
    expenditure: expenditure(),
    intake: {
      days: week(2280),
      meanKcal: 2280,
      meanProteinG: 180,
      meanFatG: 70,
      meanCarbG: 220,
      meanFiberG: 32,
      targetKcal: 2300,
    },
    ...over,
  };
}

function byId(insights: readonly CoachInsight[], id: string): CoachInsight | undefined {
  return insights.find((i) => i.id === id);
}

const ALL_DOMAINS = Object.keys(DOMAIN_RANK) as InsightDomain[];
const ALL_SEVERITIES: InsightSeverity[] = ['info', 'suggestion', 'warning', 'critical'];

/* ================================================================== */
/* 1. Ranking — the ED-aware prominence rule is structural             */
/* ================================================================== */

describe('ranking (nutrition-personalization.md §3.4 requirement 1)', () => {
  it('ranks adequacy above body-composition for every severity pairing', () => {
    for (const adequacySeverity of ALL_SEVERITIES) {
      for (const bodyCompSeverity of ALL_SEVERITIES) {
        expect(insightScore('adequacy', adequacySeverity)).toBeGreaterThan(
          insightScore('body-composition', bodyCompSeverity),
        );
      }
    }
  });

  it('never lets severity lift an insight out of its domain band', () => {
    for (const a of ALL_DOMAINS) {
      for (const b of ALL_DOMAINS) {
        if (DOMAIN_RANK[a] >= DOMAIN_RANK[b]) continue;
        for (const sa of ALL_SEVERITIES) {
          for (const sb of ALL_SEVERITIES) {
            expect(insightScore(a, sa)).toBeGreaterThan(insightScore(b, sb));
          }
        }
      }
    }
  });

  it('orders severities within a band', () => {
    expect(insightScore('training', 'critical')).toBeGreaterThan(insightScore('training', 'warning'));
    expect(insightScore('training', 'warning')).toBeGreaterThan(insightScore('training', 'suggestion'));
    expect(insightScore('training', 'suggestion')).toBeGreaterThan(insightScore('training', 'info'));
  });

  it('keeps every score inside 0..1', () => {
    for (const d of ALL_DOMAINS) {
      for (const s of ALL_SEVERITIES) {
        const score = insightScore(d, s);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns insights sorted by score descending', () => {
    const review = reviewWeek(
      baseInput({
        intake: {
          days: week(2280),
          meanKcal: 2280,
          meanProteinG: 80, // below the hard floor — forces an adequacy insight
          meanFatG: 70,
          meanCarbG: 220,
          meanFiberG: 10,
          targetKcal: 2300,
        },
      }),
    );
    const scores = review.insights.map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('puts an adequacy insight ahead of the body-composition one in a real review', () => {
    const review = reviewWeek(
      baseInput({
        intake: {
          days: week(2280),
          meanKcal: 2280,
          meanProteinG: 80,
          meanFatG: 70,
          meanCarbG: 220,
          meanFiberG: 32,
          targetKcal: 2300,
        },
      }),
    );
    const adequacyIdx = review.insights.findIndex((i) => i.domain === 'adequacy');
    const bodyIdx = review.insights.findIndex((i) => i.domain === 'body-composition');
    expect(adequacyIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(adequacyIdx).toBeLessThan(bodyIdx);
  });
});

/* ================================================================== */
/* 2. The guardrail pipeline                                           */
/* ================================================================== */

describe('guardInsight', () => {
  const passing = {
    id: 'test-ok',
    domain: 'training' as InsightDomain,
    severity: 'info' as InsightSeverity,
    headline: 'A neutral headline',
    detail: 'A neutral body.',
    action: null,
    caveat: null,
    inputs: [],
    confidence: 'well-established' as const,
    tier: 1 as const,
    findings: [] as Finding[],
    suppressesAlarm: false,
  };

  it('passes a clean insight and scores it', () => {
    const r = guardInsight(passing, { numericTargetsSuppressed: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.insight.score).toBe(insightScore('training', 'info'));
  });

  it('blocks copy that advises changing a prescribed medication', () => {
    const r = guardInsight(
      { ...passing, action: 'You should reduce your sertraline dose while cutting.' },
      { numericTargetsSuppressed: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockedBy.level).toBe('block');
      expect(r.blockedBy.code).toBe('COACH_COPY_MEDICATION_DIRECTIVE');
    }
  });

  it('blocks congratulatory day-summary copy', () => {
    const r = guardInsight(
      { ...passing, detail: 'Great job — you came in under budget every day.' },
      { numericTargetsSuppressed: false },
    );
    expect(r.ok).toBe(false);
  });

  it('blocks copy that celebrates the scale going down', () => {
    const r = guardInsight(
      { ...passing, headline: 'Fantastic loss this week' },
      { numericTargetsSuppressed: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockedBy.code).toBe('COACH_COPY_FORBIDDEN');
  });

  it('blocks copy that frames a bigger deficit as a better outcome', () => {
    const r = guardInsight(
      { ...passing, detail: 'A bigger deficit here would be better for the timeline.' },
      { numericTargetsSuppressed: false },
    );
    expect(r.ok).toBe(false);
  });

  it('blocks streak mechanics', () => {
    const r = guardInsight(
      { ...passing, detail: 'Seven days in a row logged.' },
      { numericTargetsSuppressed: false },
    );
    expect(r.ok).toBe(false);
  });

  it('blocks an insight carrying its own block finding', () => {
    const r = guardInsight(
      {
        ...passing,
        findings: [{ ok: false, level: 'block', code: 'TEST_BLOCK', message: 'no' }],
      },
      { numericTargetsSuppressed: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockedBy.code).toBe('TEST_BLOCK');
  });

  it('suppresses calorie- and weight-quoting domains when the ED gate is closed', () => {
    for (const domain of ['body-composition', 'nutrition'] as InsightDomain[]) {
      const r = guardInsight({ ...passing, domain }, { numericTargetsSuppressed: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.blockedBy.code).toBe('COACH_NUMERIC_GATE_CLOSED');
    }
  });

  it('leaves non-numeric domains alone when the ED gate is closed', () => {
    const r = guardInsight({ ...passing, domain: 'training' }, { numericTargetsSuppressed: true });
    expect(r.ok).toBe(true);
  });

  it('every forbidden pattern actually matches the thing it describes', () => {
    // A lint whose regex never fires is worse than no lint, because it reads
    // like protection. One positive sample per rule.
    const samples = [
      'Great loss this week',
      'Congratulations on the week',
      'A deeper deficit would be better',
      'Nice streak going',
    ];
    for (let i = 0; i < COACH_FORBIDDEN_COPY.length; i++) {
      expect(COACH_FORBIDDEN_COPY[i].pattern.test(samples[i])).toBe(true);
    }
  });
});

/* ================================================================== */
/* 3. Never celebrate loss, never reward a larger deficit              */
/* ================================================================== */

describe('a week of fast loss', () => {
  const fast = reviewWeek(
    baseInput({
      trend: trend({ weeklyChangePctBw: -1.3, weeklyChangeKg: -1.1 }),
      goals: { targetRatePctBwPerWeek: -0.65, targetBodyFatPct: 14, weeksElapsed: 4 },
    }),
  );

  it('is treated as a problem, not an achievement', () => {
    const i = byId(fast.insights, 'trajectory-faster-than-prescribed');
    expect(i).toBeDefined();
    expect(i?.severity).toBe('warning');
  });

  it('quantifies the lean-mass cost rather than the speed gained', () => {
    const i = byId(fast.insights, 'trajectory-faster-than-prescribed');
    expect(i?.inputs.some((e) => e.label === 'Projected lean share of loss')).toBe(true);
  });

  it('tells the user to eat more, never to cut further', () => {
    const i = byId(fast.insights, 'trajectory-faster-than-prescribed');
    expect(i?.action).toMatch(/add food back/i);
  });

  it('carries the guardrails module\'s own rate-tradeoff finding', () => {
    const i = byId(fast.insights, 'trajectory-faster-than-prescribed');
    expect(i?.findings.some((f) => f.code.startsWith('RATE_TRADEOFF'))).toBe(true);
  });

  it('produces no congratulatory copy anywhere in the review', () => {
    const allCopy = fast.insights
      .map((i) => [i.headline, i.detail, i.action ?? '', i.caveat ?? ''].join(' '))
      .join(' ');
    for (const rule of COACH_FORBIDDEN_COPY) {
      expect(rule.pattern.test(allCopy)).toBe(false);
    }
  });
});

/* ================================================================== */
/* 4. Trajectory and the honest timeline                               */
/* ================================================================== */

describe('trajectory', () => {
  it('says nothing about the rate when there is no trend', () => {
    const review = reviewWeek(baseInput({ trend: null, weighInsLast14d: 1 }));
    expect(byId(review.insights, 'trajectory-no-data')).toBeDefined();
    expect(byId(review.insights, 'trajectory-timeline')).toBeUndefined();
  });

  it('declines to act when the rate CI is wider than the decision', () => {
    const review = reviewWeek(baseInput({ trend: trend({ rateIsActionable: false }) }));
    const i = byId(review.insights, 'trajectory-imprecise');
    expect(i).toBeDefined();
    expect(i?.action).toMatch(/hold the current targets/i);
  });

  it('suppresses the "slower than prescribed" branch while a perturbation is open', () => {
    const review = reviewWeek(
      baseInput({ trend: trend({ perturbationActive: true, weeklyChangePctBw: -0.05 }) }),
    );
    expect(byId(review.insights, 'trajectory-behind')).toBeUndefined();
    const i = byId(review.insights, 'trajectory-confounded');
    expect(i).toBeDefined();
    expect(i?.suppressesAlarm).toBe(true);
    expect(i?.severity).toBe('info');
  });

  it('offers under-logging as an explanation before under-performing', () => {
    const review = reviewWeek(baseInput({ trend: trend({ weeklyChangePctBw: -0.2 }) }));
    const i = byId(review.insights, 'trajectory-behind');
    expect(i?.detail).toMatch(/not making it into the log/i);
    expect(i?.detail).toMatch(/not a character flaw/i);
  });

  it('adds diet-break and buffer weeks to every projection', () => {
    // 14 deficit weeks: two breaks (floor(14/7)) plus a 2–4 week buffer.
    expect(honestCalendarWeeks(14)).toEqual([18, 20]);
    expect(honestCalendarWeeks(7)).toEqual([10, 12]);
  });

  it('never returns a calendar shorter than the deficit weeks themselves', () => {
    for (let w = 1; w <= 80; w++) {
      const [lo, hi] = honestCalendarWeeks(w);
      expect(lo).toBeGreaterThanOrEqual(w);
      expect(hi).toBeGreaterThanOrEqual(lo);
    }
  });

  it('quotes the revised timeline in months, not weeks', () => {
    const review = reviewWeek(baseInput());
    const i = byId(review.insights, 'trajectory-timeline');
    expect(i).toBeDefined();
    expect(i?.headline).toMatch(/months/);
    expect(i?.headline).not.toMatch(/\d+ weeks? away/);
  });

  it('exposes the lean-mass cost of the current rate as evidence', () => {
    const review = reviewWeek(baseInput());
    const i = byId(review.insights, 'trajectory-timeline');
    const lean = i?.inputs.find((e) => e.label === 'Lean mass cost at this rate');
    expect(lean).toBeDefined();
    expect(lean?.unit).toBe('kg');
  });
});

/* ================================================================== */
/* 5. Expenditure confidence gates the advice                          */
/* ================================================================== */

describe('expenditure confidence', () => {
  it('holds targets when the estimator says to suppress adjustment', () => {
    const review = reviewWeek(
      baseInput({ expenditure: expenditure({ suppressAdjustment: true }) }),
    );
    const i = byId(review.insights, 'expenditure-holding');
    expect(i).toBeDefined();
    expect(byId(review.insights, 'expenditure-actionable')).toBeUndefined();
  });

  it('holds targets when data sufficiency is not "updating"', () => {
    const review = reviewWeek(
      baseInput({
        dataSufficiency: {
          status: 'holding',
          canUpdate: false,
          intakeDaysLast7: 2,
          weighInsLast7: 7,
          totalDaysLogged: 60,
          reasons: ['Only 2/7 days of food logging; need at least 4 to update.'],
        },
      }),
    );
    const i = byId(review.insights, 'expenditure-holding');
    expect(i).toBeDefined();
    expect(i?.detail).toMatch(/need at least 4 to update/);
    expect(i?.action).toMatch(/log 4 more day/i);
  });

  it('acts on a high-confidence estimate and says how much of it is the user\'s own data', () => {
    const review = reviewWeek(baseInput());
    const i = byId(review.insights, 'expenditure-actionable');
    expect(i).toBeDefined();
    expect(i?.detail).toMatch(/78% of that number/);
    expect(i?.findings.some((f) => f.code === 'COACH_EXPENDITURE_ESTIMATE')).toBe(true);
  });

  it('carries the estimator\'s own question when a regime change is suspected', () => {
    const review = reviewWeek(
      baseInput({
        expenditure: expenditure({
          confidenceLabel: 'low',
          regimeChangeSuspected: true,
          userPrompt: 'Did anything change about your training or your routine four weeks ago?',
        }),
      }),
    );
    const i = byId(review.insights, 'expenditure-holding');
    expect(i?.findings.some((f) => f.code === 'COACH_EXPENDITURE_REGIME_CHANGE')).toBe(true);
  });
});

/* ================================================================== */
/* 6. Adequacy floors                                                  */
/* ================================================================== */

describe('adequacy floors', () => {
  const lowProtein = reviewWeek(
    baseInput({
      intake: {
        days: week(2280),
        meanKcal: 2280,
        meanProteinG: 90, // 1.06 g/kg — under the hard floor
        meanFatG: 70,
        meanCarbG: 260,
        meanFiberG: 12,
        targetKcal: 2300,
      },
    }),
  );

  it('raises protein as a warning, with a concrete gram target', () => {
    const i = byId(lowProtein.insights, 'adequacy-protein');
    expect(i).toBeDefined();
    expect(i?.severity).toBe('warning');
    expect(i?.action).toMatch(/133 g a day/); // 1.6 g/kg × 83 kg
  });

  it('raises fibre with a named compound, dose and ramp', () => {
    const i = byId(lowProtein.insights, 'adequacy-fibre');
    expect(i).toBeDefined();
    expect(i?.action).toMatch(/psyllium husk/i);
    expect(i?.action).toMatch(/5 g/);
  });

  it('reuses the dietary-guardrails findings rather than inventing new codes', () => {
    const i = byId(lowProtein.insights, 'adequacy-protein');
    expect(i?.findings[0].code).toBe('PROTEIN_BELOW_HARD_FLOOR');
  });

  it('reports sustained under-eating without lowering the target', () => {
    const review = reviewWeek(
      baseInput({
        intake: {
          days: week(1400, 2300), // 61% of target, every logged day
          meanKcal: 1400,
          meanProteinG: 180,
          meanFatG: 70,
          meanCarbG: 100,
          meanFiberG: 32,
          targetKcal: 2300,
        },
      }),
    );
    const i = byId(review.insights, 'adequacy-under-eating');
    expect(i).toBeDefined();
    expect(i?.detail).toMatch(/under-logging is the first thing to rule out/i);
    expect(i?.action).not.toMatch(/lower(ing)? (your )?target/i);
  });

  it('stays quiet when the floors are met', () => {
    const review = reviewWeek(baseInput());
    expect(byId(review.insights, 'adequacy-protein')).toBeUndefined();
    expect(byId(review.insights, 'adequacy-fat')).toBeUndefined();
    expect(byId(review.insights, 'adequacy-fibre')).toBeUndefined();
  });
});

/* ================================================================== */
/* 7. Training volume against the landmarks                            */
/* ================================================================== */

describe('weekly volume budget', () => {
  const landmarks = { mev: 8, mavLow: 12, mavHigh: 20, mrv: 24 };

  function muscle(over: Partial<MuscleWeek> = {}): MuscleWeek {
    return { muscle: 'upper_back', appSets: 4, trainerSetsUpperBound: 13, prehabSets: 1, landmarks, ...over };
  }

  it('uses mavHigh as the ceiling in a deficit, not mrv', () => {
    const b = muscleBudget(muscle());
    expect(b.ceiling).toBe(landmarks.mavHigh);
    expect(b.totalSets).toBe(18);
    expect(b.headroom).toBe(2);
    expect(b.state).toBe('in-range');
  });

  it('counts the trainer\'s upper bound, not their mean', () => {
    const b = muscleBudget(muscle({ trainerSetsUpperBound: 16 }));
    expect(b.trainerShare).toBe(16);
    expect(b.state).toBe('over-ceiling');
  });

  it('flags a muscle below MEV', () => {
    expect(muscleBudget(muscle({ appSets: 0, trainerSetsUpperBound: 2, prehabSets: 0 })).state).toBe(
      'under-mev',
    );
  });

  it('says the trainer is covering a muscle rather than reporting a gap', () => {
    const review = reviewWeek(
      baseInput({
        training: {
          volume: [muscle({ appSets: 6 })], // 20 of 20
          trainerSessions: 3,
          trainerSessionsConfirmed: 3,
        },
      }),
    );
    const i = byId(review.insights, 'training-budget-spent');
    expect(i).toBeDefined();
    expect(i?.detail).toMatch(/that is the budget working, not a gap/i);
  });

  it('asks for a confirmation before escalating a single week over the ceiling', () => {
    const review = reviewWeek(
      baseInput({
        training: {
          volume: [muscle({ appSets: 10, weeksOverCeiling: 1, confirmations: 0 })],
          trainerSessions: 3,
          trainerSessionsConfirmed: 0,
        },
      }),
    );
    const i = byId(review.insights, 'training-over-ceiling-new');
    expect(i).toBeDefined();
    expect(i?.severity).toBe('suggestion');
    expect(byId(review.insights, 'training-over-ceiling-sustained')).toBeUndefined();
  });

  it('escalates only after two weeks with two confirmations, and never blames the trainer', () => {
    const review = reviewWeek(
      baseInput({
        training: {
          volume: [muscle({ appSets: 10, weeksOverCeiling: 2, confirmations: 2 })],
          trainerSessions: 3,
          trainerSessionsConfirmed: 3,
        },
      }),
    );
    const i = byId(review.insights, 'training-over-ceiling-sustained');
    expect(i).toBeDefined();
    expect(i?.severity).toBe('warning');
    // The required copy from program-personalized.md §3.7.
    expect(i?.detail).toMatch(/my model does not see your sessions and could easily be wrong/i);
    expect(i?.detail).toMatch(/your trainer does/i);
    // Three options, phrased as options.
    expect(i?.action).toMatch(/rotating emphasis/i);
    expect(i?.action).toMatch(/options rather than a verdict/i);
  });

  it('says when it has stopped tracking an indicator lift', () => {
    const review = reviewWeek(
      baseInput({
        training: {
          volume: [muscle()],
          trainerSessions: 3,
          trainerSessionsConfirmed: 3,
          indicatorLiftsDropped: ['weighted-pull-up'],
        },
      }),
    );
    const i = byId(review.insights, 'training-indicator-dropped');
    expect(i?.detail).toMatch(/silently plateaued lift/i);
  });
});

/* ================================================================== */
/* 8. Conditioning against the VO2max goal                             */
/* ================================================================== */

describe('conditioning', () => {
  it('treats a missed interval session as the whole dose, not a slowdown', () => {
    const review = reviewWeek(
      baseInput({
        conditioning: { zone2Minutes: 160, zone2Sessions: 3, hardIntervalSessions: 0 },
        goals: {
          targetRatePctBwPerWeek: -0.65,
          targetBodyFatPct: 14,
          vo2max: { targetImprovementPct: 8, horizonWeeks: 16 },
        },
      }),
    );
    const i = byId(review.insights, 'conditioning-no-intervals');
    expect(i).toBeDefined();
    expect(i?.action).toMatch(/4 × 4 minutes at 90–95%/);
    expect(i?.detail).toMatch(/8% over 16 weeks/);
  });

  it('does not promise Helgerud\'s numbers on a third of Helgerud\'s dose', () => {
    const review = reviewWeek(
      baseInput({ conditioning: { zone2Minutes: 160, zone2Sessions: 3, hardIntervalSessions: 0 } }),
    );
    const i = byId(review.insights, 'conditioning-no-intervals');
    expect(i?.detail).toMatch(/5 to 8%/);
    expect(i?.detail).toMatch(/three sessions a week/); // names the dose the 7–10% came from
  });

  it('excludes rowing and swimming for the reason the budget gives, not a generic one', () => {
    const review = reviewWeek(
      baseInput({ conditioning: { zone2Minutes: 60, zone2Sessions: 2, hardIntervalSessions: 1 } }),
    );
    const i = byId(review.insights, 'conditioning-zone2-short');
    expect(i?.action).toMatch(/upper back and lats are the most crowded/i);
  });

  it('fires the interval-output backstop at a 5% drop', () => {
    const under = reviewWeek(
      baseInput({
        conditioning: {
          zone2Minutes: 160,
          zone2Sessions: 3,
          hardIntervalSessions: 2,
          intervalOutputPctOfBest: 93,
        },
      }),
    );
    expect(byId(under.insights, 'conditioning-output-down')).toBeDefined();

    const over = reviewWeek(
      baseInput({
        conditioning: {
          zone2Minutes: 160,
          zone2Sessions: 3,
          hardIntervalSessions: 2,
          intervalOutputPctOfBest: 97,
        },
      }),
    );
    expect(byId(over.insights, 'conditioning-output-down')).toBeUndefined();
  });

  it('flags the grey zone above the threshold', () => {
    const review = reviewWeek(
      baseInput({
        conditioning: {
          zone2Minutes: 160,
          zone2Sessions: 3,
          hardIntervalSessions: 1,
          zone3Minutes: COACH_LIMITS.ZONE3_GREY_ZONE_MIN + 10,
        },
      }),
    );
    expect(byId(review.insights, 'conditioning-grey-zone')).toBeDefined();
  });

  it('answers the deficit interaction with fuelling, not with dropping a goal', () => {
    const review = reviewWeek(
      baseInput({ conditioning: { zone2Minutes: 160, zone2Sessions: 3, hardIntervalSessions: 1 } }),
    );
    const i = byId(review.insights, 'conditioning-deficit-interaction');
    expect(i?.action).toMatch(/40 to 60 g of carbohydrate/);
    expect(i?.action).toMatch(/same weekly total/i);
  });
});

/* ================================================================== */
/* 9. Micronutrients — Tier 1 means compound, form, dose, timing       */
/* ================================================================== */

describe('micronutrient recommendations', () => {
  /** A magnesium shortfall, built from the real database definition. */
  function gapAssessment(nutrientId: string, pct: number) {
    const def = MICRONUTRIENT_DB.nutrients.find((n) => n.id === nutrientId);
    if (!def) throw new Error(`fixture: ${nutrientId} missing from micronutrients.json`);
    return {
      nutrientId,
      name: def.name,
      unit: def.unit,
      intake: 0,
      fromFood: 0,
      fromSupplement: 0,
      reference: 100,
      referenceType: 'RDA' as const,
      referenceIsAnchor: false,
      pctOfReference: pct,
      status: (pct < 50 ? 'well-short' : pct < 70 ? 'short' : 'slightly-short') as
        | 'well-short'
        | 'short'
        | 'slightly-short',
      remainingGap: 100 - pct,
      upperLimit: null,
      upperLimitBasis: def.upperLimitBasis ?? 'total',
      intakeAgainstUpperLimit: 0,
      upperLimitStatus: 'no-limit' as const,
      riskWithoutVegetables: def.riskWithoutVegetables,
      supplementCloseability: def.supplementCloseability,
      trackingPriority: def.trackingPriority,
      contributors: [],
    };
  }

  it('names the compound, the dose range and the timing', () => {
    const review = reviewWeek(
      baseInput({
        micronutrients: {
          assessments: [gapAssessment('magnesium', 55)],
          database: MICRONUTRIENT_DB,
          person: PERSON,
        },
        supplementStack: { products: [] },
      }),
    );
    const i = byId(review.insights, 'micronutrients-closeable-gaps');
    expect(i).toBeDefined();
    expect(i?.tier).toBe(1);
    // A dose range, a unit and a time of day — the Tier 1 contract.
    expect(i?.action).toMatch(/\d+–\d+ mg/);
    expect(i?.action).toMatch(/(morning|midday|evening|breakfast|dinner|training|any time)/i);
  });

  it('says what it is closing and why that form', () => {
    const review = reviewWeek(
      baseInput({
        micronutrients: {
          assessments: [gapAssessment('magnesium', 55)],
          database: MICRONUTRIENT_DB,
          person: PERSON,
        },
      }),
    );
    const i = byId(review.insights, 'micronutrients-closeable-gaps');
    expect(i?.detail).toMatch(/oxide is the one to avoid/i);
    expect(i?.detail).toMatch(/what you ate, not what is in your blood/i);
  });

  it('separates the gaps a supplement cannot close, and is honest about why', () => {
    const review = reviewWeek(
      baseInput({
        micronutrients: {
          assessments: [gapAssessment('potassium', 45)],
          database: MICRONUTRIENT_DB,
          person: PERSON,
        },
      }),
    );
    const i = byId(review.insights, 'micronutrients-food-only-gaps');
    expect(i).toBeDefined();
    expect(i?.detail).toMatch(/3,400 mg/);
    expect(i?.detail).toMatch(/99 mg/);
    expect(i?.tier).toBe(2);
    expect(i?.caveat).toBeTruthy();
  });

  it('says nothing when there are no gaps', () => {
    const review = reviewWeek(
      baseInput({
        micronutrients: { assessments: [], database: MICRONUTRIENT_DB, person: PERSON },
      }),
    );
    expect(byId(review.insights, 'micronutrients-closeable-gaps')).toBeUndefined();
  });
});

/* ================================================================== */
/* 10. Confounders — standing an alarm down is output                  */
/* ================================================================== */

describe('confounders', () => {
  it('explains creatine water rather than cutting calories for a flat scale', () => {
    const review = reviewWeek(
      baseInput({
        medications: [{ id: 'creatine', startedOn: '2026-07-12' }], // 14 days in
        trend: trend({ weeklyChangePctBw: -0.05 }),
      }),
    );
    const i = byId(review.insights, 'confounder-creatine-water');
    expect(i).toBeDefined();
    expect(i?.suppressesAlarm).toBe(true);
    expect(i?.detail).toMatch(/that is the harm this check exists to prevent/i);
    expect(i?.action).toMatch(/bioimpedance infers lean mass from total body water/i);
    expect(hasSuppressedAlarms(review)).toBe(true);
  });

  it('does not fire the creatine window once the athlete is past saturation', () => {
    const review = reviewWeek(
      baseInput({ medications: [{ id: 'creatine', startedOn: '2025-01-01' }] }),
    );
    expect(byId(review.insights, 'confounder-creatine-water')).toBeUndefined();
  });

  it('attributes a raised creatinine to creatine and names the test that settles it', () => {
    const review = reviewWeek(
      baseInput({
        medications: [{ id: 'creatine', startedOn: '2025-01-01' }],
        labs: [
          {
            analyteId: 'creatinine',
            displayName: 'Creatinine (serum)',
            value: 1.32,
            unit: 'mg/dL',
            interpretation: 'high',
            drawnOn: '2026-07-20',
          },
        ],
      }),
    );
    const i = byId(review.insights, 'confounder-creatine-creatinine');
    expect(i).toBeDefined();
    expect(i?.suppressesAlarm).toBe(true);
    expect(i?.action).toMatch(/cystatin c/i);
    expect(i?.tier).toBe(2);
    expect(i?.caveat).toBeTruthy();
  });

  it('handles a mildly low eGFR the same way', () => {
    const review = reviewWeek(
      baseInput({
        medications: [{ id: 'creatine', startedOn: '2025-01-01' }],
        labs: [
          {
            analyteId: 'egfr-creatinine',
            displayName: 'eGFR (creatinine-based)',
            value: 72,
            unit: 'mL/min/1.73m2',
            interpretation: 'low',
            drawnOn: '2026-07-20',
          },
        ],
      }),
    );
    expect(byId(review.insights, 'confounder-creatine-egfr-creatinine')).toBeDefined();
  });

  it('does not offer creatine as an explanation when the athlete does not take it', () => {
    const review = reviewWeek(
      baseInput({
        labs: [
          {
            analyteId: 'creatinine',
            displayName: 'Creatinine (serum)',
            value: 1.32,
            unit: 'mg/dL',
            interpretation: 'high',
            drawnOn: '2026-07-20',
          },
        ],
      }),
    );
    expect(byId(review.insights, 'confounder-creatine-creatinine')).toBeUndefined();
  });

  it('attributes a raised ALT/AST to muscle when the week before the draw was heavy', () => {
    const review = reviewWeek(
      baseInput({
        hardSessionsBeforeLastDraw: 4,
        labs: [
          {
            analyteId: 'alt-ast',
            displayName: 'ALT',
            value: 68,
            unit: 'U/L',
            interpretation: 'high',
            drawnOn: '2026-07-20',
          },
        ],
      }),
    );
    const i = byId(review.insights, 'confounder-training-liver-enzymes');
    expect(i).toBeDefined();
    expect(i?.action).toMatch(/ggt/i);
    expect(i?.action).toMatch(/three or four days without training/i);
    expect(i?.caveat).toMatch(/common does not mean certain/i);
  });

  it('does not explain away a liver panel when there was no training before the draw', () => {
    const review = reviewWeek(
      baseInput({
        hardSessionsBeforeLastDraw: 0,
        labs: [
          {
            analyteId: 'alt-ast',
            displayName: 'ALT',
            value: 68,
            unit: 'U/L',
            interpretation: 'high',
            drawnOn: '2026-07-20',
          },
        ],
      }),
    );
    expect(byId(review.insights, 'confounder-training-liver-enzymes')).toBeUndefined();
  });

  it('surfaces topical minoxidil fluid as a possibility and subtracts nothing', () => {
    const review = reviewWeek(
      baseInput({ medications: [{ id: 'minoxidil-topical', startedOn: '2026-07-01' }] }),
    );
    const i = byId(review.insights, 'confounder-minoxidil-fluid-retention');
    expect(i).toBeDefined();
    expect(i?.suppressesAlarm).toBe(true);
    expect(i?.action).toMatch(/nothing is being subtracted/i);
  });

  it('never emits a directive about a prescribed medication, across every confounder', () => {
    const review = reviewWeek(
      baseInput({
        medications: [
          { id: 'creatine', startedOn: '2026-07-12' },
          { id: 'minoxidil-topical', startedOn: '2026-07-01' },
          { id: 'sertraline', startedOn: '2026-06-01' },
          { id: 'finasteride', startedOn: '2026-06-01' },
        ],
        labs: [
          {
            analyteId: 'creatinine',
            displayName: 'Creatinine (serum)',
            value: 1.32,
            unit: 'mg/dL',
            interpretation: 'high',
            drawnOn: '2026-07-20',
          },
        ],
        hardSessionsBeforeLastDraw: 3,
      }),
    );
    expect(
      review.suppressed.filter((s) => s.blockedBy.code === 'COACH_COPY_MEDICATION_DIRECTIVE'),
    ).toHaveLength(0);
    expect(review.insights.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 11. Tier 3 — critical values get a prompt, not an explanation       */
/* ================================================================== */

describe('critical lab values (advice-policy Tier 3 rule 3)', () => {
  const review = reviewWeek(
    baseInput({
      labs: [
        {
          analyteId: 'potassium',
          displayName: 'Potassium',
          value: 6.9,
          unit: 'mmol/L',
          interpretation: 'critical_high',
          drawnOn: '2026-07-25',
        },
      ],
    }),
  );

  it('ranks first, above everything else in the week', () => {
    expect(review.insights[0].id).toBe('labs-critical-value');
    expect(review.insights[0].domain).toBe('safety');
    expect(review.insights[0].severity).toBe('critical');
  });

  it('offers no interpretation', () => {
    const i = review.insights[0];
    expect(i.tier).toBe(3);
    expect(i.detail).toMatch(/i am not going to interpret this one/i);
    expect(i.action).toMatch(/contact a doctor today/i);
  });
});

/* ================================================================== */
/* 12. The ED numeric gate is not overridable                          */
/* ================================================================== */

describe('eating-disorder gate', () => {
  const gated = reviewWeek(
    baseInput({
      externalFindings: [
        {
          ok: false,
          level: 'block',
          code: 'ED_SCREEN_POSITIVE',
          message: 'Some of your answers suggest tracking could do more harm than good right now.',
        },
      ],
      intake: {
        days: week(1400, 2300),
        meanKcal: 1400,
        meanProteinG: 90,
        meanFatG: 40,
        meanCarbG: 120,
        meanFiberG: 10,
        targetKcal: 2300,
      },
    }),
  );

  it('closes the numeric-target gate', () => {
    expect(gated.numericTargetsSuppressed).toBe(true);
  });

  it('shows no body-composition or calorie-target insights at all', () => {
    expect(gated.insights.some((i) => i.domain === 'body-composition')).toBe(false);
    expect(gated.insights.some((i) => i.domain === 'nutrition')).toBe(false);
  });

  it('records what it suppressed rather than dropping it silently', () => {
    expect(gated.suppressed.length).toBeGreaterThan(0);
    expect(gated.suppressed.every((s) => s.blockedBy.level === 'block')).toBe(true);
    expect(gated.suppressed.some((s) => s.blockedBy.code === 'COACH_NUMERIC_GATE_CLOSED')).toBe(true);
  });

  it('keeps the adequacy floors working — that is the whole point of the affordance', () => {
    expect(gated.insights.some((i) => i.domain === 'adequacy')).toBe(true);
  });

  it('leads with an honest headline rather than a body-composition summary', () => {
    expect(gated.headline).toMatch(/turned off/i);
  });

  it('routes to the urgent referral prompt', () => {
    expect(gated.referral?.urgency).toBe('now');
    expect(gated.referral?.showResources).toBe(true);
  });

  it('closes on a self-reported eating-disorder history too', () => {
    const review = reviewWeek(
      baseInput({ profile: { ...PROFILE, eatingDisorderHistory: true } }),
    );
    expect(review.numericTargetsSuppressed).toBe(true);
  });
});

/* ================================================================== */
/* 13. Goal conflict is stated, not resolved silently                  */
/* ================================================================== */

describe('goal tradeoffs (athlete-profile.md §3.3)', () => {
  it('says what was asked, what is being done and why', () => {
    const review = reviewWeek(
      baseInput({
        goals: {
          targetRatePctBwPerWeek: -0.65,
          targetBodyFatPct: 14,
          tradeoffs: [
            {
              id: 'strength',
              statedAs: 'wants to get stronger',
              intent: 'maintain',
              because:
                'building strength and losing fat compete for the same energy, and fat loss is the higher-ranked goal this block.',
            },
          ],
        },
      }),
    );
    const i = byId(review.insights, 'goal-tradeoff-disclosure');
    expect(i).toBeDefined();
    expect(i?.detail).toMatch(/wants to get stronger/);
    expect(i?.detail).toMatch(/maintain/);
    expect(i?.action).toMatch(/re-plan/i);
  });

  it('says nothing when every goal is being programmed as asked', () => {
    const review = reviewWeek(
      baseInput({
        goals: {
          targetRatePctBwPerWeek: -0.65,
          tradeoffs: [{ id: 'fat_loss', statedAs: 'selected fat loss', intent: 'improve', because: '' }],
        },
      }),
    );
    expect(byId(review.insights, 'goal-tradeoff-disclosure')).toBeUndefined();
  });
});

/* ================================================================== */
/* 14. Adherence, framed without judgement                             */
/* ================================================================== */

describe('adherence', () => {
  const sparse = reviewWeek(
    baseInput({
      intake: {
        days: [
          { date: '2026-07-20', kcal: 2200, targetKcal: 2300 },
          { date: '2026-07-21', kcal: null, targetKcal: 2300 },
          { date: '2026-07-22', kcal: null, targetKcal: 2300 },
          { date: '2026-07-23', kcal: 2400, targetKcal: 2300 },
          { date: '2026-07-24', kcal: null, targetKcal: 2300 },
          { date: '2026-07-25', kcal: null, targetKcal: 2300 },
          { date: '2026-07-26', kcal: null, targetKcal: 2300 },
        ],
        meanKcal: 2300,
        meanProteinG: 180,
        meanFatG: 70,
        meanCarbG: 220,
        meanFiberG: 32,
        targetKcal: 2300,
      },
      trend: trend({ weighInsLast14d: 3, rateIsActionable: false }),
      training: { volume: [], trainerSessions: 3, trainerSessionsConfirmed: 1 },
    }),
  );

  it('explains the consequence rather than scoring the behaviour', () => {
    const i = byId(sparse.insights, 'adherence-sparse-logging');
    expect(i).toBeDefined();
    expect(i?.detail).toMatch(/not a scolding/i);
    expect(i?.detail).toMatch(/counting consecutive days/i);
  });

  it('gives the trainer-confirmation payoff in sets, not in compliance', () => {
    const i = byId(sparse.insights, 'adherence-trainer-confirmations');
    expect(i?.action).toMatch(/three sets a week back/i);
    expect(i?.detail).toMatch(/still counts at full prior value/i);
  });

  it('ranks adherence last — it is context, not a verdict', () => {
    const first = sparse.insights.findIndex((i) => i.domain === 'adherence');
    expect(first).toBeGreaterThanOrEqual(0);
    // Every insight from the first adherence one onward is adherence: the band
    // sits at the tail and nothing can be promoted out of it by severity.
    expect(sparse.insights.slice(first).every((i) => i.domain === 'adherence')).toBe(true);
  });
});

/* ================================================================== */
/* 15. Honest empty states                                             */
/* ================================================================== */

describe('empty and sparse states', () => {
  const bare: CoachInput = {
    weekEndingDate: '2026-07-26',
    profile: PROFILE,
    goals: { targetRatePctBwPerWeek: -0.65 },
  };

  it('names every missing input rather than filling the space', () => {
    const gaps = dataGaps(bare);
    expect(gaps.length).toBeGreaterThanOrEqual(7);
    expect(gaps.join(' ')).toMatch(/no weight trend yet/i);
    expect(gaps.join(' ')).toMatch(/no expenditure estimate/i);
    expect(gaps.join(' ')).toMatch(/no readiness check-ins/i);
  });

  it('still returns a usable review with nothing logged', () => {
    const review = reviewWeek(bare);
    expect(review.insights.length).toBeGreaterThan(0);
    expect(review.headline).toBeTruthy();
    expect(review.dataGaps.length).toBeGreaterThan(0);
  });

  it('reports the rate gap when the estimate is imprecise rather than when it is missing', () => {
    const gaps = dataGaps({ ...bare, trend: trend({ rateIsActionable: false }) });
    expect(gaps.join(' ')).toMatch(/wider than the decisions/i);
    expect(gaps.join(' ')).not.toMatch(/no weight trend yet/i);
  });

  it('lists no gaps for the inputs that are present', () => {
    const gaps = dataGaps(baseInput());
    expect(gaps.join(' ')).not.toMatch(/no weight trend yet/i);
    expect(gaps.join(' ')).not.toMatch(/no expenditure estimate/i);
    expect(gaps.join(' ')).not.toMatch(/no food logged/i);
  });
});

/* ================================================================== */
/* 16. Whole-review invariants                                         */
/* ================================================================== */

describe('review invariants', () => {
  /** A maximally loaded week, so the sweeps below see every rule at once. */
  const loaded = reviewWeek(
    baseInput({
      medications: [
        { id: 'creatine', startedOn: '2026-07-12' },
        { id: 'minoxidil-topical', startedOn: '2026-07-01' },
        { id: 'sertraline', startedOn: '2026-06-01' },
      ],
      labs: [
        {
          analyteId: 'creatinine',
          displayName: 'Creatinine (serum)',
          value: 1.32,
          unit: 'mg/dL',
          interpretation: 'high',
          drawnOn: '2026-07-20',
        },
        {
          analyteId: 'alt-ast',
          displayName: 'ALT',
          value: 68,
          unit: 'U/L',
          interpretation: 'high',
          drawnOn: '2026-07-20',
        },
      ],
      hardSessionsBeforeLastDraw: 4,
      conditioning: { zone2Minutes: 90, zone2Sessions: 2, hardIntervalSessions: 0, zone3Minutes: 90 },
      training: {
        volume: [
          {
            muscle: 'upper_back',
            appSets: 10,
            trainerSetsUpperBound: 13,
            prehabSets: 1,
            landmarks: { mev: 8, mavLow: 12, mavHigh: 20, mrv: 24 },
            weeksOverCeiling: 2,
            confirmations: 2,
          },
        ],
        trainerSessions: 3,
        trainerSessionsConfirmed: 2,
      },
      readiness: [
        { date: '2026-07-20', band: 'low', score: -0.5 },
        { date: '2026-07-21', band: 'low', score: -0.6 },
        { date: '2026-07-22', band: 'poor', score: -1.2 },
        { date: '2026-07-23', band: 'normal', score: 0 },
      ],
      intake: {
        days: week(2000, 2300),
        meanKcal: 2000,
        meanProteinG: 100,
        meanFatG: 70,
        meanCarbG: 200,
        meanFiberG: 10,
        targetKcal: 2300,
      },
      micronutrients: {
        assessments: [],
        database: MICRONUTRIENT_DB,
        person: PERSON,
      },
    }),
  );

  it('produces a substantial review from a full week', () => {
    expect(loaded.insights.length).toBeGreaterThanOrEqual(8);
  });

  it('never returns an insight carrying a block finding', () => {
    for (const i of loaded.insights) expect(hasBlock(i.findings)).toBe(false);
  });

  it('gives every insight a stable id, and never two the same', () => {
    const ids = loaded.insights.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('gives every insight a confidence tag and a tier', () => {
    for (const i of loaded.insights) {
      expect(['well-established', 'reasonable-inference', 'uncertain']).toContain(i.confidence);
      expect([1, 2, 3]).toContain(i.tier);
    }
  });

  it('gives every Tier 2 insight a specific caveat rather than a generic disclaimer', () => {
    for (const i of loaded.insights) {
      if (i.tier !== 2) continue;
      const hasCaveat = i.caveat !== null || i.findings.some((f) => f.message.length > 0);
      expect(hasCaveat).toBe(true);
      expect(i.caveat ?? '').not.toMatch(/consult your (healthcare provider|doctor)\.?$/i);
    }
  });

  it('shows the inputs behind every insight (methodology §8.5 rule 10)', () => {
    for (const i of loaded.insights) {
      // Goal-conflict copy carries its own inputs inline; everything else must
      // expose them structurally.
      expect(i.inputs.length).toBeGreaterThan(0);
    }
  });

  it('carries exactly one disclaimer, at the review level', () => {
    expect(loaded.disclaimer).toBeTruthy();
    for (const i of loaded.insights) {
      expect(i.detail).not.toMatch(/not medical advice/i);
      expect(i.detail).not.toMatch(/consult your healthcare provider/i);
    }
  });

  it('emits no forbidden copy anywhere, over every rule at once', () => {
    const copy = loaded.insights
      .map((i) => [i.headline, i.detail, i.action ?? '', i.caveat ?? ''].join(' '))
      .join(' ');
    for (const rule of COACH_FORBIDDEN_COPY) {
      expect(rule.pattern.test(copy)).toBe(false);
    }
  });

  it('derives the headline from the top insight so the two cannot disagree', () => {
    expect(loaded.headline.startsWith(loaded.insights[0].headline)).toBe(true);
  });

  it('counts alarms it stood down in the headline when one leads', () => {
    const review = reviewWeek(
      baseInput({
        medications: [{ id: 'creatine', startedOn: '2026-07-12' }],
        intake: null,
        expenditure: null,
      }),
    );
    expect(review.insights[0].suppressesAlarm).toBe(true);
    expect(review.headline).toMatch(/probably are not/i);
  });

  it('surfaces the referral prompt from the pooled findings', () => {
    const review = reviewWeek(
      baseInput({
        trend: trend({ weeklyChangePctBw: -2.0, weeklyChangeKg: -1.7 }),
        goals: { targetRatePctBwPerWeek: -0.65, targetBodyFatPct: 14, weeksElapsed: 4 },
      }),
    );
    expect(review.referral?.urgency).toBe('soon');
  });

  it('is a pure function of its input', () => {
    const input = baseInput();
    const a = reviewWeek(input);
    const b = reviewWeek(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
