'use client';

/**
 * @file Readiness, and — inseparably — why.
 *
 * §8.5 rule 10 is the whole design brief for this card: *"Every adjustment must
 * display which inputs drove it. Opaque readiness scores erode trust and
 * encourage exactly the kind of single-data-point fixation Galpin warns
 * against."*
 *
 * `assessReadiness` returns its reasoning as data — `contributions`,
 * `excluded`, and `adjustment.reasons` — so this card renders all three rather
 * than reconstructing an explanation from the number. Every string it shows a
 * user comes from the algorithm.
 *
 * ## Why there is no big number
 *
 * `readinessPercent` exists and the vault stores a 0–100 score, but a large
 * percentage at the top of a screen is a score to beat, and the brief for this
 * app rules that out. The **band** is the headline, because the band is what
 * actually changes the session; the raw mean is shown small, with its range and
 * its denominator, as the technical fact it is.
 */

import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import {
  READINESS_LIMITS,
  RECOVERY_COPY,
  actionable,
  type ConditioningGuidance,
  type ReadinessAssessment,
  type ReadinessBand,
} from '@/lib/algorithms';
import { Eyebrow, FindingNote, Note } from './atoms';

const BAND_LABEL: Record<ReadinessBand, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low',
  poor: 'Poor',
};

/**
 * Band colours.
 *
 * Deliberately not a traffic light. `high` and `normal` are the same ink,
 * because "primed" is not an achievement and "normal" is not a failure to
 * achieve it — the only visual distinction is for the two bands that actually
 * change the session.
 */
const BAND_STYLE: Record<ReadinessBand, string> = {
  high: 'bg-surface-2 text-ink',
  normal: 'bg-surface-2 text-ink',
  low: 'bg-warn-quiet text-warn',
  poor: 'bg-warn-quiet text-warn',
};

const CONDITIONING_COPY: Record<ConditioningGuidance, string> = {
  as_programmed: 'Conditioning as programmed',
  downgrade_intervals: 'Swap a hard interval day for Zone 2',
  easy_only: 'Zone 1–2 only',
  rest: 'No conditioning today',
};

/** A signed percentage: −0.25 → "−25%". */
function pct(fraction: number): string {
  const sign = fraction > 0 ? '+' : fraction < 0 ? '−' : '';
  return `${sign}${Math.round(Math.abs(fraction) * 100)}%`;
}

/** A signed count: −1 → "−1". */
function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

/** The raw mean, at two decimals, with an explicit minus sign. */
function score(n: number): string {
  const s = Math.abs(n).toFixed(2);
  return n < 0 ? `−${s}` : s;
}

export interface ReadinessCardProps {
  assessment: ReadinessAssessment;
  className?: string;
}

export function ReadinessCard({ assessment, className }: ReadinessCardProps) {
  const { band, bandCopy, contributions, excluded, adjustment } = assessment;
  // The override line is pulled out of the list and shown once at the foot of
  // the card, so rule 8's message appears exactly where the adjustment it
  // applies to ends rather than twice on the same screen.
  const findings = actionable(assessment.findings).filter(
    (f) => f.code !== 'readiness.override_available',
  );
  const showAdjustment = !assessment.programmingSuppressed;

  return (
    <Card className={cn('flex flex-col gap-5', className)}>
      <div>
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-sm font-semibold',
              BAND_STYLE[band],
            )}
          >
            {BAND_LABEL[band]}
          </span>
          <Eyebrow>Readiness today</Eyebrow>
        </div>
        <p className="mt-2.5 text-lg text-ink leading-snug">{bandCopy}</p>
        <p className="mt-1.5 text-2xs text-ink-3 tnum">
          Mean sub-score {score(assessment.score)} on a −2 to +1 scale, over{' '}
          {contributions.length} {contributions.length === 1 ? 'input' : 'inputs'}
          {excluded.length > 0 ? ` · ${excluded.length} left out` : ''}
        </p>
      </div>

      {findings.length > 0 && (
        <div className="flex flex-col gap-2">
          {findings.map((f) => (
            <FindingNote key={f.code} finding={f} />
          ))}
        </div>
      )}

      {/* ── what it does to the session ─────────────────────────────── */}
      <section>
        <Eyebrow>Today&rsquo;s session</Eyebrow>
        {showAdjustment ? (
          <>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {adjustment.volumeDelta !== 0 && (
                <Chip label="Volume" value={pct(adjustment.volumeDelta)} />
              )}
              {adjustment.setsPerExerciseDelta !== 0 && (
                <Chip
                  label="Sets per exercise"
                  value={`${signed(adjustment.setsPerExerciseDelta)} (floor ${adjustment.minSetsPerExercise})`}
                />
              )}
              {adjustment.rirDelta !== 0 && (
                <Chip
                  label="RIR"
                  value={`${signed(adjustment.rirDelta)}${adjustment.minRir === null ? '' : ` (never below ${adjustment.minRir})`}`}
                />
              )}
              {adjustment.loadDelta !== 0 && (
                <Chip label="Load" value={pct(adjustment.loadDelta)} />
              )}
              {adjustment.extraSetOnLastExercise && (
                <Chip label="Last exercise" value="+1 set, optional" />
              )}
              <Chip label="Conditioning" value={CONDITIONING_COPY[adjustment.conditioning]} />
            </ul>
            {adjustment.volumeDelta === 0 &&
              adjustment.loadDelta === 0 &&
              adjustment.rirDelta === 0 &&
              !adjustment.extraSetOnLastExercise && (
                <Note className="mt-2">Nothing is being changed.</Note>
              )}
          </>
        ) : (
          <Note className="mt-2">
            No session is being suggested today, and the readiness score is not
            being used to shape one.
          </Note>
        )}

        {adjustment.reasons.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {adjustment.reasons.map((reason) => (
              <li key={reason} className="text-sm text-ink-2 leading-relaxed">
                {reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── rule 10: what counted, and by how much ──────────────────── */}
      <section>
        <Eyebrow>What went into it</Eyebrow>
        <ul className="mt-2 divide-y divide-line">
          {contributions.map((c) => (
            <li key={c.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-base text-ink">{c.label}</span>
                <span
                  className={cn(
                    'text-sm tnum shrink-0',
                    c.score < 0 ? 'text-warn' : 'text-ink-2',
                  )}
                >
                  {score(c.score)}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-ink-2 leading-relaxed">{c.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── and what did not, and why not ───────────────────────────── */}
      {excluded.length > 0 && (
        <section>
          <Eyebrow>Left out of the score</Eyebrow>
          <ul className="mt-2 flex flex-col gap-2">
            {excluded.map((e) => (
              <li key={e.id} className="text-sm text-ink-2 leading-relaxed">
                {e.reason}
              </li>
            ))}
          </ul>
          <Note className="mt-2.5">
            Left out means left out of the average entirely, not counted as
            zero. A missing input cannot drag the score toward the middle.
          </Note>
        </section>
      )}

      {adjustment.applied && (
        <p className="text-2xs text-ink-3 leading-relaxed">{RECOVERY_COPY.override}</p>
      )}
    </Card>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <li className="rounded-[var(--radius-sm)] bg-surface-2 border border-line px-2.5 py-1.5">
      <span className="text-2xs uppercase tracking-wide text-ink-3">{label}</span>
      <span className="ml-1.5 text-sm text-ink tnum">{value}</span>
    </li>
  );
}

/** Exported for the deload prompt — the limit is the algorithm's, not ours. */
export const MAX_CONSECUTIVE_REDUCTIONS = READINESS_LIMITS.maxConsecutiveReductions;
