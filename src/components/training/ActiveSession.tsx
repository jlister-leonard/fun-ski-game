'use client';

import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import type { WorkoutSession } from '@/lib/db/types';
import { useUnits } from '@/lib/hooks/useUnits';
import { formatDuration, formatSet } from '@/lib/training/format';
import { useElapsedSeconds } from '@/lib/training/hooks';
import type { LoggedSet } from '@/lib/training/types';

/** Sets grouped by movement, in the order the movements were first logged. */
export interface ExerciseGroup {
  exerciseId: string;
  slug: string;
  name: string;
  sets: LoggedSet[];
}

/**
 * Group a session's sets by movement, preserving first-logged order.
 *
 * @param sets the session's sets, in logging order
 * @param nameFor resolves an exercise id to its slug and name
 * @returns one group per movement
 */
export function groupSets(
  sets: readonly LoggedSet[],
  nameFor: (exerciseId: string) => { slug: string; name: string } | null,
): ExerciseGroup[] {
  const groups = new Map<string, ExerciseGroup>();
  for (const set of sets) {
    let group = groups.get(set.exerciseId);
    if (!group) {
      const resolved = nameFor(set.exerciseId);
      group = {
        exerciseId: set.exerciseId,
        slug: resolved?.slug ?? '',
        name: resolved?.name ?? 'Exercise',
        sets: [],
      };
      groups.set(set.exerciseId, group);
    }
    group.sets.push(set);
  }
  return [...groups.values()];
}

export interface ActiveSessionProps {
  session: WorkoutSession;
  groups: readonly ExerciseGroup[];
  onAddExercise: () => void;
  onOpenExercise: (slug: string) => void;
  onFinish: () => void;
  onDiscard: () => void;
  pending?: boolean;
}

/**
 * The session in progress.
 *
 * Kept to one screen with no navigation: the app is backgrounded between every
 * set, and a workout that requires remembering where you were is a workout
 * logged on paper instead.
 *
 * Nothing here counts up, congratulates or awards anything for volume. The set
 * count is a fact about the session, not a score — `AGENTS.md` is explicit that
 * there is no gamification rewarding volume for its own sake, and a logger is
 * exactly where that temptation lives.
 */
export function ActiveSession({
  session,
  groups,
  onAddExercise,
  onOpenExercise,
  onFinish,
  onDiscard,
  pending = false,
}: ActiveSessionProps) {
  const { system } = useUnits();
  const workingSets = groups.reduce(
    (n, g) => n + g.sets.filter((s) => !s.warmup).length,
    0,
  );
  const elapsedSec = useElapsedSeconds(session.startedAt);

  return (
    <Card flush>
      <div className="p-4">
        <CardHeader
          title={session.title ?? 'Session in progress'}
          subtitle={`${formatDuration(elapsedSec)} · ${workingSets} working set${
            workingSets === 1 ? '' : 's'
          }`}
          accessory={
            <Button size="sm" variant="secondary" onClick={onFinish} loading={pending}>
              Finish
            </Button>
          }
        />
      </div>

      {groups.length > 0 && (
        <div className="divide-y divide-[var(--c-border)] border-t border-line">
          {groups.map((group) => (
            <button
              key={group.exerciseId}
              type="button"
              onClick={() => onOpenExercise(group.slug)}
              className="w-full px-4 py-3 text-left tap transition-colors duration-[var(--duration-fast)] active:bg-surface-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-base text-ink">{group.name}</span>
                <span className="shrink-0 text-sm text-ink-3">
                  {group.sets.length} set{group.sets.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {group.sets.map((set, i) => (
                  <li key={set.id} className="tnum text-sm text-ink-2">
                    <span className="mr-2 text-ink-3">{set.warmup ? 'W' : i + 1}</span>
                    {formatSet(set, system)}
                  </li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 border-t border-line p-4">
        <Button block onClick={onAddExercise}>
          Add exercise
        </Button>
        <Button variant="ghost" onClick={onDiscard} className="shrink-0 text-ink-2">
          Discard
        </Button>
      </div>
    </Card>
  );
}
