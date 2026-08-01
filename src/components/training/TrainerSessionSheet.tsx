'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { NumberPad } from '@/components/ui/NumberPad';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/cn';
import type { Muscle } from '@/lib/db/types';
import { useUnits } from '@/lib/hooks/useUnits';
import { formatDistance } from '@/lib/units';
import { muscleLabel, regionLabel } from '@/lib/training/format';
import {
  EFFORT_LABELS,
  EFFORT_TO_SETS,
  estimateFromReport,
  NEUTRAL_REGION_EFFORT,
  TRAINER_REGIONS,
} from '@/lib/training/trainer-estimate';
import type { TrainerSessionInput } from '@/lib/training/store';
import type { EffortLevel, TrainerRegion } from '@/lib/training/types';

const DURATIONS = [30, 45, 60, 75, 90] as const;
const YARDS_PER_METRE = 1.0936133;

/** One region, as four tappable segments rather than a drag slider. */
function RegionRow({
  region,
  value,
  onChange,
}: {
  region: TrainerRegion;
  value: EffortLevel;
  onChange: (next: EffortLevel) => void;
}) {
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-base text-ink">{regionLabel(region)}</span>
        <span className="text-xs text-ink-3">
          {EFFORT_LABELS[value]}
          {value > 0 && ` · ~${EFFORT_TO_SETS[value]} sets`}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1" role="group" aria-label={regionLabel(region)}>
        {([0, 1, 2, 3] as const).map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => onChange(level)}
            aria-pressed={value === level}
            aria-label={`${regionLabel(region)}: ${EFFORT_LABELS[level]}`}
            className={cn(
              'h-10 flex-1 rounded-[var(--radius-sm)] text-sm tap border',
              'transition-colors duration-[var(--duration-fast)]',
              value === level
                ? 'border-accent bg-accent-quiet text-accent font-medium'
                : 'border-line bg-surface-2 text-ink-3',
            )}
          >
            {level === 0 ? '—' : level}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface TrainerSessionSheetProps {
  open: boolean;
  onClose: () => void;
  onSave: (input: TrainerSessionInput) => void;
  pending?: boolean;
  /** Defaults to the trainer's name from the last session. */
  coachName?: string | null;
  /** On-device defaults derived from the encrypted trainer-focus answer. */
  initialEffort?: Readonly<Partial<Record<TrainerRegion, EffortLevel>>>;
}

/**
 * Capture a session the trainer ran.
 *
 * **The app cannot program these days.** The app was not in the room, cannot
 * move those days, and cannot reduce them when readiness is poor. It learns what
 * happened only if the athlete tells it — so the ask has to be cheap enough
 * that they actually will.
 *
 * Hence the shape of this screen, which follows the UX contract in
 * `program-personalized.md` §2.2 exactly:
 *
 * - **Nine regions, not twenty-two muscles.** Someone who has just finished an
 *   hour with a trainer will not transcribe it. Four taps of effort is the
 *   budget.
 * - **Segments, not sliders.** A drag target is imprecise with sweaty hands and
 *   invisible under a thumb. Four buttons hit the same four values faster.
 * - **Every control starts at the current prior**, so "save" with no edits is a
 *   valid and meaningful answer: it means *normal session*.
 * - **The estimate is shown before it is saved**, and it is the athlete's to
 *   edit. Nothing is inferred behind their back.
 *
 * The estimate this produces is what weekly volume budgeting subtracts, at its
 * upper credible bound — so a muscle the trainer already hammered shows as
 * full and the app stops stacking more work on top of it. Skipping the capture
 * entirely is safe: the prior still counts at full value. Treating an
 * unreported session as zero volume is the one failure mode the whole model
 * exists to prevent.
 */
export function TrainerSessionSheet({
  open,
  onClose,
  onSave,
  pending = false,
  coachName = null,
  initialEffort = NEUTRAL_REGION_EFFORT,
}: TrainerSessionSheetProps) {
  const { system } = useUnits();
  const [effort, setEffort] = useState<Record<TrainerRegion, EffortLevel>>(() => {
    const seeded = {} as Record<TrainerRegion, EffortLevel>;
    for (const region of TRAINER_REGIONS) seeded[region] = initialEffort[region] ?? 0;
    return seeded;
  });
  const [durationMin, setDurationMin] = useState(60);
  const [rpe, setRpe] = useState<number | null>(null);
  const [sledText, setSledText] = useState('');
  const [note, setNote] = useState('');
  const [exerciseText, setExerciseText] = useState('');
  const [detail, setDetail] = useState(false);

  const sledEntered = Number.parseFloat(sledText);
  const sledMeters = Number.isFinite(sledEntered)
    ? system === 'metric'
      ? sledEntered
      : sledEntered / YARDS_PER_METRE
    : null;

  const estimate = estimateFromReport({
    regionEffort: effort,
    hardSetsTotal: null,
    confirmed: true,
  });

  const topMuscles = (Object.entries(estimate) as [Muscle, { meanSets: number }][])
    .filter(([, e]) => e.meanSets >= 0.5)
    .sort((a, b) => b[1].meanSets - a[1].meanSets)
    .slice(0, 8);

  function save(): void {
    onSave({
      durationMin,
      regionEffort: effort,
      hardSetsTotal: null,
      perceivedEffort: rpe,
      perceivedRir: null,
      sledMeters,
      exerciseNames: exerciseText
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      note: note.trim() || null,
      coachName,
      confirmed: true,
    });
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Trainer session"
      detent="large"
      footer={
        <Button block onClick={save} loading={pending}>
          Save session
        </Button>
      }
    >
      <div className="space-y-5 px-4 pb-2">
        <p className="text-sm text-ink-2">
          Roughly what got worked. Everything starts where I expect it to be, so if it
          was a normal session you can just save.
        </p>

        {/* ---- duration --------------------------------------------------- */}
        <section>
          <div className="pb-2 text-2xs uppercase tracking-wide text-ink-3">Length</div>
          <div className="flex gap-2" role="group" aria-label="Session length">
            {DURATIONS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setDurationMin(minutes)}
                aria-pressed={durationMin === minutes}
                className={cn(
                  'h-10 flex-1 rounded-[var(--radius-sm)] text-sm tap border',
                  durationMin === minutes
                    ? 'border-accent bg-accent-quiet text-accent font-medium'
                    : 'border-line bg-surface-2 text-ink-2',
                )}
              >
                {minutes}m
              </button>
            ))}
          </div>
        </section>

        {/* ---- the nine regions ------------------------------------------- */}
        <section>
          <div className="pb-1 text-2xs uppercase tracking-wide text-ink-3">
            What got worked
          </div>
          <div className="divide-y divide-[var(--c-border)]">
            {TRAINER_REGIONS.map((region) => (
              <RegionRow
                key={region}
                region={region}
                value={effort[region]}
                onChange={(next) => setEffort((e) => ({ ...e, [region]: next }))}
              />
            ))}
          </div>
        </section>

        {/* ---- effort ----------------------------------------------------- */}
        <section>
          <div className="pb-2 text-2xs uppercase tracking-wide text-ink-3">
            How hard was it?
          </div>
          <div className="flex gap-1" role="group" aria-label="Session effort">
            {[4, 5, 6, 7, 8, 9, 10].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setRpe(value === rpe ? null : value)}
                aria-pressed={rpe === value}
                className={cn(
                  'h-10 flex-1 rounded-[var(--radius-sm)] text-sm tnum tap border',
                  rpe === value
                    ? 'border-accent bg-accent-quiet text-accent font-medium'
                    : 'border-line bg-surface-2 text-ink-3',
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-3">
            Overall session RPE. Optional — it only affects how the fatigue side of the
            estimate is weighted.
          </p>
        </section>

        {/* ---- the estimate ----------------------------------------------- */}
        <section className="rounded-[var(--radius-md)] bg-surface-2 p-3">
          <div className="text-2xs uppercase tracking-wide text-ink-2">
            What I&apos;ll count this as
          </div>
          {topMuscles.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-2">
              Nothing yet — set at least one region above zero.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-0.5">
              {topMuscles.map(([muscle, e]) => (
                <li key={muscle} className="flex justify-between text-sm">
                  <span className="text-ink">{muscleLabel(muscle)}</span>
                  <span className="tnum text-ink-2">
                    ~{Math.round(e.meanSets * 10) / 10} sets
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-ink-3">
            An estimate, not a measurement — I wasn&apos;t there. It is budgeted at its
            upper bound, so the app leans toward giving these muscles a rest rather than
            piling more on. Confirming sessions tightens it.
          </p>
        </section>

        {/* ---- optional detail -------------------------------------------- */}
        {!detail ? (
          <button
            type="button"
            onClick={() => setDetail(true)}
            className="text-sm text-accent tap"
          >
            + Sled distance, exercises, notes
          </button>
        ) : (
          <section className="space-y-4">
            <div>
              <div className="pb-2 text-2xs uppercase tracking-wide text-ink-3">
                Sled distance ({system === 'metric' ? 'metres' : 'yards'})
              </div>
              <div className="mb-2 tnum text-2xl font-semibold text-ink">
                {sledText === '' ? '—' : sledText}
              </div>
              <NumberPad value={sledText} onChange={setSledText} allowDecimal={false} />
              {sledMeters !== null && sledMeters > 0 && (
                <p className="mt-1.5 text-xs text-ink-3">
                  {formatDistance(sledMeters, system).text} — sled work is charged at a
                  lower fatigue cost than eccentric loading, so it makes room rather than
                  taking it.
                </p>
              )}
            </div>

            <div>
              <div className="pb-2 text-2xs uppercase tracking-wide text-ink-3">
                Exercises (optional)
              </div>
              <input
                type="text"
                value={exerciseText}
                onChange={(e) => setExerciseText(e.target.value)}
                placeholder="trap bar deadlift, chest-supported row, sled"
                aria-label="Exercises"
                className={cn(
                  'w-full rounded-[var(--radius-md)] bg-surface-2 px-3 py-2.5',
                  'text-sm text-ink placeholder:text-ink-3',
                  'border border-transparent outline-none focus:border-accent',
                )}
              />
            </div>

            <div>
              <div className="pb-2 text-2xs uppercase tracking-wide text-ink-3">Notes</div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="How it felt, anything that hurt, what the trainer said"
                aria-label="Notes"
                className={cn(
                  'w-full rounded-[var(--radius-md)] bg-surface-2 px-3 py-2.5',
                  'text-sm text-ink placeholder:text-ink-3 resize-none',
                  'border border-transparent outline-none focus:border-accent',
                )}
              />
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
