/**
 * @file Daily rollup of raw HealthKit samples.
 *
 * ## The property that makes a 1.4 GB import possible on a phone
 *
 * Three million `<Record>` elements are not three million rows. Steps alone
 * arrive as one sample every few minutes; four years of them is ~400,000
 * records and **1,460 days**. Folding each sample into a per-`(type, day)`
 * accumulator as it streams past means peak memory is bounded by *days of
 * history times metric types* — a few tens of thousands of small objects —
 * regardless of how many samples produced them.
 *
 * That is the whole reason the import can stay flat at ~110 MB while the file
 * is measured in gigabytes, and it is why this accumulator never keeps a
 * sample after folding it.
 */

import type { HealthMetricType } from '../db/types';
import type { Rollup } from './hk-map';
import type { CanonicalMetric } from './types';

/** Live state for one `(type, dateKey)` bucket. */
interface Bucket {
  type: HealthMetricType;
  dateKey: string;
  rollup: Rollup;
  sum: number;
  count: number;
  min: number;
  max: number;
  latestValue: number;
  latestAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** How a {@link Rollup} is reported in `HealthMetric.aggregation`. */
const AGGREGATION: Readonly<Record<Rollup, CanonicalMetric['aggregation']>> = {
  sum: 'sum',
  average: 'average',
  latest: 'latest',
  max: 'max',
  min: 'min',
};

/**
 * Folds raw samples into one canonical value per metric per day.
 *
 * Not a `Map<string, number>` because the collapse rule differs per metric:
 * steps sum, resting heart rate averages, VO2 max takes the most recent
 * reading. Summing a heart rate would produce a number in the thousands, and
 * averaging steps would silently divide a day's total by its sample count.
 */
export class MetricAccumulator {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Fold one converted sample in.
   *
   * @param type the canonical metric
   * @param dateKey the sample's **local** calendar day
   * @param rollup how this metric collapses across a day
   * @param value the value, already converted to the metric's SI unit
   * @param startedAt sample start, epoch ms
   * @param endedAt sample end, epoch ms
   */
  add(
    type: HealthMetricType,
    dateKey: string,
    rollup: Rollup,
    value: number,
    startedAt: number | null,
    endedAt: number | null,
  ): void {
    if (!Number.isFinite(value)) return;
    // A NUL separator written as an escape, never as a literal byte: a raw
    // control character in a source file makes the whole file read as binary
    // to git and to every diff tool.
    const key = `${type}\u0000${dateKey}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        type,
        dateKey,
        rollup,
        sum: 0,
        count: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        latestValue: value,
        latestAt: Number.NEGATIVE_INFINITY,
        startedAt: null,
        endedAt: null,
      };
      this.buckets.set(key, bucket);
    }

    bucket.sum += value;
    bucket.count++;
    if (value < bucket.min) bucket.min = value;
    if (value > bucket.max) bucket.max = value;

    const at = startedAt ?? 0;
    if (at >= bucket.latestAt) {
      bucket.latestAt = at;
      bucket.latestValue = value;
    }
    if (startedAt !== null && (bucket.startedAt === null || startedAt < bucket.startedAt)) {
      bucket.startedAt = startedAt;
    }
    if (endedAt !== null && (bucket.endedAt === null || endedAt > bucket.endedAt)) {
      bucket.endedAt = endedAt;
    }
  }

  /** How many `(type, day)` buckets are live. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Collapse every bucket to its canonical value.
   *
   * @returns one metric per `(type, day)`, ascending by day
   */
  drain(): CanonicalMetric[] {
    const out: CanonicalMetric[] = [];
    for (const b of this.buckets.values()) {
      let value: number;
      switch (b.rollup) {
        case 'sum':
          value = b.sum;
          break;
        case 'average':
          value = b.count > 0 ? b.sum / b.count : 0;
          break;
        case 'latest':
          value = b.latestValue;
          break;
        case 'max':
          value = b.max;
          break;
        case 'min':
          value = b.min;
          break;
      }
      if (!Number.isFinite(value)) continue;
      out.push({
        type: b.type,
        dateKey: b.dateKey,
        // Six decimals is well past any instrument's resolution and keeps the
        // ciphertext from carrying float noise like 10714.000000000002.
        value: Math.round(value * 1e6) / 1e6,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        aggregation: AGGREGATION[b.rollup],
        sampleCount: b.count,
      });
    }
    out.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
    this.buckets.clear();
    return out;
  }
}
