'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { NumberPad } from '@/components/ui/NumberPad';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/cn';
import { useUnits } from '@/lib/hooks/useUnits';
import { kgToLb, lbToKg, type UnitSystem } from '@/lib/units';
import {
  countAllowsDecimal,
  countForEditing,
  countFromEditing,
  countUnitLabel,
  formatSet,
} from '@/lib/training/format';
import {
  checkLoggedSet,
  type SetSuggestion,
} from '@/lib/training/guardrails';
import type { Finding } from '@/lib/algorithms';
import { useElapsedSeconds } from '@/lib/training/hooks';
import { exerciseBySlug, romMeasurementOf, romUnitHint } from '@/lib/training/library';
import { DemoVideoCard } from '@/components/video';
import type { LastPerformance, LogSetInput } from '@/lib/training/store';
import type { LibraryExercise, LoggedSet, RomEntry } from '@/lib/training/types';

/** Which value the keypad is currently editing. */
type Field = 'load' | 'count' | 'rir' | 'rom';

/** The units a ROM measurement is offered in. Inches first, for a US user. */
const ROM_UNITS = ['in', 'cm', 'deg'] as const;

function toDisplayLoad(kg: number, system: UnitSystem): string {
  if (kg <= 0) return '';
  const value = system === 'metric' ? kg : kgToLb(kg);
  const rounded = Math.round(value * 2) / 2;
  return String(rounded % 1 === 0 ? rounded : rounded.toFixed(1));
}

function fromDisplayLoad(text: string, system: UnitSystem): number {
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return system === 'metric' ? n : lbToKg(n);
}

/** One tappable value in the field strip. */
function FieldChip({
  label,
  value,
  unit,
  active,
  onPress,
  emphasis,
}: {
  label: string;
  value: string;
  unit: string;
  active: boolean;
  onPress: () => void;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={active}
      className={cn(
        'flex-1 rounded-[var(--radius-md)] px-3 py-2.5 text-left tap',
        'border transition-colors duration-[var(--duration-fast)]',
        active
          ? 'border-accent bg-accent-quiet'
          : 'border-line bg-surface-2',
      )}
    >
      <div className="text-2xs uppercase tracking-wide text-ink-2">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span
          className={cn(
            'tnum text-2xl font-semibold',
            value === '' ? 'text-ink-3' : emphasis ? 'text-accent' : 'text-ink',
          )}
        >
          {value === '' ? '—' : value}
        </span>
        <span className="text-sm text-ink-2">{unit}</span>
      </div>
    </button>
  );
}

export interface SetEntrySheetProps {
  open: boolean;
  onClose: () => void;
  exercise: LibraryExercise;
  /** The previous session's work on this movement, for the inline reference. */
  last: LastPerformance | null;
  /** Sets already logged for this movement in the current session. */
  current: readonly LoggedSet[];
  onLog: (input: Omit<LogSetInput, 'sessionId' | 'exerciseId'>) => void;
  /** Remove a set logged by mistake. Soft delete, so it is recoverable. */
  onDelete?: (setId: string) => void;
  pending?: boolean;
  /** Canonical progression proposal. The user chooses whether to apply it. */
  suggestion?: SetSuggestion | null;
  /** Pain/substitution guardrails already resolved for this movement. */
  guidance?: readonly Finding[];
}

/**
 * Log one set.
 *
 * The design constraint is stated plainly in the brief: this is the screen
 * someone touches with sweaty hands between sets. So —
 *
 * - **No iOS keyboard, ever.** Every number goes through `NumberPad`: it
 *   appears instantly, does not resize the viewport, and puts the digits under
 *   the thumb. Tapping a field switches what the pad edits; nothing else moves.
 * - **Last session's numbers are on screen, not a tap away.** People program
 *   against what they did last time. Hiding it behind a history screen means
 *   they either guess or leave the app.
 * - **Repeat is one tap.** The commonest action in a workout is "same again".
 *   The fields pre-fill from the last set of this movement — the previous
 *   session's if this is the first set today — so the default path is: open,
 *   tap Log.
 * - **`rep_unit` decides what the count field even means.** A Zone 2 ride asks
 *   for seconds, a sled drag asks for yards, a banded walk asks for steps. The
 *   pad's decimal key, its label and its stored value all follow from it.
 * - **`rom_tracked` movements lead with depth.** For those 16 the load field is
 *   demoted behind a toggle, because a deeper pain-free rep at the same
 *   bodyweight is the progress, and offering a weight box first quietly teaches
 *   the wrong lesson.
 */
export function SetEntrySheet({
  open,
  onClose,
  exercise,
  last,
  current,
  onLog,
  onDelete,
  pending = false,
  suggestion = null,
  guidance = [],
}: SetEntrySheetProps) {
  const { system } = useUnits();
  const repUnit = exercise.rep_unit;
  const romTracked = exercise.rom_tracked;

  // Seed from the last set of this movement today, else from last session's
  // top set, else from the library's default range. Whatever the source, the
  // fields arrive filled so "same again" is a single tap.
  const seed: LoggedSet | null = current.at(-1) ?? last?.topSet ?? null;

  const [field, setField] = useState<Field>(romTracked ? 'rom' : 'count');
  const [load, setLoad] = useState(() => toDisplayLoad(seed?.weightKg ?? 0, system));
  const [count, setCount] = useState(() =>
    String(
      seed
        ? countForEditing(seed.unitValue, repUnit, system)
        : exercise.default_rep_range[0],
    ),
  );
  const [rir, setRir] = useState(() => (seed?.effort != null ? String(seed.effort) : '2'));
  const [romValue, setRomValue] = useState(() =>
    seed?.rom ? String(seed.rom.value) : '',
  );
  const [romUnit, setRomUnit] = useState(
    () => seed?.rom?.unit ?? romUnitHint(exercise.slug),
  );
  const [romNote, setRomNote] = useState(() => seed?.rom?.note ?? '');
  const [showLoad, setShowLoad] = useState(() => !romTracked || (seed?.weightKg ?? 0) > 0);
  const [warmup, setWarmup] = useState(false);
  const latestSet = current.at(-1) ?? null;
  const restStartedAt = latestSet?.createdAt ?? 0;
  const elapsedRest = useElapsedSeconds(restStartedAt);
  const [restCapture, setRestCapture] = useState<{ afterSetId: string; seconds: number } | null>(null);
  const restSeconds = latestSet !== null && restCapture?.afterSetId === latestSet.id
    ? restCapture.seconds
    : null;

  const romSentence = romMeasurementOf(exercise.slug);

  const weightKg = fromDisplayLoad(load, system);
  const unitValue = countFromEditing(Number.parseFloat(count) || 0, repUnit, system);
  const rom: RomEntry | null =
    romTracked && romValue !== ''
      ? { value: Number.parseFloat(romValue) || 0, unit: romUnit, note: romNote }
      : null;

  const findings = checkLoggedSet({
    weightKg,
    unitValue,
    repUnit,
    effort: rir === '' ? null : Number.parseFloat(rir),
  });
  const blocking = findings.filter((f) => f.level === 'warn');

  const padValue =
    field === 'load' ? load : field === 'count' ? count : field === 'rir' ? rir : romValue;
  const setPadValue =
    field === 'load'
      ? setLoad
      : field === 'count'
        ? setCount
        : field === 'rir'
          ? setRir
          : setRomValue;

  function repeatLast(set: LoggedSet): void {
    setLoad(toDisplayLoad(set.weightKg, system));
    setCount(String(countForEditing(set.unitValue, repUnit, system)));
    setRir(set.effort != null ? String(set.effort) : '');
    if (set.rom) {
      setRomValue(String(set.rom.value));
      setRomUnit(set.rom.unit);
      setRomNote(set.rom.note);
    }
    if (set.weightKg > 0) setShowLoad(true);
  }

  function applySuggestion(): void {
    if (!suggestion) return;
    setLoad(toDisplayLoad(suggestion.weightKg, system));
    setCount(String(countForEditing(suggestion.unitValue, repUnit, system)));
    setRir(suggestion.targetRir === null ? '' : String(suggestion.targetRir));
  }

  function submit(): void {
    onLog({
      repUnit,
      unitValue,
      weightKg: showLoad ? weightKg : 0,
      rir: rir === '' ? null : Number.parseFloat(rir),
      warmup,
      rom,
      restSeconds,
      note: null,
    });
  }

  const loadLabel = system === 'metric' ? 'kg' : 'lb';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={exercise.name}
      detent="large"
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} className="shrink-0">
            Done
          </Button>
          <Button block onClick={submit} loading={pending} disabled={unitValue <= 0}>
            {warmup ? 'Log warm-up' : `Log set ${current.length + 1}`}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 px-4 pb-2">
        {/* ---- how it's done ---------------------------------------------- */}
        {/* Collapsed by default and click-to-load: nothing is requested from
            YouTube until the user actually taps play, so opening a set sheet
            mid-workout costs nothing. A recording of this user's own trainer,
            if one exists, takes precedence over any generic demo. */}
        <DemoVideoCard slug={exercise.slug} />

        {suggestion && !suggestion.findings.some((finding) => finding.level === 'block') && (
          <section className="rounded-[var(--radius-md)] border border-accent bg-accent-quiet p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-ink">Next-set suggestion</div>
                <p className="mt-1 text-xs leading-relaxed text-ink-2">{suggestion.reason}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={applySuggestion}>Apply</Button>
            </div>
          </section>
        )}

        {guidance.length > 0 && (
          <section className="rounded-[var(--radius-md)] bg-surface-2 p-3">
            <ul className="space-y-1">
              {guidance.map((finding) => (
                <li key={finding.code} className="text-sm leading-relaxed text-ink-2">
                  {finding.message}
                </li>
              ))}
            </ul>
            {exercise.regressions.length > 0 && (
              <p className="mt-2 text-xs text-ink-3">
                More-comfortable alternatives: {exercise.regressions
                  .map((slug) => exerciseBySlug(slug)?.name ?? slug)
                  .join(', ')}.
              </p>
            )}
          </section>
        )}

        {/* ---- last time -------------------------------------------------- */}
        {last && last.sets.length > 0 && (
          <section className="rounded-[var(--radius-md)] bg-surface-2 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-2xs uppercase tracking-wide text-ink-2">
                Last time · {last.dateKey}
              </span>
              <button
                type="button"
                onClick={() => repeatLast(last.sets[0])}
                className="text-sm font-medium text-accent tap"
              >
                Repeat
              </button>
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {last.sets.slice(0, 4).map((set, i) => (
                <li key={set.id} className="tnum text-sm text-ink">
                  <span className="mr-2 text-ink-3">{i + 1}</span>
                  {formatSet(set, system)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ---- ROM guidance ---------------------------------------------- */}
        {romTracked && romSentence && (
          <p className="text-sm text-ink-2">
            <span className="text-ink">Depth is the progression here.</span> Measured as{' '}
            {romSentence}.
          </p>
        )}

        {/* ---- the fields ------------------------------------------------ */}
        <div className="flex gap-2">
          {romTracked && (
            <FieldChip
              label="Depth"
              value={romValue}
              unit={romUnit}
              active={field === 'rom'}
              onPress={() => setField('rom')}
              emphasis
            />
          )}
          {showLoad && (
            <FieldChip
              label="Load"
              value={load}
              unit={loadLabel}
              active={field === 'load'}
              onPress={() => setField('load')}
            />
          )}
          <FieldChip
            label={repUnit === 'reps' ? 'Reps' : repUnit === 'seconds' ? 'Time' : 'Amount'}
            value={count}
            unit={countUnitLabel(repUnit, system)}
            active={field === 'count'}
            onPress={() => setField('count')}
          />
          <FieldChip
            label="RIR"
            value={rir}
            unit=""
            active={field === 'rir'}
            onPress={() => setField('rir')}
          />
        </div>

        {romTracked && !showLoad && (
          <button
            type="button"
            onClick={() => setShowLoad(true)}
            className="text-sm text-accent tap"
          >
            + Add load
          </button>
        )}

        {current.length > 0 && (
          <section className="rounded-[var(--radius-md)] bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-2xs uppercase tracking-wide text-ink-2">Actual rest</div>
                <div className="tnum mt-0.5 text-lg text-ink">
                  {restSeconds === null ? `${elapsedRest}s` : `${restSeconds}s saved`}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (latestSet) setRestCapture({ afterSetId: latestSet.id, seconds: elapsedRest });
                }}
                disabled={restSeconds !== null}
              >
                {restSeconds === null ? 'End rest' : 'Recorded'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-ink-3">
              Tap when you start the next set. Only an explicitly ended rest is used to learn your pace.
            </p>
          </section>
        )}

        {/* ---- ROM detail ------------------------------------------------- */}
        {romTracked && field === 'rom' && (
          <div className="space-y-2">
            <div className="flex gap-2" role="group" aria-label="Depth unit">
              {ROM_UNITS.map((unit) => (
                <button
                  key={unit}
                  type="button"
                  onClick={() => setRomUnit(unit)}
                  aria-pressed={romUnit === unit}
                  className={cn(
                    'rounded-[var(--radius-sm)] px-3 py-1.5 text-sm tap border',
                    romUnit === unit
                      ? 'border-accent bg-accent-quiet text-accent'
                      : 'border-line bg-surface-2 text-ink-2',
                  )}
                >
                  {unit}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={romNote}
              onChange={(e) => setRomNote(e.target.value)}
              placeholder="What you actually reached — “hamstring touched calf”"
              aria-label="Depth note"
              className={cn(
                'w-full rounded-[var(--radius-md)] bg-surface-2 px-3 py-2.5',
                'text-sm text-ink placeholder:text-ink-3',
                'border border-transparent outline-none focus:border-accent',
              )}
            />
          </div>
        )}

        {/* ---- the pad ---------------------------------------------------- */}
        <NumberPad
          value={padValue}
          onChange={setPadValue}
          allowDecimal={
            field === 'load' || field === 'rom' || (field === 'count' && countAllowsDecimal(repUnit))
          }
          decimalPlaces={1}
        />

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setWarmup((w) => !w)}
            aria-pressed={warmup}
            className={cn(
              'rounded-[var(--radius-full)] px-3 py-1.5 text-sm tap border',
              warmup
                ? 'border-accent bg-accent-quiet text-accent'
                : 'border-line bg-surface-2 text-ink-2',
            )}
          >
            Warm-up
          </button>
          <span className="text-xs text-ink-3">
            {warmup ? "Doesn't count toward weekly volume" : 'Counts as a hard set'}
          </span>
        </div>

        {blocking.length > 0 && (
          <ul className="space-y-1">
            {blocking.map((f) => (
              <li key={f.code} className="text-sm text-warn">
                {f.message}
              </li>
            ))}
          </ul>
        )}

        {/* ---- this session ----------------------------------------------- */}
        {current.length > 0 && (
          <section>
            <div className="pb-1 text-2xs uppercase tracking-wide text-ink-3">
              This session
            </div>
            <ul className="space-y-0.5">
              {current.map((set, i) => (
                <li key={set.id} className="flex items-baseline gap-2">
                  <span className="tnum flex-1 text-sm text-ink">
                    <span className="mr-2 text-ink-3">{set.warmup ? 'W' : i + 1}</span>
                    {formatSet(set, system)}
                  </span>
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => onDelete(set.id)}
                      aria-label={`Delete set ${i + 1}`}
                      className="shrink-0 px-2 text-sm text-ink-3 tap"
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Sheet>
  );
}
