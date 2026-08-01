"use client";

import { useMemo } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { LineChart, type LineChartBand, type LineSeries } from "@/components/charts";
import type { TrendPoint, TrendSummary } from "@/lib/algorithms";
import { formatBodyMass, formatBodyMassDelta, kgToLb, type UnitSystem } from "@/lib/units";

export interface WeightTrendCardProps {
  /** Output of `computeWeightTrend`, in kilograms. */
  trend: readonly TrendPoint[];
  summary: TrendSummary | null;
  system: UnitSystem;
  /** True when a logged perturbation is settling anywhere in the window. */
  hasPerturbation: boolean;
}

/** Midday local, so a date lands unambiguously inside its day on the x axis. */
function xOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

/** One decimal, no trailing zero — matches `formatBodyMass`. */
function axisFormat(value: number): string {
  const s = value.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * The weight trend — the screen this app exists to show.
 *
 * Raw weigh-ins are drawn as scatter and the filtered trend over them, because
 * the whole argument for the trend line is visual: you can see the scale
 * jumping 1.5 kg on water and the trend not caring. Rendering only the trend
 * would ask the user to take that on trust.
 *
 * Three deliberate choices:
 *
 * - **The uncertainty band is drawn, not hidden.** The filter knows how sure it
 *   is; a single confident-looking line would be a claim it cannot support.
 * - **No forward projection.** `nutrition-personalization.md` §3 rules out
 *   "you'd weigh X in five weeks" — it turns a noisy estimate into a promise.
 * - **No colour verdict.** Losing weight is not rendered green and gaining is
 *   not rendered red. The rate is a fact; whether it is the right rate is a
 *   question the coaching layer answers in words, with its reasoning.
 */
export function WeightTrendCard({
  trend,
  summary,
  system,
  hasPerturbation,
}: WeightTrendCardProps) {
  const display = useMemo(
    () => (kg: number) => (system === "metric" ? kg : kgToLb(kg)),
    [system]
  );

  const { series, band } = useMemo(() => {
    const raw: LineSeries = {
      id: "raw",
      label: "Weigh-ins",
      color: "var(--c-neutral)",
      kind: "scatter",
      muted: true,
      // `null`, never 0: a day with no weigh-in is not a day at zero kilograms.
      data: trend.map((p) => ({
        x: xOf(p.date),
        y: p.observed && p.rawKg !== null ? display(p.rawKg) : null,
      })),
    };

    const line: LineSeries = {
      id: "trend",
      label: "Trend",
      color: "var(--c-weight)",
      kind: "line",
      smooth: true,
      endLabel: true,
      data: trend.map((p) => ({ x: xOf(p.date), y: display(p.trendKg) })),
    };

    // The perturbation-corrected series: what the scale would read with the
    // modelled water removed. Shown only when there is something to correct,
    // because otherwise it sits exactly on the trend line and just adds ink.
    const corrected: LineSeries = {
      id: "energy-trend",
      label: "Water removed",
      color: "var(--c-expenditure)",
      kind: "line",
      smooth: true,
      dashed: true,
      skipReadout: false,
      data: trend.map((p) => ({ x: xOf(p.date), y: display(p.energyTrendKg) })),
    };

    const uncertainty: LineChartBand = {
      id: "trend-ci",
      label: "Trend uncertainty",
      color: "var(--c-weight)",
      data: trend.map((p) => ({
        x: xOf(p.date),
        lo: display(p.trendKg - 1.96 * p.trendSdKg),
        hi: display(p.trendKg + 1.96 * p.trendSdKg),
      })),
    };

    return {
      series: hasPerturbation ? [raw, corrected, line] : [raw, line],
      band: uncertainty,
    };
  }, [trend, display, hasPerturbation]);

  const observations = trend.filter((p) => p.observed).length;
  const unit = system === "metric" ? "kg" : "lb";

  const rate = summary ? formatBodyMassDelta(summary.weeklyChangeKg, system) : null;
  const ciLo = summary ? formatBodyMassDelta(summary.weeklyChangeCi95[0], system) : null;
  const ciHi = summary ? formatBodyMassDelta(summary.weeklyChangeCi95[1], system) : null;

  return (
    <Card>
      <CardHeader
        title="Weight trend"
        subtitle={
          summary
            ? `${formatBodyMass(summary.trendKg, system).text} · smoothed`
            : "Waiting for weigh-ins"
        }
      />

      <div className="mt-3">
        <LineChart
          series={series}
          band={trend.length >= 3 ? band : undefined}
          height={200}
          unit={unit}
          yFormat={axisFormat}
          scatterRadius={2.5}
          note={
            observations < 10
              ? `A trend needs about ten weigh-ins before it means much — there ${
                  observations === 1 ? "is" : "are"
                } ${observations} so far. The line will move a lot until then.`
              : undefined
          }
          empty={{
            title: "No weigh-ins yet",
            hint: "Log one and the chart starts here.",
            ghost: "lines",
          }}
        />
      </div>

      {summary && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Stat
            label="Per week"
            value={rate ? `${rate.value} ${rate.unit}` : "—"}
            hint={
              summary.rateIsActionable && ciLo && ciHi
                ? `95% range ${ciLo.value} to ${ciHi.value} ${unit}`
                : "Still settling — the range is too wide to act on"
            }
          />
          <Stat
            label="Weigh-ins, last 14 days"
            value={`${summary.weighInsLast14d} of 14`}
            hint={
              summary.weighInsLast14d >= 10
                ? "Enough for a tight estimate"
                : "More readings narrow the estimate"
            }
          />
        </div>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2.5">
      <div className="text-2xs text-ink-3 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold text-ink tnum mt-0.5">{value}</div>
      <div className="text-2xs text-ink-3 mt-1 leading-snug">{hint}</div>
    </div>
  );
}
