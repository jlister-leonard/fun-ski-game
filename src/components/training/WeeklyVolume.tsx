'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { muscleLabel } from '@/lib/training/format';
import type { TrainingWeek } from '@/lib/training/store';
import { remainingBudget, type MuscleWeek } from '@/lib/training/volume';

/**
 * One muscle's week as a single bar.
 *
 * Two segments, deliberately distinguishable: the solid part is work the app
 * watched happen, the hatched part is the trainer's estimate. Merging them into
 * one confident-looking total would hide the fact that most of the second half
 * is a guess — and the guess is the part the user can improve by confirming a
 * session.
 *
 * The scale runs to MRV, with MEV and the top of MAV marked. MRV is a limit,
 * never a target: nothing here rewards filling the bar.
 */
function MuscleBar({ week }: { week: MuscleWeek }) {
  const scale = Math.max(week.landmarks.mrv, week.totalUpperBound, 1);
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;

  const overCeiling = week.status === 'above_mav' || week.status === 'above_mrv';
  const budget = remainingBudget(week);

  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-ink">
          {muscleLabel(week.muscle)}
          {week.lowConfidence && (
            <span className="ml-1 text-ink-3" title="Landmarks extrapolated, not published">
              *
            </span>
          )}
        </span>
        <span className="shrink-0 tnum text-xs text-ink-2">
          {Math.round(week.totalUpperBound * 10) / 10}
          <span className="text-ink-3"> / {week.landmarks.mrv}</span>
        </span>
      </div>

      {/* Every layer below is aria-hidden, which left the whole bar with no
          accessible name and no value — unavailable non-visually. The numbers
          exist in the caption underneath, but the bar is what carries "where
          in the window am I", so it gets its own summary. */}
      <div
        role="img"
        aria-label={`${muscleLabel(week.muscle)}: ${Math.round(week.totalUpperBound * 10) / 10} of ${week.landmarks.mrv} sets this week. Productive range ${week.landmarks.mavLow} to ${week.landmarks.mavHigh}, minimum ${week.landmarks.mev}.`}
        className="relative mt-1 h-2.5 w-full overflow-hidden rounded-[var(--radius-full)] bg-surface-2"
      >
        {/* MAV window — the band where growth per unit of fatigue is best. */}
        <div
          className="absolute inset-y-0 bg-[var(--c-accent-quiet)]"
          style={{
            left: pct(week.landmarks.mavLow),
            width: pct(week.landmarks.mavHigh - week.landmarks.mavLow),
          }}
          aria-hidden
        />
        {/* Logged — exact. */}
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-[var(--radius-full)]',
            overCeiling ? 'bg-warn' : 'bg-accent',
          )}
          style={{ width: pct(week.loggedSets) }}
          aria-hidden
        />
        {/* Trainer — estimated, drawn as a translucent continuation. */}
        {week.trainerUpperBound > 0 && (
          <div
            className={cn(
              'absolute inset-y-0 rounded-r-[var(--radius-full)] opacity-45',
              overCeiling ? 'bg-warn' : 'bg-accent',
            )}
            style={{
              left: pct(week.loggedSets),
              width: pct(week.trainerUpperBound),
            }}
            aria-hidden
          />
        )}
        {/* MEV marker. */}
        <div
          className="absolute inset-y-0 w-px bg-[var(--c-border-strong)]"
          style={{ left: pct(week.landmarks.mev) }}
          aria-hidden
        />
      </div>

      <div className="mt-1 text-xs text-ink-3">
        {week.trainerUpperBound > 0 && (
          <>
            {Math.round(week.loggedSets * 10) / 10} logged ·{' '}
            {Math.round(week.trainerUpperBound * 10) / 10} estimated from your trainer
            {' · '}
          </>
        )}
        {budget.sets > 0
          ? `${budget.sets} set${budget.sets === 1 ? '' : 's'} of room left`
          : week.trainerUpperBound > 0
            ? "your trainer's covering this"
            : 'at the ceiling'}
      </div>
    </div>
  );
}

export interface WeeklyVolumeProps {
  week: TrainingWeek | null;
  loading?: boolean;
  /** How many rows to show before "show all". */
  limit?: number;
}

/**
 * The week's hard sets per muscle, app and trainer side by side.
 *
 * This is the screen where the trainer-session estimate earns its keep: a
 * muscle the trainer has already hammered shows as full, and the app says so
 * rather than quietly programming more on top of it.
 */
export function WeeklyVolume({ week, loading = false, limit = 10 }: WeeklyVolumeProps) {
  if (loading || !week) {
    return (
      <Card>
        <CardHeader title="This week" subtitle="Hard sets by muscle" />
        <p className="mt-3 text-sm text-ink-2">
          {loading ? 'Reading your week…' : 'Nothing logged yet.'}
        </p>
      </Card>
    );
  }

  const rows = week.muscles.filter((m) => m.totalUpperBound > 0).slice(0, limit);
  const estimatePct = Math.round(week.confidence * 100);

  return (
    <Card>
      <CardHeader
        title="This week"
        subtitle={`${week.from} – ${week.to} · hard sets by muscle`}
      />

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2">
          Nothing logged this week yet. Log a session, or record a trainer session so the
          app knows what it is working around.
        </p>
      ) : (
        <div className="mt-2 divide-y divide-[var(--c-border)]">
          {rows.map((row) => (
            <MuscleBar key={row.muscle} week={row} />
          ))}
        </div>
      )}

      {week.trainerSessions > 0 && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
          {week.trainerSessions} trainer session
          {week.trainerSessions === 1 ? '' : 's'} counted, {week.trainerConfirmed} confirmed
          — confidence {estimatePct}%. The translucent part of each bar is an estimate of
          work I didn&apos;t see, counted at its upper bound so I lean toward leaving those
          muscles alone. Confirming sessions narrows it and hands sets back.
        </p>
      )}

      {rows.some((r) => r.lowConfidence) && (
        <p className="mt-2 text-xs text-ink-3">
          * Landmarks for this muscle are extrapolated rather than published — treat the
          ceiling loosely.
        </p>
      )}
    </Card>
  );
}
