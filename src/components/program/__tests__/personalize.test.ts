import { describe, expect, it } from 'vitest';

import { EMPTY_HEALTH, EMPTY_TRAINING } from '@/components/onboarding/store';
import { generateWeek } from '@/lib/training/program';
import {
  applyReadinessToDay,
  canSaveProgram,
  profileFromOnboarding,
  trainingReadinessState,
  type TrainingReadinessState,
} from '../personalize';

function state(over: Partial<TrainingReadinessState['decision']> = {}): TrainingReadinessState {
  return {
    painFlag: false,
    programmingSuppressed: false,
    suppressionReason: null,
    decision: {
      band: 'low', programmingSuppressed: false, adjustmentPaused: false, referral: false,
      adjustment: {
        applied: true, volumeDelta: -0.25, setsPerExerciseDelta: -1,
        minSetsPerExercise: 2, rirDelta: 1, minRir: 3, loadDelta: -0.05,
        extraSetOnLastExercise: false, conditioning: 'downgrade_intervals',
        reasons: ['Recovery is down.'],
      },
      ...over,
    },
  };
}

describe('planner personalization', () => {
  it('uses onboarding days, training age, working lifts, goals, and discomfort', () => {
    const profile = profileFromOnboarding({
      training: {
        ...EMPTY_TRAINING,
        trainingAge: 'advanced',
        daysPerWeek: 5,
        trainerDays: [2, 3],
        workingWeights: [{ slug: 'hack-squat', label: 'Hack squat', kg: 80 }],
      },
      health: { ...EMPTY_HEALTH, injuries: ['left knee'] },
      activeGoal: null,
      secondaryGoals: ['strength', 'vo2max'],
    });

    expect(profile.trainingAge).toBe('advanced');
    expect(profile.trainerDays).toEqual([2, 3]);
    expect(profile.appDays).toEqual([1, 4, 5]);
    expect(profile.indicatorLifts).toEqual(['hack-squat']);
    expect(profile.goals.map((goal) => goal.id)).toEqual(['strength', 'vo2max']);
    expect(profile.discomfortSites).toEqual(['left knee']);
  });

  it('uses conservative beginner landmarks when training age is unanswered', () => {
    const profile = profileFromOnboarding({
      training: EMPTY_TRAINING,
      health: EMPTY_HEALTH,
      activeGoal: null,
      secondaryGoals: [],
    });
    expect(profile.trainingAge).toBe('beginner');
    expect(profile.appDays).toEqual([1, 5, 6, 0]);
  });

  it('applies a low-readiness reduction only to the matching app day', () => {
    const profile = profileFromOnboarding({
      training: EMPTY_TRAINING,
      health: EMPTY_HEALTH,
      activeGoal: null,
      secondaryGoals: ['strength'],
    });
    const plan = generateWeek(profile, { canPerform: () => true });
    const monday = plan.days.find((day) => day.day === 1 && day.owner === 'app');
    const friday = plan.days.find((day) => day.day === 5 && day.owner === 'app');
    expect(monday).toBeDefined();
    expect(friday).toBeDefined();

    const adjusted = applyReadinessToDay(plan, 1, state());
    const adjustedMonday = adjusted.days.find((day) => day.day === 1 && day.owner === 'app');
    const adjustedFriday = adjusted.days.find((day) => day.day === 5 && day.owner === 'app');
    expect(adjustedMonday?.items.every((item, index) => item.sets <= (monday?.items[index]?.sets ?? 0)))
      .toBe(true);
    expect(adjustedFriday).toEqual(friday);
    expect(adjusted.findings.some((finding) => finding.code === 'readiness.low')).toBe(true);
  });

  it('suppresses the matching app day for illness or referral symptoms', () => {
    const profile = profileFromOnboarding({
      training: EMPTY_TRAINING, health: EMPTY_HEALTH, activeGoal: null, secondaryGoals: [],
    });
    const plan = generateWeek(profile, { canPerform: () => true });
    const suppressed = applyReadinessToDay(plan, 1, {
      ...state(), programmingSuppressed: true, suppressionReason: 'illness',
    });
    const monday = suppressed.days.find((day) => day.day === 1 && day.owner === 'app');
    expect(monday?.items.every((item) => item.sets === 0)).toBe(true);
    expect(suppressed.findings.some((finding) => finding.level === 'block')).toBe(true);
  });

  it('does not guess a band for migrated rows but still fails closed on symptoms', () => {
    const migrated = trainingReadinessState({
      trainingDecision: null,
      subjective: {
        soreness: 3, energy: 3, motivation: null, stress: null, sleepQuality: null,
        painFlag: false, illnessFlag: false,
        symptoms: {
          chestPain: true, dizzinessOrFainting: false, shortnessOfBreath: false,
          unexplainedWeightChange: false, painAtRest: false,
        },
      },
    } as never);
    expect(migrated.decision).toBeNull();
    expect(migrated.programmingSuppressed).toBe(true);
    expect(migrated.suppressionReason).toBe('referral');
  });

  it('uses the persisted canonical band instead of re-banding the 0–100 display score', () => {
    const record = {
      score: 67,
      trainingDecision: state().decision,
      subjective: null,
    } as never;
    expect(trainingReadinessState(record).decision?.band).toBe('low');
  });

  it('cannot save a generic or safety-suppressed plan', () => {
    expect(canSaveProgram({ contextReady: false, trainingHistoryReady: true, paceReady: true, programmingSuppressed: false }))
      .toBe(false);
    expect(canSaveProgram({ contextReady: true, trainingHistoryReady: false, paceReady: true, programmingSuppressed: false }))
      .toBe(false);
    expect(canSaveProgram({ contextReady: true, trainingHistoryReady: true, paceReady: false, programmingSuppressed: false }))
      .toBe(false);
    expect(canSaveProgram({ contextReady: true, trainingHistoryReady: true, paceReady: true, programmingSuppressed: true }))
      .toBe(false);
    expect(canSaveProgram({ contextReady: true, trainingHistoryReady: true, paceReady: true, programmingSuppressed: false }))
      .toBe(true);
  });
});
