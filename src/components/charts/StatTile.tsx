"use client";

import * as React from "react";
import "./chart-tokens.module.css";
import { Sparkline } from "./Sparkline";
import { formatCompact, formatSigned, type Point } from "./geometry";

/**
 * How a change should be read.
 *
 * `neutral` is the default and the right answer almost everywhere in this app:
 * a number moving is information, not a verdict. Only opt into a judged tone
 * where the direction genuinely has a safety meaning (a readiness collapse,
 * a missed protein floor) — never for body weight, calories, or anything a
 * person could read as a scolding.
 */
export type DeltaTone = "neutral" | "up-is-good" | "down-is-good";

export type StatTileDelta = {
  value: number;
  /** Names the comparison: "vs last week". Required — a bare delta is unreadable. */
  period: string;
  unit?: string;
  decimals?: number;
  tone?: DeltaTone;
};

export type StatTileProps = {
  /** Sentence case, no trailing colon. */
  label: string;
  /** Pass a preformatted string to control units and precision yourself. */
  value: number | string | null | undefined;
  unit?: string;
  delta?: StatTileDelta;
  /** ~12 points reads best at tile width. */
  trend?: readonly number[] | readonly Point[];
  /** Colour of the sparkline. Defaults to the neutral series colour. */
  trendColor?: string;
  /** Shown in place of the value when there is no data yet. */
  emptyHint?: string;
  /** Renders as a tappable tile. */
  onClick?: () => void;
  /** Drop the card chrome — for tiles already inside a card. */
  bare?: boolean;
  className?: string;
  /** Extra content under the value (a chip, a target). */
  children?: React.ReactNode;
};

export function StatTile({
  label,
  value,
  unit,
  delta,
  trend,
  trendColor = "var(--c-neutral)",
  emptyHint = "No data yet",
  onClick,
  bare = false,
  className,
  children,
}: StatTileProps) {
  const hasValue = value !== null && value !== undefined && value !== "";
  const display = typeof value === "number" ? formatCompact(value) : value;

  const body = (
    <>
      <span style={LABEL}>{label}</span>

      {hasValue ? (
        <span style={VALUE_ROW}>
          <span style={VALUE}>{display}</span>
          {unit && <span style={UNIT}>{unit}</span>}
        </span>
      ) : (
        <span style={EMPTY}>{emptyHint}</span>
      )}

      {hasValue && delta && <DeltaLine delta={delta} />}
      {children}

      {trend && trend.length > 0 && (
        <span style={TREND}>
          <Sparkline data={trend} color={trendColor} width={104} height={26} endDot />
        </span>
      )}
    </>
  );

  const style: React.CSSProperties = bare ? BARE : TILE;

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} style={{ ...style, ...TAPPABLE }}>
        {body}
      </button>
    );
  }
  return (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

function DeltaLine({ delta }: { delta: StatTileDelta }) {
  const tone = delta.tone ?? "neutral";
  const text = formatSigned(delta.value, delta.decimals ?? 1);
  const arrow = delta.value > 0 ? "↑" : delta.value < 0 ? "↓" : "→";

  let color = "var(--hc-ink-2)";
  if (tone !== "neutral" && delta.value !== 0) {
    const good = tone === "up-is-good" ? delta.value > 0 : delta.value < 0;
    // Only the positive direction is ever tinted. The other direction stays
    // ink — nothing in this app colours a number to signal that you did badly.
    color = good ? "var(--hc-good)" : "var(--hc-ink-2)";
  }

  return (
    <span style={{ ...DELTA, color }}>
      <span aria-hidden="true">{arrow}</span>
      <span>
        {text}
        {delta.unit ? ` ${delta.unit}` : ""}
      </span>
      <span style={DELTA_PERIOD}>{delta.period}</span>
    </span>
  );
}

/* ── styles ────────────────────────────────────────────────────────────── */

const TILE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 3,
  padding: "14px 16px 12px",
  borderRadius: "var(--hc-radius-lg)",
  background: "var(--hc-surface)",
  boxShadow: "inset 0 0 0 1px var(--hc-line)",
  fontFamily: "var(--hc-font-sans)",
  textAlign: "left",
  minWidth: 0,
};

const BARE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 3,
  fontFamily: "var(--hc-font-sans)",
  textAlign: "left",
  minWidth: 0,
};

const TAPPABLE: React.CSSProperties = {
  minHeight: 44,
  border: 0,
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
  appearance: "none",
  width: "100%",
};

const LABEL: React.CSSProperties = {
  font: "590 0.6875rem/1.2 var(--hc-font-sans)",
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--hc-ink-3)",
};

const VALUE_ROW: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 4 };

/* Proportional figures on purpose: tabular-nums makes a large standalone
   number look loose. Columns of numbers get tabular; hero values do not. */
const VALUE: React.CSSProperties = {
  font: "590 2.375rem/1.02 var(--hc-font-sans)",
  letterSpacing: "-0.028em",
  color: "var(--hc-ink)",
};

const UNIT: React.CSSProperties = {
  font: "400 0.875rem/1 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
};

const EMPTY: React.CSSProperties = {
  font: "400 0.9375rem/1.3 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
  paddingBlock: "10px 6px",
};

const DELTA: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: 5,
  font: "510 0.8125rem/1.2 var(--hc-font-sans)",
  fontVariantNumeric: "tabular-nums",
};

const DELTA_PERIOD: React.CSSProperties = {
  color: "var(--hc-ink-3)",
  fontWeight: 400,
};

const TREND: React.CSSProperties = { marginTop: 6, display: "block" };
