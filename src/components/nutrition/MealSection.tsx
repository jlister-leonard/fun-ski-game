'use client';

import { ListGroup, ListRow } from '@/components/ui/ListRow';
import type { FoodLog, MealSlot } from '@/lib/db/types';
import { SLOT_LABELS } from './copy';
import { EnergyValue, formatGrams } from './atoms';

/**
 * @file One meal's worth of entries.
 *
 * The day view is a list of what was eaten, grouped by meal, with the meal's
 * own totals in the header. Empty meals are not rendered — an empty
 * "Breakfast" row with a zero next to it is a prompt disguised as a heading,
 * and this product does not prompt anybody to fill in a meal.
 */

export interface MealSectionProps {
  slot: MealSlot;
  logs: readonly FoodLog[];
  hideCalories: boolean;
  onPressEntry: (log: FoodLog) => void;
}

export function MealSection({ slot, logs, hideCalories, onPressEntry }: MealSectionProps) {
  if (logs.length === 0) return null;

  const kcal = logs.reduce((sum, l) => sum + l.nutrients.kcal, 0);
  const proteinG = logs.reduce((sum, l) => sum + l.nutrients.proteinG, 0);

  return (
    <section className="mt-5">
      <div className="flex items-baseline justify-between px-1 pb-2">
        <h2 className="text-sm font-medium text-ink-2">{SLOT_LABELS[slot]}</h2>
        <div className="flex items-baseline gap-3 text-sm text-ink-3 tnum">
          <span>{Math.round(proteinG)} g protein</span>
          <EnergyValue kcal={kcal} hidden={hideCalories} />
        </div>
      </div>

      <ListGroup>
        {logs.map((log) => (
          <ListRow
            key={log.id}
            title={log.label}
            subtitle={formatGrams(log.grams)}
            value={
              <span className="flex items-baseline gap-3">
                <span className="text-ink-3">{Math.round(log.nutrients.proteinG)} g</span>
                <EnergyValue kcal={log.nutrients.kcal} hidden={hideCalories} />
              </span>
            }
            onPress={() => onPressEntry(log)}
          />
        ))}
      </ListGroup>
    </section>
  );
}
