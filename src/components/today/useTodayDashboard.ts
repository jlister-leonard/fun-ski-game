'use client';

import { useMemo } from 'react';
import { useDayLogs, useRecentLogs } from '@/components/nutrition/useDiary';
import { totalEaten } from '@/components/nutrition/model';
import { useLiveQuery } from '@/components/nutrition/live';
import { HIDE_CALORIES_KEY } from '@/components/nutrition/prefs';
import { useTargets } from '@/components/nutrition/useTargets';
import { useRecovery } from '@/components/recovery/useRecovery';
import {
  insights,
  mesocycles,
  programs,
  settings,
  toDateKey,
  workoutSessions,
} from '@/lib/db/repos';
import { useVaultQuery } from '@/lib/training/hooks';
import { trainingSummary, type TrainingSnapshot } from './model';

const TARGET_HISTORY_DAYS = 180;
const DEFAULT_PREFS = Object.freeze({ hideCalories: false });

/** Compose Today from existing live vault bindings; no duplicated calculations. */
export function useTodayDashboard() {
  const todayKey = useMemo(() => toDateKey(new Date()), []);
  const dayLogs = useDayLogs(todayKey);
  const history = useRecentLogs(TARGET_HISTORY_DAYS);
  const prefs = useLiveQuery(
    'today:nutrition-preferences',
    async () => {
      const ui = (await settings.load())?.ui ?? {};
      return { hideCalories: ui[HIDE_CALORIES_KEY] === true };
    },
    DEFAULT_PREFS,
  );
  const intakeByDate = useMemo(() => {
    const out = new Map<string, number>();
    for (const log of history.data) {
      out.set(log.dateKey, (out.get(log.dateKey) ?? 0) + log.nutrients.kcal);
    }
    return out;
  }, [history.data]);
  const targets = useTargets(intakeByDate);
  const recovery = useRecovery();

  const training = useVaultQuery<TrainingSnapshot>(
    async () => {
      const [open, todaySessions, activeMesocycle, allPrograms, recentSessions] =
        await Promise.all([
          workoutSessions.getOpen(),
          workoutSessions.getForDate(todayKey),
          mesocycles.getActive(),
          programs.list(),
          workoutSessions.recent(50),
        ]);
      return { open, todaySessions, activeMesocycle, programs: allPrograms, recentSessions };
    },
    [todayKey],
  );
  const coach = useVaultQuery(() => insights.getForDate(todayKey), [todayKey]);

  const nutritionLoading =
    dayLogs.status === 'loading' ||
    history.status === 'loading' ||
    targets.status === 'loading' ||
    prefs.status === 'loading';
  const nutritionUnavailable =
    dayLogs.status === 'unavailable' ||
    history.status === 'unavailable' ||
    dayLogs.status === 'locked' ||
    history.status === 'locked' ||
    targets.status === 'locked';
  const preferenceUnavailable = prefs.status === 'unavailable' || prefs.status === 'locked';

  return {
    todayKey,
    nutrition: {
      status: nutritionLoading
        ? 'loading' as const
        : nutritionUnavailable || preferenceUnavailable
          ? 'unavailable' as const
          : 'ready' as const,
      logs: dayLogs.data,
      eaten: totalEaten(dayLogs.data),
      targets,
      hideCalories: prefs.data.hideCalories,
    },
    training: {
      loading: training.loading,
      error: training.error,
      summary: training.data ? trainingSummary(training.data) : null,
    },
    recovery,
    coach,
  };
}
