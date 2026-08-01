import type { MacroTargets, ReadinessAssessment } from '@/lib/algorithms';
import type {
  Insight,
  Mesocycle,
  Nutrients,
  Program,
  WorkoutSession,
} from '@/lib/db/types';
import type { RecoverySnapshot } from '@/components/recovery/model';
import { hrvView, rhrView } from '@/components/recovery/model';

export interface MacroTile {
  readonly label: string;
  readonly unit: string | null;
  readonly value: string;
  readonly target: string | null;
  readonly tone: 'calories' | 'protein' | 'carbs' | 'fat';
}

/** Dashboard macros, with calorie numbers removed structurally when hidden. */
export function nutritionTiles(
  eaten: Nutrients,
  targets: MacroTargets | null,
  hideCalories: boolean,
): MacroTile[] {
  return [
    {
      label: 'Energy',
      unit: hideCalories ? null : 'kcal',
      value: hideCalories ? 'Hidden' : Math.round(eaten.kcal).toLocaleString('en-US'),
      target:
        hideCalories || targets === null
          ? null
          : `Target ${Math.round(targets.kcal).toLocaleString('en-US')}`,
      tone: 'calories',
    },
    macro('Protein', eaten.proteinG, targets?.proteinG ?? null, 'protein'),
    macro('Carbs', eaten.carbG, targets?.carbG ?? null, 'carbs'),
    macro('Fat', eaten.fatG, targets?.fatG ?? null, 'fat'),
  ];
}

function macro(
  label: string,
  eaten: number,
  target: number | null,
  tone: MacroTile['tone'],
): MacroTile {
  return {
    label,
    unit: 'g',
    value: Math.round(eaten).toLocaleString('en-US'),
    target: target === null ? null : `Target ${Math.round(target).toLocaleString('en-US')}`,
    tone,
  };
}

export type TrainingSummary =
  | {
      readonly kind: 'active' | 'completed' | 'next' | 'block';
      readonly title: string;
      readonly subtitle: string;
      readonly detail: string | null;
    }
  | { readonly kind: 'empty'; readonly title: string; readonly subtitle: string; readonly detail: null };

export interface TrainingSnapshot {
  readonly open: WorkoutSession | null;
  readonly todaySessions: readonly WorkoutSession[];
  readonly activeMesocycle: Mesocycle | null;
  readonly programs: readonly Program[];
  readonly recentSessions: readonly WorkoutSession[];
}

/** Select only a training state the persisted schema can actually support. */
export function trainingSummary(snapshot: TrainingSnapshot): TrainingSummary {
  if (snapshot.open) {
    return {
      kind: 'active',
      title: snapshot.open.title?.trim() || 'Workout in progress',
      subtitle: 'Started and not finished yet',
      detail: sessionKind(snapshot.open.kind),
    };
  }

  const completedToday = [...snapshot.todaySessions]
    .filter((session) => session.endedAt !== null)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  if (completedToday) {
    return {
      kind: 'completed',
      title: completedToday.title?.trim() || 'Workout logged today',
      subtitle: 'Completed today',
      detail: sessionKind(completedToday.kind),
    };
  }

  const active = snapshot.activeMesocycle;
  if (!active) {
    return {
      kind: 'empty',
      title: 'No active program',
      subtitle: 'Build a block when you are ready',
      detail: null,
    };
  }
  const program = snapshot.programs.find((item) => item.id === active.programId);
  if (!program || program.days.length === 0) {
    return {
      kind: 'block',
      title: active.name,
      subtitle: 'Active training block',
      detail: 'No programmed session is stored for this block.',
    };
  }

  const linked = snapshot.recentSessions
    .filter(
      (session) =>
        session.mesocycleId === active.id &&
        session.endedAt !== null &&
        session.dayIndex !== null &&
        session.dayIndex >= 0 &&
        session.dayIndex < program.days.length,
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const nextIndex = linked?.dayIndex === null || linked?.dayIndex === undefined
    ? 0
    : (linked.dayIndex + 1) % program.days.length;
  const day = program.days[nextIndex];
  const knownOrder = linked !== undefined || snapshot.recentSessions.every(
    (session) => session.mesocycleId !== active.id,
  );

  if (!knownOrder) {
    return {
      kind: 'block',
      title: active.name,
      subtitle: 'Active training block',
      detail: 'Logged sessions are not linked to program days, so Keel cannot name the next one yet.',
    };
  }

  const sets = day.slots.reduce((sum, slot) => sum + slot.sets, 0);
  return {
    kind: 'next',
    title: day.label,
    subtitle: linked ? `Next in ${active.name}` : `First programmed session in ${active.name}`,
    detail: `${day.slots.length} ${day.slots.length === 1 ? 'movement' : 'movements'} · ${sets} sets`,
  };
}

function sessionKind(kind: WorkoutSession['kind']): string {
  const labels: Record<WorkoutSession['kind'], string> = {
    self: 'Self-guided session',
    personal_trainer: 'Session with your trainer',
    class: 'Class',
    rehab: 'Rehab session',
  };
  return labels[kind];
}

export interface RecoverySummary {
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string | null;
  readonly hasAssessment: boolean;
}

/** Summarize readiness without turning a partial baseline into a score. */
export function recoverySummary(
  assessment: ReadinessAssessment | null,
  snapshot: RecoverySnapshot | null,
): RecoverySummary {
  if (assessment) {
    const labels = { high: 'High', normal: 'Normal', low: 'Low', poor: 'Poor' } as const;
    return {
      title: `${labels[assessment.band]} readiness`,
      subtitle: assessment.bandCopy,
      detail: assessment.baseline.message,
      hasAssessment: true,
    };
  }
  if (!snapshot) {
    return {
      title: 'No readiness state yet',
      subtitle: 'Check in to assess today',
      detail: null,
      hasAssessment: false,
    };
  }
  const hrv = hrvView(snapshot.hrv);
  const rhr = rhrView(snapshot.rhr);
  if (hrv.series.length === 0 && rhr.series.length === 0) {
    return {
      title: 'No readiness check-in yet',
      subtitle: 'Import readings or answer today’s check-in',
      detail: null,
      hasAssessment: false,
    };
  }
  const progress = [
    hrv.series.length > 0
      ? hrv.ready
        ? `HRV baseline ${hrv.days} days`
        : `HRV ${hrv.days}/${hrv.days + hrv.daysRemaining}`
      : null,
    rhr.series.length > 0
      ? rhr.ready
        ? `RHR baseline ${rhr.days} days`
        : `RHR ${rhr.days}/${rhr.days + rhr.daysRemaining}`
      : null,
  ].filter((item): item is string => item !== null);
  return {
    title: hrv.ready || rhr.ready ? 'Baseline data is ready' : 'Building your baseline',
    subtitle: 'Check in to turn today’s inputs into readiness guidance',
    detail: progress.join(' · '),
    hasAssessment: false,
  };
}

/** Preserve repository ranking while suppressing calorie copy when requested. */
export function visibleInsights(
  insights: readonly Insight[],
  hideCalories: boolean,
  limit = 3,
): Insight[] {
  return insights
    .filter(
      (insight) =>
        !hideCalories || !/\b(?:kcal|calorie|calories)\b/i.test(`${insight.title} ${insight.body}`),
    )
    .slice(0, limit);
}
