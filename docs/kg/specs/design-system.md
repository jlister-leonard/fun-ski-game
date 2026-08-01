# Design system — chart layer (F4)

**Owner of this section:** design-system agent (charts).
**Owner of the token and UI-primitive sections:** the design-system owner writing
`src/app/globals.css` and `src/components/ui/**`. This file currently documents the
**chart layer only**; add the token/primitive sections above or below it.

**Status:** shipped. `npx tsc --noEmit` and `npm run lint` are clean for
`src/components/charts/**`; `next build` compiles.

---

## 1. What exists

`src/components/charts/` — hand-written SVG, **zero dependencies**.

| Component | File | Job |
|---|---|---|
| `LineChart` | `LineChart.tsx` | Time series. Raw scatter + smoothed trend + uncertainty band, reference lines, drag-to-read. |
| `BarChart` | `BarChart.tsx` | Stacked or grouped columns. Daily macros, protein vs target. |
| `MacroRing` | `MacroRing.tsx` | Concentric progress rings — calories + the macro triad. |
| `Sparkline` | `Sparkline.tsx` | Inline mark, no axes. Used inside `StatTile` and list rows. |
| `StatTile` | `StatTile.tsx` | Big number + delta + optional sparkline. |
| `HeatmapCalendar` | `HeatmapCalendar.tsx` | Day-grid consistency/streaks. |
| `RangeBar` | `RangeBar.tsx` | A value inside a target window, or a stage composition (sleep). |
| `ChartFrame` | `ChartFrame.tsx` | Shared frame: title, caption, legend, empty state, scroll container, accessible table. |
| geometry | `geometry.ts` | Pure scales, ticks, path builders, formatters. No DOM, no React. |
| tokens | `chart-tokens.module.css` | Bridge from app tokens to chart chrome; fills in data colours the app has not defined. |
| gallery | `__gallery__/ChartGallery.tsx` | Every chart in every state, with deterministic sample data. |

Import from the barrel:

```ts
import { LineChart, MacroRing, StatTile, BarChart, Sparkline, HeatmapCalendar, RangeBar } from "@/components/charts";
import type { LineSeries, Point } from "@/components/charts";
```

---

## 2. Semantic data colours

Charts **never contain a hex.** Every mark is `fill`/`stroke` = a CSS custom
property, so a theme change repaints with no re-render and no JavaScript.

### 2.1 Owned by `src/app/globals.css`

| Token | Domain |
|---|---|
| `--c-protein` | Protein |
| `--c-carbs` | Carbohydrate |
| `--c-fat` | Fat |
| `--c-calories` | Calories / energy **in** |
| `--c-fiber` | Fibre |
| `--c-sleep` | Sleep |
| `--c-readiness` | Readiness, HRV, recovery |
| `--c-strain` | Training strain / load |
| `--c-neutral-data` | Comparison / "everything else" |

### 2.2 Declared by the chart layer (move them into `globals.css` freely — an
unlayered declaration there always wins)

| Token | Domain | Why it exists |
|---|---|---|
| `--c-expenditure` | Energy **out** / adaptive TDEE | Low-chroma steel on purpose. It is the algorithm's reference line, not a peer series — the "emphasis" pattern (highlight one, recede the rest). Pairs with the warm `--c-calories` so *in* reads warm and *out* reads cool. |
| `--c-weight` | Body-weight trend | Aliases `--c-accent`: the hero series wears the brand colour. |
| `--c-neutral` | Alias of `--c-neutral-data` | Shorter name used inside charts. |
| `--c-seq-1` … `--c-seq-5` | Sequential ramp (magnitude) | One hue, light→dark. Heatmap intensity. Never a rainbow. |
| `--c-seq-empty` | "No data" heatmap cell | A neutral, never step 1 of the ramp. |
| `--c-sleep-awake`, `--c-sleep-rem`, `--c-sleep-core`, `--c-sleep-deep` | Sleep stages | **Ordinal**: one hue, monotone lightness, so the order reads in the colour. |

### 2.3 Validated co-plot groups

The `dataviz` skill's checks apply to *sets of marks that can touch*, not to the
token list as a whole. These are the sets that were validated. Plotting across
groups in one chart is **not** validated — facet instead.

| Group | Series | Rule |
|---|---|---|
| **Nutrition** | protein · carbs · fat · calories | all-pairs (rings and stacks put any two beside each other) |
| **Recovery** | sleep · readiness · strain | all-pairs |
| **Energy balance** | calories · expenditure | two series |

Status of the app palette against those groups, re-measured with
`dataviz/scripts/validate_palette.js` after the July 2026 re-stepping (OKLab
ΔE ×100, Machado 2009 at severity 1.0, against this app's own surfaces):

| Group / mode | Band | Chroma | CVD | Normal-vision | Contrast |
|---|---|---|---|---|---|
| Nutrition · dark (`#141922`) | pass | pass | 9.9 pass | 18.3 pass | pass |
| Nutrition · light (`#ffffff`) | pass | pass | **6.5 WARN** (calories↔protein) | 18.6 pass | pass |
| Recovery · dark | pass | pass | 11.8 pass | 18.8 pass | pass |
| Recovery · light | pass | **0.098 FAIL** (readiness) | 14.0 pass | 20.7 pass | pass |

Two notes:

1. The light-mode nutrition **CVD WARN is legal but conditional**: a 6–8 ΔE pair
   ships only with secondary encoding. Charts supply it unconditionally — a
   legend is always present for ≥2 series and `MacroRing` direct-labels every
   ring. Do not build a light-mode nutrition chart that drops both.
2. `--c-readiness` light (`#0f8f93`) sits at chroma 0.098, a hair under the 0.10
   floor — below it a hue starts reading as grey. **`#008f94` fixes it**: same
   hue and lightness, chroma 0.1004, and the whole recovery light group then
   passes every check (CVD 14.0, normal-vision 20.7, contrast 3.92:1). One-line
   change in `globals.css`, no other value moves.

The earlier collision (`--c-calories` = `--c-readiness` = `--c-accent`) and the
dark-mode lightness-band failures are **resolved** — readiness moved to teal and
the dark steps were re-stepped into the band.

### 2.4 Colour rules charts follow

- **Categorical** = identity, fixed assignment. Colour follows the entity, never
  its rank — filtering a series out never repaints the survivors.
- **Sequential** = one hue, light→dark, for magnitude only.
- **Ordinal** (sleep stages, tiers) = one hue with monotone lightness steps.
- **Never a dual-axis chart.** Two measures of different scale get two charts.
- **Text never wears the data colour.** Values, labels and legends use ink
  tokens; a coloured mark beside the text carries identity.
- **Status colour is reserved.** A series that merely *is* series 4 never wears
  `--c-warn` / `--c-danger`.

### 2.5 Safety rule — this one is not negotiable

> **No chart ever renders "over target" in a negative colour, and no chart makes
> a larger deficit look like a better score.**

The user has disclosed suspected ARFID. Red-for-exceeded produces guilt and
shame responses. Concretely, in this layer:

- `MacroRing` past 100% sends the ring **round again in a lighter step of its
  own colour**. Nothing turns red; the legend reads `199 / 165 g` in ink.
- `RangeBar`'s target window is a quiet grey inset. Being outside it is
  information, not a verdict.
- `StatTile` deltas default to `tone: "neutral"` — ink, with a direction arrow.
  The `up-is-good` / `down-is-good` tones only ever tint the **positive**
  direction; the other direction stays ink. Do not use a judged tone for body
  weight, calories, or macro adherence.
- `BarChart`'s `target` is a dashed hairline, never a fill that bars "break".

---

## 2.6 Missing data is a discontinuity, not a zero

> **`null` means the day was not logged. `0` means it was logged and the value
> was zero. These are different facts and they never render the same way.**

This is a correctness rule, not a styling one. Drawing an unlogged day as zero
intake invents a calorie deficit that never happened, and it interacts directly
with the eating-disorder-aware rules in §2.5 — a chart that dips to the axis on
a day nothing was recorded visually rewards not eating.

How each chart handles it:

| Chart | `null` — not logged | `0` — a logged zero |
|---|---|---|
| `LineChart` | path breaks; no mark; excluded from the y-domain; readout says "not logged"; an isolated observation between two gaps still gets a ringed dot | plotted on the baseline like any other value |
| `BarChart` | no bar; a **dashed baseline tick** marks the absence; excluded from totals | a **2px stub** in the series colour, so "logged, and it was zero" is visible |
| `Sparkline` | line breaks; index position preserved so the gap keeps its width | plotted normally |
| all | table twin reads `not logged`; `aria-label` reports the count of unlogged days | table twin reads `0` |

Types (`geometry.ts`):

```ts
type Point    = { x: number; y: number };
type GapPoint = { x: number; y: number | null | undefined };   // NaN counts as a gap

hasValue(p: GapPoint): p is Point      // 0 → true, null → false
isValue(v): v is number                // same test for a raw value
splitRuns(data): Point[][]             // contiguous observed runs, for one path each
observed(data): Point[]                // observations only, for the domain
halfSpacing(data): number              // readout tolerance (median interval / 2)
```

`Point[]` is assignable to `GapPoint[]`, so callers with dense data need no change.

**A trend may legitimately span a gap.** The raw series breaks; a smoothed trend
is a model and stays continuous across a missed weigh-in. The gallery shows both
in the same chart.

Verified by `src/components/charts/geometry.verify.mjs` (11 assertions):

```
node --experimental-strip-types src/components/charts/geometry.verify.mjs
```

It asserts, among others, that a gappy series and the same series with the gaps
removed produce an **identical y-domain** — the regression test for the spikes
bug.

## 2.7 Zero-anchoring

Audited; nothing is wrongly anchored:

| Chart | y-domain | Correct? |
|---|---|---|
| `LineChart` | `padDomain(observed extent)` — 8% headroom, never zero-anchored | yes — weight and expenditure keep their vertical resolution |
| `Sparkline` | `padDomain(observed extent, 0.12)` | yes |
| `BarChart` | `[0, yTop]` | yes — **deliberate**. Bar length encodes magnitude from a common baseline; a non-zero baseline on bars is a lie about proportion. |
| `RangeBar` | caller-supplied `domain` | caller's choice |

Pass `yDomain` to `LineChart` only when a fixed scale is genuinely wanted.

## 3. Mark specs

Fixed across every chart (`MARK` in `geometry.ts`), so nothing drifts:

| Mark | Spec |
|---|---|
| Line | 2px, round cap/join |
| Bar/column | ≤ 24px thick, 4px rounded data-end, square at the baseline |
| Marker / end-dot | 8px diameter, filled, with a 2px ring in the surface colour |
| Raw scatter dot | 3px radius, 50–75% opacity — a texture under the trend, not marks to hit |
| Area / band fill | series hue at 10% opacity |
| Gridlines & axes | 1px **solid** hairline, one step off the surface. Never dashed. |
| Gap between touching fills | 2px in the surface colour — never a stroke around a mark |
| Minimum hit target | 24px; bar hit areas span the whole band and the full plot height |

Smoothing is **monotone cubic** (Fritsch–Carlson), not Catmull–Rom: it cannot
overshoot, so a smoothed weight trend never draws a dip that is not in the data.

---

## 4. Layout rules on a 390px phone

- **Nothing overflows the viewport.** `BarChart` and `HeatmapCalendar` set a
  `minWidth`; when the content is wider than the container it scrolls inside its
  own `.hc-chart-scroll` element (momentum on, `overscroll-behavior-x: contain`,
  scrollbar hidden). The page body never scrolls sideways.
- **Axis labels are budgeted, not hoped for.** `labelBudget(px)` computes how
  many x labels fit; `thin()` reduces the tick list to that many, always keeping
  the first and last. First/last labels anchor inward so neither is clipped.
- **The y-axis inset is measured** from the longest formatted tick, so "2,400"
  and "81.6" both get the room they need and no more.
- **The container reserves the axis band**, so a chart card never grows a tiny
  nested scrollbar because the x labels didn't fit.
- **A label that will not fit is not drawn.** `LineChart`'s end label measures
  first and falls back to the legend + table rather than clipping.
- `touch-action: pan-y` on every plot: vertical page scroll keeps working while
  a finger is on a chart.

---

## 5. Empty and thin-data states

Designed first, because day one has no data.

Every chart takes `empty?: Partial<EmptyStateProps>` — `{ title, hint, action, ghost }`.
The default copy is written for a real first-run user; override it with
something screen-specific where you can.

```tsx
<LineChart
  series={[]}
  empty={{
    title: "No weigh-ins yet",
    hint: "Log your weight each morning. The trend line appears after about ten days.",
    action: <Button size="sm">Log weight</Button>,
  }}
/>
```

- `ghost` draws a faint placeholder behind the message — `"lines"`, `"rings"`,
  `"cells"` or `"none"` — so the space reads as a chart that is **waiting**, not
  a broken box. Each chart picks a sensible default.
- Thin data degrades rather than failing: `Sparkline` draws dots below three
  points; `LineChart` renders a single point as a ringed dot; use the `note`
  prop for the caveat ("Four weigh-ins so far. A trend needs about ten.").
- Copy rules: name what is missing, then one sentence on how to fix it. No
  apology, no exclamation mark, no blame.

---

## 6. Accessibility

- Every chart renders an **`sr-only` table twin** containing every plotted
  value. A tooltip or scrub readout never gates a number.
- `role="img"` plus an `aria-label` that summarises the latest value per series
  and points at the table.
- `LineChart` is keyboard operable: `Tab` to focus, `←`/`→` to move the readout,
  `Esc` to clear. Focus shows the same information as a pointer would.
- The scrub readout sits **above** the plot in an `aria-live="polite"` region —
  Apple-Health-style. It cannot collide with the marks, and it needs no
  tooltip-positioning logic.
- `:focus-visible` draws a 2px ring in `--hc-focus`; `:focus` alone does not.
- `prefers-reduced-motion: reduce` collapses all chart transitions.

---

## 7. Component API

Common to `LineChart`, `BarChart`, `MacroRing`, `HeatmapCalendar`:
`title`, `caption`, `height`, `empty`, `className`, and an sr-only table.

### LineChart

```ts
type LineSeries = {
  id: string; label: string; color: string;   // color is always var(--c-…)
  data: { x: number; y: number | null }[];    // null = not logged (see §2.6)
  kind?: "line" | "scatter" | "area";
  smooth?: boolean;        // monotone cubic
  dashed?: boolean;        // reserved for targets
  muted?: boolean;         // thinner + lower opacity (raw data under a trend)
  endLabel?: boolean;      // value at the line end
  skipReadout?: boolean;   // excluded from the scrub readout
};

<LineChart
  series={LineSeries[]}
  band={{ id, label, color, data: { x, lo, hi }[] }}   // uncertainty / target band
  refLines={{ id, value, label?, color? }[]}
  height={190} unit="kg"
  yDomain={[min, max]} yTickCount={4}
  yFormat={fn} xFormat={fn} xReadoutFormat={fn}
  note={ReactNode} scrub={true} scatterRadius={3}
/>
```

The hero pattern (weight):

```tsx
<LineChart
  title="Weight" unit="kg" yFormat={(v) => formatNumber(v, 1)}
  series={[
    { id: "raw",   label: "Daily weigh-in", color: "var(--c-neutral)", data: raw,   kind: "scatter", muted: true },
    { id: "trend", label: "Trend",         color: "var(--c-weight)",  data: trend, smooth: true, endLabel: true },
  ]}
  band={{ id: "ci", label: "Uncertainty", color: "var(--c-weight)", data: band }}
/>
```

Raw weigh-ins recede to a neutral texture; the trend and its band carry the
story. `trend` and `band` come from `lib/weight-trend` (A1) — the chart does no
smoothing of its own.

Pass `y: null` for a day with no weigh-in. The raw series breaks there; the
trend, being a model, stays continuous. Never pass `0`.

### BarChart

```ts
<BarChart
  categories={string[]}
  series={{ id, label, color, values: (number|null)[] }[]}   // null = not logged, 0 = a logged zero
  mode="stacked" | "grouped"
  target={{ value, label?, color? }}     // dashed hairline, never a fill
  unit="g" minBandWidth={34} yFormat={fn} note={ReactNode}
/>
```

### MacroRing

```ts
<MacroRing
  rings={{ id, label, color, value, target?, unit?, decimals? }[]}   // outermost first
  size={184} thickness={13} gap={6}
  center={ReactNode}       // defaults to the first ring's value / target
  showLegend={true}
/>
```

### StatTile

```ts
<StatTile
  label="Trend weight" value={81.6} unit="kg"
  delta={{ value: -0.42, period: "vs last week", unit: "kg", tone: "neutral" }}
  trend={number[] | Point[]} trendColor="var(--c-weight)"
  emptyHint="Add a measurement" onClick={fn} bare={false}
/>
```

`value` accepts `null`/`undefined` and renders `emptyHint`. Pass a preformatted
string when you need to control precision.

### Sparkline

```ts
<Sparkline data={number[] | Point[]} color="var(--c-readiness)"
  width={88} height={28} area smooth endDot baseline={65} ariaLabel="…" />
```

### HeatmapCalendar

```ts
<HeatmapCalendar
  values={{ date: number; value: number }[]}
  start={ms} end={ms}        // pass Date.now() for end — see below
  scale={string[]} max={number}
  cellSize={13} cellGap={3} unit="entries" format={fn}
/>
```

`end` is **not** defaulted to `Date.now()`: reading the clock during render
desyncs a statically pre-rendered page. Pass it from the screen. Without it the
grid ends at the most recent value.

### RangeBar

Two shapes in one component:

```tsx
// composition (sleep stages)
<RangeBar label="Sleep last night" unit="min"
  segments={[{ id: "deep", label: "Deep", color: "var(--c-sleep-deep)", value: 78 }, …]} />

// a value inside a target window
<RangeBar label="Protein today" value={128} domain={[0, 220]}
  band={{ lo: 150, hi: 190 }} color="var(--c-protein)" unit="g" ticks={[0, 110, 220]} />
```

---

## 8. Reviewing the work

`ChartGallery` is a plain component — no route of its own, per the working
agreement:

```tsx
import { ChartGallery } from "@/components/charts/__gallery__/ChartGallery";
```

Mount it anywhere. It renders every chart in every state (empty state first)
with deterministic seeded sample data, so it looks identical on every reload.
