/**
 * Verification for the missing-day (discontinuity) semantics.
 *
 * Run:  node --experimental-strip-types src/components/charts/geometry.verify.mjs
 *
 * These are correctness properties, not styling ones. An unlogged day rendered
 * as zero intake invents a calorie deficit that never happened, so the rules
 * below are asserted rather than eyeballed.
 */

import assert from "node:assert/strict";
import {
  extent,
  hasValue,
  isValue,
  halfSpacing,
  observed,
  padDomain,
  splitRuns,
} from "./geometry.ts";

let checks = 0;
const ok = (name, fn) => {
  fn();
  checks++;
  console.log("  ok  " + name);
};

console.log("\nmissing-day semantics\n");

ok("null / undefined / NaN are absences; 0 is an observation", () => {
  assert.equal(hasValue({ x: 0, y: null }), false);
  assert.equal(hasValue({ x: 0, y: undefined }), false);
  assert.equal(hasValue({ x: 0, y: NaN }), false);
  assert.equal(hasValue({ x: 0, y: 0 }), true);
  assert.equal(isValue(0), true);
  assert.equal(isValue(null), false);
});

ok("a gap splits the series into separate runs", () => {
  const runs = splitRuns([
    { x: 0, y: 10 },
    { x: 1, y: 11 },
    { x: 2, y: null },
    { x: 3, y: 13 },
    { x: 4, y: 14 },
  ]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].map((p) => p.x), [0, 1]);
  assert.deepEqual(runs[1].map((p) => p.x), [3, 4]);
});

ok("a logged zero does NOT split the series", () => {
  const runs = splitRuns([
    { x: 0, y: 10 },
    { x: 1, y: 0 },
    { x: 2, y: 12 },
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 3);
});

ok("an isolated observation survives as its own run (so it gets a dot)", () => {
  const runs = splitRuns([
    { x: 0, y: null },
    { x: 1, y: 7 },
    { x: 2, y: null },
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 1);
});

ok("leading and trailing gaps produce no empty runs", () => {
  const runs = splitRuns([
    { x: 0, y: null },
    { x: 1, y: 1 },
    { x: 2, y: null },
    { x: 3, y: null },
    { x: 4, y: 2 },
    { x: 5, y: null },
  ]);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.length > 0));
});

ok("an all-null series yields no runs and no observations", () => {
  const data = [
    { x: 0, y: null },
    { x: 1, y: null },
  ];
  assert.deepEqual(splitRuns(data), []);
  assert.deepEqual(observed(data), []);
});

console.log("\ny-domain is never dragged toward zero by a gap\n");

ok("the domain of a gappy series matches the same series without gaps", () => {
  const gappy = [
    { x: 0, y: 84.1 },
    { x: 1, y: null },
    { x: 2, y: 83.7 },
    { x: 3, y: null },
    { x: 4, y: 83.9 },
  ];
  const dense = [
    { x: 0, y: 84.1 },
    { x: 2, y: 83.7 },
    { x: 4, y: 83.9 },
  ];
  const a = extent(observed(gappy).map((p) => p.y));
  const b = extent(dense.map((p) => p.y));
  assert.deepEqual(a, b);
  // Nowhere near zero: the plot keeps its vertical resolution.
  assert.ok(a[0] > 83, "min stayed at the data, not at 0");
});

ok("treating a gap as 0 would collapse the domain — the bug this guards", () => {
  const asZero = [84.1, 0, 83.7, 0, 83.9];
  const wrong = extent(asZero);
  assert.equal(wrong[0], 0, "this is what the old behaviour produced");
  const right = extent(
    observed([
      { x: 0, y: 84.1 },
      { x: 1, y: null },
      { x: 2, y: 83.7 },
      { x: 3, y: null },
      { x: 4, y: 83.9 },
    ]).map((p) => p.y),
  );
  assert.ok(right[0] > 83);
});

ok("padDomain never anchors a weight range to zero", () => {
  const [lo, hi] = padDomain([83.7, 84.1]);
  assert.ok(lo > 83 && hi < 85, `expected a tight range, got ${lo}–${hi}`);
});

console.log("\nreadout tolerance\n");

ok("halfSpacing is half the median daily interval", () => {
  const day = 86_400_000;
  const data = Array.from({ length: 6 }, (_, i) => ({ x: i * day, y: i }));
  assert.equal(halfSpacing(data), day / 2);
});

ok("a gap does not widen the tolerance (median, not mean)", () => {
  const day = 86_400_000;
  const data = [
    { x: 0, y: 1 },
    { x: day, y: 2 },
    { x: 2 * day, y: 3 },
    { x: 3 * day, y: 4 },
    { x: 30 * day, y: 5 },
  ];
  assert.equal(halfSpacing(data), day / 2);
});

console.log(`\n${checks} checks passed\n`);
