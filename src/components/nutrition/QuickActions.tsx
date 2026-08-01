'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { ListGroup, ListRow } from '@/components/ui/ListRow';
import type { FoodItem } from '@/data/foods';
import type { FoodLog } from '@/lib/db/types';
import { DIARY_COPY } from './copy';
import { EnergyValue, formatGrams } from './atoms';

/**
 * @file The three shortcuts that make the diary fast on the second day.
 *
 * Repeat yesterday, the foods you actually eat, and a way in for anything the
 * database does not have. Ranked by how often they save a search.
 *
 * Note what is deliberately absent: any count, badge or run-length. "You have
 * logged 12 days in a row" is a streak, a streak on intake rewards
 * restriction directly, and `validateTrackingSafety()` treats it as a
 * `block`-level violation rather than a feature.
 */

export interface QuickActionsProps {
  /** Yesterday's entries, for the repeat action. */
  yesterday: readonly FoodLog[];
  /** Recently logged catalogue items, most recent first. */
  recent: readonly FoodItem[];
  hideCalories: boolean;
  onRepeatYesterday: () => void | Promise<void>;
  onPickRecent: (item: FoodItem) => void;
  onCreateCustom: () => void;
}

export function QuickActions({
  yesterday,
  recent,
  hideCalories,
  onRepeatYesterday,
  onPickRecent,
  onCreateCustom,
}: QuickActionsProps) {
  const slots = new Set(yesterday.map((l) => l.slot)).size;
  const yesterdayKcal = yesterday.reduce((sum, l) => sum + l.nutrients.kcal, 0);

  return (
    <Card flush className="overflow-hidden">
      <div className="p-4 pb-2">
        <CardHeader title={DIARY_COPY.quickHeading} />
      </div>

      <ListGroup className="rounded-none border-x-0 border-b-0">
        <ListRow
          title={DIARY_COPY.repeatYesterday}
          subtitle={
            yesterday.length === 0
              ? DIARY_COPY.repeatYesterdayEmpty
              : DIARY_COPY.repeatYesterdayDetail(yesterday.length, slots)
          }
          value={
            yesterday.length > 0 ? (
              <EnergyValue kcal={yesterdayKcal} hidden={hideCalories} />
            ) : undefined
          }
          muted={yesterday.length === 0}
          onPress={yesterday.length === 0 ? undefined : () => void onRepeatYesterday()}
        />

        {recent.slice(0, 6).map((item) => (
          <ListRow
            key={item.id}
            title={item.name}
            subtitle={item.brand ?? formatGrams(item.servings[0]?.grams ?? 100)}
            onPress={() => onPickRecent(item)}
          />
        ))}

        <ListRow
          title={DIARY_COPY.customFood}
          subtitle={DIARY_COPY.customFoodDetail}
          onPress={onCreateCustom}
        />
      </ListGroup>
    </Card>
  );
}
