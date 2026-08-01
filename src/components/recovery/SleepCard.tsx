'use client';

/**
 * @file Sleep — duration, stages where they exist, and the last three weeks.
 *
 * Sleep is the one recovery input that needs no baseline: seven hours is seven
 * hours from the first night, so this card carries real information on day two
 * while HRV is still three weeks from saying anything.
 *
 * Two honesty requirements are visible here:
 *
 * - **Stages are not always available.** The clipboard and manual-paste
 *   ingest paths carry duration; only the `export.zip` parse carries a stage
 *   breakdown (`ARCHITECTURE.md` §5.1). When there is no breakdown the card
 *   says which import would produce one, instead of drawing an empty bar.
 * - **A vendor sleep score is not available at all.** Oura computes it and it
 *   does not cross HealthKit (§5.2). Named, not silently dropped.
 */

import { useMemo } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { LineChart, RangeBar, type LineSeries } from '@/components/charts';
import type { SleepRecord } from '@/lib/db/types';
import { Missing, Note } from './atoms';
import {
  CHART_DAYS,
  dayRange,
  formatRelativeDay,
  formatSleepDuration,
  hasStages,
  xOf,
  type SleepDebt,
} from './model';

/** The 7–9 h window the sleep sub-score is built around, in minutes. */
const TARGET_BAND = { lo: 7 * 60, hi: 9 * 60 };
/** Full scale of the duration track: 0–12 h. */
const TRACK: [number, number] = [0, 12 * 60];

export interface SleepCardProps {
  nights: readonly SleepRecord[];
  lastNight: SleepRecord | null;
  todayKey: string;
  debt: SleepDebt;
}

export function SleepCard({ nights, lastNight, todayKey, debt }: SleepCardProps) {
  const series = useMemo<LineSeries[]>(() => {
    const byDay = new Map(nights.map((n) => [n.dateKey, n]));
    return [
      {
        id: 'sleep',
        label: 'Asleep',
        color: 'var(--c-sleep)',
        kind: 'line',
        endLabel: true,
        // `null`, never 0 — a night with no reading is not a night with no
        // sleep, and drawing it at zero invents an all-nighter.
        data: dayRange(todayKey, CHART_DAYS).map((dateKey) => ({
          x: xOf(dateKey),
          y: byDay.has(dateKey) ? (byDay.get(dateKey) as SleepRecord).asleepMin / 60 : null,
        })),
      },
    ];
  }, [nights, todayKey]);

  const stages = lastNight && hasStages(lastNight) ? lastNight.stages : null;
  const nightsWithData = nights.length;

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader
        title="Sleep"
        subtitle={
          lastNight
            ? `${formatRelativeDay(lastNight.dateKey, todayKey)} · ${formatSleepDuration(lastNight.asleepMin)}`
            : 'No nights recorded yet'
        }
      />

      {lastNight ? (
        <>
          <RangeBar
            label="Time asleep"
            value={lastNight.asleepMin}
            domain={TRACK}
            band={TARGET_BAND}
            color="var(--c-sleep)"
            ticks={[0, 6 * 60, 12 * 60]}
            format={(v) => formatSleepDuration(v)}
          />

          {stages ? (
            <RangeBar
              label="Stages"
              segments={[
                { id: 'deep', label: 'Deep', color: 'var(--c-sleep-deep)', value: stages.deepMin ?? 0 },
                { id: 'rem', label: 'REM', color: 'var(--c-sleep-rem)', value: stages.remMin ?? 0 },
                { id: 'core', label: 'Core', color: 'var(--c-sleep-core)', value: stages.lightMin ?? 0 },
                { id: 'awake', label: 'Awake', color: 'var(--c-sleep-awake)', value: stages.awakeMin ?? 0 },
              ]}
              format={(v) => formatSleepDuration(v)}
            />
          ) : (
            <Missing
              what="No stage breakdown for this night"
              because={
                <>
                  deep, REM and core minutes only come through the full Health{' '}
                  <code className="text-ink-2">export.zip</code> import. The daily
                  clipboard import carries duration and nothing finer.
                </>
              }
            />
          )}

          {lastNight.score === null && (
            <Missing
              what="No sleep score"
              because="Oura computes its own sleep score and it does not cross into Apple Health, so we cannot read it. Duration and stages are all HealthKit carries."
            />
          )}

          {lastNight.efficiency !== null && (
            <Note>
              Efficiency {Math.round(lastNight.efficiency * 100)}% —{' '}
              {formatSleepDuration(lastNight.asleepMin)} asleep out of{' '}
              {formatSleepDuration(lastNight.inBedMin)} in bed.
            </Note>
          )}

          <Note>
            {debt.usable
              ? `Sleep debt ${debt.hours.toFixed(1)} h across ${debt.nights} ${debt.nights === 1 ? 'night' : 'nights'} with data, against a ${debt.targetHours} h target. Only nights with a reading count — a night you did not record is not counted as a night you did not sleep.`
              : `Sleep debt needs at least three of the last seven nights recorded; there ${debt.nights === 1 ? 'is' : 'are'} ${debt.nights}. Until then it stays out of the score.`}
          </Note>

          <LineChart
            series={series}
            height={140}
            unit="h"
            yFormat={(v) => v.toFixed(1)}
            refLines={[{ id: 'target', value: 7, label: '7 h' }]}
            caption={`Last ${CHART_DAYS} nights · ${nightsWithData} recorded`}
            empty={{ title: 'No nights yet' }}
          />
        </>
      ) : (
        <Note>
          Nothing has been imported yet. Once a night lands here you will see the
          hours, the 7–9 h window, and — if the data came from a full Health
          export — the stage breakdown.
        </Note>
      )}
    </Card>
  );
}
