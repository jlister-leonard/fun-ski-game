"use client";

import * as React from "react";
import "./chart-tokens.module.css";
import { MARK } from "./geometry";

/* ── measurement ───────────────────────────────────────────────────────── */

/**
 * Width of an element, kept current with a ResizeObserver.
 *
 * `initial` is returned on the server and on the first client paint, so the
 * chart occupies its final box immediately — the container's height is fixed
 * by the caller, so a width correction reflows nothing outside the chart.
 */
export function useElementWidth(initial = 0): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(initial);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    apply(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

/* ── shared prop shapes ────────────────────────────────────────────────── */

export type LegendItem = {
  id: string;
  label: string;
  /** A CSS colour — always a `var(--c-…)` reference, never a literal. */
  color: string;
  /** `line` draws a short key, `dot` a circle, `swatch` a rounded square. */
  mark?: "line" | "dot" | "swatch";
  /** Optional value shown next to the label (already formatted). */
  value?: string;
  /** Renders the key as an outline — used for "target" / reference series. */
  outline?: boolean;
};

export type ChartTable = {
  columns: string[];
  rows: (string | number)[][];
};

export type ChartFrameProps = {
  /** Sentence-case, no trailing colon. Names what is plotted. */
  title?: React.ReactNode;
  /** One line under the title. Units, period, or the caveat. */
  caption?: React.ReactNode;
  /** Present whenever two or more series are drawn. */
  legend?: LegendItem[];
  /** Plot height in px, excluding header, legend and the x-axis band. */
  height: number;
  /** Extra height reserved below the plot for x-axis labels. */
  axisHeight?: number;
  /** When set and wider than the container, the plot scrolls horizontally. */
  minWidth?: number;
  /** Anything to place under the plot (notes, a scale legend). */
  footer?: React.ReactNode;
  /**
   * The accessible twin. Every value in the chart must be reachable here, so
   * a tooltip never gates a number.
   */
  table?: ChartTable;
  /** Rendered instead of the plot when there is nothing to draw. */
  empty?: EmptyStateProps | null;
  className?: string;
  /** Receives the measured plot box. Return the `<svg>`. */
  children: (size: { width: number; height: number }) => React.ReactNode;
};

/* ── frame ─────────────────────────────────────────────────────────────── */

export function ChartFrame({
  title,
  caption,
  legend,
  height,
  axisHeight = 0,
  minWidth,
  footer,
  table,
  empty,
  className,
  children,
}: ChartFrameProps) {
  const [ref, measured] = useElementWidth(0);
  const plotWidth = Math.max(minWidth ?? 0, measured);
  const totalHeight = height + axisHeight;
  const ready = measured > 0 && !empty;

  return (
    <figure className={`hc-chart ${className ?? ""}`} style={FIGURE}>
      {(title || caption) && (
        <figcaption style={HEADER}>
          {title && <div style={TITLE}>{title}</div>}
          {caption && <div style={CAPTION}>{caption}</div>}
        </figcaption>
      )}

      {legend && legend.length > 1 && <Legend items={legend} />}

      <div ref={ref} className={minWidth ? "hc-chart-scroll" : undefined} style={{ width: "100%" }}>
        <div style={{ height: totalHeight, width: plotWidth || "100%" }}>
          {empty ? (
            <EmptyState {...empty} height={totalHeight} />
          ) : ready ? (
            children({ width: plotWidth, height: totalHeight })
          ) : (
            <div style={{ height: totalHeight }} aria-hidden="true" />
          )}
        </div>
      </div>

      {footer && <div style={FOOTER}>{footer}</div>}
      {table && <SrTable {...table} caption={typeof title === "string" ? title : undefined} />}
    </figure>
  );
}

/* ── legend ────────────────────────────────────────────────────────────── */

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul style={LEGEND_LIST}>
      {items.map((item) => (
        <li key={item.id} style={LEGEND_ITEM}>
          <LegendKey item={item} />
          <span>{item.label}</span>
          {item.value !== undefined && <span style={LEGEND_VALUE}>{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

function LegendKey({ item }: { item: LegendItem }) {
  const mark = item.mark ?? "dot";
  const common = { flex: "0 0 auto" as const };
  if (mark === "line") {
    return (
      <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true" style={common}>
        <line
          x1="0"
          y1="5"
          x2="14"
          y2="5"
          stroke={item.color}
          strokeWidth={MARK.line}
          strokeLinecap="round"
          strokeDasharray={item.outline ? "3 3" : undefined}
        />
      </svg>
    );
  }
  if (mark === "swatch") {
    return (
      <span
        aria-hidden="true"
        style={{
          ...common,
          width: 10,
          height: 10,
          borderRadius: 3,
          background: item.outline ? "transparent" : item.color,
          boxShadow: item.outline ? `inset 0 0 0 1.5px ${item.color}` : undefined,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        ...common,
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: item.outline ? "transparent" : item.color,
        boxShadow: item.outline ? `inset 0 0 0 1.5px ${item.color}` : undefined,
      }}
    />
  );
}

/* ── empty state ───────────────────────────────────────────────────────── */

export type EmptyStateProps = {
  /** What is missing, in the user's words. */
  title: string;
  /** How to fix it — one short sentence, no apology. */
  hint?: string;
  /** Optional call to action rendered by the caller. */
  action?: React.ReactNode;
  /**
   * Draws faint baselines behind the message so the space reads as a chart
   * that is waiting, not as a broken box.
   */
  ghost?: "lines" | "rings" | "cells" | "none";
  height?: number;
};

export function EmptyState({ title, hint, action, ghost = "lines", height = 180 }: EmptyStateProps) {
  return (
    <div style={{ ...EMPTY_WRAP, height }}>
      {ghost !== "none" && <GhostPlot kind={ghost} />}
      <div style={EMPTY_CONTENT}>
        <p style={EMPTY_TITLE}>{title}</p>
        {hint && <p style={EMPTY_HINT}>{hint}</p>}
        {action}
      </div>
    </div>
  );
}

function GhostPlot({ kind }: { kind: "lines" | "rings" | "cells" }) {
  return (
    <svg
      aria-hidden="true"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
      style={GHOST}
      focusable="false"
    >
      {kind === "lines" &&
        // Faint and inset, so an empty chart reads as waiting rather than as a
        // grid with the data missing. Not the real gridline colour.
        [26, 54, 82].map((y) => (
          <line key={y} x1="8" y1={y} x2="92" y2={y} stroke="var(--hc-line)" strokeWidth="0.5" />
        ))}
      {kind === "cells" &&
        Array.from({ length: 5 }, (_, row) =>
          Array.from({ length: 14 }, (_, col) => (
            <rect
              key={`${row}-${col}`}
              x={col * 7.2 + 0.6}
              y={row * 19 + 4}
              width="5.6"
              height="14"
              rx="1.6"
              fill="var(--c-seq-empty)"
            />
          )),
        )}
      {kind === "rings" && (
        <g fill="none" stroke="var(--hc-grid)" strokeWidth="4" vectorEffect="non-scaling-stroke">
          <circle cx="50" cy="50" r="38" />
          <circle cx="50" cy="50" r="27" />
          <circle cx="50" cy="50" r="16" />
        </g>
      )}
    </svg>
  );
}

/* ── accessible table twin ─────────────────────────────────────────────── */

export function SrTable({ columns, rows, caption }: ChartTable & { caption?: string }) {
  return (
    <div className="hc-sr-only">
      <table>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── axis primitives ───────────────────────────────────────────────────── */

export function GridLines({
  ticks,
  scale,
  x0,
  x1,
}: {
  ticks: number[];
  scale: (v: number) => number;
  x0: number;
  x1: number;
}) {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <line
          key={t}
          x1={x0}
          x2={x1}
          y1={scale(t)}
          y2={scale(t)}
          stroke="var(--hc-grid)"
          strokeWidth={MARK.hairline}
          shapeRendering="crispEdges"
        />
      ))}
    </g>
  );
}

export function YAxisLabels({
  ticks,
  scale,
  x,
  format,
}: {
  ticks: number[];
  scale: (v: number) => number;
  x: number;
  format: (v: number) => string;
}) {
  return (
    <g aria-hidden="true" style={AXIS_TEXT}>
      {ticks.map((t) => (
        <text key={t} x={x} y={scale(t)} dy="0.32em" textAnchor="end" fill="var(--hc-ink-3)">
          {format(t)}
        </text>
      ))}
    </g>
  );
}

export function XAxisLabels({
  ticks,
  scale,
  y,
  format,
  width,
}: {
  ticks: number[];
  scale: (v: number) => number;
  y: number;
  format: (v: number) => string;
  width: number;
}) {
  return (
    <g aria-hidden="true" style={AXIS_TEXT}>
      {ticks.map((t, i) => {
        const cx = scale(t);
        // Clamp the first and last labels inward so neither is cut off by the
        // frame — the alternative (dropping them) loses the period's bounds.
        const anchor = i === 0 && cx < 24 ? "start" : i === ticks.length - 1 && cx > width - 24 ? "end" : "middle";
        return (
          <text key={t} x={cx} y={y} dy="0.72em" textAnchor={anchor} fill="var(--hc-ink-3)">
            {format(t)}
          </text>
        );
      })}
    </g>
  );
}

/* ── style objects ─────────────────────────────────────────────────────── */
/* Inline so charts drop into any screen without a stylesheet dependency;
   every value is a token reference. */

const FIGURE: React.CSSProperties = { margin: 0, display: "flex", flexDirection: "column", gap: 10 };

const HEADER: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

const TITLE: React.CSSProperties = {
  font: "590 0.9375rem/1.25 var(--hc-font-sans)",
  letterSpacing: "-0.006em",
  color: "var(--hc-ink)",
};

const CAPTION: React.CSSProperties = {
  font: "400 0.8125rem/1.35 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
};

const FOOTER: React.CSSProperties = {
  font: "400 0.75rem/1.4 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
};

const LEGEND_LIST: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px 14px",
  listStyle: "none",
  margin: 0,
  padding: 0,
  font: "400 0.75rem/1 var(--hc-font-sans)",
  color: "var(--hc-ink-2)",
};

const LEGEND_ITEM: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const LEGEND_VALUE: React.CSSProperties = {
  color: "var(--hc-ink)",
  fontWeight: 590,
  fontVariantNumeric: "tabular-nums",
};

const EMPTY_WRAP: React.CSSProperties = {
  position: "relative",
  display: "grid",
  placeItems: "center",
  width: "100%",
  borderRadius: "var(--hc-radius-md)",
};

const GHOST: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  opacity: 0.45,
};

const EMPTY_CONTENT: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  textAlign: "center",
  maxWidth: "26ch",
  padding: "0 12px",
};

const EMPTY_TITLE: React.CSSProperties = {
  margin: 0,
  font: "590 0.875rem/1.3 var(--hc-font-sans)",
  color: "var(--hc-ink-2)",
};

const EMPTY_HINT: React.CSSProperties = {
  margin: 0,
  font: "400 0.8125rem/1.4 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
  textWrap: "balance",
};

const AXIS_TEXT: React.CSSProperties = {
  font: "400 0.6875rem/1 var(--hc-font-sans)",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.01em",
};
