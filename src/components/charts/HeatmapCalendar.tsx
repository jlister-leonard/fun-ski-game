"use client";

import * as React from "react";
import { ChartFrame, type ChartTable, type EmptyStateProps } from "./ChartFrame";
import { DAY_MS, formatFullDate, formatNumber, startOfDay } from "./geometry";

export type HeatmapValue = {
  /** Any timestamp within the day; it is bucketed to local midnight. */
  date: number;
  value: number;
};

export type HeatmapCalendarProps = {
  values: HeatmapValue[];
  /** Defaults to 26 weeks back from `end`. */
  start?: number;
  /**
   * Last day in the grid. Pass `Date.now()` from the screen so the calendar
   * runs up to today; it is not defaulted here because reading the clock
   * during render would desync a statically pre-rendered page. Falls back to
   * the most recent value.
   */
  end?: number;
  /**
   * Sequential ramp, light→dark, ONE hue. Five steps by default. Never a
   * rainbow: this encodes magnitude, not identity.
   */
  scale?: string[];
  /** Value that maps to the darkest step. Defaults to the observed maximum. */
  max?: number;
  title?: React.ReactNode;
  caption?: React.ReactNode;
  /** Formats the value in the readout and the table. */
  format?: (v: number) => string;
  /** Names the quantity: "sessions", "days logged". */
  unit?: string;
  cellSize?: number;
  cellGap?: number;
  empty?: Partial<EmptyStateProps>;
  className?: string;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEFT_GUTTER = 30;
const TOP_GUTTER = 16;

export function HeatmapCalendar({
  values,
  start,
  end,
  scale = ["var(--c-seq-1)", "var(--c-seq-2)", "var(--c-seq-3)", "var(--c-seq-4)", "var(--c-seq-5)"],
  max,
  title,
  caption,
  format = (v) => formatNumber(v, 0),
  unit,
  cellSize = 13,
  cellGap = 3,
  empty,
  className,
}: HeatmapCalendarProps) {
  const [selected, setSelected] = React.useState<number | null>(null);

  const { days, weeks, byDay, observedMax } = React.useMemo(() => {
    const latest = values.reduce((t, v) => (Number.isFinite(v.date) && v.date > t ? v.date : t), 0);
    const endDay = startOfDay(end ?? latest);
    const startDay = startOfDay(start ?? endDay - 181 * DAY_MS);
    // Align the grid to the Monday on or before the start.
    const offset = (new Date(startDay).getDay() + 6) % 7;
    const gridStart = startDay - offset * DAY_MS;

    const map = new Map<number, number>();
    let observed = 0;
    for (const v of values) {
      if (!Number.isFinite(v.value)) continue;
      const key = startOfDay(v.date);
      const next = (map.get(key) ?? 0) + v.value;
      map.set(key, next);
      if (next > observed) observed = next;
    }

    const list: number[] = [];
    for (let t = gridStart; t <= endDay; t += DAY_MS) list.push(t);
    return {
      days: list,
      weeks: Math.ceil(list.length / 7),
      byDay: map,
      observedMax: observed,
      startDay,
    };
  }, [values, start, end]);

  const ceiling = Math.max(1, max ?? observedMax);
  const hasData = byDay.size > 0;

  const table: ChartTable = {
    columns: ["Date", unit ? `Value (${unit})` : "Value"],
    rows: [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, v]) => [formatFullDate(day), format(v)]),
  };

  const emptyState: EmptyStateProps | null = !hasData
    ? {
        title: empty?.title ?? "No history yet",
        hint: empty?.hint ?? "Each day you log fills in a square. Consistency shows up here first.",
        action: empty?.action,
        ghost: empty?.ghost ?? "cells",
      }
    : null;

  const gridHeight = 7 * (cellSize + cellGap) - cellGap;
  const contentWidth = LEFT_GUTTER + weeks * (cellSize + cellGap);

  const readout =
    selected !== null ? (
      <span style={READOUT} aria-live="polite">
        <span style={READOUT_DATE}>{formatFullDate(selected)}</span>
        <span style={READOUT_VALUE}>
          {format(byDay.get(selected) ?? 0)}
          {unit ? <span style={READOUT_UNIT}> {unit}</span> : null}
        </span>
      </span>
    ) : null;

  return (
    <ChartFrame
      title={title}
      caption={readout ?? caption}
      height={TOP_GUTTER + gridHeight + 4}
      minWidth={contentWidth}
      table={table}
      empty={emptyState}
      className={className}
      footer={hasData ? <ScaleLegend scale={scale} /> : undefined}
    >
      {() => (
        <svg
          className="hc-chart-plot"
          width={contentWidth}
          height={TOP_GUTTER + gridHeight + 4}
          viewBox={`0 0 ${contentWidth} ${TOP_GUTTER + gridHeight + 4}`}
          role="img"
          aria-label={`Daily activity calendar. ${byDay.size} days with data. Full values are in the table that follows.`}
        >
          <g style={AXIS_TEXT} fill="var(--hc-ink-3)" aria-hidden="true">
            {[0, 2, 4].map((row) => (
              <text key={row} x={LEFT_GUTTER - 7} y={TOP_GUTTER + row * (cellSize + cellGap) + cellSize / 2} dy="0.32em" textAnchor="end">
                {WEEKDAYS[row]}
              </text>
            ))}
            {monthLabels(days, cellSize, cellGap).map((m) => (
              <text key={m.key} x={LEFT_GUTTER + m.x} y={TOP_GUTTER - 5}>
                {m.label}
              </text>
            ))}
          </g>

          {days.map((day, i) => {
            const week = Math.floor(i / 7);
            const row = i % 7;
            const value = byDay.get(day);
            const fill = value === undefined ? "var(--c-seq-empty)" : scale[stepFor(value, ceiling, scale.length)];
            return (
              <rect
                key={day}
                x={LEFT_GUTTER + week * (cellSize + cellGap)}
                y={TOP_GUTTER + row * (cellSize + cellGap)}
                width={cellSize}
                height={cellSize}
                rx={3}
                fill={fill}
                stroke={selected === day ? "var(--hc-ink)" : "none"}
                strokeWidth={selected === day ? 1.5 : 0}
                style={{ cursor: "pointer" }}
                onPointerDown={() => setSelected((prev) => (prev === day ? null : day))}
              />
            );
          })}
        </svg>
      )}
    </ChartFrame>
  );
}

function stepFor(value: number, ceiling: number, steps: number): number {
  if (value <= 0) return 0;
  const ratio = Math.min(1, value / ceiling);
  return Math.min(steps - 1, Math.max(0, Math.ceil(ratio * steps) - 1));
}

function monthLabels(days: number[], cellSize: number, cellGap: number) {
  const out: { key: string; x: number; label: string }[] = [];
  let lastMonth = -1;
  for (let i = 0; i < days.length; i += 7) {
    const d = new Date(days[i]);
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      const x = (i / 7) * (cellSize + cellGap);
      // Skip a label that would sit on top of the previous one.
      if (!out.length || x - out[out.length - 1].x > 26) {
        out.push({ key: `${d.getFullYear()}-${lastMonth}`, x, label: MONTHS[lastMonth] });
      }
    }
  }
  return out;
}

function ScaleLegend({ scale }: { scale: string[] }) {
  return (
    <span style={SCALE_LEGEND}>
      <span>Less</span>
      <span aria-hidden="true" style={{ display: "inline-flex", gap: 3 }}>
        <span style={{ ...SWATCH, background: "var(--c-seq-empty)" }} />
        {scale.map((c) => (
          <span key={c} style={{ ...SWATCH, background: c }} />
        ))}
      </span>
      <span>More</span>
    </span>
  );
}

const AXIS_TEXT: React.CSSProperties = {
  font: "400 0.6875rem/1 var(--hc-font-sans)",
  letterSpacing: "0.01em",
};

const SCALE_LEGEND: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  font: "400 0.6875rem/1 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
};

const SWATCH: React.CSSProperties = { width: 11, height: 11, borderRadius: 3, display: "block" };

const READOUT: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: "2px 10px",
  font: "400 0.8125rem/1.35 var(--hc-font-sans)",
  color: "var(--hc-ink-2)",
};
const READOUT_DATE: React.CSSProperties = { color: "var(--hc-ink-3)" };
const READOUT_VALUE: React.CSSProperties = {
  color: "var(--hc-ink)",
  fontWeight: 590,
  fontVariantNumeric: "tabular-nums",
};
const READOUT_UNIT: React.CSSProperties = { color: "var(--hc-ink-3)", fontWeight: 400 };
