"use client";

import * as React from "react";
import {
  ChartFrame,
  GridLines,
  XAxisLabels,
  YAxisLabels,
  type ChartTable,
  type EmptyStateProps,
  type LegendItem,
} from "./ChartFrame";
import {
  MARK,
  barPath,
  formatNumber,
  isValue,
  labelBudget,
  linearScale,
  niceTicks,
  thin,
} from "./geometry";

export type BarSeries = {
  id: string;
  label: string;
  /** A `var(--c-…)` reference. Never a literal colour. */
  color: string;
  /**
   * One value per category. `null`/`undefined` means **not logged** — no bar is
   * drawn, the day is marked as a gap, and it is excluded from totals. A `0` is
   * a real observation (a logged fast, a day with no alcohol) and is drawn as a
   * visible stub on the baseline. Never pass 0 for "missing".
   */
  values: (number | null | undefined)[];
};

export type BarChartProps = {
  /** One label per x position. Keep them short — "Mon", "14 Mar". */
  categories: string[];
  series: BarSeries[];
  /** `stacked` for parts of a whole (macros in a day), `grouped` to compare. */
  mode?: "stacked" | "grouped";
  title?: React.ReactNode;
  caption?: React.ReactNode;
  height?: number;
  yFormat?: (v: number) => string;
  /** A target or average line across the plot. */
  target?: { value: number; label?: string; color?: string };
  /** Appended to values in the readout and the table. */
  unit?: string;
  /** Below this per-category width the plot scrolls instead of squeezing. */
  minBandWidth?: number;
  empty?: Partial<EmptyStateProps>;
  note?: React.ReactNode;
  className?: string;
};

const AXIS_BAND = 20;
/** Height of the mark that says "logged, and the value really was zero". */
const ZERO_STUB = 2;

export function BarChart({
  categories,
  series,
  mode = "stacked",
  title,
  caption,
  height = 180,
  yFormat = (v) => formatNumber(v, 0),
  target,
  unit,
  minBandWidth = 34,
  empty,
  note,
  className,
}: BarChartProps) {
  const [selected, setSelected] = React.useState<number | null>(null);

  // A category counts as logged if ANY series recorded a value for it —
  // including a real zero. Unlogged days contribute nothing to totals.
  const logged = categories.map((_, i) => series.some((s) => isValue(s.values[i])));
  const totals = categories.map((_, i) =>
    mode === "stacked"
      ? series.reduce((sum, s) => sum + num(s.values[i]), 0)
      : series.reduce((max, s) => Math.max(max, num(s.values[i])), 0),
  );
  const hasData = logged.some(Boolean);
  const yMax = Math.max(...totals, target?.value ?? 0, 1);
  const yTicks = niceTicks([0, yMax * 1.08], 4);
  const yTop = Math.max(yTicks[yTicks.length - 1] ?? yMax, yMax);

  const legend: LegendItem[] = series.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    mark: "swatch" as const,
  }));
  if (target) {
    legend.push({
      id: "target",
      label: target.label ?? "Target",
      color: target.color ?? "var(--hc-ink-3)",
      mark: "line",
      outline: true,
    });
  }

  const table: ChartTable = {
    columns: ["Day", ...series.map((s) => (unit ? `${s.label} (${unit})` : s.label)), "Total"],
    rows: categories.map((cat, i) => [
      cat,
      ...series.map((s) => (isValue(s.values[i]) ? yFormat(s.values[i] as number) : "not logged")),
      logged[i] ? yFormat(totals[i]) : "not logged",
    ]),
  };

  const emptyState: EmptyStateProps | null = !hasData
    ? {
        title: empty?.title ?? "Nothing logged for this period",
        hint: empty?.hint ?? "Days you log will stack up here.",
        action: empty?.action,
        ghost: empty?.ghost ?? "lines",
      }
    : null;

  const readout =
    selected !== null && categories[selected] ? (
      <span style={READOUT} aria-live="polite">
        <span style={READOUT_DATE}>{categories[selected]}</span>
        {series.map((s) => {
          const v = s.values[selected];
          return (
            <span key={s.id} style={READOUT_ITEM}>
              <span aria-hidden="true" style={{ ...READOUT_DOT, background: s.color }} />
              {/* An unlogged day reads as "not logged", never as zero. */}
              {isValue(v) ? yFormat(v) : <span style={READOUT_MISSING}>not logged</span>}
              {isValue(v) && unit ? <span style={READOUT_UNIT}>{unit}</span> : null}
            </span>
          );
        })}
      </span>
    ) : null;

  return (
    <ChartFrame
      title={title}
      caption={readout ?? caption}
      legend={legend}
      height={height}
      axisHeight={AXIS_BAND}
      minWidth={categories.length * minBandWidth + 56}
      table={table}
      empty={emptyState}
      footer={note}
      className={className}
    >
      {({ width }) => {
        const leftInset = Math.min(64, 14 + yTicks.reduce((n, t) => Math.max(n, yFormat(t).length), 1) * 6.4);
        const x0 = leftInset;
        const x1 = Math.max(x0 + 1, width - 10);
        const y0 = 10;
        const y1 = height - 4;

        const sy = linearScale([0, yTop], [y1, y0]);
        const band = (x1 - x0) / Math.max(1, categories.length);
        const barW = Math.min(MARK.barMax, band * 0.62);
        const groupW = mode === "grouped" ? Math.min(MARK.barMax, (band * 0.72) / Math.max(1, series.length)) : barW;

        const tickIdx = thin(
          categories.map((_, i) => i),
          labelBudget(x1 - x0, 46),
        );

        return (
          <svg
            className="hc-chart-plot"
            width={width}
            height={height + AXIS_BAND}
            viewBox={`0 0 ${width} ${height + AXIS_BAND}`}
            role="img"
            aria-label={`${typeof title === "string" ? title : "Bar chart"}. ${categories.length} periods. Full values are in the table that follows.`}
          >
            <GridLines ticks={yTicks} scale={sy} x0={x0} x1={x1} />
            <YAxisLabels ticks={yTicks} scale={sy} x={x0 - 8} format={yFormat} />
            <XAxisLabels
              ticks={tickIdx}
              scale={(i) => x0 + band * (i + 0.5)}
              y={height}
              format={(i) => categories[i] ?? ""}
              width={width}
            />

            {categories.map((cat, i) => {
              const cx = x0 + band * (i + 0.5);
              const isSelected = selected === i;

              const bars: React.ReactNode[] = [];

              if (!logged[i]) {
                // Not logged. A dashed baseline tick marks the absence — this
                // day is deliberately NOT drawn as a zero-height bar, because
                // "no bar" and "ate nothing" must never look the same.
                bars.push(
                  <line
                    key="gap"
                    x1={cx - barW / 2}
                    x2={cx + barW / 2}
                    y1={y1}
                    y2={y1}
                    stroke="var(--hc-ink-3)"
                    strokeWidth={1.5}
                    strokeDasharray="2 3"
                    strokeLinecap="round"
                    opacity={0.55}
                  />,
                );
              } else if (mode === "stacked") {
                const valued = series.filter((s) => isValue(s.values[i]));
                const positive = valued.filter((s) => (s.values[i] as number) > 0);

                if (positive.length === 0) {
                  // Logged, and it really was zero. A visible stub says so.
                  bars.push(
                    <rect
                      key="zero"
                      x={cx - barW / 2}
                      y={y1 - ZERO_STUB}
                      width={barW}
                      height={ZERO_STUB}
                      rx={1}
                      fill={valued[0].color}
                    />,
                  );
                } else {
                  // Offsets computed up front — no mutation during render.
                  // Segments are separated by a 2px gap in the surface colour,
                  // never by a stroke drawn around the mark.
                  positive
                    .reduce<{ s: BarSeries; base: number; v: number }[]>((acc, s) => {
                      const prev = acc[acc.length - 1];
                      const base = prev ? prev.base + prev.v : 0;
                      return [...acc, { s, base, v: s.values[i] as number }];
                    }, [])
                    .forEach(({ s, base, v }, si) => {
                      const yTopPx = sy(base + v);
                      const yBottomPx = sy(base);
                      const isTop = si === positive.length - 1;
                      const h = Math.max(0, yBottomPx - yTopPx - (si > 0 ? MARK.gap : 0));
                      if (h <= 0) return;
                      bars.push(
                        <path
                          key={s.id}
                          d={barPath(cx - barW / 2, yTopPx, barW, h, isTop ? MARK.barCap : 0)}
                          fill={s.color}
                        />,
                      );
                    });
                }
              } else {
                const totalW = groupW * series.length + MARK.gap * (series.length - 1);
                series.forEach((s, si) => {
                  const v = s.values[i];
                  if (!isValue(v)) return; // this series did not record the day
                  const bx = cx - totalW / 2 + si * (groupW + MARK.gap);
                  const h = Math.max(ZERO_STUB, y1 - sy(v));
                  bars.push(
                    <path
                      key={s.id}
                      d={barPath(bx, y1 - h, groupW, h, v > 0 ? MARK.barCap : 1)}
                      fill={s.color}
                    />,
                  );
                });
              }

              return (
                <g key={cat + i} opacity={selected === null || isSelected ? 1 : 0.45}>
                  {bars}
                  {/* Hit target spans the whole band and the full plot height,
                      so a thumb never has to find a 20px-wide bar. */}
                  <rect
                    x={cx - band / 2}
                    y={y0}
                    width={band}
                    height={y1 - y0}
                    fill="transparent"
                    style={{ cursor: "pointer" }}
                    onPointerDown={() => setSelected((prev) => (prev === i ? null : i))}
                  />
                </g>
              );
            })}

            {target && (
              <g>
                <line
                  x1={x0}
                  x2={x1}
                  y1={sy(target.value)}
                  y2={sy(target.value)}
                  stroke={target.color ?? "var(--hc-ink-3)"}
                  strokeWidth={MARK.hairline}
                  strokeDasharray="4 4"
                />
                {target.label && (
                  <text x={x1} y={sy(target.value) - 5} textAnchor="end" fill="var(--hc-ink-3)" style={TICK_TEXT}>
                    {target.label}
                  </text>
                )}
              </g>
            )}
          </svg>
        );
      }}
    </ChartFrame>
  );
}

/** Magnitude contributed to a stack or total. Unlogged and negative add nothing. */
function num(v: number | null | undefined): number {
  return isValue(v) && v > 0 ? v : 0;
}

const TICK_TEXT: React.CSSProperties = {
  font: "400 0.6875rem/1 var(--hc-font-sans)",
  fontVariantNumeric: "tabular-nums",
};

const READOUT: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: "2px 12px",
  font: "400 0.8125rem/1.35 var(--hc-font-sans)",
  color: "var(--hc-ink-2)",
};
const READOUT_DATE: React.CSSProperties = { color: "var(--hc-ink-3)" };
const READOUT_MISSING: React.CSSProperties = {
  color: "var(--hc-ink-3)",
  fontWeight: 400,
  fontStyle: "italic",
};
const READOUT_ITEM: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  color: "var(--hc-ink)",
  fontWeight: 590,
  fontVariantNumeric: "tabular-nums",
};
const READOUT_DOT: React.CSSProperties = { width: 8, height: 8, borderRadius: 3 };
const READOUT_UNIT: React.CSSProperties = { color: "var(--hc-ink-3)", fontWeight: 400, marginLeft: 1 };
