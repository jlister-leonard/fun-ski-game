'use client';

/**
 * @file Day one — and, for now, most days.
 *
 * There is no connected data source and no 21-day baseline, so this is the
 * screen a user actually meets. It was designed first and it is the state the
 * rest of the screen is built around.
 *
 * The one thing it must not do is show a readiness number. `assessReadiness`
 * requires soreness and energy; substituting 3/3 for "unanswered" would produce
 * a confident `normal` band and the copy "Normal day. Run the plan." out of an
 * empty vault. Withholding that is the feature — an app that guesses on day one
 * has taught the user that its numbers are decoration.
 *
 * What it does instead: name what is missing, name what each missing thing
 * would unlock, and give the single action that starts everything. That action
 * is the check-in, not an import, because §8.2 is explicit that subjective
 * inputs are first-class — two taps produce a fully explained assessment with
 * no wearable at all.
 */

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { READINESS_LIMITS } from '@/lib/algorithms';
import { Eyebrow, Missing, Note } from './atoms';
import type { BaselineView } from './model';

export interface EmptyStateProps {
  onCheckIn: () => void;
  /** Nights of sleep already in the vault. */
  nights: number;
  hrv: BaselineView;
  rhr: BaselineView;
}

export function EmptyState({ onCheckIn, nights, hrv, rhr }: EmptyStateProps) {
  const hasWearable = hrv.series.length > 0 || rhr.series.length > 0;
  const hasAnything = hasWearable || nights > 0;

  return (
    <Card className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold text-ink">No readiness yet today</h2>
        <Note className="mt-2">
          Readiness needs two answers from you — how sore you are and how much
          energy you have. Without them there is nothing to score, so nothing is
          scored. A number here that was not built out of your answers would be
          decoration.
        </Note>
      </div>

      <Button block size="lg" onClick={onCheckIn}>
        Do today&rsquo;s check-in
      </Button>

      <div>
        <Eyebrow>What you get, and when</Eyebrow>
        <ul className="mt-2.5 space-y-3.5">
          <Milestone when="After the check-in, today">
            A readiness band, the adjustment it suggests for today&rsquo;s
            session, and a line for every input explaining what it contributed.
            Soreness and energy alone are enough — a wearable adds to this, it
            is not required for it.
          </Milestone>

          <Milestone
            when={
              nights > 0
                ? `Sleep · ${nights} ${nights === 1 ? 'night' : 'nights'} recorded`
                : 'Sleep · nothing imported yet'
            }
          >
            {nights > 0
              ? 'Last night’s hours already count toward the score. Sleep needs no baseline — seven hours is seven hours on the first night.'
              : 'Import from Apple Health and last night’s hours count immediately. Sleep is the one input that needs no baseline period.'}
          </Milestone>

          <Milestone when={baselineWhen('HRV', hrv)}>
            {hrv.series.length === 0
              ? `Heart rate variability contributes nothing until ${READINESS_LIMITS.baselineDays} days of readings exist. A reading is only interpretable against your own range, and there is no population average worth substituting.`
              : `${hrv.days} of ${READINESS_LIMITS.baselineDays} days collected. Until the baseline is complete it contributes exactly zero — not a reduced weight, zero, and excluded from the average.`}
          </Milestone>

          <Milestone when={baselineWhen('Resting heart rate', rhr)}>
            {rhr.series.length === 0
              ? `Same ${READINESS_LIMITS.baselineDays}-day rule, and even then it can only ever trim a session — a low resting heart rate never earns extra work.`
              : `${rhr.days} of ${READINESS_LIMITS.baselineDays} days collected. Even complete, it can only trim a session, never add to one.`}
          </Milestone>
        </ul>
      </div>

      <div>
        <Eyebrow>What this app cannot get</Eyebrow>
        <div className="mt-2.5 flex flex-col gap-2.5">
          <Missing
            what="Oura's own readiness score"
            because="Oura computes it on their servers and it does not cross into Apple Health. We read the underlying HRV, heart rate and sleep and do our own working, which is why every number here comes with its reasoning attached."
          />
          <Missing
            what="Oura's own sleep score"
            because="Same reason. Duration, stages and efficiency come through; the score does not."
          />
          <Missing
            what="Sleep stages from the daily import"
            because="The one-tap daily import carries duration. Deep, REM and core minutes only come through the full Health export.zip."
          />
        </div>
        {!hasAnything && (
          <Note className="mt-3">
            No data source is connected yet. Nothing about that is broken — the
            check-in works on its own, and everything above is an addition to it
            rather than a prerequisite.
          </Note>
        )}
      </div>
    </Card>
  );
}

function baselineWhen(name: string, view: BaselineView): string {
  if (view.series.length === 0) return `${name} · nothing imported yet`;
  if (view.ready) return `${name} · baseline complete`;
  return `${name} · ${view.days}/${READINESS_LIMITS.baselineDays} days`;
}

function Milestone({ when, children }: { when: ReactNode; children: ReactNode }) {
  return (
    <li>
      <div className="text-2xs uppercase tracking-wide text-ink-3">{when}</div>
      <div className="text-sm text-ink-2 mt-0.5 leading-relaxed">{children}</div>
    </li>
  );
}
