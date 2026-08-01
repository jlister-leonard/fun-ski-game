"use client";

import * as React from "react";
import "./chart-tokens.module.css";
import { Legend, useElementWidth, type LegendItem } from "./ChartFrame";
import { MARK, barPath, formatNumber, linearScale } from "./geometry";

export type RangeSegment = {
  id: string;
  label: string;
  /** A `var(--c-…)` reference. Sleep stages use the ordinal `--c-sleep-*` ramp. */
  color: string;
  value: number;
};

export type RangeBarProps = {
  /** Small caps label above the bar. */
  label?: string;
  /** The measured value. Omit when using `segments`. */
  value?: number;
  /** Full scale of the track. Required in value mode. */
  domain?: [number, number];
  /** The healthy / target window. Rendered as a calm inset, never a verdict. */
  band?: { lo: number; hi: number; label?: string };
  /** Colour of the value marker. */
  color?: string;
  /** Composition mode: a stacked horizontal bar (sleep stages). */
  segments?: RangeSegment[];
  unit?: string;
  format?: (v: number) => string;
  /** Track thickness in px. */
  thickness?: number;
  /** Tick values printed under the track. Value mode only. */
  ticks?: number[];
  /** Shown when there is nothing to draw. */
  emptyHint?: string;
  className?: string;
};

export function RangeBar({
  label,
  value,
  domain,
  band,
  color = "var(--hc-accent)",
  segments,
  unit,
  format = (v) => formatNumber(v, 0),
  thickness = 14,
  ticks,
  emptyHint = "No data yet",
  className,
}: RangeBarProps) {
  const [ref, width] = useElementWidth(0);
  const isComposition = !!segments?.length;
  const total = segments?.reduce((sum, s) => sum + Math.max(0, s.value), 0) ?? 0;
  const hasData = isComposition ? total > 0 : Number.isFinite(value ?? NaN);

  const legend: LegendItem[] | null = isComposition
    ? segments!.map((s) => ({
        id: s.id,
        label: s.label,
        color: s.color,
        mark: "swatch" as const,
        value: `${format(s.value)}${unit ? ` ${unit}` : ""}`,
      }))
    : null;

  const height = thickness + (ticks?.length ? 18 : 0);

  return (
    <div className={`hc-chart ${className ?? ""}`} style={WRAP}>
      {(label || (!isComposition && hasData)) && (
        <div style={HEAD}>
          {label && <span style={LABEL}>{label}</span>}
          {!isComposition && hasData && (
            <span style={VALUE}>
              {format(value!)}
              {unit && <span style={UNIT}> {unit}</span>}
            </span>
          )}
        </div>
      )}

      <div ref={ref} style={{ width: "100%" }}>
        {!hasData ? (
          <div style={{ ...EMPTY, height: thickness }}>{emptyHint}</div>
        ) : width > 0 ? (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={ariaLabel({ label, value, unit, band, segments, format })}
            style={{ display: "block", overflow: "visible" }}
          >
            {isComposition ? (
              <Composition segments={segments!} total={total} width={width} thickness={thickness} />
            ) : (
              <ValueTrack
                value={value!}
                domain={domain ?? [0, Math.max(1, value! * 1.4)]}
                band={band}
                color={color}
                width={width}
                thickness={thickness}
                ticks={ticks}
                format={format}
              />
            )}
          </svg>
        ) : (
          <div style={{ height }} aria-hidden="true" />
        )}
      </div>

      {legend && legend.length > 1 && <Legend items={legend} />}
    </div>
  );
}

function Composition({
  segments,
  total,
  width,
  thickness,
}: {
  segments: RangeSegment[];
  total: number;
  width: number;
  thickness: number;
}) {
  const drawn = segments.filter((s) => s.value > 0);
  const gaps = Math.max(0, drawn.length - 1) * MARK.gap;
  const usable = Math.max(1, width - gaps);
  // Offsets are computed up front so the render body stays free of mutation.
  const laid = drawn.reduce<{ seg: RangeSegment; x: number; w: number }[]>((acc, s) => {
    const prev = acc[acc.length - 1];
    const w = (s.value / total) * usable;
    return [...acc, { seg: s, w, x: prev ? prev.x + prev.w + MARK.gap : 0 }];
  }, []);
  return (
    <g>
      {laid.map(({ seg: s, x, w }, i) => {
        const isFirst = i === 0;
        const isLast = i === drawn.length - 1;
        const rx = isFirst || isLast ? Math.min(MARK.barCap, thickness / 2) : 0;
        return (
          <rect
            key={s.id}
            x={x}
            y={0}
            width={Math.max(1, w)}
            height={thickness}
            rx={rx}
            fill={s.color}
          />
        );
      })}
    </g>
  );
}

function ValueTrack({
  value,
  domain,
  band,
  color,
  width,
  thickness,
  ticks,
  format,
}: {
  value: number;
  domain: [number, number];
  band?: { lo: number; hi: number; label?: string };
  color: string;
  width: number;
  thickness: number;
  ticks?: number[];
  format: (v: number) => string;
}) {
  const sx = linearScale(domain, [0, width]);
  const clamped = Math.max(domain[0], Math.min(domain[1], value));
  const fillW = Math.max(2, sx(clamped));
  const overshoot = value > domain[1];

  return (
    <g>
      <rect x={0} y={0} width={width} height={thickness} rx={thickness / 2} fill="var(--hc-surface-inset)" />

      {band && (
        // The target window is drawn as a quiet inset on the track. Being
        // outside it is information, not a failure — no status colour here.
        <rect
          x={sx(band.lo)}
          y={0}
          width={Math.max(2, sx(band.hi) - sx(band.lo))}
          height={thickness}
          fill="var(--hc-ink-3)"
          opacity={0.16}
        />
      )}

      <path d={barPath(0, 0, thickness, fillW, MARK.barCap, "right")} fill={color} opacity={0.9} />

      {/* Value marker: a 2px surface ring keeps it legible wherever it lands. */}
      <circle
        cx={fillW}
        cy={thickness / 2}
        r={thickness / 2 + 1}
        fill={color}
        stroke="var(--hc-surface)"
        strokeWidth={MARK.ring}
      />

      {overshoot && (
        <text x={width - 2} y={thickness / 2} dy="0.32em" textAnchor="end" fill="var(--hc-ink)" style={TICK_TEXT}>
          ▸
        </text>
      )}

      {ticks?.map((t) => (
        <text
          key={t}
          x={Math.max(0, Math.min(width, sx(t)))}
          y={thickness + 6}
          dy="0.72em"
          textAnchor={sx(t) < 12 ? "start" : sx(t) > width - 12 ? "end" : "middle"}
          fill="var(--hc-ink-3)"
          style={TICK_TEXT}
        >
          {format(t)}
        </text>
      ))}
    </g>
  );
}

function ariaLabel({
  label,
  value,
  unit,
  band,
  segments,
  format,
}: {
  label?: string;
  value?: number;
  unit?: string;
  band?: { lo: number; hi: number; label?: string };
  segments?: RangeSegment[];
  format: (v: number) => string;
}): string {
  if (segments?.length) {
    return `${label ?? "Composition"}. ${segments
      .map((s) => `${s.label} ${format(s.value)}${unit ? ` ${unit}` : ""}`)
      .join(", ")}.`;
  }
  const target = band ? ` Target range ${format(band.lo)} to ${format(band.hi)}${unit ? ` ${unit}` : ""}.` : "";
  return `${label ?? "Value"} ${value !== undefined ? format(value) : "unknown"}${unit ? ` ${unit}` : ""}.${target}`;
}

const WRAP: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 7 };

const HEAD: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
};

const LABEL: React.CSSProperties = {
  font: "590 0.6875rem/1.2 var(--hc-font-sans)",
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--hc-ink-3)",
};

const VALUE: React.CSSProperties = {
  font: "590 0.9375rem/1.2 var(--hc-font-sans)",
  fontVariantNumeric: "tabular-nums",
  color: "var(--hc-ink)",
};

const UNIT: React.CSSProperties = { color: "var(--hc-ink-3)", fontWeight: 400 };

const EMPTY: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  font: "400 0.8125rem/1 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
};

const TICK_TEXT: React.CSSProperties = {
  font: "400 0.6875rem/1 var(--hc-font-sans)",
  fontVariantNumeric: "tabular-nums",
};
