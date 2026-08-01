'use client';

/**
 * @file The top of the review: what the week actually was.
 *
 * Four facts and a trend line, and every one of them is a reading rather than a
 * verdict. The `StatTile` deltas are all `tone: 'neutral'` — the component
 * supports judged tones and this screen deliberately never uses them, because
 * body weight going down is not a score and calories are not a budget you win.
 *
 * The trend chart shows both the smoothed trend and, when it differs, the
 * energy trend — the same line with modelled non-energetic mass removed. Those
 * two diverging is the visual form of "your scale is carrying creatine water",
 * and seeing it is more convincing than being told it.
 */

import { Card } from '@/components/ui/Card';
import { LineChart, StatTile, type LineSeries } from '@/components/charts';
import type { CoachInput } from '@/lib/algorithms';
import type { TrendPoint } from '@/lib/algorithms';
import { formatBodyMass, kgToLb, type UnitSystem } from '@/lib/units';
import { Eyebrow, Note } from './atoms';

/** Days of trend drawn. A fortnight is too short to read, a quarter too dense. */
const CHART_DAYS = 56;

export interface WeekOverviewProps {
  input: CoachInput;
  trendSeries: readonly TrendPoint[];
  system: UnitSystem;
}

export function WeekOverview({ input, trendSeries, system }: WeekOverviewProps) {
  const { trend, expenditure, intake, conditioning } = input;
  const window = trendSeries.slice(-CHART_DAYS);

  const massUnit = formatBodyMass(0, system).unit;
  const trendMass = trend ? formatBodyMass(trend.trendKg, system) : null;

  // The energy trend is only worth a second line when it actually differs —
  // otherwise it is a legend entry that explains nothing.
  const showEnergyTrend = window.some((p) => Math.abs(p.trendKg - p.energyTrendKg) > 0.05);

  const toDisplay = (kg: number) => (system === 'imperial' ? kgToLb(kg) : kg);
  const x = (date: string) => Date.parse(`${date}T00:00:00Z`);

  const series: LineSeries[] = [
    {
      id: 'trend',
      label: 'Trend',
      color: 'var(--c-weight)',
      smooth: true,
      endLabel: true,
      data: window.map((p) => ({ x: x(p.date), y: toDisplay(p.trendKg) })),
    },
    ...(showEnergyTrend
      ? [
          {
            id: 'energy-trend',
            label: 'Water removed (estimate)',
            color: 'var(--c-expenditure)',
            dashed: true,
            smooth: true,
            data: window.map((p) => ({ x: x(p.date), y: toDisplay(p.energyTrendKg) })),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label="Trend weight"
          value={trendMass ? trendMass.value : null}
          unit={trendMass ? trendMass.unit : massUnit}
          emptyHint="No weigh-ins"
          {...(trend
            ? {
                delta: {
                  value: trend.weeklyChangePctBw,
                  period: 'per week, of bodyweight',
                  unit: '%',
                  decimals: 2,
                  tone: 'neutral' as const,
                },
              }
            : {})}
        />
        <StatTile
          label="Expenditure estimate"
          value={expenditure ? Math.round(expenditure.tdeeKcal) : null}
          unit="kcal"
          emptyHint="Not enough data"
        >
          {expenditure && (
            <span className="text-2xs text-ink-3 mt-1 block">
              {Math.round(expenditure.ci95[0])}–{Math.round(expenditure.ci95[1])} · {expenditure.confidenceLabel} confidence
            </span>
          )}
        </StatTile>
        <StatTile
          label="Mean intake, logged days"
          value={intake ? Math.round(intake.meanKcal) : null}
          unit="kcal"
          emptyHint="Nothing logged"
        >
          {intake && (
            <span className="text-2xs text-ink-3 mt-1 block">
              {intake.days.filter((d) => d.kcal !== null).length} of 7 days logged
            </span>
          )}
        </StatTile>
        <StatTile
          label="Zone 2"
          value={conditioning ? conditioning.zone2Minutes : null}
          unit="min"
          emptyHint="None logged"
        >
          {conditioning && (
            <span className="text-2xs text-ink-3 mt-1 block">
              {conditioning.hardIntervalSessions} hard session
              {conditioning.hardIntervalSessions === 1 ? '' : 's'}
            </span>
          )}
        </StatTile>
      </div>

      {window.length >= 2 && (
        <Card flush className="overflow-hidden">
          <div className="px-4 pt-4">
            <Eyebrow>Weight trend, last {Math.min(CHART_DAYS, window.length)} days</Eyebrow>
          </div>
          <LineChart
            series={series}
            height={180}
            unit={massUnit}
            yFormat={(v) => v.toFixed(1)}
            className="mt-1"
          />
          {showEnergyTrend && (
            <div className="px-4 pb-4">
              <Note>
                The dotted line is the same trend with modelled non-energetic mass
                removed — water that came with creatine, glycogen or sodium rather
                than with food. It is a model, not a measurement, and it is the
                line the expenditure estimate is fitted to.
              </Note>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
