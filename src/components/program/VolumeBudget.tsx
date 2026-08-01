'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { muscleLabel } from '@/lib/training/format';
import type { MuscleBudget, WeekPlan } from '@/lib/training/program';

/**
 * One muscle's week, as a single bar with three distinguishable parts.
 *
 * | Segment | What it is | Why it is drawn differently |
 * |---|---|---|
 * | Hatched | The **trainer's** estimated upper bound | It is a guess about a room the app was not in, and the user can shrink it by confirming a session |
 * | Solid | What the **app** is prescribing | Exact, and the only part the app controls |
 * | Faint | Prehab, at half set weight | Rank-0 veto work that came off the top before anything else was allocated |
 *
 * Merging them into one confident total would hide the fact that most of the
 * crowded muscles are crowded by an *estimate*. The scale runs to MRV with MEV
 * and the MAV window marked, and **nothing here rewards filling the bar** —
 * MRV is a limit, and the plan deliberately aims at MAV.
 */
function MuscleBar({ budget, prescribed }: { budget: MuscleBudget; prescribed: number }) {
  const { landmarks } = budget;
  // Prehab is already inside `prescribed`; it is drawn as its own segment, so
  // subtract it out of the app's share rather than counting it twice.
  const app = Math.max(0, prescribed - budget.prehab);
  const total = budget.trainerStimulus + budget.prehab + app;
  const scale = Math.max(landmarks.mrv, total, 1);
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / scale) * 100))}%`;

  const overCeiling = total > budget.ceiling;

  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-ink">
          {muscleLabel(budget.muscle)}
          {budget.lowConfidence && (
            <span className="ml-1 text-ink-3" title="Landmarks extrapolated, not published">
              *
            </span>
          )}
        </span>
        <span className="shrink-0 tnum text-xs text-ink-2">
          {round(total)}
          <span className="text-ink-3"> / {round(landmarks.mrv)}</span>
        </span>
      </div>

      <div className="relative mt-1.5 h-2.5 w-full overflow-hidden rounded-[var(--radius-full)] bg-surface-2">
        {/* The MAV window — where growth per unit of fatigue is best, and what
            this block actually aims at in a deficit. */}
        <div
          className="absolute inset-y-0 bg-[var(--c-accent-quiet)]"
          style={{
            left: pct(landmarks.mavLow),
            width: pct(landmarks.mavHigh - landmarks.mavLow),
          }}
          aria-hidden
        />
        {/* Trainer — estimated, drawn hatched so it never reads as measurement. */}
        {budget.trainerStimulus > 0 && (
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-l-[var(--radius-full)] opacity-50',
              overCeiling ? 'bg-warn' : 'bg-accent',
            )}
            style={{
              width: pct(budget.trainerStimulus),
              backgroundImage:
                'repeating-linear-gradient(135deg, transparent 0 3px, rgba(255,255,255,0.45) 3px 5px)',
            }}
            aria-hidden
          />
        )}
        {/* Prehab — rank-0, charged before anything else. */}
        {budget.prehab > 0 && (
          <div
            className="absolute inset-y-0 bg-accent opacity-30"
            style={{ left: pct(budget.trainerStimulus), width: pct(budget.prehab) }}
            aria-hidden
          />
        )}
        {/* The app's own prescription — exact. */}
        {app > 0 && (
          <div
            className={cn(
              'absolute inset-y-0 rounded-r-[var(--radius-full)]',
              overCeiling ? 'bg-warn' : 'bg-accent',
            )}
            style={{
              left: pct(budget.trainerStimulus + budget.prehab),
              width: pct(app),
            }}
            aria-hidden
          />
        )}
        {/* MEV. */}
        <div
          className="absolute inset-y-0 w-px bg-[var(--c-border-strong)]"
          style={{ left: pct(landmarks.mev) }}
          aria-hidden
        />
      </div>

      <p className="mt-1 text-xs text-ink-3">
        {budget.trainerStimulus > 0 && (
          <>
            <span className="text-ink-2">{round(budget.trainerStimulus)}</span> estimated
            from your trainer
            {' · '}
          </>
        )}
        {budget.prehab > 0 && <>{round(budget.prehab)} prehab · </>}
        {app > 0 ? (
          <span className="text-ink-2">{round(app)} from me</span>
        ) : budget.trainerStimulus > 0 ? (
          "nothing from me — your trainer's covering this"
        ) : (
          'nothing from me this week'
        )}
      </p>
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface VolumeBudgetProps {
  plan: WeekPlan;
  /** How many rows before the rest are hidden. */
  limit?: number;
}

/**
 * Weekly volume against the landmarks, with the trainer's share drawn apart.
 *
 * This is the screen where the trainer estimate earns its keep. A muscle the
 * trainer has already hammered shows as full, the app says so in words, and it
 * prescribes nothing — which is the correct output, not an omission.
 */
export function VolumeBudget({ plan, limit = 12 }: VolumeBudgetProps) {
  // Muscles the app is actually programming lead the list. `budgets` arrives
  // sorted by how crowded each muscle is, which surfaces the trainer's busiest
  // muscles first — useful, but it buries the work the athlete is being asked
  // to do under a wall of "nothing from me".
  const appShare = (b: MuscleBudget) =>
    Math.max(0, (plan.prescribed[b.muscle] ?? 0) - b.prehab);
  const rows = plan.budgets
    .filter((b) => b.trainerStimulus > 0 || (plan.prescribed[b.muscle] ?? 0) > 0)
    .sort(
      (a, b) =>
        (appShare(b) > 0 ? 1 : 0) - (appShare(a) > 0 ? 1 : 0) || appShare(b) - appShare(a),
    )
    .slice(0, limit);
  const covered = plan.coveredByTrainer.length;

  return (
    <Card>
      <CardHeader
        title="Weekly volume"
        subtitle={`Week ${plan.week}${plan.isDeload ? ' · deload' : ''} · hard sets by muscle`}
      />

      <div className="mt-2 divide-y divide-[var(--c-border)]">
        {rows.map((budget) => (
          <MuscleBar
            key={budget.muscle}
            budget={budget}
            prescribed={plan.prescribed[budget.muscle] ?? 0}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs text-ink-3">
        <Swatch className="bg-accent opacity-50" hatched label="Trainer (estimated)" />
        <Swatch className="bg-accent opacity-30" label="Prehab" />
        <Swatch className="bg-accent" label="Prescribed by me" />
        <Swatch className="bg-[var(--c-accent-quiet)]" label="MAV window" />
      </div>

      {covered > 0 && (
        <p className="mt-3 text-xs text-ink-3">
          {covered} muscle{covered === 1 ? '' : 's'} got no direct work from me this week
          because your trainer already covers {covered === 1 ? 'it' : 'them'} — anything you
          see against them here is incidental, picked up from other movements. The hatched
          part of each bar is an estimate of work I didn&apos;t see, counted at its upper
          bound so I lean toward leaving those muscles alone. Confirming sessions narrows it
          and hands sets back.
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

function Swatch({
  className,
  label,
  hatched = false,
}: {
  className: string;
  label: string;
  hatched?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn('h-2.5 w-4 rounded-[2px]', className)}
        style={
          hatched
            ? {
                backgroundImage:
                  'repeating-linear-gradient(135deg, transparent 0 3px, rgba(255,255,255,0.45) 3px 5px)',
              }
            : undefined
        }
        aria-hidden
      />
      {label}
    </span>
  );
}
