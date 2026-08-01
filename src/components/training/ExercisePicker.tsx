'use client';

import { useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/cn';
import { muscleLabel } from '@/lib/training/format';
import { EXERCISE_LIBRARY, searchLibrary } from '@/lib/training/library';
import type { LibraryExercise, RepUnit } from '@/lib/training/types';

/**
 * Badge for anything that is not measured in reps.
 *
 * A `seconds` or `meters` movement looks identical to a `reps` movement in a
 * list of names, and picking the wrong one means the keypad asks the wrong
 * question. So the unit is on the row, not discovered afterwards.
 */
function UnitBadge({ unit }: { unit: RepUnit }) {
  if (unit === 'reps') return null;
  const label = unit === 'seconds' ? 'timed' : unit === 'meters' ? 'distance' : 'steps';
  return (
    <span className="shrink-0 rounded-[var(--radius-full)] bg-surface-2 px-2 py-0.5 text-2xs uppercase tracking-wide text-ink-2">
      {label}
    </span>
  );
}

/** Badge for the 16 movements where depth, not load, is the progression. */
function RomBadge() {
  return (
    <span className="shrink-0 rounded-[var(--radius-full)] bg-accent-quiet px-2 py-0.5 text-2xs uppercase tracking-wide text-accent">
      depth
    </span>
  );
}

function ResultRow({
  exercise,
  onPick,
}: {
  exercise: LibraryExercise;
  onPick: (exercise: LibraryExercise) => void;
}) {
  const muscles = exercise.primary_muscles.map(muscleLabel).join(' · ');
  return (
    <button
      type="button"
      onClick={() => onPick(exercise)}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-3 text-left tap',
        'transition-colors duration-[var(--duration-fast)] active:bg-surface-2',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-base text-ink">{exercise.name}</div>
        <div className="mt-0.5 truncate text-sm text-ink-2">{muscles}</div>
      </div>
      {exercise.rom_tracked && <RomBadge />}
      <UnitBadge unit={exercise.rep_unit} />
    </button>
  );
}

export interface ExercisePickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (exercise: LibraryExercise) => void;
  /** Slugs to offer before anything is typed — the movements used most recently. */
  recentSlugs?: readonly string[];
}

/**
 * Find a movement in the 220-exercise library.
 *
 * Search runs against the **bundled** library, not the vault: names live inside
 * the ciphertext, so a vault-side search is a full-table decrypt, and this one
 * is a synchronous scan of a frozen array that completes between keystrokes.
 * It matches names, aliases ("bb bench", "RDL") and slugs, because the word
 * someone reaches for mid-set is whatever their gym calls it.
 *
 * This is the one text field in the logger. Everything numeric uses
 * {@link import('@/components/ui/NumberPad').NumberPad} instead — but a search
 * box genuinely needs letters, and faking that would be worse than the keyboard.
 */
export function ExercisePicker({
  open,
  onClose,
  onPick,
  recentSlugs = [],
}: ExercisePickerProps) {
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const recent = recentSlugs
    .map((slug) => EXERCISE_LIBRARY.find((e) => e.slug === slug))
    .filter((e): e is LibraryExercise => e !== undefined);

  const results = trimmed.length > 0 ? searchLibrary(trimmed) : recent;
  const heading = trimmed.length > 0 ? 'Results' : recent.length > 0 ? 'Recent' : 'Search';

  function pick(exercise: LibraryExercise): void {
    setQuery('');
    onPick(exercise);
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add exercise" detent="large">
      <div className="px-4 pb-2">
        <input
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Bench, RDL, sled, plank…"
          aria-label="Search exercises"
          className={cn(
            'w-full rounded-[var(--radius-md)] bg-surface-2 px-4 py-3',
            'text-base text-ink placeholder:text-ink-3',
            'border border-transparent outline-none',
            'focus:border-accent',
          )}
        />
      </div>

      <div className="px-4 pb-1 pt-2 text-2xs uppercase tracking-wide text-ink-3">
        {heading}
      </div>

      {results.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-2">
          {trimmed.length > 0
            ? `Nothing in the library matches “${trimmed}”.`
            : 'Search the library — 220 movements, offline.'}
        </p>
      ) : (
        <div className="divide-y divide-[var(--c-border)]">
          {results.map((exercise) => (
            <ResultRow key={exercise.slug} exercise={exercise} onPick={pick} />
          ))}
        </div>
      )}
    </Sheet>
  );
}
