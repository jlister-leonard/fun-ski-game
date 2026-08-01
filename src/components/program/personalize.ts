import type { HealthIntake, TrainingIntake } from '@/components/onboarding/store';
import type {
  Goal,
  ReadinessRecord,
  ReadinessTrainingDecision,
} from '@/lib/db/types';
import {
  prescribedByMuscle,
  type DayOfWeek,
  type GoalId,
  type ProgramGoal,
  type ProgramProfile,
  type WeekPlan,
} from '@/lib/training/program';

/** Generic fallback when no trainer schedule has been configured. */
const DEFAULT_APP_DAY_ORDER: readonly DayOfWeek[] = [1, 5, 6, 0, 2, 3, 4];

/** Put the app day before and after a trainer block first, then fill remaining days. */
function appDayOrder(trainerDays: readonly DayOfWeek[]): DayOfWeek[] {
  if (trainerDays.length === 0) return [...DEFAULT_APP_DAY_ORDER];
  const ordered = [...trainerDays].sort((a, b) => (a || 7) - (b || 7));
  const preferred = [
    ((ordered[0] + 6) % 7) as DayOfWeek,
    ((ordered[ordered.length - 1] + 1) % 7) as DayOfWeek,
    ...DEFAULT_APP_DAY_ORDER,
  ];
  return [...new Set(preferred)].filter((day) => !trainerDays.includes(day));
}

const GOAL_LABELS: Readonly<Record<GoalId, string>> = {
  joint_integrity: 'joint integrity',
  fat_loss: 'fat loss',
  vo2max: 'VO2 max',
  strength: 'strength',
  hypertrophy: 'muscle growth',
};

function goalRows(activeGoal: Goal | null, secondary: readonly string[]): ProgramGoal[] {
  const ids: GoalId[] = [];
  if (activeGoal?.direction === 'cut') ids.push('fat_loss');
  for (const id of secondary) {
    if (
      (id === 'joint_integrity' || id === 'fat_loss' || id === 'vo2max' ||
        id === 'strength' || id === 'hypertrophy') &&
      !ids.includes(id)
    ) {
      ids.push(id);
    }
  }
  return ids.map((id, rank) => ({
    id,
    rank,
    intent: id === 'strength' && activeGoal?.direction === 'cut' ? 'maintain' : 'improve',
    statedAs: `selected ${GOAL_LABELS[id]} during onboarding`,
  }));
}

/**
 * Convert encrypted onboarding answers into the pure generator's profile.
 *
 * Missing answers stay conservative and visible: a missing training age uses
 * the beginner volume landmarks, while a missing weekly-day count uses every
 * app-owned day in the canonical skeleton. Trainer focus is kept in memory
 * only long enough for the local estimator to build a coarse prior.
 */
export function profileFromOnboarding(input: {
  training: TrainingIntake;
  health: HealthIntake;
  activeGoal: Goal | null;
  secondaryGoals: readonly string[];
}): ProgramProfile {
  const trainerDays = [...new Set(input.training.trainerDays)];
  const requestedAppDays = input.training.daysPerWeek === null
    ? 4
    : Math.max(0, Math.round(input.training.daysPerWeek) - trainerDays.length);
  const appDays = appDayOrder(trainerDays).slice(0, requestedAppDays);

  return {
    trainingAge: input.training.trainingAge ?? 'beginner',
    deficit: input.activeGoal?.direction === 'cut',
    appDays,
    trainerDays,
    trainerFocus: input.training.trainerFocus,
    equipment: [],
    indicatorLifts: input.training.workingWeights.map((row) => row.slug),
    ladders: [],
    goals: goalRows(input.activeGoal, input.secondaryGoals),
    discomfortSites: [...input.health.injuries],
  };
}

export interface TrainingReadinessState {
  decision: ReadinessTrainingDecision | null;
  painFlag: boolean;
  programmingSuppressed: boolean;
  suppressionReason: 'illness' | 'referral' | null;
}

/** Saving is fail-closed until every personalized source has emitted. */
export function canSaveProgram(options: {
  contextReady: boolean;
  trainingHistoryReady: boolean;
  paceReady: boolean;
  programmingSuppressed: boolean;
}): boolean {
  return options.contextReady && options.trainingHistoryReady && options.paceReady &&
    !options.programmingSuppressed;
}

/**
 * Read the persisted engine decision, while failing closed for migrated rows
 * whose old body predates that decision. Subjective safety flags are canonical
 * user input and remain sufficient to suppress programming on those rows.
 */
export function trainingReadinessState(record: ReadinessRecord | null): TrainingReadinessState {
  const subjective = record?.subjective;
  const hasReferralSymptom = subjective
    ? Object.values(subjective.symptoms).some(Boolean)
    : false;
  const illness = subjective?.illnessFlag ?? false;
  const decision = record?.trainingDecision ?? null;
  const programmingSuppressed =
    illness || hasReferralSymptom || (decision?.programmingSuppressed ?? false);
  return {
    decision,
    painFlag: subjective?.painFlag ?? false,
    programmingSuppressed,
    suppressionReason: illness ? 'illness' : hasReferralSymptom || decision?.referral ? 'referral' : null,
  };
}

/** Apply today's persisted readiness decision only to today's app-owned plan. */
export function applyReadinessToDay(
  plan: WeekPlan,
  day: DayOfWeek,
  state: TrainingReadinessState,
): WeekPlan {
  const findings = [...plan.findings];
  if (state.programmingSuppressed) {
    findings.push({
      ok: false,
      level: 'block',
      code: 'readiness.programming_suppressed',
      message: state.suppressionReason === 'illness'
        ? 'No session is being programmed today because you flagged illness.'
        : 'Readiness-based programming is paused while the symptoms you reported are looked at properly.',
    });
  } else if (state.decision?.adjustmentPaused) {
    findings.push({
      ok: false,
      level: 'warn',
      code: 'readiness.stop_adjusting',
      message: 'Readiness has already trimmed three sessions in a row, so it is not hiding the problem by trimming another. Take a rest day or deload.',
    });
  }

  const adjustment = state.decision?.adjustment ?? null;
  if (!state.programmingSuppressed && (!adjustment || !adjustment.applied)) {
    return findings.length === plan.findings.length ? plan : { ...plan, findings };
  }

  const days = plan.days.map((planned) => {
    if (planned.day !== day || planned.owner !== 'app') return planned;
    const lastIndex = planned.items.length - 1;
    const items = planned.items.map((item, index) => {
      if (state.programmingSuppressed || !adjustment) {
        return {
          ...item,
          sets: 0,
          note: [item.note, 'Readiness safety gate: no session is programmed today.']
            .filter(Boolean)
            .join(' '),
        };
      }
      const floor = Math.min(adjustment.minSetsPerExercise, item.sets);
      const byExercise = item.sets + adjustment.setsPerExerciseDelta;
      const byVolume = Math.round(item.sets * (1 + adjustment.volumeDelta));
      const adjustedSets = Math.max(floor, Math.min(item.sets, byExercise, byVolume));
      const extra = adjustment.extraSetOnLastExercise && index === lastIndex ? 1 : 0;
      return {
        ...item,
        sets: adjustedSets + extra,
        targetRir: item.targetRir === null
          ? null
          : Math.min(10, Math.max(adjustment.minRir ?? 0, item.targetRir + adjustment.rirDelta)),
        note: adjustment.loadDelta === 0
          ? item.note
          : [item.note, `Readiness adjustment: use ${Math.round((1 + adjustment.loadDelta) * 100)}% of the planned load.`]
              .filter(Boolean)
              .join(' '),
      };
    });
    return { ...planned, items };
  });
  if (!state.programmingSuppressed && adjustment?.reasons[0]) {
    findings.push({
      ok: false,
      level: 'info',
      code: `readiness.${state.decision?.band ?? 'adjusted'}`,
      message: adjustment.reasons[0],
    });
  }
  const adjusted = { ...plan, days, findings };
  return { ...adjusted, prescribed: prescribedByMuscle(adjusted.days) };
}
