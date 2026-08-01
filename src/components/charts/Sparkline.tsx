"use client";

import * as React from "react";
import "./chart-tokens.module.css";
import {
  MARK,
  extent,
  isValue,
  linearScale,
  padDomain,
  splitRuns,
  toAreaPath,
  toMonotonePath,
  toPolyline,
  type GapPoint,
  type Point,
} from "./geometry";

export type SparklineProps = {
  /**
   * Bare numbers are treated as evenly spaced. A `null`/`undefined` entry means
   * the day was **not logged**: the line breaks there and the point is left out
   * of the domain. A `0` is a real observation and is plotted. Never pass 0 for
   * "missing" — it drags the baseline down and invents a dip.
   */
  data: readonly (number | null | undefined)[] | readonly GapPoint[];
  /** A `var(--c-…)` reference. Defaults to the muted series colour. */
  color?: string;
  width?: number;
  height?: number;
  /** Fill the area under the line with a 10% wash. */
  area?: boolean;
  /** Monotone-cubic interpolation. On by default — sparklines read as shape. */
  smooth?: boolean;
  /** Ringed dot on the final observed point. */
  endDot?: boolean;
  /** A horizontal reference (a target, or the period mean). */
  baseline?: number;
  strokeWidth?: number;
  /**
   * A sparkline carries no axis, so it needs its own description unless the
   * surrounding component already names it (StatTile does).
   */
  ariaLabel?: string;
  className?: string;
};

/** Below this many points a line is noise, not a trend — show dots instead. */
const MIN_LINE_POINTS = 3;

export function Sparkline({
  data,
  color = "var(--c-neutral)",
  width = 88,
  height = 28,
  area = false,
  smooth = true,
  endDot = true,
  baseline,
  strokeWidth = MARK.line,
  ariaLabel,
  className,
}: SparklineProps) {
  // `slots` keeps every x position, including unlogged ones, so a gap occupies
  // its real width. `points` is the observed subset that drives the domain.
  const slots = React.useMemo(() => normalise(data), [data]);
  const points = React.useMemo(() => slots.filter((p) => isValue(p.y)) as Point[], [slots]);

  const pad = endDot ? MARK.marker / 2 + MARK.ring : 2;
  const yValues = points.map((p) => p.y);
  if (baseline !== undefined) yValues.push(baseline);
  const yExt = extent(yValues);
  const xExt = extent(slots.map((p) => p.x));

  if (points.length === 0 || !yExt || !xExt) {
    return (
      <svg
        className={className}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        focusable="false"
      >
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--hc-grid)"
          strokeWidth={MARK.hairline}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const sx = linearScale(xExt[0] === xExt[1] ? [xExt[0] - 1, xExt[1] + 1] : xExt, [pad, width - pad]);
  const sy = linearScale(padDomain(yExt, 0.12), [height - pad, pad]);
  const project = (p: Point) => ({ cx: sx(p.x), cy: sy(p.y) });

  const last = points[points.length - 1];
  const useLine = points.length >= MIN_LINE_POINTS;
  // One path per contiguous run — the line breaks at an unlogged day rather
  // than interpolating straight across it.
  const runs = splitRuns(slots);

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      focusable="false"
      style={{ display: "block", overflow: "visible" }}
    >
      {baseline !== undefined && (
        <line
          x1="0"
          y1={sy(baseline)}
          x2={width}
          y2={sy(baseline)}
          stroke="var(--hc-ink-3)"
          strokeWidth={MARK.hairline}
          strokeDasharray="3 3"
          opacity={0.7}
        />
      )}

      {useLine
        ? runs.map((run, ri) => {
            const projected = run.map(project);
            // A lone observation between two gaps still gets a dot: a
            // one-point path draws nothing at all.
            if (projected.length === 1) {
              return (
                <circle key={ri} cx={projected[0].cx} cy={projected[0].cy} r={2.5} fill={color} />
              );
            }
            return (
              <g key={ri}>
                {area && (
                  <path
                    d={toAreaPath(projected, height - pad, smooth)}
                    fill={color}
                    fillOpacity={MARK.wash}
                  />
                )}
                <path
                  d={smooth ? toMonotonePath(projected) : toPolyline(projected)}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })
        : points.map((p, i) => {
            const q = project(p);
            return <circle key={i} cx={q.cx} cy={q.cy} r={2.5} fill={color} />;
          })}

      {endDot && (
        <circle
          cx={project(last).cx}
          cy={project(last).cy}
          r={MARK.marker / 2}
          fill={color}
          stroke="var(--hc-surface)"
          strokeWidth={MARK.ring}
        />
      )}
    </svg>
  );
}

/**
 * Normalise to `GapPoint[]`, preserving index positions. An unlogged entry is
 * kept with `y: null` rather than dropped, so the gap keeps its width on the x
 * axis instead of the surrounding days silently closing over it.
 */
function normalise(
  data: readonly (number | null | undefined)[] | readonly GapPoint[],
): GapPoint[] {
  const out: GapPoint[] = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i] as number | null | undefined | GapPoint;
    if (item === null || item === undefined) {
      out.push({ x: i, y: null });
    } else if (typeof item === "number") {
      out.push({ x: i, y: Number.isFinite(item) ? item : null });
    } else if (Number.isFinite(item.x)) {
      out.push({ x: item.x, y: isValue(item.y) ? item.y : null });
    }
  }
  return out;
}
