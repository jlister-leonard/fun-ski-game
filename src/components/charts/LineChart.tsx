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
  extent,
  formatDayMonth,
  formatFullDate,
  formatNumber,
  halfSpacing,
  hasValue,
  labelBudget,
  linearScale,
  niceTicks,
  observed,
  padDomain,
  r,
  splitRuns,
  thin,
  toAreaPath,
  toBandPath,
  toMonotonePath,
  toPolyline,
  type BandPoint,
  type Domain,
  type GapPoint,
  type Point,
} from "./geometry";

export type LineSeriesKind = "line" | "scatter" | "area";

export type LineSeries = {
  id: string;
  /** Names the series in the legend, the readout and the table. */
  label: string;
  /** A `var(--c-…)` reference. Never a literal colour. */
  color: string;
  /**
   * `y: null` means the day was **not logged**: the line breaks, no mark is
   * drawn, and the point is left out of the y-domain. A genuine `y: 0` is a
   * real observation and is plotted on the baseline. Never pass 0 for
   * "missing" — an unlogged day drawn as zero intake invents a deficit that
   * never happened.
   */
  data: GapPoint[];
  /** `line` (default) · `scatter` for raw observations · `area` for a filled line. */
  kind?: LineSeriesKind;
  /** Monotone-cubic interpolation. Cannot overshoot, so a trend never invents a dip. */
  smooth?: boolean;
  /** Dashed stroke — reserved for targets and reference series. */
  dashed?: boolean;
  /** Recede this series: thinner, lower opacity. Used for raw data under a trend. */
  muted?: boolean;
  /** Print the final value beside the line end. Use on at most one or two series. */
  endLabel?: boolean;
  /** Excluded from the scrub readout (e.g. a flat target line). */
  skipReadout?: boolean;
};

export type LineChartBand = {
  id: string;
  label: string;
  color: string;
  data: BandPoint[];
};

export type RefLine = {
  id: string;
  value: number;
  label?: string;
  /** Defaults to `--ink-3`. Never a status colour unless the value *is* a status. */
  color?: string;
};

export type LineChartProps = {
  series: LineSeries[];
  /** An uncertainty or target band, drawn behind every line. */
  band?: LineChartBand;
  refLines?: RefLine[];
  title?: React.ReactNode;
  caption?: React.ReactNode;
  height?: number;
  /** Lock the y range. Omit to fit the data with 8% headroom. */
  yDomain?: Domain;
  yTickCount?: number;
  /** Formats y ticks and readout values. Default: thousands-separated integer. */
  yFormat?: (v: number) => string;
  /** Formats x ticks. Default: "14 Mar". */
  xFormat?: (v: number) => string;
  /** Formats the x value in the scrub readout. Default: "Fri 14 Mar 2026". */
  xReadoutFormat?: (v: number) => string;
  /** Appended to readout and end-label values, e.g. "kg", "kcal". */
  unit?: string;
  /** Copy for the no-data case. Written for a user on day one. */
  empty?: Partial<EmptyStateProps>;
  /** A caveat under the plot — "trend needs about 10 days of weigh-ins". */
  note?: React.ReactNode;
  /** Turn off the drag-to-read interaction (it is on by default). */
  scrub?: boolean;
  className?: string;
  /** Radius of a raw-observation dot. */
  scatterRadius?: number;
};

const INSET_TOP = 12;
const AXIS_BAND = 20;

export function LineChart({
  series,
  band,
  refLines,
  title,
  caption,
  height = 190,
  yDomain,
  yTickCount = 4,
  yFormat = (v) => formatNumber(v, 0),
  xFormat = formatDayMonth,
  xReadoutFormat = formatFullDate,
  unit,
  empty,
  note,
  scrub = true,
  className,
  scatterRadius = 3,
}: LineChartProps) {
  // A series is drawable only if it holds at least one real observation. A
  // column of nulls is an unlogged period, not a flat line at zero.
  const drawable = series.filter((s) => s.data.some(hasValue));
  const totalPoints = drawable.reduce((n, s) => n + s.data.filter(hasValue).length, 0);

  /* ── domains ─────────────────────────────────────────────────────────── */
  // x spans every position on the axis, including unlogged days — a gap has to
  // occupy its real width or the break reads as a compressed line.
  const xValues = drawable.flatMap((s) => s.data.map((p) => p.x));
  // y is built from observations ONLY, so a missing day can never drag the
  // domain down to zero and flatten the signal.
  const yValues = drawable.flatMap((s) => s.data.filter(hasValue).map((p) => p.y));
  if (band) {
    for (const p of band.data) yValues.push(p.lo, p.hi);
  }
  for (const line of refLines ?? []) yValues.push(line.value);

  const xExt = extent(xValues);
  const yExt = extent(yValues);
  const xd: Domain = xExt ? (xExt[0] === xExt[1] ? [xExt[0] - 1, xExt[1] + 1] : xExt) : [0, 1];
  const yd: Domain = yDomain ?? (yExt ? padDomain(yExt) : [0, 1]);

  const yTicks = React.useMemo(() => niceTicks(yd, yTickCount), [yd[0], yd[1], yTickCount]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── readout state ───────────────────────────────────────────────────── */
  const readoutSeries = drawable.filter((s) => !s.skipReadout);
  const anchor = readoutSeries.find((s) => s.kind !== "scatter") ?? readoutSeries[0];
  // The scrub only ever lands on days that were actually logged.
  const anchorData = anchor ? observed(anchor.data) : [];
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
  const active = activeIndex !== null && anchorData[activeIndex] ? anchorData[activeIndex] : null;

  /* ── frame plumbing ──────────────────────────────────────────────────── */
  const legend: LegendItem[] = series.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    mark: s.kind === "scatter" ? "dot" : "line",
    outline: s.dashed,
  }));
  if (band) legend.push({ id: band.id, label: band.label, color: band.color, mark: "swatch" });

  const table: ChartTable = {
    columns: ["Date", ...drawable.map((s) => (unit ? `${s.label} (${unit})` : s.label))],
    rows: buildTableRows(drawable, xReadoutFormat, yFormat),
  };

  const emptyState: EmptyStateProps | null =
    totalPoints === 0
      ? {
          title: empty?.title ?? "Nothing logged yet",
          hint: empty?.hint ?? "Your first entry starts the chart. A trend appears after about a week.",
          action: empty?.action,
          ghost: empty?.ghost ?? "lines",
        }
      : null;

  const readout = active ? (
    <span style={READOUT} aria-live="polite">
      <span style={READOUT_DATE}>{xReadoutFormat(active.x)}</span>
      {readoutSeries.map((s) => {
        const p = valueAt(s.data, active.x);
        return (
          <span key={s.id} style={READOUT_ITEM}>
            <span aria-hidden="true" style={{ ...READOUT_DOT, background: s.color }} />
            {/* An unlogged day says so. It is never reported as zero. */}
            {p ? yFormat(p.y) : <span style={READOUT_MISSING}>not logged</span>}
            {p && unit ? <span style={READOUT_UNIT}>{unit}</span> : null}
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
      table={table}
      empty={emptyState}
      footer={note}
      className={className}
    >
      {({ width }) => {
        const leftInset = yAxisInset(yTicks, yFormat);
        const rightInset = series.some((s) => s.endLabel) ? 46 : 12;
        const x0 = leftInset;
        const x1 = Math.max(x0 + 1, width - rightInset);
        const y0 = INSET_TOP;
        const y1 = height - 4;

        const sx = linearScale(xd, [x0, x1]);
        const sy = linearScale(yd, [y1, y0]);

        const xTicks = thin(pickXTicks(drawable, xd), labelBudget(x1 - x0, 58));

        const project = (p: Point) => ({ cx: sx(p.x), cy: sy(p.y) });

        const onScrub = (clientX: number, rect: DOMRect) => {
          if (!scrub || anchorData.length === 0) return;
          const px = clientX - rect.left;
          const value = xd[0] + ((px - x0) / (x1 - x0)) * (xd[1] - xd[0]);
          setActiveIndex(nearestIndex(anchorData, value));
        };

        return (
          <svg
            className="hc-chart-plot"
            width={width}
            height={height + AXIS_BAND}
            viewBox={`0 0 ${width} ${height + AXIS_BAND}`}
            role="img"
            aria-label={ariaSummary(title, drawable, yFormat, unit)}
            tabIndex={scrub && anchorData.length > 0 ? 0 : -1}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              onScrub(e.clientX, e.currentTarget.getBoundingClientRect());
            }}
            onPointerMove={(e) => {
              if (e.buttons === 0 && e.pointerType !== "mouse") return;
              if (e.pointerType === "mouse" || e.buttons > 0) {
                onScrub(e.clientX, e.currentTarget.getBoundingClientRect());
              }
            }}
            onPointerLeave={() => setActiveIndex(null)}
            onPointerUp={() => setActiveIndex(null)}
            onBlur={() => setActiveIndex(null)}
            onKeyDown={(e) => {
              if (!scrub || anchorData.length === 0) return;
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const step = e.key === "ArrowRight" ? 1 : -1;
                setActiveIndex((i) => {
                  const next = (i ?? (step > 0 ? -1 : anchorData.length)) + step;
                  return Math.max(0, Math.min(anchorData.length - 1, next));
                });
              } else if (e.key === "Escape") {
                setActiveIndex(null);
              }
            }}
          >
            <GridLines ticks={yTicks} scale={sy} x0={x0} x1={x1} />
            <YAxisLabels ticks={yTicks} scale={sy} x={x0 - 8} format={yFormat} />
            <XAxisLabels ticks={xTicks} scale={sx} y={height} format={xFormat} width={width} />

            {refLines?.map((line) => (
              <g key={line.id}>
                <line
                  x1={x0}
                  x2={x1}
                  y1={sy(line.value)}
                  y2={sy(line.value)}
                  stroke={line.color ?? "var(--hc-ink-3)"}
                  strokeWidth={MARK.hairline}
                  strokeDasharray="4 4"
                  opacity={0.9}
                />
                {line.label && (
                  <text
                    x={x1}
                    y={sy(line.value) - 5}
                    textAnchor="end"
                    fill="var(--hc-ink-3)"
                    style={TICK_TEXT}
                  >
                    {line.label}
                  </text>
                )}
              </g>
            ))}

            {band && band.data.length > 1 && (
              <path
                d={toBandPath(
                  band.data.map((p) => ({ cx: sx(p.x), cy: sy(p.hi) })),
                  band.data.map((p) => ({ cx: sx(p.x), cy: sy(p.lo) })),
                  true,
                )}
                fill={band.color}
                fillOpacity={MARK.wash}
                stroke="none"
              />
            )}

            {drawable.map((s) => {
              // Each contiguous run of logged days is its own path, so an
              // unlogged day breaks the line instead of being interpolated
              // across.
              const runs = splitRuns(s.data);
              const seen = observed(s.data);
              const lastPoint = seen[seen.length - 1];

              if (s.kind === "scatter") {
                return (
                  <g key={s.id} fill={s.color} opacity={s.muted ? 0.5 : 0.75}>
                    {seen.map((p, i) => {
                      const q = project(p);
                      return <circle key={i} cx={q.cx} cy={q.cy} r={scatterRadius} />;
                    })}
                  </g>
                );
              }

              return (
                <g key={s.id}>
                  {runs.map((run, ri) => {
                    const pts = run.map(project);
                    // A lone observation between two gaps still gets a dot: a
                    // one-point path draws nothing at all.
                    if (pts.length === 1) {
                      return (
                        <circle
                          key={ri}
                          cx={pts[0].cx}
                          cy={pts[0].cy}
                          r={MARK.marker / 2}
                          fill={s.color}
                          stroke="var(--hc-surface)"
                          strokeWidth={MARK.ring}
                          opacity={s.muted ? 0.6 : 1}
                        />
                      );
                    }
                    return (
                      <g key={ri}>
                        {s.kind === "area" && (
                          <path
                            d={toAreaPath(pts, y1, !!s.smooth)}
                            fill={s.color}
                            fillOpacity={MARK.wash}
                            stroke="none"
                          />
                        )}
                        <path
                          d={s.smooth ? toMonotonePath(pts) : toPolyline(pts)}
                          fill="none"
                          stroke={s.color}
                          strokeWidth={s.muted ? 1.5 : MARK.line}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeDasharray={s.dashed ? "5 4" : undefined}
                          opacity={s.muted ? 0.6 : 1}
                        />
                      </g>
                    );
                  })}
                  {s.endLabel && lastPoint && (
                    <EndMarker
                      point={project(lastPoint)}
                      color={s.color}
                      label={`${yFormat(lastPoint.y)}${unit ? ` ${unit}` : ""}`}
                      maxX={width}
                    />
                  )}
                </g>
              );
            })}

            {active && (
              <g aria-hidden="true">
                <line
                  x1={r(sx(active.x))}
                  x2={r(sx(active.x))}
                  y1={y0}
                  y2={y1}
                  stroke="var(--hc-ink-3)"
                  strokeWidth={MARK.hairline}
                />
                {readoutSeries.map((s) => {
                  // No dot on a day this series did not record.
                  const p = valueAt(s.data, active.x);
                  if (!p) return null;
                  return (
                    <circle
                      key={s.id}
                      cx={r(sx(p.x))}
                      cy={r(sy(p.y))}
                      r={MARK.marker / 2}
                      fill={s.color}
                      stroke="var(--hc-surface)"
                      strokeWidth={MARK.ring}
                    />
                  );
                })}
              </g>
            )}
          </svg>
        );
      }}
    </ChartFrame>
  );
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function EndMarker({
  point,
  color,
  label,
  maxX,
}: {
  point: { cx: number; cy: number };
  color: string;
  label: string;
  maxX: number;
}) {
  // Only place the label outside the line end when it actually fits; otherwise
  // the legend and the table carry the value rather than clipping it.
  const fits = point.cx + 10 + label.length * 6.2 <= maxX;
  return (
    <g>
      <circle
        cx={point.cx}
        cy={point.cy}
        r={MARK.marker / 2}
        fill={color}
        stroke="var(--hc-surface)"
        strokeWidth={MARK.ring}
      />
      {fits && (
        <text x={point.cx + 9} y={point.cy} dy="0.32em" fill="var(--hc-ink)" style={END_LABEL}>
          {label}
        </text>
      )}
    </g>
  );
}

function yAxisInset(ticks: number[], format: (v: number) => string): number {
  const longest = ticks.reduce((n, t) => Math.max(n, format(t).length), 1);
  return Math.min(64, 14 + longest * 6.4);
}

function pickXTicks(series: LineSeries[], domain: Domain): number[] {
  const longest = series.reduce<LineSeries | null>(
    (best, s) => (!best || s.data.length > best.data.length ? s : best),
    null,
  );
  if (!longest || longest.data.length < 2) return [domain[0], domain[1]];
  return longest.data.map((p) => p.x);
}

function nearestIndex(data: Point[], x: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < data.length; i++) {
    const d = Math.abs(data[i].x - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * The observation this series holds at `x`, or `null` if it holds none.
 *
 * An exact x match wins. Otherwise the nearest observation is accepted only if
 * it falls within half the series' own sampling interval — so series on
 * slightly different grids still line up, while a genuinely unlogged day
 * resolves to "not logged" instead of borrowing a value from days away.
 */
function valueAt(data: GapPoint[], x: number): Point | null {
  const seen = observed(data);
  if (!seen.length) return null;
  const exact = seen.find((p) => p.x === x);
  if (exact) return exact;
  const tolerance = halfSpacing(data);
  let best: Point | null = null;
  let bestD = Infinity;
  for (const p of seen) {
    const d = Math.abs(p.x - x);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best && bestD <= tolerance ? best : null;
}

function buildTableRows(
  series: LineSeries[],
  xFormat: (v: number) => string,
  yFormat: (v: number) => string,
): (string | number)[][] {
  const xs = Array.from(new Set(series.flatMap((s) => s.data.map((p) => p.x)))).sort((a, b) => a - b);
  return xs.map((x) => [
    xFormat(x),
    ...series.map((s) => {
      const hit = s.data.find((p) => p.x === x);
      // "Not logged" and a logged 0 are different facts; the table says which.
      return hit && hasValue(hit) ? yFormat(hit.y) : "not logged";
    }),
  ]);
}

function ariaSummary(
  title: React.ReactNode,
  series: LineSeries[],
  yFormat: (v: number) => string,
  unit?: string,
): string {
  const name = typeof title === "string" ? title : "Line chart";
  const parts = series
    .map((s) => {
      const seen = observed(s.data);
      if (!seen.length) return null;
      const last = seen[seen.length - 1];
      const missing = s.data.length - seen.length;
      const gapNote = missing > 0 ? `, ${missing} day${missing === 1 ? "" : "s"} not logged` : "";
      return `${s.label} latest ${yFormat(last.y)}${unit ? ` ${unit}` : ""}${gapNote}`;
    })
    .filter((p): p is string => p !== null);
  return `${name}. ${parts.join(". ")}. Full values are in the table that follows.`;
}

/* ── styles ────────────────────────────────────────────────────────────── */

const TICK_TEXT: React.CSSProperties = {
  font: "400 0.6875rem/1 var(--hc-font-sans)",
  fontVariantNumeric: "tabular-nums",
};

const END_LABEL: React.CSSProperties = {
  font: "590 0.75rem/1 var(--hc-font-sans)",
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

const READOUT_ITEM: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  color: "var(--hc-ink)",
  fontWeight: 590,
  fontVariantNumeric: "tabular-nums",
};

const READOUT_DOT: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%" };

const READOUT_UNIT: React.CSSProperties = {
  color: "var(--hc-ink-3)",
  fontWeight: 400,
  marginLeft: 1,
};

const READOUT_MISSING: React.CSSProperties = {
  color: "var(--hc-ink-3)",
  fontWeight: 400,
  fontStyle: "italic",
};
