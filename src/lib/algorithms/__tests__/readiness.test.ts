/**
 * readiness.test.ts — the §8.5 guardrails, as executable requirements.
 *
 * `training-methodology.md` §8.5 is normative. Every rule in it is a testable
 * invariant, and this file is where each one is pinned. The organising
 * principle: **a guardrail that is only enforced by the code that happens to be
 * written today is not a guardrail.** Each `describe` below names its rule, so
 * a future change that loosens one fails with the rule number in the output.
 *
 * The two properties that get their own exhaustive sweeps — bounded adjustment
 * and "readiness may never increase load" — are swept over the whole plausible
 * input space rather than spot-checked, because those are the ones where a
 * plausible-looking special case is exactly how the bound gets lost.
 */

import { describe, it, expect } from 'vitest';
import {
  BAND_COPY,
  READINESS_LIMITS,
  RECOVERY_COPY,
  adjustmentForBand,
  assessReadiness,
  bandForScore,
  baselineStatus,
  clampReadinessAdjustment,
  consecutiveDaysAbove,
  consecutiveDaysBelow,
  energyScore,
  hrvScore,
  performanceScore,
  physicianReferralFindings,
  readinessPercent,
  rhrScore,
  sleepQualityScore,
  sleepScore,
  summarizeMetricBaseline,
  sorenessScore,
  type ReadinessAssessment,
  type ReadinessBand,
  type ReadinessInput,
  type SubjectiveScale,
} from '../readiness';
import { hasBlock } from '../guardrails';

/** A neutral day: nothing good, nothing bad, no wearable. */
function baseInput(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    subjectiveSoreness: 3,
    subjectiveEnergy: 3,
    painFlag: false,
    illnessFlag: false,
    ...over,
  };
}

/** A complete 21-day HRV baseline with today's reading sitting on it. */
function withHrvBaseline(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return baseInput({
    hrvToday: 62,
    hrvBaseline: 62,
    hrvSD: 8,
    hrvBaselineDays: 21,
    hrvSuppressedDays: 0,
    ...over,
  });
}

/** Every string the assessment could put in front of a user. */
function allCopy(a: ReadinessAssessment): string[] {
  return [
    a.bandCopy,
    ...a.contributions.map((c) => c.detail),
    ...a.excluded.map((e) => e.reason),
    ...a.adjustment.reasons,
    ...a.findings.map((f) => f.message),
    a.baseline.message ?? '',
  ];
}

/* ================================================================== */
/* Rule 3 — no baseline, no HRV-driven decisions                       */
/* ================================================================== */

describe('§8.5 rule 3 — no baseline, no HRV-driven decisions', () => {
  it('scores HRV at nothing until 21 days of readings exist', () => {
    for (let days = 0; days < READINESS_LIMITS.baselineDays; days++) {
      const i = withHrvBaseline({ hrvToday: 30, hrvBaselineDays: days, hrvSuppressedDays: 5 });
      expect(hrvScore(i)).toBeNull();
    }
    // The 21st day is the first that counts.
    expect(
      hrvScore(withHrvBaseline({ hrvToday: 30, hrvBaselineDays: 21, hrvSuppressedDays: 5 })),
    ).toBe(-2);
  });

  it('scores RHR at nothing until 21 days of readings exist', () => {
    for (let days = 0; days < READINESS_LIMITS.baselineDays; days++) {
      const i = baseInput({
        rhrToday: 74,
        rhrBaseline: 58,
        rhrBaselineDays: days,
        rhrElevatedDays: 5,
      });
      expect(rhrScore(i)).toBeNull();
    }
    expect(
      rhrScore(
        baseInput({ rhrToday: 74, rhrBaseline: 58, rhrBaselineDays: 21, rhrElevatedDays: 5 }),
      ),
    ).toBe(-2);
  });

  it('excludes an unbaselined HRV from the denominator rather than scoring it 0', () => {
    // A zero would drag a bad subjective day *up* toward normal. Exclusion is
    // not the same as neutrality, and this is the difference.
    const noHrv = assessReadiness(baseInput({ subjectiveSoreness: 5, subjectiveEnergy: 1 }));
    const partialHrv = assessReadiness(
      baseInput({
        subjectiveSoreness: 5,
        subjectiveEnergy: 1,
        hrvToday: 40,
        hrvBaseline: 62,
        hrvSD: 8,
        hrvBaselineDays: 10,
      }),
    );
    expect(partialHrv.score).toBe(noHrv.score);
    expect(partialHrv.contributions.map((c) => c.id)).not.toContain('hrv');
  });

  it('surfaces "building your baseline — N/21"', () => {
    const a = assessReadiness(
      withHrvBaseline({ hrvBaselineDays: 12, rhrToday: 55, rhrBaseline: 55, rhrBaselineDays: 12 }),
    );
    expect(a.baseline.message).toContain('12/21');
    expect(a.baseline.hrvReady).toBe(false);
    expect(a.findings.some((f) => f.code === 'readiness.baseline_building')).toBe(true);
  });

  it('reports the shorter of the two baselines while both are building', () => {
    const s = baselineStatus(
      withHrvBaseline({ hrvBaselineDays: 18, rhrToday: 55, rhrBaseline: 55, rhrBaselineDays: 4 }),
    );
    expect(s.message).toContain('4/21');
  });

  it('says nothing about a baseline when there is no wearable data at all', () => {
    const s = baselineStatus(baseInput());
    expect(s.noWearableData).toBe(true);
    expect(s.message).toBeNull();
  });
});

/* ================================================================== */
/* Rule: a single bad night barely moves the score                     */
/* ================================================================== */

describe('§8.3 — one bad night is noise, a sustained dip is signal', () => {
  it('scores a one-day HRV dip at −0.5, not −2', () => {
    const oneOff = withHrvBaseline({ hrvToday: 45, hrvSuppressedDays: 1 });
    expect(hrvScore(oneOff)).toBe(-0.5);
  });

  it('scores a 3-day suppression at the full −2', () => {
    const sustained = withHrvBaseline({ hrvToday: 45, hrvSuppressedDays: 3 });
    expect(hrvScore(sustained)).toBe(-2);
  });

  it('holds the damping across days 0, 1 and 2 and switches only at 3', () => {
    for (const days of [0, 1, 2]) {
      expect(hrvScore(withHrvBaseline({ hrvToday: 45, hrvSuppressedDays: days }))).toBe(-0.5);
    }
    for (const days of [3, 4, 10]) {
      expect(hrvScore(withHrvBaseline({ hrvToday: 45, hrvSuppressedDays: days }))).toBe(-2);
    }
  });

  it('a one-day dip alone cannot push an otherwise ordinary day out of `normal`', () => {
    // Everything else is unremarkable. Only HRV dipped, and only this morning.
    const a = assessReadiness(
      withHrvBaseline({
        hrvToday: 40,
        hrvSuppressedDays: 1,
        sleepHours: 6.8,
        subjectiveSoreness: 3,
        subjectiveEnergy: 3,
        sessionPerfLastTime: 'flat',
      }),
    );
    expect(a.score).toBeCloseTo(-0.1, 6);
    expect(a.band).toBe('normal');
    expect(a.adjustment.volumeDelta).toBe(0);
    expect(a.adjustment.loadDelta).toBe(0);
  });

  it('but the same dip sustained for three days does move the band', () => {
    const a = assessReadiness(
      withHrvBaseline({
        hrvToday: 40,
        hrvSuppressedDays: 3,
        sleepHours: 6.8,
        subjectiveSoreness: 3,
        subjectiveEnergy: 3,
        sessionPerfLastTime: 'flat',
      }),
    );
    expect(a.score).toBeCloseTo(-0.4, 6);
    expect(a.band).toBe('low');
    expect(a.adjustment.volumeDelta).toBeLessThan(0);
  });

  it('damps a one-off resting heart rate elevation too', () => {
    const i = baseInput({
      rhrToday: 64,
      rhrBaseline: 58,
      rhrBaselineDays: 21,
      rhrElevatedDays: 1,
    });
    expect(rhrScore(i)).toBe(-0.5);
  });

  it('lets a sustained moderate RHR elevation outweigh a one-off', () => {
    // Regression. The -1 branch used to gate on `rhrElevatedDays`, which counts
    // only days more than 10 bpm above baseline — the physician-referral
    // threshold. So a steady +8 could never reach -1 no matter how long it ran,
    // and a week of accumulating fatigue scored the same as one bad morning.
    // That inverts the whole point of the module: sustained beats one-off.
    const oneOff = baseInput({
      rhrToday: 66,
      rhrBaseline: 58,
      rhrBaselineDays: 21,
      rhrModeratelyElevatedDays: 1,
    });
    const sustained = baseInput({
      rhrToday: 66,
      rhrBaseline: 58,
      rhrBaselineDays: 21,
      rhrModeratelyElevatedDays: 4,
    });

    expect(rhrScore(oneOff)).toBe(-0.5);
    expect(rhrScore(sustained)).toBe(-1);
    expect(rhrScore(sustained)!).toBeLessThan(rhrScore(oneOff)!);
  });

  it('still reaches -2 only at the marked threshold, not the moderate one', () => {
    // A long moderate run must not escalate to the illness-grade score; that
    // one is reserved for >=10 bpm, which is what the referral rule keys on.
    const longModerate = baseInput({
      rhrToday: 66,
      rhrBaseline: 58,
      rhrBaselineDays: 21,
      rhrModeratelyElevatedDays: 30,
      rhrElevatedDays: 0,
    });
    expect(rhrScore(longModerate)).toBe(-1);
  });

  it('degrades safely when only the old counter is supplied', () => {
    // Callers predating the moderate counter must not silently lose the -1
    // branch; the marked counter stands in.
    const legacy = baseInput({
      rhrToday: 66,
      rhrBaseline: 58,
      rhrBaselineDays: 21,
      rhrElevatedDays: 4,
    });
    expect(rhrScore(legacy)).toBe(-1);
  });

  it('never lets a low resting heart rate earn a bonus', () => {
    // Galpin: RHR is not sensitive enough to detect one hard session, so it is
    // not sensitive enough to hand out a green light either.
    for (const today of [40, 45, 50, 55, 58]) {
      const s = rhrScore(
        baseInput({ rhrToday: today, rhrBaseline: 58, rhrBaselineDays: 30, rhrElevatedDays: 0 }),
      );
      expect(s).not.toBeNull();
      expect(s as number).toBeLessThanOrEqual(0);
    }
  });
});

/* ================================================================== */
/* Rule 1 — bounded adjustment, and load may never rise                */
/* ================================================================== */

describe('§8.5 rule 1 — bounded per-session change', () => {
  it('clamps every axis to its documented range', () => {
    expect(clampReadinessAdjustment('volume', -5)).toBe(READINESS_LIMITS.volume.min);
    expect(clampReadinessAdjustment('volume', 5)).toBe(READINESS_LIMITS.volume.max);
    expect(clampReadinessAdjustment('rir', -9)).toBe(READINESS_LIMITS.rir.min);
    expect(clampReadinessAdjustment('rir', 9)).toBe(READINESS_LIMITS.rir.max);
    expect(clampReadinessAdjustment('load', -9)).toBe(READINESS_LIMITS.load.min);
    expect(clampReadinessAdjustment('load', 9)).toBe(READINESS_LIMITS.load.max);
    expect(clampReadinessAdjustment('load', Number.NaN)).toBe(0);
  });

  it('bounds volume to [−50%, +10%], RIR to [−1, +2] and load to [−20%, 0%]', () => {
    expect(READINESS_LIMITS.volume).toEqual({ min: -0.5, max: 0.1 });
    expect(READINESS_LIMITS.rir).toEqual({ min: -1, max: 2 });
    expect(READINESS_LIMITS.load).toEqual({ min: -0.2, max: 0 });
  });

  it('keeps every band inside the bounds', () => {
    for (const band of ['high', 'normal', 'low', 'poor'] as ReadinessBand[]) {
      const a = adjustmentForBand(band);
      expect(a.volumeDelta).toBeGreaterThanOrEqual(READINESS_LIMITS.volume.min);
      expect(a.volumeDelta).toBeLessThanOrEqual(READINESS_LIMITS.volume.max);
      expect(a.rirDelta).toBeGreaterThanOrEqual(READINESS_LIMITS.rir.min);
      expect(a.rirDelta).toBeLessThanOrEqual(READINESS_LIMITS.rir.max);
      expect(a.loadDelta).toBeGreaterThanOrEqual(READINESS_LIMITS.load.min);
      expect(a.loadDelta).toBeLessThanOrEqual(READINESS_LIMITS.load.max);
    }
  });

  it('never prescribes below 3 RIR when readiness is low or poor', () => {
    for (const band of ['low', 'poor'] as ReadinessBand[]) {
      expect(adjustmentForBand(band).minRir).toBe(READINESS_LIMITS.minRirWhenSuppressed);
    }
  });
});

describe('§8.5 rule 1 — readiness may never increase prescribed load', () => {
  /**
   * Sweep the whole plausible input space rather than spot-check. 3,240
   * combinations, and not one of them may return a positive `loadDelta` or a
   * volume increase beyond the +10% ceiling.
   */
  it('holds across an exhaustive sweep of inputs', () => {
    const scale: SubjectiveScale[] = [1, 2, 3, 4, 5];
    let checked = 0;

    for (const soreness of scale) {
      for (const energy of scale) {
        for (const sleepHours of [null, 4, 6, 7.5, 9]) {
          for (const hrvToday of [null, 30, 62, 95]) {
            for (const suppressedDays of [0, 3]) {
              for (const perf of [null, 'up', 'flat', 'down'] as const) {
                for (const pain of [false, true]) {
                  const a = assessReadiness({
                    subjectiveSoreness: soreness,
                    subjectiveEnergy: energy,
                    sleepHours,
                    sleepDebt7d: 0,
                    hrvToday,
                    hrvBaseline: hrvToday === null ? null : 62,
                    hrvSD: 8,
                    hrvBaselineDays: 30,
                    hrvSuppressedDays: suppressedDays,
                    sessionPerfLastTime: perf,
                    painFlag: pain,
                    illnessFlag: false,
                  });
                  checked++;
                  expect(a.adjustment.loadDelta).toBeLessThanOrEqual(0);
                  expect(a.adjustment.loadDelta).toBeGreaterThanOrEqual(
                    READINESS_LIMITS.load.min,
                  );
                  expect(a.adjustment.volumeDelta).toBeLessThanOrEqual(
                    READINESS_LIMITS.volume.max,
                  );
                  expect(a.adjustment.volumeDelta).toBeGreaterThanOrEqual(
                    READINESS_LIMITS.volume.min,
                  );
                  expect(a.adjustment.rirDelta).toBeGreaterThanOrEqual(READINESS_LIMITS.rir.min);
                  expect(a.adjustment.rirDelta).toBeLessThanOrEqual(READINESS_LIMITS.rir.max);
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('gives the best possible day one extra accessory set and not one gram more', () => {
    const a = assessReadiness(
      withHrvBaseline({
        hrvToday: 95,
        sleepHours: 8.5,
        sleepDebt7d: 0,
        sleepQuality: 5,
        subjectiveSoreness: 1,
        subjectiveEnergy: 5,
        sessionPerfLastTime: 'up',
      }),
    );
    expect(a.band).toBe('high');
    expect(a.adjustment.extraSetOnLastExercise).toBe(true);
    expect(a.adjustment.loadDelta).toBe(0);
    expect(a.adjustment.volumeDelta).toBe(0);
    expect(a.adjustment.rirDelta).toBe(0);
    expect(a.adjustment.reasons.join(' ')).toContain('never raises a prescribed load');
  });
});

/* ================================================================== */
/* Rule 2 — three consecutive reductions stops the adjusting           */
/* ================================================================== */

describe('§8.5 rule 2 — bounded consecutive change', () => {
  const lowDay = (reductions: number) =>
    assessReadiness(
      baseInput({
        sleepHours: 6,
        subjectiveSoreness: 4,
        subjectiveEnergy: 3,
        consecutiveReductions: reductions,
      }),
    );

  it('still trims on the first, second and third reduced session', () => {
    for (const n of [0, 1, 2]) {
      const a = lowDay(n);
      expect(a.band).toBe('low');
      expect(a.adjustment.applied).toBe(true);
      expect(a.adjustment.volumeDelta).toBeLessThan(0);
      expect(a.adjustmentPaused).toBe(false);
    }
  });

  it('stops adjusting once three reductions have already run', () => {
    const a = lowDay(READINESS_LIMITS.maxConsecutiveReductions);
    expect(a.adjustmentPaused).toBe(true);
    expect(a.adjustment.applied).toBe(false);
    expect(a.adjustment.volumeDelta).toBe(0);
    expect(a.adjustment.loadDelta).toBe(0);
    expect(a.adjustment.rirDelta).toBe(0);
  });

  it('prompts a deload or rest day instead, with the nudge attached', () => {
    const a = lowDay(4);
    expect(a.deloadPrompted).toBe(true);
    const f = a.findings.find((x) => x.code === 'readiness.chronic_reduction');
    expect(f).toBeDefined();
    expect(f?.level).toBe('warn');
    expect(f?.message).toMatch(/deload|rest day/i);
    // The nudge is the point: a silent fourth trim would hide the problem.
    expect(f?.message).toMatch(/sleep/i);
    expect(f?.message).toMatch(/stress/i);
  });

  it('does not fire on a normal or high day, however many past reductions there were', () => {
    const a = assessReadiness(baseInput({ consecutiveReductions: 9 }));
    expect(a.band).toBe('normal');
    expect(a.adjustmentPaused).toBe(false);
    expect(a.deloadPrompted).toBe(false);
  });
});

/* ================================================================== */
/* Rule 4 — pain                                                       */
/* ================================================================== */

describe('§8.5 rule 4 — never train through pain', () => {
  it('never increases load or volume while pain is flagged', () => {
    // A `high` day is the adversarial case: it is the only band that would
    // otherwise add anything.
    const a = assessReadiness(
      baseInput({
        sleepHours: 8.5,
        sleepDebt7d: 0,
        subjectiveSoreness: 1,
        subjectiveEnergy: 5,
        sessionPerfLastTime: 'up',
        painFlag: true,
      }),
    );
    expect(a.band).toBe('high');
    expect(a.adjustment.extraSetOnLastExercise).toBe(false);
    expect(a.adjustment.volumeDelta).toBeLessThanOrEqual(0);
    expect(a.adjustment.loadDelta).toBeLessThanOrEqual(0);
    expect(a.adjustment.setsPerExerciseDelta).toBeLessThanOrEqual(0);
  });

  it('shows the required pain copy verbatim', () => {
    const a = assessReadiness(baseInput({ painFlag: true }));
    const f = a.findings.find((x) => x.code === 'readiness.pain_flagged');
    expect(f?.message).toBe(RECOVERY_COPY.pain);
    expect(f?.message).toContain("Pain isn't soreness");
    expect(f?.message).toContain('qualified clinician');
  });

  it('offers a substitution for discomfort only, never framed as a fix', () => {
    const a = assessReadiness(baseInput({ painFlag: true }));
    const f = a.findings.find((x) => x.code === 'readiness.substitution_offered');
    expect(f).toBeDefined();
    expect(f?.message).toMatch(/alternative/i);
    expect(f?.message).toMatch(/not a fix/i);
    expect(f?.message).not.toMatch(/\b(fix(es|ed)?|cure[sd]?|treat\w*|heal(s|ed|ing)?)\b(?! for whatever)/i);
  });

  it('names pain in the reasoning rather than trimming silently', () => {
    const a = assessReadiness(baseInput({ painFlag: true }));
    expect(a.adjustment.reasons.join(' ')).toMatch(/pain/i);
  });
});

/* ================================================================== */
/* Rule 5 — illness                                                    */
/* ================================================================== */

describe('§8.5 rule 5 — illness handling', () => {
  it('does no automated programming at all', () => {
    const a = assessReadiness(baseInput({ illnessFlag: true, subjectiveEnergy: 5 }));
    expect(a.programmingSuppressed).toBe(true);
    expect(a.adjustment.applied).toBe(false);
    expect(a.adjustment.conditioning).toBe('rest');
    expect(a.adjustment.volumeDelta).toBe(0);
    expect(a.adjustment.loadDelta).toBe(0);
    expect(a.adjustment.extraSetOnLastExercise).toBe(false);
  });

  it('blocks, so `hasBlock` alone is enough for a caller to refuse to prescribe', () => {
    const a = assessReadiness(baseInput({ illnessFlag: true }));
    expect(hasBlock(a.findings)).toBe(true);
  });

  it('shows rest guidance and a clinician referral, and attempts no triage', () => {
    const a = assessReadiness(baseInput({ illnessFlag: true }));
    const f = a.findings.find((x) => x.code === 'readiness.illness');
    expect(f?.message).toMatch(/rest/i);
    expect(f?.message).toMatch(/clinician/i);
    // No neck-check, no "above the neck" heuristic, no symptom sorting.
    expect(f?.message).not.toMatch(/neck|fever|symptom|above the neck/i);
  });

  it('overrides even a pain-flagged high day', () => {
    const a = assessReadiness(
      baseInput({ illnessFlag: true, painFlag: true, subjectiveEnergy: 5, subjectiveSoreness: 1 }),
    );
    expect(a.adjustment.applied).toBe(false);
    expect(a.adjustment.conditioning).toBe('rest');
  });
});

/* ================================================================== */
/* Rule 6 — no medical claims                                          */
/* ================================================================== */

describe('§8.5 rule 6 — no medical claims, ever', () => {
  const FORBIDDEN =
    /\b(diagnos\w*|treat|treats|treated|treating|treatment[s]?|cure[sd]?|curing|heal|heals|healed|healing|disease[s]?|infection|illness detected|overtraining syndrome|prevent[s]?)\b/i;

  it('never uses a clinical verb anywhere in its output', () => {
    const cases: ReadinessInput[] = [
      baseInput(),
      baseInput({ painFlag: true }),
      baseInput({ illnessFlag: true }),
      baseInput({ subjectiveSoreness: 5, subjectiveEnergy: 1, sleepHours: 4 }),
      withHrvBaseline({ hrvToday: 30, hrvSuppressedDays: 5 }),
      withHrvBaseline({ hrvToday: 95, subjectiveEnergy: 5, subjectiveSoreness: 1 }),
      baseInput({ hrvBelow2SdDays: 8 }),
      baseInput({ rhrToday: 75, rhrBaseline: 58, rhrBaselineDays: 30, rhrElevatedDays: 4 }),
      baseInput({ consecutiveReductions: 5, subjectiveSoreness: 5, subjectiveEnergy: 1 }),
      baseInput({ symptoms: { chestPain: true } }),
    ];
    for (const input of cases) {
      for (const text of allCopy(assessReadiness(input))) {
        expect(text, `forbidden clinical language in: ${text}`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('describes a suppressed HRV as "below your usual range", not as a health finding', () => {
    const a = assessReadiness(withHrvBaseline({ hrvToday: 30, hrvSuppressedDays: 5 }));
    const hrv = a.contributions.find((c) => c.id === 'hrv');
    expect(hrv?.detail).toContain(RECOVERY_COPY.belowUsualRange);
    expect(hrv?.detail).not.toMatch(/\b(sick|unwell|ill|overtrained|inflammation)\b/i);
  });

  it('does not tell the user why a referral trigger fired', () => {
    // Rule 7: "do not attempt an explanation". Naming the pattern is one step
    // from interpreting it.
    const a = assessReadiness(baseInput({ symptoms: { chestPain: true } }));
    const f = a.findings.find((x) => x.code === 'readiness.clinician_referral');
    expect(f?.message).toMatch(/not able to say why/i);
    expect(f?.message).not.toMatch(/\b(cardiac|heart problem|anaemi|anemi|virus)\b/i);
  });
});

/* ================================================================== */
/* Rule 7 — physician-first triggers                                   */
/* ================================================================== */

describe('§8.5 rule 7 — physician-first triggers', () => {
  it('fires when RHR is >10 bpm above baseline for ≥3 days', () => {
    const trip = baseInput({
      rhrToday: 69,
      rhrBaseline: 58,
      rhrBaselineDays: 30,
      rhrElevatedDays: 3,
    });
    expect(physicianReferralFindings(trip)).toHaveLength(1);

    // Two days is not three, and +10 exactly is not ">10".
    expect(physicianReferralFindings({ ...trip, rhrElevatedDays: 2 })).toHaveLength(0);
    expect(physicianReferralFindings({ ...trip, rhrToday: 68 })).toHaveLength(0);
  });

  it('fires when HRV is >2 SD below baseline for ≥7 days', () => {
    expect(physicianReferralFindings(baseInput({ hrvBelow2SdDays: 7 }))).toHaveLength(1);
    expect(physicianReferralFindings(baseInput({ hrvBelow2SdDays: 6 }))).toHaveLength(0);
  });

  it('fires on chest pain, dizziness, breathlessness, unexplained weight change or pain at rest', () => {
    const symptoms = [
      'chestPain',
      'dizzinessOrFainting',
      'shortnessOfBreath',
      'unexplainedWeightChange',
      'painAtRest',
    ] as const;
    for (const s of symptoms) {
      expect(physicianReferralFindings(baseInput({ symptoms: { [s]: true } }))).toHaveLength(1);
    }
    expect(physicianReferralFindings(baseInput({ symptoms: {} }))).toHaveLength(0);
  });

  it('suppresses readiness-based programming when it fires', () => {
    const a = assessReadiness(
      baseInput({ subjectiveEnergy: 5, subjectiveSoreness: 1, symptoms: { painAtRest: true } }),
    );
    expect(a.referral).toBe(true);
    expect(a.programmingSuppressed).toBe(true);
    expect(a.adjustment.applied).toBe(false);
    expect(a.adjustment.extraSetOnLastExercise).toBe(false);
    expect(hasBlock(a.findings)).toBe(true);
  });
});

/* ================================================================== */
/* Rules 8 and 10 — override, and show the reasoning                   */
/* ================================================================== */

describe('§8.5 rules 8 and 10 — override, and show the reasoning', () => {
  it('names its inputs on every applied adjustment', () => {
    const a = assessReadiness(
      baseInput({ sleepHours: 4.5, subjectiveSoreness: 5, subjectiveEnergy: 1 }),
    );
    expect(a.adjustment.applied).toBe(true);
    expect(a.adjustment.reasons.length).toBeGreaterThan(0);
    const reasons = a.adjustment.reasons.join(' ').toLowerCase();
    // The named drivers are the actual worst contributors, not a generic blurb.
    expect(reasons).toContain('sleep');
    expect(reasons).toContain('soreness');
    expect(reasons).toContain('energy');
  });

  it('gives every contribution a detail sentence quoting the real number', () => {
    const a = assessReadiness(
      withHrvBaseline({
        hrvToday: 45,
        hrvSuppressedDays: 1,
        sleepHours: 6,
        sleepQuality: 2,
        rhrToday: 62,
        rhrBaseline: 58,
        rhrBaselineDays: 30,
        sessionPerfLastTime: 'down',
      }),
    );
    expect(a.contributions.map((c) => c.id).sort()).toEqual(
      ['energy', 'hrv', 'performance', 'rhr', 'sleep', 'sleep_quality', 'soreness'].sort(),
    );
    for (const c of a.contributions) {
      expect(c.detail.length).toBeGreaterThan(10);
      expect(c.label.length).toBeGreaterThan(0);
    }
    expect(a.contributions.find((c) => c.id === 'sleep')?.detail).toContain('6');
    expect(a.contributions.find((c) => c.id === 'hrv')?.detail).toContain('45');
  });

  it('explains every excluded input rather than dropping it silently', () => {
    const a = assessReadiness(baseInput());
    expect(a.excluded.map((e) => e.id).sort()).toEqual(
      ['hrv', 'performance', 'rhr', 'sleep'].sort(),
    );
    for (const e of a.excluded) expect(e.reason.length).toBeGreaterThan(10);
  });

  it('tells the user the suggestion is theirs to override', () => {
    const a = assessReadiness(
      baseInput({ sleepHours: 5, subjectiveSoreness: 4, subjectiveEnergy: 2 }),
    );
    const f = a.findings.find((x) => x.code === 'readiness.override_available');
    expect(f?.message).toBe(RECOVERY_COPY.override);
  });
});

/* ================================================================== */
/* §8.3 / §8.4 — the arithmetic itself                                 */
/* ================================================================== */

describe('§8.3 — scoring', () => {
  it('matches the spec sub-score tables exactly', () => {
    expect(sleepScore(baseInput({ sleepHours: 4.9 }))).toBe(-2);
    expect(sleepScore(baseInput({ sleepHours: 6 }))).toBe(-1);
    expect(sleepScore(baseInput({ sleepHours: 6.8 }))).toBe(0);
    expect(sleepScore(baseInput({ sleepHours: 7.5, sleepDebt7d: 0 }))).toBe(1);
    expect(sleepScore(baseInput({ sleepHours: 7.5, sleepDebt7d: 4 }))).toBe(0);
    expect(sleepScore(baseInput())).toBeNull();

    expect([1, 2, 3, 4, 5].map((n) => sorenessScore(baseInput({ subjectiveSoreness: n as SubjectiveScale })))).toEqual(
      [1, 0, 0, -1, -2],
    );
    expect([1, 2, 3, 4, 5].map((n) => energyScore(baseInput({ subjectiveEnergy: n as SubjectiveScale })))).toEqual(
      [-2, -1, 0, 0, 1],
    );
    expect([1, 2, 3, 4, 5].map((n) => sleepQualityScore(baseInput({ sleepQuality: n as SubjectiveScale })))).toEqual(
      [-2, -1, 0, 0, 1],
    );
    expect(sleepQualityScore(baseInput())).toBeNull();

    expect(performanceScore(baseInput({ sessionPerfLastTime: 'up' }))).toBe(1);
    expect(performanceScore(baseInput({ sessionPerfLastTime: 'flat' }))).toBe(0);
    expect(performanceScore(baseInput({ sessionPerfLastTime: 'down' }))).toBe(-1);
    expect(performanceScore(baseInput())).toBeNull();
  });

  it('averages only the contributing sub-scores', () => {
    // sleep −1, soreness −1, energy 0 → −2/3.
    const a = assessReadiness(
      baseInput({ sleepHours: 6, subjectiveSoreness: 4, subjectiveEnergy: 3 }),
    );
    expect(a.score).toBeCloseTo(-2 / 3, 3);
    expect(a.contributions).toHaveLength(3);
  });

  it('reproduces §8.3 exactly when the optional sleep-quality input is omitted', () => {
    const spec = assessReadiness(
      withHrvBaseline({
        hrvToday: 45,
        hrvSuppressedDays: 1,
        sleepHours: 6,
        subjectiveSoreness: 4,
        subjectiveEnergy: 2,
        sessionPerfLastTime: 'down',
        rhrToday: 58,
        rhrBaseline: 58,
        rhrBaselineDays: 30,
      }),
    );
    // hrv −0.5, rhr 0, sleep −1, soreness −1, energy −1, perf −1 → −4.5/6.
    expect(spec.score).toBeCloseTo(-4.5 / 6, 6);
  });

  it('bands on the spec thresholds', () => {
    expect(bandForScore(-2)).toBe('poor');
    expect(bandForScore(-1)).toBe('poor');
    expect(bandForScore(-0.99)).toBe('low');
    expect(bandForScore(-0.31)).toBe('low');
    expect(bandForScore(-0.3)).toBe('normal');
    expect(bandForScore(0.4)).toBe('normal');
    expect(bandForScore(0.41)).toBe('high');
    expect(bandForScore(1)).toBe('high');
  });

  it('carries the §8.4 band copy', () => {
    expect(BAND_COPY.high).toContain('primed');
    expect(BAND_COPY.normal).toContain('Run the plan');
    expect(BAND_COPY.low).toContain('a bit down');
    expect(BAND_COPY.poor).toContain('not a PR day');
    expect(assessReadiness(baseInput()).bandCopy).toBe(BAND_COPY.normal);
  });
});

describe('§8.4 / §9.3 — conditioning is the first thing cut and the last thing dropped', () => {
  it('downgrades intervals on a low day and goes easy-only on a poor day', () => {
    expect(adjustmentForBand('normal').conditioning).toBe('as_programmed');
    expect(adjustmentForBand('low').conditioning).toBe('downgrade_intervals');
    expect(adjustmentForBand('poor').conditioning).toBe('easy_only');
  });
});

describe('turning a timeseries into baseline inputs', () => {
  const series = (values: number[]) =>
    values.map((value, k) => ({ date: `2026-06-${String(k + 1).padStart(2, '0')}`, value }));

  it('holds the newest reading out of its own baseline', () => {
    const b = summarizeMetricBaseline(series([60, 60, 60, 20]));
    expect(b.mean).toBe(60);
    expect(b.days).toBe(3);
    expect(b.latest?.value).toBe(20);
  });

  it('reports no SD from a single reading rather than a fake zero', () => {
    const b = summarizeMetricBaseline(series([60, 55]));
    expect(b.days).toBe(1);
    expect(b.sd).toBeNull();
  });

  it('is empty, not zero, when there is nothing to average', () => {
    expect(summarizeMetricBaseline([])).toEqual({ mean: null, sd: null, days: 0, latest: null });
  });

  it('counts a run of recent readings and stops at the first that breaks it', () => {
    expect(consecutiveDaysBelow(series([50, 40, 40, 40]), 45)).toBe(3);
    expect(consecutiveDaysBelow(series([40, 40, 40, 50]), 45)).toBe(0);
    expect(consecutiveDaysAbove(series([50, 70, 70]), 60)).toBe(2);
    expect(consecutiveDaysAbove(series([]), 60)).toBe(0);
  });

  it('composes into a baseline that gates the score exactly as rule 3 requires', () => {
    // 20 days of readings is not 21, whatever the deviation looks like.
    const twenty = summarizeMetricBaseline(
      series(Array.from({ length: 21 }, (_, k) => (k === 20 ? 30 : 62))),
    );
    expect(twenty.days).toBe(20);
    expect(
      hrvScore(
        baseInput({
          hrvToday: twenty.latest?.value,
          hrvBaseline: twenty.mean,
          hrvSD: twenty.sd ?? 1,
          hrvBaselineDays: twenty.days,
          hrvSuppressedDays: 4,
        }),
      ),
    ).toBeNull();
  });
});

describe('readinessPercent', () => {
  it('maps the raw score onto 0–100 without ever re-deciding the band', () => {
    expect(readinessPercent(-2)).toBe(0);
    expect(readinessPercent(1)).toBe(100);
    expect(readinessPercent(-0.5)).toBe(50);
    expect(readinessPercent(-99)).toBe(0);
    expect(readinessPercent(99)).toBe(100);
  });
});
