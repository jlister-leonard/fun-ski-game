/**
 * Deterministic sample data for the chart gallery.
 *
 * Presentation-only. Nothing here is an algorithm the app relies on — the real
 * weight trend comes from `lib/weight-trend` (node A1) and the real expenditure
 * estimate from `lib/expenditure` (node A2). These generators exist so the
 * gallery renders the same picture on every machine and every reload.
 */

import { DAY_MS, hasValue, startOfDay, type BandPoint, type GapPoint, type Point } from "../geometry";

/** Mulberry32 — a tiny seeded PRNG so the gallery never flickers between runs. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed "today" so the gallery is stable in a statically pre-rendered page. */
export const TODAY = startOfDay(Date.UTC(2026, 6, 26));

export function daysBack(n: number): number[] {
  return Array.from({ length: n }, (_, i) => TODAY - (n - 1 - i) * DAY_MS);
}

/**
 * Noisy daily weigh-ins around a slow downward drift — the real shape of this
 * data, including the days a real person simply does not step on the scale.
 *
 * Missed days are emitted as `y: null`, NOT as `0`. That is the whole point:
 * the chart must break the line there rather than draw a plunge to zero.
 */
export function weighIns(n = 84): GapPoint[] {
  const rand = rng(20260726);
  return daysBack(n).map((x, i) => {
    // One skipped day a week, plus a four-day break (a holiday) mid-series.
    const missed = i % 7 === 5 || (i >= 46 && i <= 49);
    if (missed) return { x, y: null };
    const drift = 84.2 - i * 0.038;
    const water = Math.sin(i / 3.1) * 0.35 + Math.sin(i / 11) * 0.22;
    const noise = (rand() - 0.5) * 0.9;
    return { x, y: Number((drift + water + noise).toFixed(2)) };
  });
}

/**
 * Centred moving average over the OBSERVED points only — stands in for the real
 * trend filter (`lib/weight-trend`, node A1) in the gallery.
 *
 * The trend is a model, so it legitimately spans a missed weigh-in and stays
 * continuous; it is the raw series that breaks. Unlogged days contribute
 * nothing to the average rather than being counted as zero.
 */
export function movingAverage(points: readonly GapPoint[], window = 11): Point[] {
  const seen = points.filter(hasValue);
  const half = Math.floor(window / 2);
  return seen.map((p, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(seen.length - 1, i + half);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += seen[j].y;
    return { x: p.x, y: Number((sum / (to - from + 1)).toFixed(3)) };
  });
}

export function confidenceBand(trend: Point[], halfWidth = 0.32): BandPoint[] {
  return trend.map((p, i) => {
    // The estimate is least certain at the ends of the window.
    const edge = Math.min(i, trend.length - 1 - i);
    const widen = halfWidth * (1 + Math.max(0, 6 - edge) / 8);
    return { x: p.x, lo: p.y - widen, hi: p.y + widen };
  });
}

/**
 * Intake vs expenditure.
 *
 * Intake has gaps — days the diary was not filled in. Expenditure does not:
 * it is an algorithmic estimate that exists for every day whether or not the
 * user logged. That asymmetry is exactly the case the chart has to render
 * honestly, and it is what made the original spikes-to-zero bug visible.
 */
export function energyBalance(n = 42): { intake: GapPoint[]; expenditure: Point[] } {
  const rand = rng(77);
  const days = daysBack(n);
  const intake: GapPoint[] = [];
  const expenditure: Point[] = [];
  days.forEach((x, i) => {
    const weekend = [0, 6].includes(new Date(x).getDay());
    // Logging lapses: a stretch away from home, plus the odd forgotten day.
    const unlogged = (i >= 17 && i <= 20) || i === 8 || i === 31;
    intake.push({
      x,
      y: unlogged ? null : Math.round(2180 + (weekend ? 420 : 0) + (rand() - 0.5) * 420),
    });
    expenditure.push({ x, y: Math.round(2680 - i * 1.4 + Math.sin(i / 5) * 55) });
  });
  return { intake, expenditure };
}

/**
 * A week of macros. Thursday was not logged at all (`null` across every macro),
 * which is a different fact from a day where something was genuinely zero.
 */
export function macroWeek() {
  const rand = rng(915);
  const categories = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const protein: (number | null)[] = [];
  const carbs: (number | null)[] = [];
  const fat: (number | null)[] = [];
  categories.forEach((_, i) => {
    const unlogged = i === 3;
    protein.push(unlogged ? null : Math.round(150 + (rand() - 0.5) * 40));
    carbs.push(unlogged ? null : Math.round(210 + (rand() - 0.5) * 90));
    fat.push(unlogged ? null : Math.round(72 + (rand() - 0.5) * 26));
  });
  return { categories, protein, carbs, fat };
}

/**
 * A series that is mostly a genuine, logged zero — the counterpart to a gap.
 * Zero days draw a visible stub; the unlogged day draws a dashed tick.
 */
export function alcoholWeek(): (number | null)[] {
  return [0, 0, 0, null, 24, 38, 0];
}

export function adherence(n = 182) {
  const rand = rng(4242);
  const days = daysBack(n);
  return days
    .map((date) => ({ date, value: rand() < 0.24 ? 0 : Math.ceil(rand() * 4) }))
    .filter((d) => d.value > 0);
}

export function readinessSeries(n = 30): Point[] {
  const rand = rng(31);
  return daysBack(n).map((x, i) => ({
    x,
    y: Math.round(62 + Math.sin(i / 4.5) * 14 + (rand() - 0.5) * 10),
  }));
}
