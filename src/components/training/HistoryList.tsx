'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { ListGroup, ListRow } from '@/components/ui/ListRow';
import type { PersonalRecord, WorkoutSession } from '@/lib/db/types';
import { useUnits } from '@/lib/hooks/useUnits';
import { formatLoad } from '@/lib/units';
import { muscleLabel, regionLabel } from '@/lib/training/format';
import { readTrainerReport } from '@/lib/training/types';

/** A session's one-line summary, computed once per row. */
function summarise(session: WorkoutSession, setCount: number): string {
  if (session.kind === 'personal_trainer') {
    const report = readTrainerReport(session);
    if (!report) return 'Trainer session';
    const worked = Object.entries(report.regionEffort)
      .filter(([, level]) => (level ?? 0) >= 2)
      .map(([region]) => regionLabel(region))
      .slice(0, 3);
    const head = worked.length > 0 ? worked.join(', ') : 'General';
    return `${head} · ${report.durationMin} min${report.confirmed ? '' : ' · estimated'}`;
  }
  return `${setCount} set${setCount === 1 ? '' : 's'}`;
}

export interface HistoryListProps {
  sessions: readonly WorkoutSession[];
  /** Set counts by session id, so the list does not re-query per row. */
  setCounts: ReadonlyMap<string, number>;
  onOpenSession?: (sessionId: string) => void;
}

/**
 * Recent sessions, the app's and the trainer's together.
 *
 * Showing both in one list is the point: the week the athlete actually trains
 * includes trainer days plus whatever the app programmed around them, and a
 * history that only showed the app's half would misrepresent the week to the
 * person living it.
 */
export function HistoryList({ sessions, setCounts, onOpenSession }: HistoryListProps) {
  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader title="Recent sessions" />
        <p className="mt-3 text-sm text-ink-2">Nothing logged yet.</p>
      </Card>
    );
  }

  return (
    <section>
      <h2 className="px-1 pb-2 text-2xs uppercase tracking-wide text-ink-3">
        Recent sessions
      </h2>
      <ListGroup>
        {sessions.map((session) => (
          <ListRow
            key={session.id}
            title={
              session.kind === 'personal_trainer'
                ? (session.coachName ?? 'Trainer session')
                : (session.title ?? 'Session')
            }
            subtitle={summarise(session, setCounts.get(session.id) ?? 0)}
            value={session.dateKey}
            onPress={onOpenSession ? () => onOpenSession(session.id) : undefined}
          />
        ))}
      </ListGroup>
    </section>
  );
}

export interface PersonalRecordListProps {
  records: readonly PersonalRecord[];
  /** Exercise id → display name. */
  nameById: ReadonlyMap<string, string>;
}

/**
 * Personal records, stated as facts.
 *
 * No streaks, no badges, no "you're on fire". A PR is worth showing because it
 * is information the athlete uses to pick their next load — not because
 * training deserves a payout.
 */
export function PersonalRecordList({ records, nameById }: PersonalRecordListProps) {
  const { system } = useUnits();
  if (records.length === 0) return null;

  return (
    <section>
      <h2 className="px-1 pb-2 text-2xs uppercase tracking-wide text-ink-3">
        Personal records
      </h2>
      <ListGroup>
        {records.map((pr) => (
          <ListRow
            key={pr.id}
            title={nameById.get(pr.exerciseId) ?? 'Exercise'}
            subtitle={
              pr.kind === 'e1rm'
                ? `Estimated 1RM · ${formatLoad(pr.weightKg, system).text} × ${pr.reps}`
                : `${pr.reps} reps`
            }
            value={
              pr.kind === 'e1rm'
                ? formatLoad(pr.value, system).text
                : String(Math.round(pr.value))
            }
          />
        ))}
      </ListGroup>
    </section>
  );
}

export interface TrainerCoverageProps {
  /** Muscles the trainer's estimate already fills, most crowded first. */
  muscles: readonly { muscle: string }[];
}

/**
 * The one-line version of the budget: what the app is deliberately not
 * programming this week, and why.
 */
export function TrainerCoverage({ muscles }: TrainerCoverageProps) {
  if (muscles.length === 0) return null;
  const names = muscles.slice(0, 4).map((m) => muscleLabel(m.muscle));
  return (
    <Card>
      <CardHeader title="Left to your trainer" />
      <p className="mt-2 text-sm text-ink-2">
        On my estimate your trainer is already covering{' '}
        <span className="text-ink">{names.join(', ')}</span>, so I&apos;m not programming
        more there this week. My model doesn&apos;t see your sessions and could easily be
        wrong — your trainer does.
      </p>
    </Card>
  );
}
