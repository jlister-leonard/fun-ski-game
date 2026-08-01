"use client";

import * as React from "react";
import { ChartFrame, type ChartTable, type EmptyStateProps, type LegendItem } from "./ChartFrame";
import { formatCompact, formatNumber, ringArc } from "./geometry";

export type MacroRingDatum = {
  id: string;
  /** "Protein", "Carbs", "Fat", "Calories". */
  label: string;
  /** A `var(--c-…)` reference. Never a literal colour. */
  color: string;
  value: number;
  /** 0 or undefined renders the track only — no target set yet. */
  target?: number;
  unit?: string;
  /** Decimals for the legend value. */
  decimals?: number;
};

export type MacroRingProps = {
  /** Outermost ring first. Calories outside, macros inside, reads best. */
  rings: MacroRingDatum[];
  /** Outer diameter in px. Clamped to the container width. */
  size?: number;
  /** Ring stroke width in px. */
  thickness?: number;
  /** Gap between rings, in px — the surface doing the separating. */
  gap?: number;
  /** Replaces the default centre readout. */
  center?: React.ReactNode;
  title?: React.ReactNode;
  caption?: React.ReactNode;
  empty?: Partial<EmptyStateProps>;
  className?: string;
  /** Legend on by default; turn off when the rings sit beside their own list. */
  showLegend?: boolean;
};

export function MacroRing({
  rings,
  size = 184,
  thickness = 13,
  gap = 6,
  center,
  title,
  caption,
  empty,
  className,
  showLegend = true,
}: MacroRingProps) {
  const hasAnything = rings.some((ring) => ring.value > 0 || (ring.target ?? 0) > 0);

  const legend: LegendItem[] | undefined = showLegend
    ? rings.map((ring) => ({
        id: ring.id,
        label: ring.label,
        color: ring.color,
        mark: "swatch" as const,
        value: legendValue(ring),
      }))
    : undefined;

  const table: ChartTable = {
    columns: ["Nutrient", "Logged", "Target", "Share of target"],
    rows: rings.map((ring) => [
      ring.label,
      `${formatNumber(ring.value, ring.decimals ?? 0)}${ring.unit ? ` ${ring.unit}` : ""}`,
      ring.target ? `${formatNumber(ring.target, ring.decimals ?? 0)}${ring.unit ? ` ${ring.unit}` : ""}` : "not set",
      ring.target ? `${Math.round((ring.value / ring.target) * 100)}%` : "—",
    ]),
  };

  const emptyState: EmptyStateProps | null = !hasAnything
    ? {
        title: empty?.title ?? "No targets yet",
        hint: empty?.hint ?? "Set your daily targets and today's rings start filling as you log.",
        action: empty?.action,
        ghost: empty?.ghost ?? "rings",
      }
    : null;

  return (
    <ChartFrame
      title={title}
      caption={caption}
      legend={legend}
      height={size}
      table={table}
      empty={emptyState}
      className={className}
    >
      {({ width }) => {
        const d = Math.max(96, Math.min(size, width));
        const c = d / 2;
        const primary = rings[0];

        return (
          <div style={{ display: "grid", placeItems: "center", height: size, position: "relative" }}>
            <svg
              width={d}
              height={d}
              viewBox={`0 0 ${d} ${d}`}
              role="img"
              aria-label={ariaSummary(rings)}
              style={{ display: "block" }}
            >
              {rings.map((ring, i) => {
                const radius = c - thickness / 2 - i * (thickness + gap);
                if (radius <= thickness) return null;
                const share = ring.target ? ring.value / ring.target : 0;
                const firstLap = Math.min(1, Math.max(0, share));
                // Past 100% the ring simply goes round again in a lighter step
                // of its own colour. Exceeding a target is information, never a
                // failure — nothing here turns red and nothing shouts.
                const secondLap = Math.min(1, Math.max(0, share - 1));

                return (
                  <g key={ring.id}>
                    <circle
                      cx={c}
                      cy={c}
                      r={radius}
                      fill="none"
                      stroke="var(--hc-surface-inset)"
                      strokeWidth={thickness}
                    />
                    {firstLap > 0 && (
                      <path
                        d={ringArc(c, c, radius, 0, firstLap)}
                        fill="none"
                        stroke={ring.color}
                        strokeWidth={thickness}
                        strokeLinecap={firstLap >= 1 ? "butt" : "round"}
                      />
                    )}
                    {secondLap > 0 && (
                      <path
                        d={ringArc(c, c, radius, 0, secondLap)}
                        fill="none"
                        stroke={`color-mix(in oklab, ${ring.color} 42%, var(--hc-surface))`}
                        strokeWidth={thickness}
                        strokeLinecap="round"
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            <div style={CENTER}>
              {center ?? (primary ? <DefaultCentre ring={primary} /> : null)}
            </div>
          </div>
        );
      }}
    </ChartFrame>
  );
}

function DefaultCentre({ ring }: { ring: MacroRingDatum }) {
  return (
    <>
      <span style={CENTER_VALUE}>{formatCompact(ring.value)}</span>
      <span style={CENTER_SUB}>
        {ring.target ? `of ${formatCompact(ring.target)}` : "logged"}
        {ring.unit ? ` ${ring.unit}` : ""}
      </span>
    </>
  );
}

function legendValue(ring: MacroRingDatum): string {
  const decimals = ring.decimals ?? 0;
  const logged = formatNumber(ring.value, decimals);
  if (!ring.target) return `${logged}${ring.unit ? ` ${ring.unit}` : ""}`;
  return `${logged} / ${formatNumber(ring.target, decimals)}${ring.unit ? ` ${ring.unit}` : ""}`;
}

function ariaSummary(rings: MacroRingDatum[]): string {
  return `Progress rings. ${rings
    .map((ring) =>
      ring.target
        ? `${ring.label} ${formatNumber(ring.value, ring.decimals ?? 0)} of ${formatNumber(
            ring.target,
            ring.decimals ?? 0,
          )}${ring.unit ? ` ${ring.unit}` : ""}`
        : `${ring.label} ${formatNumber(ring.value, ring.decimals ?? 0)}${ring.unit ? ` ${ring.unit}` : ""}, no target set`,
    )
    .join(". ")}. Full values are in the table that follows.`;
}

const CENTER: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 1,
  pointerEvents: "none",
  textAlign: "center",
};

const CENTER_VALUE: React.CSSProperties = {
  font: "590 1.875rem/1 var(--hc-font-sans)",
  letterSpacing: "-0.022em",
  color: "var(--hc-ink)",
};

const CENTER_SUB: React.CSSProperties = {
  font: "400 0.75rem/1.2 var(--hc-font-sans)",
  color: "var(--hc-ink-3)",
};
