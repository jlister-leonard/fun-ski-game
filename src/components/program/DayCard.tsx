'use client';

import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { formatCount, formatDuration } from '@/lib/training/format';
import type { PlannedDay, PrescribedItem } from '@/lib/training/program';
import { useUnits } from '@/lib/hooks/useUnits';
import type { UnitSystem } from '@/lib/units';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A prescription line, rendered in the athlete's own units.
 *
 * The count is formatted through `rep_unit`, never through an assumption: a
 * 4-minute interval renders as `4:00`, a sled push as yards, a plank as
 * seconds. This is the one place where getting it wrong shows up as "1800
 * reps" on the Zone 2 card.
 */
function doseLine(item: PrescribedItem, system: UnitSystem): string {
  const low = formatCount(item.repMin, item.repUnit, system);
  const high = formatCount(item.repMax, item.repUnit, system);
  const range = item.repMin === item.repMax ? low : `${stripUnit(low, high)}–${high}`;
  const per = item.unilateral ? '/side' : '';
  const label = item.repUnit === 'meters' && item.sets > 1 ? 'bouts' : 'sets';
  return `${item.sets} ${item.sets === 1 ? label.replace(/s$/, '') : label} × ${range}${per}`;
}

/** `8–12 reps`, not `8 reps–12 reps`. */
function stripUnit(low: string, high: string): string {
  const suffix = high.replace(/^[\d.:]+\s*/, '');
  return suffix.length > 0 && low.endsWith(suffix)
    ? low.slice(0, low.length - suffix.length).trim()
    : low;
}

function RoleChip({ item }: { item: PrescribedItem }) {
  if (item.role === 'indicator') {
    return <Chip tone="accent">Indicator</Chip>;
  }
  if (item.role === 'prehab' || item.role === 'mobility') {
    return <Chip tone="quiet">Prehab</Chip>;
  }
  if (item.role === 'conditioning') {
    return <Chip tone="quiet">{item.zone ? item.zone.toUpperCase() : 'Conditioning'}</Chip>;
  }
  return null;
}

function Chip({ tone, children }: { tone: 'accent' | 'quiet'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[var(--radius-full)] px-2 py-0.5 text-[11px]',
        tone === 'accent' ? 'bg-accent-quiet text-accent' : 'bg-surface-2 text-ink-2',
      )}
    >
      {children}
    </span>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  label: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        className="h-8 w-8 rounded-[var(--radius-sm)] bg-surface-2 text-ink-2 tap disabled:opacity-40"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        aria-label={`One less set of ${label}`}
      >
        −
      </button>
      <span className="w-6 text-center tnum text-sm text-ink">{value}</span>
      <button
        type="button"
        className="h-8 w-8 rounded-[var(--radius-sm)] bg-surface-2 text-ink-2 tap disabled:opacity-40"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        aria-label={`One more set of ${label}`}
      >
        +
      </button>
    </div>
  );
}

export interface DayCardProps {
  day: PlannedDay;
  /** Editing turns each row into a stepper. */
  editing?: boolean;
  /** Called with the day, the slug and the new set count. */
  onChangeSets?: (day: number, slug: string, sets: number) => void;
}

/**
 * One day of the plan.
 *
 * Trainer days render as a deliberate blank: the app has nothing to prescribe
 * there and must not pretend otherwise. Showing them at all matters — they are
 * the reason the rest of the week looks the way it does.
 */
export function DayCard({ day, editing = false, onChangeSets }: DayCardProps) {
  const { system } = useUnits();
  const isTrainer = day.owner === 'trainer';

  return (
    <Card className={cn(isTrainer && 'border-dashed')}>
      <CardHeader
        title={
          <span className="flex items-baseline gap-2">
            <span className="text-ink-3">{DAY_NAMES[day.day].slice(0, 3)}</span>
            <span>{day.label}</span>
          </span>
        }
        subtitle={
          isTrainer
            ? 'Your trainer owns this one'
            : `${Math.round(day.estimatedSeconds / 60)} min · ${day.items.length} item${day.items.length === 1 ? '' : 's'} · ${costLabel(day.systemicCost)}`
        }
      />

      <p className="mt-2 text-xs leading-relaxed text-ink-3">{day.note}</p>

      {day.items.length > 0 && (
        <ul className="mt-3 divide-y divide-[var(--c-border)]">
          {day.items.map((item) => (
            <li key={`${item.slug}-${item.role}`} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-ink">{item.name}</span>
                  {supersetPartner(day, item.slug) !== null && (
                    <Chip tone="quiet">with {supersetPartner(day, item.slug)}</Chip>
                  )}
                  <RoleChip item={item} />
                  {item.romTracked && <Chip tone="quiet">Depth</Chip>}
                </div>
                <p className="mt-0.5 tnum text-xs text-ink-2">
                  {doseLine(item, system)}
                  {item.targetRir !== null && ` · ${item.targetRir} RIR`}
                  {item.restSeconds > 0 && ` · rest ${formatDuration(item.restSeconds)}`}
                </p>
                {item.substitutedFor !== null && (
                  <p className="mt-0.5 text-xs text-ink-3">
                    Standing in for {item.substitutedFor} — you don&apos;t have the kit for it.
                  </p>
                )}
                {item.reservedSets > 0 && (
                  <p className="mt-0.5 text-xs text-ink-3">
                    Running this to keep measuring it, not because the muscle had room.
                  </p>
                )}
                {item.note !== null && (
                  <p className="mt-1 text-xs leading-relaxed text-ink-3">{item.note}</p>
                )}
              </div>

              {editing && onChangeSets && (
                <Stepper
                  value={item.sets}
                  min={0}
                  max={item.sets + 4}
                  label={item.name}
                  onChange={(next) => onChangeSets(day.day, item.slug, next)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <TrimmedLine day={day} />
    </Card>
  );
}

/** The name of the movement this one is alternated with, if any. */
function supersetPartner(day: PlannedDay, slug: string): string | null {
  for (const pair of day.supersets) {
    const other = pair.find((s) => s !== slug);
    if (pair.includes(slug) && other !== undefined) {
      return day.items.find((i) => i.slug === other)?.name ?? other;
    }
  }
  return null;
}

/**
 * What came out to fit the session in the time available.
 *
 * Silent by default, never concealed. The plan simply arrives the right length
 * — the athlete is not asked to negotiate over it — but one quiet line lets
 * them see what was cut if they care.
 */
function TrimmedLine({ day }: { day: PlannedDay }) {
  const [open, setOpen] = useState(false);
  if (day.trimmed.length === 0) return null;

  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <button
        type="button"
        className="text-xs text-ink-3 tap"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Trimmed {day.trimmed.length} for time {open ? '▴' : '▾'}
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {day.trimmed.map((cut) => (
            <li key={cut.slug} className="text-xs text-ink-3">
              <span className="text-ink-2">{cut.name}</span> — {cut.reason}
            </li>
          ))}
          <li className="pt-1 text-xs text-ink-3">
            Rest periods were left alone. Shortening those would turn this into a different
            session without telling you.
          </li>
        </ul>
      )}
    </div>
  );
}

function costLabel(cost: PlannedDay['systemicCost']): string {
  switch (cost) {
    case 'high':
      return 'hard day';
    case 'moderate':
      return 'moderate';
    case 'low':
      return 'easy day';
  }
}
