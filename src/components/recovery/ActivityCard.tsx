'use client';

/**
 * @file Recent activity — what was actually done, not a score for doing it.
 *
 * §9.3 makes conditioning the first thing readiness trims and the last thing it
 * drops, so the readiness card's guidance ("swap intervals for Zone 2") only
 * means something next to a list of what has actually been happening. That is
 * this card's whole job.
 *
 * No totals-versus-target, no streak, no ring to close. Distances are shown in
 * miles through `@/lib/units`; the records stay in metres.
 */

import { Card, CardHeader } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import type { Activity } from '@/lib/db/types';
import { formatDistance, type UnitSystem } from '@/lib/units';
import { Note } from './atoms';
import { formatActivityType, formatDuration, formatRelativeDay } from './model';

export interface ActivityCardProps {
  activities: readonly Activity[];
  todayKey: string;
  system: UnitSystem;
  /** How many to list. The rest stay in the vault, not on the screen. */
  limit?: number;
}

export function ActivityCard({ activities, todayKey, system, limit = 6 }: ActivityCardProps) {
  const shown = activities.slice(0, limit);

  return (
    <Card className="flex flex-col gap-3" flush>
      <div className="px-4 pt-4">
        <CardHeader
          title="Recent activity"
          subtitle={
            activities.length === 0
              ? 'Nothing in the last two weeks'
              : `${activities.length} in the last two weeks`
          }
        />
      </div>

      {shown.length === 0 ? (
        <div className="px-4 pb-4">
          <Note>
            Runs, rides and walks arrive with the same import as everything else.
            Sessions you log in Train appear under Train, not here.
          </Note>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((a) => (
            <li key={a.id} className="px-4">
              <ListRow
                title={a.name ?? formatActivityType(a.activityType)}
                subtitle={[
                  formatRelativeDay(a.dateKey, todayKey),
                  formatDuration(a.durationSec),
                  a.distanceM !== null ? formatDistance(a.distanceM, system).text : null,
                  a.zone !== null ? `Zone ${a.zone}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                value={
                  a.averageHeartRate !== null ? (
                    <span className="text-sm text-ink-2 tnum">
                      {Math.round(a.averageHeartRate)} bpm
                    </span>
                  ) : undefined
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
