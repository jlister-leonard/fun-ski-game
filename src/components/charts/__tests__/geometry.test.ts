import { describe, expect, it } from "vitest";
import {
  extent,
  halfSpacing,
  hasValue,
  isValue,
  observed,
  padDomain,
  splitRuns,
} from "../geometry";

/**
 * Missing-day (discontinuity) semantics.
 *
 * These are correctness properties, not styling ones. An unlogged day rendered
 * as zero intake invents a calorie deficit that never happened, it makes an
 * adherent week look erratic, and it collides with the eating-disorder-aware
 * rules: a chart must never make a day with no data look like a day of eating
 * nothing. So the rules are asserted here rather than eyeballed in the gallery.
 *
 * The contract:
 *   null / undefined / NaN  → the day was NOT LOGGED  (a gap)
 *   0                       → it WAS logged, and the value was zero
 */
describe("gap vs zero", () => {
  it("treats null, undefined and NaN as absences but 0 as an observation", () => {
    expect(hasValue({ x: 0, y: null })).toBe(false);
    expect(hasValue({ x: 0, y: undefined })).toBe(false);
    expect(hasValue({ x: 0, y: NaN })).toBe(false);
    expect(hasValue({ x: 0, y: 0 })).toBe(true);

    expect(isValue(0)).toBe(true);
    expect(isValue(null)).toBe(false);
    expect(isValue(undefined)).toBe(false);
    expect(isValue(NaN)).toBe(false);
  });

  it("splits the series into separate runs at a gap", () => {
    const runs = splitRuns([
      { x: 0, y: 10 },
      { x: 1, y: 11 },
      { x: 2, y: null },
      { x: 3, y: 13 },
      { x: 4, y: 14 },
    ]);

    expect(runs).toHaveLength(2);
    expect(runs[0].map((p) => p.x)).toEqual([0, 1]);
    expect(runs[1].map((p) => p.x)).toEqual([3, 4]);
  });

  it("does NOT split at a genuine logged zero", () => {
    const runs = splitRuns([
      { x: 0, y: 10 },
      { x: 1, y: 0 },
      { x: 2, y: 12 },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  it("keeps a lone observation between two gaps, so it can be drawn as a dot", () => {
    const runs = splitRuns([
      { x: 0, y: null },
      { x: 1, y: 7 },
      { x: 2, y: null },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(1);
  });

  it("produces no empty runs from leading, trailing or repeated gaps", () => {
    const runs = splitRuns([
      { x: 0, y: null },
      { x: 1, y: 1 },
      { x: 2, y: null },
      { x: 3, y: null },
      { x: 4, y: 2 },
      { x: 5, y: null },
    ]);

    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.length > 0)).toBe(true);
  });

  it("yields nothing at all for an all-null series", () => {
    const data = [
      { x: 0, y: null },
      { x: 1, y: null },
    ];

    expect(splitRuns(data)).toEqual([]);
    expect(observed(data)).toEqual([]);
  });
});

describe("y-domain is never dragged toward zero by a gap", () => {
  const gappy = [
    { x: 0, y: 84.1 },
    { x: 1, y: null },
    { x: 2, y: 83.7 },
    { x: 3, y: null },
    { x: 4, y: 83.9 },
  ];

  it("matches the domain of the same series with the gaps removed", () => {
    const withGaps = extent(observed(gappy).map((p) => p.y));
    const withoutGaps = extent([84.1, 83.7, 83.9]);

    expect(withGaps).toEqual(withoutGaps);
  });

  it("keeps the range tight around the data instead of collapsing to 0", () => {
    const [min] = extent(observed(gappy).map((p) => p.y))!;
    expect(min).toBeGreaterThan(83);
  });

  it("is the regression guard: filling gaps with 0 collapses the domain", () => {
    // This is precisely the old behaviour, and why the chart drew vertical
    // spikes down to the axis on days that were simply never logged.
    const asZero = extent([84.1, 0, 83.7, 0, 83.9])!;
    expect(asZero[0]).toBe(0);

    const correct = extent(observed(gappy).map((p) => p.y))!;
    expect(correct[0]).toBeGreaterThan(83);
  });

  it("never anchors a padded weight range to zero", () => {
    const [lo, hi] = padDomain([83.7, 84.1]);
    expect(lo).toBeGreaterThan(83);
    expect(hi).toBeLessThan(85);
  });

  it("gives a flat series a real span rather than a degenerate one", () => {
    const [lo, hi] = padDomain([80, 80]);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("readout tolerance", () => {
  const DAY = 86_400_000;

  it("is half the median sampling interval", () => {
    const data = Array.from({ length: 6 }, (_, i) => ({ x: i * DAY, y: i }));
    expect(halfSpacing(data)).toBe(DAY / 2);
  });

  it("is not widened by one long gap (median, not mean)", () => {
    const data = [
      { x: 0, y: 1 },
      { x: DAY, y: 2 },
      { x: 2 * DAY, y: 3 },
      { x: 3 * DAY, y: 4 },
      { x: 30 * DAY, y: 5 },
    ];

    // A 27-day hole must not let a readout borrow a value from weeks away.
    expect(halfSpacing(data)).toBe(DAY / 2);
  });

  it("is infinite for a single point, so it can always resolve itself", () => {
    expect(halfSpacing([{ x: 0, y: 1 }])).toBe(Infinity);
  });
});
