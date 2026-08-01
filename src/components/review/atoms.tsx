'use client';

/**
 * @file The small pieces the weekly review is built from.
 *
 * Three carry a requirement rather than a look:
 *
 * - **`ConfidenceTag`** is not decoration. `advice-policy.md` Tier 1 requires
 *   every recommendation to carry the reasoning, the inputs *and* a confidence
 *   tag. A recommendation shown without one is out of policy, so the tag is
 *   rendered unconditionally and never abbreviated away.
 *
 * - **`EvidenceList`** renders `insight.inputs` verbatim, converting only the
 *   units. `training-methodology.md` §8.5 rule 10: show the reasoning. A card
 *   that summarised the inputs in its own words would pass every test in
 *   `coach.test.ts` and still hide the working.
 *
 * - **`Tone`** has no green. Nothing on this screen is scored, so nothing on
 *   this screen is coloured for approval — `nutrition-personalization.md` §3.4
 *   requirement 8. `warn` exists because a safety finding has to be findable;
 *   there is deliberately no counterpart for "good".
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { CoachEvidence, Finding, InsightSeverity } from '@/lib/algorithms';
import { formatBodyMass, type UnitSystem } from '@/lib/units';

/** A small caps section label, matching the rest of the app. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-2xs uppercase tracking-wide text-ink-3">{children}</div>;
}

/** Ordinary explanatory prose. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-sm text-ink-2 leading-relaxed', className)}>{children}</p>;
}

/* ------------------------------------------------------------------ */
/* Confidence and tier                                                 */
/* ------------------------------------------------------------------ */

const CONFIDENCE_LABEL = {
  'well-established': 'Well established',
  'reasonable-inference': 'Reasonable inference',
  uncertain: 'Uncertain',
} as const;

const CONFIDENCE_HINT = {
  'well-established': 'Multiple independent lines of evidence point the same way.',
  'reasonable-inference': 'The direction is well supported; the exact number is a judgement call.',
  uncertain: 'Thin evidence, or credible people disagree. Treat it as a possibility.',
} as const;

export interface ConfidenceTagProps {
  confidence: keyof typeof CONFIDENCE_LABEL;
}

/** How much to trust this. Always shown — see the file note. */
export function ConfidenceTag({ confidence }: ConfidenceTagProps) {
  return (
    <span
      title={CONFIDENCE_HINT[confidence]}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs',
        'bg-surface-2 text-ink-2 border border-line',
      )}
    >
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

/**
 * Only Tier 3 is labelled.
 *
 * Tier 1 is the ordinary case — a coach saying what they would do — and
 * stamping a badge on it would train the user to read every card as a legal
 * classification. Tier 2 already carries its specific caveat as a sentence,
 * which is more useful than a badge. Tier 3 is the one that means *I am
 * deliberately not answering this*, and that is worth naming.
 */
export function TierTag({ tier }: { tier: 1 | 2 | 3 }) {
  if (tier !== 3) return null;
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-2xs bg-surface-2 text-ink-2 border border-line">
      Outside what an app should answer
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Severity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Severity styling. No green, by design.
 *
 * `info` and `suggestion` share the neutral treatment because a suggestion is
 * not a lesser warning, it is a different kind of thing. Only the two that
 * carry a safety meaning get a tint.
 */
export const SEVERITY_STYLE: Record<InsightSeverity, string> = {
  info: 'border-line',
  suggestion: 'border-line',
  warning: 'border-warn/35',
  critical: 'border-danger/45',
};

const SEVERITY_LABEL: Partial<Record<InsightSeverity, string>> = {
  warning: 'Take care',
  critical: 'Needs a person',
};

export function SeverityTag({ severity }: { severity: InsightSeverity }) {
  const label = SEVERITY_LABEL[severity];
  if (!label) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs border',
        severity === 'critical'
          ? 'bg-danger-quiet text-danger border-danger/35'
          : 'bg-warn-quiet text-warn border-warn/35',
      )}
    >
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/**
 * Render one evidence value in the user's units.
 *
 * `kg` is the only unit that converts: kcal, grams, percentages, weeks, sets
 * and minutes read identically in both systems, which is exactly why the coach
 * writes its copy in them.
 */
export function formatEvidence(e: CoachEvidence, system: UnitSystem): string {
  if (typeof e.value !== 'number') return e.unit ? `${e.value} ${e.unit}` : String(e.value);
  if (e.unit === 'kg') {
    const f = formatBodyMass(e.value, system);
    return `${f.value} ${f.unit}`;
  }
  const n = Number.isInteger(e.value) ? e.value : Math.round(e.value * 100) / 100;
  switch (e.unit) {
    case null:
    case undefined:
      return String(n);
    case '%':
      return `${n}%`;
    case '%bw/wk':
      return `${n}%/week`;
    default:
      return `${n} ${e.unit}`;
  }
}

export interface EvidenceListProps {
  inputs: readonly CoachEvidence[];
  system: UnitSystem;
}

/** The inputs behind an insight, shown rather than summarised. */
export function EvidenceList({ inputs, system }: EvidenceListProps) {
  if (inputs.length === 0) return null;
  return (
    <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5">
      {inputs.map((e, i) => (
        <div key={`${e.label}-${i}`} className="contents">
          <dt className="text-sm text-ink-2 min-w-0 truncate">{e.label}</dt>
          <dd className="text-sm text-ink tnum text-right">{formatEvidence(e, system)}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

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

/**
 * One guardrail finding, rendered word for word.
 *
 * Same contract as the Recovery screen's version: the level colours a hairline
 * and a label, never the text. The messages that carry the most weight are the
 * ones the user most needs to actually read, and shouting is not reading.
 */
export function FindingNote({ finding, className }: { finding: Finding; className?: string }) {
  return (
    <div
      className={cn('rounded-[var(--radius-md)] border px-3 py-2.5', LEVEL_STYLES[finding.level], className)}
      role={finding.level === 'block' ? 'alert' : undefined}
    >
      <Eyebrow>{LEVEL_LABELS[finding.level]}</Eyebrow>
      <p className="text-sm text-ink mt-1 leading-relaxed">{finding.message}</p>
    </div>
  );
}

/**
 * A line of prose with `**bold**` spans honoured.
 *
 * The coach emphasises the compound-and-dose in a supplement recommendation,
 * because that is the part a person copies onto a shopping list. Rendering the
 * asterisks raw would be worse than not emphasising at all.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
  return (
    <p className={cn('text-sm text-ink-2 leading-relaxed', className)}>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i} className="font-semibold text-ink">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}
