/**
 * Chart geometry — pure, dependency-free.
 *
 * Nothing in here touches the DOM or React. Scales, tick selection, path
 * builders and number formatting live together so every chart draws marks the
 * same way and axis labels are chosen by the same rules.
 */

export type Point = { x: number; y: number };

/**
 * A point that may have no value.
 *
 * `y: null` (or `undefined`, or `NaN`) means **no data for this x** — the day
 * was not logged. It is NOT zero. Charts break the line, plot no mark, and
 * leave it out of the y-domain. A genuine `y: 0` is a real observation (a
 * logged fast, a day with no alcohol) and is plotted on the baseline like any
 * other value.
 *
 * This is not cosmetic: drawing an unlogged day as zero intake invents a
 * deficit that never happened.
 */
export type GapPoint = { x: number; y: number | null | undefined };

export type BandPoint = { x: number; lo: number; hi: number };
export type Domain = [number, number];

/** True when a point carries a real observation. */
export function hasValue(p: GapPoint): p is Point {
  return typeof p.y === "number" && Number.isFinite(p.y);
}

/** True when a raw value is a real observation (`0` counts, `null` does not). */
export function isValue(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Split a series into contiguous runs of observed points. Each run is drawn as
 * its own path, so the line breaks across a gap instead of interpolating over
 * it. Runs of length 1 are kept — an isolated observation still deserves a dot.
 */
export function splitRuns(data: readonly GapPoint[]): Point[][] {
  const runs: Point[][] = [];
  let current: Point[] = [];
  for (const p of data) {
    if (hasValue(p)) {
      current.push({ x: p.x, y: p.y });
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

/** Only the observed points, in order. */
export function observed(data: readonly GapPoint[]): Point[] {
  return data.filter(hasValue).map((p) => ({ x: p.x, y: p.y }));
}

/**
 * Half the median spacing of a series — the window inside which a readout may
 * borrow a neighbouring point's value. Beyond it, the honest answer is "—".
 */
export function halfSpacing(data: readonly GapPoint[]): number {
  const xs = data.map((p) => p.x).sort((a, b) => a - b);
  if (xs.length < 2) return Infinity;
  const gaps: number[] = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] / 2;
}

export type Insets = { top: number; right: number; bottom: number; left: number };

/** Mark specs from the dataviz skill — fixed across every chart in the app. */
export const MARK = {
  /** Line stroke, px. */
  line: 2,
  /** Minimum diameter of a marker/end-dot, px (r >= 4). */
  marker: 8,
  /** Radius of a raw-observation scatter dot, px. */
  scatter: 2.5,
  /** Surface-coloured ring around overlapping marks, px. */
  ring: 2,
  /** Gap in the surface colour between touching fills, px. */
  gap: 2,
  /** Bars never fill their band; this is the hard cap, px. */
  barMax: 24,
  /** Rounded data-end on a bar, px. */
  barCap: 4,
  /** Area/band wash opacity. */
  wash: 0.1,
  /** Hairline grid + axis stroke, px. */
  hairline: 1,
  /** Minimum pointer/keyboard hit target, px. */
  hit: 24,
} as const;

/* ── scales ────────────────────────────────────────────────────────────── */

export function linearScale(domain: Domain, range: Domain) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

export function extent(values: readonly number[]): Domain | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : [min, max];
}

/**
 * Pad a domain so marks never touch the frame. A flat series (min === max)
 * gets a synthetic span so it renders as a centred line rather than a
 * degenerate one.
 */
export function padDomain([min, max]: Domain, fraction = 0.08): Domain {
  if (min === max) {
    const bump = Math.abs(min) > 1 ? Math.abs(min) * 0.02 : 1;
    return [min - bump, max + bump];
  }
  const pad = (max - min) * fraction;
  return [min - pad, max + pad];
}

/* ── ticks ─────────────────────────────────────────────────────────────── */

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** A "nice" step at or above `raw` — 1/2/2.5/5 × a power of ten. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  for (const s of NICE_STEPS) if (norm <= s) return s * mag;
  return 10 * mag;
}

/**
 * Ticks on round numbers inside `domain`. `count` is a target, not a promise —
 * the step is snapped to a nice value, which is what keeps 0 / 1,000 / 2,000
 * on the axis instead of 0 / 1,143 / 2,286.
 */
export function niceTicks(domain: Domain, count = 4): number[] {
  const [min, max] = domain;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const step = niceStep((max - min) / Math.max(1, count));
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  // Guard against float drift accumulating across many steps.
  for (let i = 0; start + i * step <= max + step * 1e-6; i++) {
    out.push(roundToStep(start + i * step, step));
    if (out.length > 24) break;
  }
  return out;
}

function roundToStep(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(10, decimals)));
}

/**
 * How many x labels fit without collision. Every axis label in this app is
 * measured against a budget rather than laid out and hoped for: at 390px the
 * plot is ~330px wide, which is four "Mar 14"-sized labels, not eight.
 */
export function labelBudget(pixelWidth: number, approxLabelWidth = 62): number {
  return Math.max(2, Math.floor(pixelWidth / approxLabelWidth));
}

/** Evenly thin `items` down to at most `max`, always keeping first and last. */
export function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return [items[items.length - 1]];
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
  return Array.from(new Set(out));
}

/* ── paths ─────────────────────────────────────────────────────────────── */

type XY = { cx: number; cy: number };

export function toPolyline(points: readonly XY[]): string {
  if (!points.length) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.cx)} ${r(p.cy)}`).join(" ");
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson). Chosen over a Catmull–Rom
 * because it cannot overshoot: a smoothed weight trend must never draw a dip
 * that is not in the data.
 */
export function toMonotonePath(points: readonly XY[]): string {
  const n = points.length;
  if (n === 0) return "";
  if (n < 3) return toPolyline(points);

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = points[i + 1].cx - points[i].cx;
    dx.push(h);
    slope.push(h === 0 ? 0 : (points[i + 1].cy - points[i].cy) / h);
  }

  const m: number[] = new Array(n).fill(0);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }

  let d = `M${r(points[0].cx)} ${r(points[0].cy)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d +=
      ` C${r(points[i].cx + h)} ${r(points[i].cy + m[i] * h)}` +
      ` ${r(points[i + 1].cx - h)} ${r(points[i + 1].cy - m[i + 1] * h)}` +
      ` ${r(points[i + 1].cx)} ${r(points[i + 1].cy)}`;
  }
  return d;
}

/** Close a line path down to a baseline to make an area. */
export function toAreaPath(points: readonly XY[], baselineY: number, smooth: boolean): string {
  if (!points.length) return "";
  const top = smooth ? toMonotonePath(points) : toPolyline(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${top} L${r(last.cx)} ${r(baselineY)} L${r(first.cx)} ${r(baselineY)} Z`;
}

/** Upper edge forward, lower edge back — one closed path for a band. */
export function toBandPath(upper: readonly XY[], lower: readonly XY[], smooth: boolean): string {
  if (!upper.length || !lower.length) return "";
  const top = smooth ? toMonotonePath(upper) : toPolyline(upper);
  const reversed = [...lower].reverse();
  const bottomStart = reversed[0];
  const bottom = smooth ? toMonotonePath(reversed) : toPolyline(reversed);
  return `${top} L${r(bottomStart.cx)} ${r(bottomStart.cy)} ${bottom.slice(1)} Z`;
}

/** SVG path for an arc segment of a ring, drawn clockwise from 12 o'clock. */
export function ringArc(
  cx: number,
  cy: number,
  radius: number,
  startTurn: number,
  endTurn: number,
): string {
  const sweep = endTurn - startTurn;
  if (sweep <= 0) return "";
  // A full circle cannot be expressed as a single arc — split it.
  if (sweep >= 1) {
    return (
      `M${r(cx)} ${r(cy - radius)} A${r(radius)} ${r(radius)} 0 1 1 ${r(cx)} ${r(cy + radius)}` +
      ` A${r(radius)} ${r(radius)} 0 1 1 ${r(cx)} ${r(cy - radius)}`
    );
  }
  const a0 = startTurn * 2 * Math.PI - Math.PI / 2;
  const a1 = endTurn * 2 * Math.PI - Math.PI / 2;
  const x0 = cx + radius * Math.cos(a0);
  const y0 = cy + radius * Math.sin(a0);
  const x1 = cx + radius * Math.cos(a1);
  const y1 = cy + radius * Math.sin(a1);
  return `M${r(x0)} ${r(y0)} A${r(radius)} ${r(radius)} 0 ${sweep > 0.5 ? 1 : 0} 1 ${r(x1)} ${r(y1)}`;
}

/** A rounded-top / square-bottom bar, per the mark spec. */
export function barPath(
  x: number,
  y: number,
  width: number,
  height: number,
  cap: number,
  direction: "up" | "right" = "up",
): string {
  const c = Math.min(cap, width / 2, Math.abs(height));
  if (height <= 0) return "";
  if (direction === "up") {
    return (
      `M${r(x)} ${r(y + height)} L${r(x)} ${r(y + c)} Q${r(x)} ${r(y)} ${r(x + c)} ${r(y)}` +
      ` L${r(x + width - c)} ${r(y)} Q${r(x + width)} ${r(y)} ${r(x + width)} ${r(y + c)}` +
      ` L${r(x + width)} ${r(y + height)} Z`
    );
  }
  const w = height; // for "right", height is the bar length along x
  const h = width;
  const cc = Math.min(cap, h / 2, w);
  return (
    `M${r(x)} ${r(y)} L${r(x + w - cc)} ${r(y)} Q${r(x + w)} ${r(y)} ${r(x + w)} ${r(y + cc)}` +
    ` L${r(x + w)} ${r(y + h - cc)} Q${r(x + w)} ${r(y + h)} ${r(x + w - cc)} ${r(y + h)}` +
    ` L${r(x)} ${r(y + h)} Z`
  );
}

/** Round to 2dp — keeps path strings short without visible quantisation. */
export function r(v: number): number {
  return Math.round(v * 100) / 100;
}

/* ── formatting ────────────────────────────────────────────────────────── */

/**
 * Compact display value: 1,284 · 12.9K · 1.2M. Used for stat tiles and direct
 * labels. Proportional figures are the default; only columns get tabular-nums.
 */
export function formatCompact(v: number, maxDecimals = 1): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return trimZero((v / 1_000_000).toFixed(maxDecimals)) + "M";
  if (abs >= 10_000) return trimZero((v / 1000).toFixed(maxDecimals)) + "K";
  if (abs >= 1000) return Math.round(v).toLocaleString("en-US");
  if (Number.isInteger(v)) return String(v);
  return trimZero(v.toFixed(maxDecimals));
}

export function formatNumber(v: number, decimals = 0): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Signed, for deltas: "+0.4", "−1.2" (true minus sign, not a hyphen). */
export function formatSigned(v: number, decimals = 1): string {
  if (!Number.isFinite(v)) return "—";
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (v > 0) return `+${s}`;
  if (v < 0) return `−${s}`;
  return s;
}

function trimZero(s: string): string {
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/* ── dates ─────────────────────────────────────────────────────────────── */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "14 Mar" — short enough for four labels across a 390px screen. */
export function formatDayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function formatWeekday(ms: number): string {
  return DAYS[new Date(ms).getDay()];
}

export function formatFullDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export const DAY_MS = 86_400_000;

/** Local-midnight epoch for a date — the key every daily metric is bucketed on. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
