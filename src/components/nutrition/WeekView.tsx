'use client';

import { Card } from '@/components/ui/Card';
import type { FoodLog } from '@/lib/db/types';
import { EnergyValue, Note, formatGrams } from './atoms';
import { weekDiaryRows } from './model';

export interface WeekViewProps {
  endingDate: string;
  logs: readonly FoodLog[];
  hideCalories: boolean;
  onSelectDay: (dateKey: string) => void;
}

/** Seven-day intake overview ending on the selected diary date. */
export function WeekView({ endingDate, logs, hideCalories, onSelectDay }: WeekViewProps) {
  const rows = weekDiaryRows(endingDate, logs);
  return (
    <Card>
      <div className="text-base text-ink">Seven days</div>
      <Note className="mt-1">A day with no entries is shown as unlogged, never as zero intake.</Note>
      <div className="mt-3 divide-y divide-line">
        {rows.map((row) => (
          <button
            key={row.dateKey}
            type="button"
            onClick={() => onSelectDay(row.dateKey)}
            className="w-full py-3 text-left active:opacity-60"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-ink">{row.label}</span>
              {row.logged ? (
                <EnergyValue kcal={row.total.kcal} hidden={hideCalories} className="text-sm text-ink" />
              ) : (
                <span className="text-sm text-ink-3">Not logged</span>
              )}
            </div>
            {row.logged && (
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-3">
                <span>Protein {formatGrams(row.total.proteinG)}</span>
                <span>Carbs {formatGrams(row.total.carbG)}</span>
                <span>Fat {formatGrams(row.total.fatG)}</span>
                <span>{row.entries} {row.entries === 1 ? 'entry' : 'entries'}</span>
              </div>
            )}
          </button>
        ))}
      </div>
    </Card>
  );
}
