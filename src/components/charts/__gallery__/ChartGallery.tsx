"use client";

import * as React from "react";
import "../chart-tokens.module.css";
import { BarChart } from "../BarChart";
import { HeatmapCalendar } from "../HeatmapCalendar";
import { LineChart } from "../LineChart";
import { MacroRing } from "../MacroRing";
import { RangeBar } from "../RangeBar";
import { Sparkline } from "../Sparkline";
import { StatTile } from "../StatTile";
import { formatNumber } from "../geometry";
import {
  TODAY,
  adherence,
  alcoholWeek,
  confidenceBand,
  energyBalance,
  macroWeek,
  movingAverage,
  readinessSeries,
  weighIns,
} from "./sample-data";

/**
 * Every chart, in every state that matters, with realistic data.
 *
 * Mount this anywhere (it is a plain component — no route of its own) to review
 * the chart layer. Empty states come FIRST in each section, because that is
 * what this app looks like on day one.
 */
export function ChartGallery() {
  const raw = React.useMemo(() => weighIns(84), []);
  const trend = React.useMemo(() => movingAverage(raw, 11), [raw]);
  const band = React.useMemo(() => confidenceBand(trend), [trend]);
  const balance = React.useMemo(() => energyBalance(42), []);
  const week = React.useMemo(() => macroWeek(), []);
  const logDays = React.useMemo(() => adherence(182), []);
  const alcohol = React.useMemo(() => alcoholWeek(), []);
  const readiness = React.useMemo(() => readinessSeries(30), []);

  return (
    <div style={PAGE}>
      <header style={PAGE_HEAD}>
        <h1 style={H1}>Chart primitives</h1>
        <p style={LEDE}>
          Hand-written SVG, no dependencies. Colours come from the app&apos;s semantic data tokens,
          so every chart follows the theme without a re-render.
        </p>
      </header>

      {/* ── the hero ────────────────────────────────────────────────────── */}
      <Section
        title="Weight trend"
        note="The hero chart. Raw weigh-ins recede; the smoothed trend and its uncertainty band carry the story. Days without a weigh-in are gaps, not zeros."
      >
        <Card>
          <LineChart
            title="Weight"
            caption="Last 12 weeks · drag across the chart to read a day"
            height={200}
            unit="kg"
            yFormat={(v) => formatNumber(v, 1)}
            series={[
              {
                id: "raw",
                label: "Daily weigh-in",
                color: "var(--c-neutral)",
                data: raw,
                kind: "scatter",
                muted: true,
              },
              {
                id: "trend",
                label: "Trend",
                color: "var(--c-weight)",
                data: trend,
                smooth: true,
                endLabel: true,
              },
            ]}
            band={{ id: "ci", label: "Uncertainty", color: "var(--c-weight)", data: band }}
            note="The trend is what to act on. A single weigh-in moves with water, salt and sleep. The raw dots stop where the scale was skipped; the trend spans it, because a trend is a model rather than an observation."
          />
        </Card>

        <Card>
          <LineChart
            title="Weight"
            caption="Nothing logged yet"
            height={160}
            empty={{
              title: "No weigh-ins yet",
              hint: "Log your weight each morning. The trend line appears after about ten days.",
            }}
            series={[]}
          />
        </Card>

        <Card>
          <LineChart
            title="Weight"
            caption="First week"
            height={160}
            unit="kg"
            yFormat={(v) => formatNumber(v, 1)}
            series={[
              { id: "raw", label: "Daily weigh-in", color: "var(--c-weight)", data: raw.slice(0, 4), kind: "scatter" },
            ]}
            note="Four weigh-ins so far. A trend needs about ten."
          />
        </Card>
      </Section>

      {/* ── energy ──────────────────────────────────────────────────────── */}
      <Section
        title="Energy balance"
        note="Two series, one axis. Intake is warm because it is the thing you control; expenditure is the algorithm's calm reference line. Intake breaks across unlogged days — drawing them as zero would invent a deficit that never happened."
      >
        <Card>
          <LineChart
            title="Calories in and out"
            caption="Last 6 weeks · six days unlogged"
            height={190}
            unit="kcal"
            series={[
              { id: "in", label: "Intake", color: "var(--c-calories)", data: balance.intake, smooth: true },
              {
                id: "out",
                label: "Expenditure",
                color: "var(--c-expenditure)",
                data: balance.expenditure,
                smooth: true,
              },
            ]}
          />
        </Card>
      </Section>

      {/* ── rings ───────────────────────────────────────────────────────── */}
      <Section
        title="Macro rings"
        note="Going past a target simply sends the ring round again in a lighter step of its own colour. Nothing turns red."
      >
        <Row>
          <Card>
            <MacroRing
              title="Today"
              rings={[
                { id: "kcal", label: "Calories", color: "var(--c-calories)", value: 1840, target: 2350, unit: "kcal" },
                { id: "p", label: "Protein", color: "var(--c-protein)", value: 128, target: 165, unit: "g" },
                { id: "c", label: "Carbs", color: "var(--c-carbs)", value: 186, target: 240, unit: "g" },
                { id: "f", label: "Fat", color: "var(--c-fat)", value: 54, target: 72, unit: "g" },
              ]}
            />
          </Card>
          <Card>
            <MacroRing
              title="Yesterday"
              caption="Protein and calories went past target"
              rings={[
                { id: "kcal", label: "Calories", color: "var(--c-calories)", value: 2680, target: 2350, unit: "kcal" },
                { id: "p", label: "Protein", color: "var(--c-protein)", value: 199, target: 165, unit: "g" },
                { id: "c", label: "Carbs", color: "var(--c-carbs)", value: 240, target: 240, unit: "g" },
                { id: "f", label: "Fat", color: "var(--c-fat)", value: 81, target: 72, unit: "g" },
              ]}
            />
          </Card>
          <Card>
            <MacroRing
              title="Today"
              rings={[
                { id: "kcal", label: "Calories", color: "var(--c-calories)", value: 0, unit: "kcal" },
                { id: "p", label: "Protein", color: "var(--c-protein)", value: 0, unit: "g" },
                { id: "c", label: "Carbs", color: "var(--c-carbs)", value: 0, unit: "g" },
                { id: "f", label: "Fat", color: "var(--c-fat)", value: 0, unit: "g" },
              ]}
            />
          </Card>
        </Row>
      </Section>

      {/* ── bars ────────────────────────────────────────────────────────── */}
      <Section
        title="Bars"
        note="Stacked for parts of a whole, grouped to compare. Tap a day to read it. Thursday was not logged — it shows a dashed tick, not an empty column that would read as a zero-calorie day."
      >
        <Card>
          <BarChart
            title="Macros this week"
            caption="Tap a day"
            mode="stacked"
            unit="g"
            categories={week.categories}
            series={[
              { id: "p", label: "Protein", color: "var(--c-protein)", values: week.protein },
              { id: "c", label: "Carbs", color: "var(--c-carbs)", values: week.carbs },
              { id: "f", label: "Fat", color: "var(--c-fat)", values: week.fat },
            ]}
          />
        </Card>
        <Card>
          <BarChart
            title="Alcohol this week"
            caption="Mostly a real, logged zero — Thursday is simply unlogged"
            mode="grouped"
            unit="g"
            categories={week.categories}
            series={[{ id: "a", label: "Alcohol", color: "var(--c-fiber)", values: alcohol }]}
            note="A logged zero draws a visible stub on the baseline. An unlogged day draws a dashed tick. They are different facts and they look different."
          />
        </Card>
        <Card>
          <BarChart
            title="Protein against target"
            mode="grouped"
            unit="g"
            categories={week.categories}
            target={{ value: 165, label: "Target" }}
            series={[{ id: "p", label: "Protein", color: "var(--c-protein)", values: week.protein }]}
          />
        </Card>
        <Card>
          <BarChart
            title="Macros this week"
            categories={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}
            series={[{ id: "p", label: "Protein", color: "var(--c-protein)", values: [] }]}
          />
        </Card>
      </Section>

      {/* ── stat tiles ──────────────────────────────────────────────────── */}
      <Section title="Stat tiles" note="Deltas are neutral by default — a number moving is information, not a verdict.">
        <Row>
          <StatTile
            label="Trend weight"
            value="81.6"
            unit="kg"
            delta={{ value: -0.42, period: "vs last week", unit: "kg" }}
            trend={trend.slice(-14).map((p) => p.y)}
            trendColor="var(--c-weight)"
          />
          <StatTile
            label="Expenditure"
            value={2634}
            unit="kcal"
            delta={{ value: 38, period: "vs 2 weeks ago" }}
            trend={balance.expenditure.slice(-14).map((p) => p.y)}
            trendColor="var(--c-expenditure)"
          />
          <StatTile
            label="Readiness"
            value={71}
            delta={{ value: 6, period: "vs yesterday", decimals: 0, tone: "up-is-good" }}
            trend={readiness.slice(-14).map((p) => p.y)}
            trendColor="var(--c-readiness)"
          />
          <StatTile label="Body fat" value={null} emptyHint="Add a measurement" />
        </Row>
      </Section>

      {/* ── sparklines ──────────────────────────────────────────────────── */}
      <Section title="Sparklines" note="An inline mark, not a chart. Under three points it draws dots instead of a line.">
        <Row>
          <SparkCell label="Trend">
            <Sparkline data={trend.slice(-20).map((p) => p.y)} color="var(--c-weight)" area />
          </SparkCell>
          <SparkCell label="Readiness">
            <Sparkline data={readiness.map((p) => p.y)} color="var(--c-readiness)" baseline={65} />
          </SparkCell>
          <SparkCell label="Two entries">
            <Sparkline data={[72, 74]} color="var(--c-protein)" />
          </SparkCell>
          <SparkCell label="Nothing yet">
            <Sparkline data={[]} />
          </SparkCell>
        </Row>
      </Section>

      {/* ── range bars ──────────────────────────────────────────────────── */}
      <Section title="Range bars" note="A value inside a target window, and stage composition.">
        <Card>
          <RangeBar
            label="Sleep last night"
            segments={[
              { id: "deep", label: "Deep", color: "var(--c-sleep-deep)", value: 78 },
              { id: "rem", label: "REM", color: "var(--c-sleep-rem)", value: 96 },
              { id: "core", label: "Core", color: "var(--c-sleep-core)", value: 214 },
              { id: "awake", label: "Awake", color: "var(--c-sleep-awake)", value: 22 },
            ]}
            unit="min"
          />
        </Card>
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <RangeBar
              label="Protein today"
              value={128}
              domain={[0, 220]}
              band={{ lo: 150, hi: 190 }}
              color="var(--c-protein)"
              unit="g"
              ticks={[0, 110, 220]}
            />
            <RangeBar
              label="Sleep duration"
              value={432}
              domain={[0, 600]}
              band={{ lo: 420, hi: 540 }}
              color="var(--c-sleep)"
              unit="min"
              ticks={[0, 300, 600]}
            />
            <RangeBar label="Resting heart rate" color="var(--c-readiness)" unit="bpm" emptyHint="No reading today" />
          </div>
        </Card>
      </Section>

      {/* ── heatmap ─────────────────────────────────────────────────────── */}
      <Section title="Consistency" note="Wide content scrolls inside its own container — the page never scrolls sideways.">
        <Card>
          <HeatmapCalendar
            title="Days logged"
            caption="Last 26 weeks · tap a square"
            values={logDays}
            end={TODAY}
            unit="entries"
          />
        </Card>
        <Card>
          <HeatmapCalendar title="Days logged" values={[]} end={TODAY} />
        </Card>
      </Section>
    </div>
  );
}

/* ── gallery chrome ────────────────────────────────────────────────────── */

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={SECTION}>
      <div style={SECTION_HEAD}>
        <h2 style={H2}>{title}</h2>
        {note && <p style={NOTE}>{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={CARD}>{children}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={ROW}>{children}</div>;
}

function SparkCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ ...CARD, display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={SPARK_LABEL}>{label}</span>
      {children}
    </div>
  );
}

const PAGE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 34,
  padding: "28px 16px 64px",
  maxWidth: 460,
  margin: "0 auto",
  background: "var(--hc-bg)",
  fontFamily: "var(--hc-font-sans)",
};

const PAGE_HEAD: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

const H1: React.CSSProperties = {
  margin: 0,
  font: "700 1.875rem/1.1 var(--hc-font-sans)",
  letterSpacing: "-0.028em",
  color: "var(--hc-ink)",
};

const LEDE: React.CSSProperties = {
  margin: 0,
  font: "400 0.9375rem/1.5 var(--hc-font-sans)",
  color: "var(--hc-ink-2)",
  textWrap: "balance",
};

const SECTION: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 12 };

const SECTION_HEAD: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };

const H2: React.CSSProperties = {
  margin: 0,
  font: "590 0.6875rem/1.2 var(--hc-font-sans)",
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--hc-ink-3)",
};

const NOTE: React.CSSProperties = {
  margin: 0,
  font: "400 0.8125rem/1.45 var(--hc-font-sans)",
  color: "var(--hc-ink-2)",
  textWrap: "balance",
};

const CARD: React.CSSProperties = {
  padding: 16,
  borderRadius: "var(--hc-radius-lg)",
  background: "var(--hc-surface)",
  boxShadow: "inset 0 0 0 1px var(--hc-line)",
};

const ROW: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
};

const SPARK_LABEL: React.CSSProperties = {
  font: "590 0.6875rem/1.2 var(--hc-font-sans)",
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--hc-ink-3)",
};
