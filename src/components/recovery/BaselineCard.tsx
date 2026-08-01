'use client';

/**
 * @file HRV and resting heart rate, each against its own baseline.
 *
 * §8.5 rule 3 is the reason this card exists in its own right rather than as
 * two numbers on the readiness card: *"HRV and RHR contribute 0 to the score
 * until ≥21 days of readings exist. Show the user 'building your baseline —
 * N/21 days.'"* Before then these are readings the user can look at and nothing
 * more, and the card says exactly that.
 *
 * The chart draws `mean ± SD` as a band — "your usual range" is a range, and a
 * single reading is only interpretable as being inside or outside it. A bare
 * line invites reading this morning's wobble as a result.
 */

import { useMemo, type ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { LineChart, type LineChartBand, type LineSeries } from '@/components/charts';
import { READINESS_LIMITS, RECOVERY_COPY } from '@/lib/algorithms';
import { Eyebrow, Missing, Note } from './atoms';
import { CHART_DAYS, dayRange, xOf, type BaselineView } from './model';

export interface BaselineCardProps {
  hrv: BaselineView;
  rhr: BaselineView;
  todayKey: string;
}

export function BaselineCard({ hrv, rhr, todayKey }: BaselineCardProps) {
  return (
    <Card className="flex flex-col gap-6">
      <CardHeader
        title="Against your baseline"
        subtitle="Your own normal range, not anyone else's"
      />

      <Metric
        title="Heart rate variability"
        unit="ms"
        color="var(--c-readiness)"
        view={hrv}
        todayKey={todayKey}
        digits={1}
        direction="below"
        footnote={
          <Missing
            what="Recorded as SDNN, not RMSSD"
            because="Apple Health stores heart rate variability as SDNN, and the methodology was written against RMSSD. The two are not interchangeable, so every comparison here is against your own SDNN history — internally consistent, and not comparable with an RMSSD figure from another app."
          />
        }
      />

      <Metric
        title="Resting heart rate"
        unit="bpm"
        color="var(--c-strain)"
        view={rhr}
        todayKey={todayKey}
        digits={0}
        direction="above"
        footnote={
          <Note>
            Resting heart rate is not sensitive enough to notice one hard
            session, so it never earns a green light here — it can only ever
            trim, and only when it has been elevated for days.
          </Note>
        }
      />
    </Card>
  );
}

interface MetricProps {
  title: string;
  unit: string;
  color: string;
  view: BaselineView;
  todayKey: string;
  digits: number;
  /** Which way is the direction of concern, for the run-length sentence. */
  direction: 'above' | 'below';
  footnote: ReactNode;
}

function Metric({
  title,
  unit,
  color,
  view,
  todayKey,
  digits,
  direction,
  footnote,
}: MetricProps) {
  const { series, band } = useMemo(() => {
    const byDay = new Map(view.series.map((p) => [p.date, p.value]));
    const days = dayRange(todayKey, CHART_DAYS);

    const line: LineSeries = {
      id: 'reading',
      label: title,
      color,
      kind: 'line',
      endLabel: true,
      data: days.map((d) => ({ x: xOf(d), y: byDay.has(d) ? (byDay.get(d) as number) : null })),
    };

    const usual: LineChartBand | undefined =
      view.mean !== null && view.sd !== null
        ? {
            id: 'usual',
            label: 'Your usual range',
            color,
            data: days.map((d) => ({
              x: xOf(d),
              lo: (view.mean as number) - (view.sd as number),
              hi: (view.mean as number) + (view.sd as number),
            })),
          }
        : undefined;

    return { series: [line], band: usual };
  }, [view, todayKey, title, color]);

  if (view.series.length === 0) {
    return (
      <section>
        <Eyebrow>{title}</Eyebrow>
        <Note className="mt-1.5">
          No readings yet. This fills in once a data source is connected; it
          needs 21 days of them before it may influence anything.
        </Note>
        <div className="mt-2.5">{footnote}</div>
      </section>
    );
  }

  const latest = view.latest;
  const baselineCopy = RECOVERY_COPY.baseline
    .replace('{n}', String(view.days))
    .replace('{required}', String(READINESS_LIMITS.baselineDays));

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>{title}</Eyebrow>
        {view.ready ? (
          <span className="text-2xs text-ink-3">
            Baseline over {view.days} days
          </span>
        ) : (
          <span className="text-2xs text-warn tnum">
            Building — {view.days}/{READINESS_LIMITS.baselineDays} days
          </span>
        )}
      </div>

      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold text-ink tnum tracking-[-0.02em]">
          {latest ? latest.value.toFixed(digits) : '—'}
        </span>
        <span className="text-base text-ink-2">{unit}</span>
        {view.mean !== null && (
          <span className="ml-1 text-sm text-ink-2 tnum">
            vs {view.mean.toFixed(digits)} {unit} average
          </span>
        )}
      </div>

      {view.z !== null && view.ready && (
        <p className="mt-1 text-sm text-ink-2 tnum">
          {deviationSentence(view.z, direction)}
          {view.runDays > 0 &&
            ` ${view.runDays} ${view.runDays === 1 ? 'day' : 'days'} running ${direction} your usual range.`}
        </p>
      )}

      {!view.ready && <Note className="mt-2">{baselineCopy}</Note>}

      <LineChart
        className="mt-3"
        series={series}
        band={band}
        height={130}
        unit={unit}
        yFormat={(v) => v.toFixed(digits)}
        caption={`Last ${CHART_DAYS} days · ${view.series.length} readings in the window`}
        empty={{ title: 'No readings yet' }}
      />

      <div className="mt-2.5">{footnote}</div>
    </section>
  );
}

/**
 * Today's deviation, in words.
 *
 * Deviation is only called out when it runs the way that matters. A resting
 * heart rate well *below* baseline is not a result — §8.1 is explicit that RHR
 * is too blunt to hand out a green light on the strength of one morning — and
 * printing "1.4 SD below your average" invites reading it as one. The other
 * direction is simply "inside your usual range", which is the whole of what can
 * honestly be said about it.
 */
function deviationSentence(z: number, direction: 'above' | 'below'): string {
  const magnitude = Math.abs(z).toFixed(1);
  const concerning = direction === 'below' ? z <= -1 : z >= 1;
  if (concerning) return `${magnitude} SD ${direction} your average.`;
  if (Math.abs(z) < 1) return 'Inside your usual range.';
  return `Inside your usual range, ${magnitude} SD ${z < 0 ? 'below' : 'above'} your average.`;
}
