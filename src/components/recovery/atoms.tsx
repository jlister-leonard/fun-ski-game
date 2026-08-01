'use client';

/**
 * @file The small pieces the Recovery surfaces are built from.
 *
 * Two of them carry a requirement rather than a look:
 *
 * - **`FindingNote`** is the only thing on this screen that renders a
 *   guardrail message, and it renders `finding.message` verbatim. §8.5
 *   constrains the *wording* — rule 4's pain copy and rule 7's referral copy
 *   are pinned by tests in `readiness.test.ts`. A component that paraphrased
 *   would pass those tests and still ship the wrong sentence.
 *
 * - **`ScaleField`** never pre-selects an answer. A 1–5 control that starts at
 *   3 turns "I have not answered" into "I answered neutral", and the whole
 *   point of the empty state is that the two are different.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { Finding } from '@/lib/algorithms';

/** A small caps section label, matching the rest of the app. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-2xs uppercase tracking-wide text-ink-3">{children}</div>;
}

/** Ordinary explanatory prose. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-sm text-ink-2 leading-relaxed', className)}>{children}</p>
  );
}

const LEVEL_STYLES: Record<Finding['level'], string> = {
  block: 'border-danger/35 bg-danger-quiet',
  warn: 'border-warn/35 bg-warn-quiet',
  info: 'border-line bg-surface-2',
};

const LEVEL_LABELS: Record<Finding['level'], string> = {
  block: 'Stop',
  warn: 'Take care',
  info: 'Note',
};

export interface FindingNoteProps {
  finding: Finding;
  className?: string;
}

/**
 * One guardrail finding, rendered word for word.
 *
 * The level colours a hairline and a label, never the text: a `block` is not
 * shouted, because the messages that carry a block are the ones the user most
 * needs to actually read.
 */
export function FindingNote({ finding, className }: FindingNoteProps) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-md)] border px-3 py-2.5',
        LEVEL_STYLES[finding.level],
        className,
      )}
      role={finding.level === 'block' ? 'alert' : undefined}
    >
      <Eyebrow>{LEVEL_LABELS[finding.level]}</Eyebrow>
      <p className="text-sm text-ink mt-1 leading-relaxed">{finding.message}</p>
    </div>
  );
}

export interface ScaleFieldProps {
  label: string;
  /** What 1 and 5 mean, in the user's words. */
  lowLabel: string;
  highLabel: string;
  /** `null` renders nothing selected. */
  value: number | null;
  onChange: (next: 1 | 2 | 3 | 4 | 5) => void;
  /** Optional clarifying line under the label. */
  hint?: ReactNode;
}

/** A 1–5 rating, entered by tapping. Nothing is selected until the user taps. */
export function ScaleField({
  label,
  lowLabel,
  highLabel,
  value,
  onChange,
  hint,
}: ScaleFieldProps) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-base font-medium text-ink">{label}</legend>
      {hint && <Note className="mt-1">{hint}</Note>}
      <div className="mt-2.5 flex gap-1.5" role="radiogroup" aria-label={label}>
        {([1, 2, 3, 4, 5] as const).map((n) => {
          const selected = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${label}: ${n} of 5`}
              onClick={() => onChange(n)}
              className={cn(
                'flex-1 h-11 rounded-[var(--radius-sm)] text-base tnum border',
                'transition-colors duration-[var(--duration-fast)]',
                selected
                  ? 'bg-accent text-accent-ink border-transparent font-semibold'
                  : 'bg-surface-2 text-ink-2 border-line',
              )}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-2xs text-ink-3">
        <span>1 · {lowLabel}</span>
        <span>5 · {highLabel}</span>
      </div>
    </fieldset>
  );
}

export interface CheckFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/** A yes/no answer with room for an explanation. */
export function CheckField({ label, hint, checked, onChange }: CheckFieldProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'w-full flex items-start gap-3 text-left rounded-[var(--radius-md)] border px-3 py-3',
        'transition-colors duration-[var(--duration-fast)]',
        checked ? 'border-accent/50 bg-accent-quiet' : 'border-line bg-surface-2',
      )}
    >
      <span
        className={cn(
          'mt-0.5 h-5 w-5 shrink-0 rounded-[6px] border grid place-items-center',
          checked ? 'bg-accent border-transparent' : 'border-line-strong bg-surface',
        )}
        aria-hidden
      >
        {checked && (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-accent-ink" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 13 4 4L19 7" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-base text-ink">{label}</span>
        {hint && <span className="block text-sm text-ink-2 mt-0.5 leading-relaxed">{hint}</span>}
      </span>
    </button>
  );
}

export interface MissingProps {
  /** What cannot be shown. */
  what: string;
  /** Why not, and what would change it. */
  because: ReactNode;
}

/**
 * A metric the app cannot obtain, named rather than omitted.
 *
 * `ARCHITECTURE.md` §5.2: Oura's own readiness and sleep scores are computed by
 * Oura and do not cross HealthKit. Silently leaving them out would read as
 * "this app does not care about sleep quality"; saying so reads as what it is.
 */
export function Missing({ what, because }: MissingProps) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" aria-hidden />
      <p className="text-sm text-ink-2 leading-relaxed">
        <span className="text-ink">{what}</span> — {because}
      </p>
    </div>
  );
}
