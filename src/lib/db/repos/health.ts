/**
 * @file Recovery repositories: the canonical metric timeseries, sleep,
 * readiness and discrete activities.
 *
 * Everything here is written by the ingest pipelines (nodes I2/I4/I5/I6) and
 * read by the coach. All four tables are idempotent on `sourceKey`, so
 * re-opening the same Shortcuts URL twice changes nothing.
 */

import type {
  Activity,
  DateKey,
  HealthMetric,
  HealthMetricType,
  ReadinessRecord,
  SleepRecord,
} from '../types';
import { Repo, type BulkResult, type NewRecord } from './base';

/** One point of a metric timeseries. */
export interface MetricPoint {
  date: DateKey;
  value: number;
}

/** The canonical daily/interval metric timeseries. */
export class HealthMetricRepo extends Repo<HealthMetric> {
  constructor() {
    super('healthMetrics');
  }

  /**
   * One metric's series over a date range.
   *
   * Served by the `[deleted+type+dateKey]` compound index: the scan touches
   * only rows of this metric in this window, so 90 days of resting HR decrypts
   * 90 rows rather than the entire table.
   *
   * @param type the metric
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns one point per day with data, ascending
   */
  async getSeries(type: HealthMetricType, from: DateKey, to: DateKey): Promise<MetricPoint[]> {
    const rows = await this.rows()
      .where('[deleted+type+dateKey]')
      .between([0, type, from], [0, type, to], true, true)
      .toArray();
    const records = await this.decode(rows);
    const byDay = new Map<DateKey, number>();
    for (const r of records) {
      if (r.aggregation === 'sum') byDay.set(r.dateKey, (byDay.get(r.dateKey) ?? 0) + r.value);
      else byDay.set(r.dateKey, r.value);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, value]) => ({ date, value }));
  }

  /**
   * Several metrics at once, for the dashboard.
   *
   * @param types the metrics to fetch
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns a map from metric type to its series
   */
  async getSeriesMulti(
    types: readonly HealthMetricType[],
    from: DateKey,
    to: DateKey,
  ): Promise<Map<HealthMetricType, MetricPoint[]>> {
    const out = new Map<HealthMetricType, MetricPoint[]>();
    for (const type of types) out.set(type, await this.getSeries(type, from, to));
    return out;
  }

  /**
   * One metric on one day.
   *
   * @param type the metric
   * @param dateKey `YYYY-MM-DD`
   * @returns the value, or `null` when there is no datum
   */
  async getForDate(type: HealthMetricType, dateKey: DateKey): Promise<number | null> {
    const series = await this.getSeries(type, dateKey, dateKey);
    return series[0]?.value ?? null;
  }

  /**
   * The most recent value of a metric.
   *
   * @param type the metric
   * @param lookbackDays how far back to search. Default 30.
   * @returns the newest point, or `null`
   */
  async getLatest(type: HealthMetricType, lookbackDays = 30): Promise<MetricPoint | null> {
    const to = toDateKey(new Date());
    const from = toDateKey(new Date(Date.now() - lookbackDays * 86_400_000));
    const series = await this.getSeries(type, from, to);
    return series.length > 0 ? series[series.length - 1] : null;
  }

  /**
   * Idempotently write a batch of metrics from an ingest pipeline.
   *
   * @param items metrics, each carrying a deterministic `sourceKey`
   * @returns insert/update/skip counts
   */
  async ingest(items: readonly NewRecord<HealthMetric>[]): Promise<BulkResult<HealthMetric>> {
    return this.bulkUpsertBySourceKey(
      items.map((input) => ({
        sourceKey: input.sourceKey ?? `${input.source}:${input.type}:${input.dateKey}`,
        input,
      })),
    );
  }
}

/** Nightly sleep records. */
export class SleepRepo extends Repo<SleepRecord> {
  constructor() {
    super('sleepRecords');
  }

  /**
   * The night attributed to a given wake day.
   *
   * @param dateKey the **wake** day, `YYYY-MM-DD`
   * @returns the night's record, or `null`
   */
  async getForDate(dateKey: DateKey): Promise<SleepRecord | null> {
    const rows = await this.listByDate(dateKey);
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (b.asleepMin > a.asleepMin ? b : a));
  }

  /**
   * Nightly sleep duration across a range.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns one point per night with data, ascending
   */
  async getDurationSeries(from: DateKey, to: DateKey): Promise<MetricPoint[]> {
    const rows = await this.listByDateRange(from, to);
    return rows
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
      .map((r) => ({ date: r.dateKey, value: r.asleepMin }));
  }

  /**
   * Mean sleep duration over the last N nights — the readiness baseline.
   *
   * @param nights how many nights to average. Default 14.
   * @returns mean minutes asleep, or `null` when there is no data
   */
  async rollingAverageMin(nights = 14): Promise<number | null> {
    const to = toDateKey(new Date());
    const from = toDateKey(new Date(Date.now() - nights * 86_400_000));
    const series = await this.getDurationSeries(from, to);
    if (series.length === 0) return null;
    return series.reduce((sum, p) => sum + p.value, 0) / series.length;
  }
}

/** Daily readiness scores, vendor-supplied or derived. */
export class ReadinessRepo extends Repo<ReadinessRecord> {
  constructor() {
    super('readinessRecords');
  }

  /**
   * Readiness for one day.
   *
   * When both a vendor score and the app's own derived score exist for a day,
   * the **derived** one wins: it is the score the coach can explain, and
   * `training-methodology.md` §8 requires the reasoning to be visible.
   *
   * @param dateKey `YYYY-MM-DD`
   * @returns the record, or `null`
   */
  async getForDate(dateKey: DateKey): Promise<ReadinessRecord | null> {
    const rows = await this.listByDate(dateKey);
    if (rows.length === 0) return null;
    return rows.find((r) => r.source === 'derived') ?? rows[0];
  }

  /**
   * Today's readiness.
   *
   * @returns the record, or `null`
   */
  async getToday(): Promise<ReadinessRecord | null> {
    return this.getForDate(toDateKey(new Date()));
  }

  /**
   * The readiness series over a range.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   */
  async getSeries(from: DateKey, to: DateKey): Promise<MetricPoint[]> {
    const rows = await this.listByDateRange(from, to);
    const byDay = new Map<DateKey, ReadinessRecord>();
    for (const r of rows) {
      const existing = byDay.get(r.dateKey);
      if (!existing || r.source === 'derived') byDay.set(r.dateKey, r);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, r]) => ({ date, value: r.score }));
  }
}

/** Discrete cardio and activity sessions. */
export class ActivityRepo extends Repo<Activity> {
  constructor() {
    super('activities');
  }

  /**
   * Activities on one day.
   *
   * @param dateKey `YYYY-MM-DD`
   */
  async getForDate(dateKey: DateKey): Promise<Activity[]> {
    return (await this.listByDate(dateKey)).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Activities in a date range.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   */
  async getForRange(from: DateKey, to: DateKey): Promise<Activity[]> {
    return (await this.listByDateRange(from, to)).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Weekly minutes per Galpin conditioning zone.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns a sparse map of zone (1–5) → minutes
   */
  async zoneMinutes(from: DateKey, to: DateKey): Promise<Partial<Record<number, number>>> {
    const out: Partial<Record<number, number>> = {};
    for (const a of await this.getForRange(from, to)) {
      if (a.zone === null) continue;
      out[a.zone] = (out[a.zone] ?? 0) + a.durationSec / 60;
    }
    return out;
  }

  /**
   * Records shaped for `dedupeWorkouts` in the expenditure algorithm.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns one entry per activity with a known energy cost
   */
  async asWorkoutRecords(
    from: DateKey,
    to: DateKey,
  ): Promise<Array<{ startMs: number; endMs: number; kcal: number; source: string }>> {
    return (await this.getForRange(from, to))
      .filter((a) => a.activeKcal !== null)
      .map((a) => ({
        startMs: a.startedAt,
        endMs: a.endedAt,
        kcal: a.activeKcal as number,
        source: a.source,
      }));
  }
}

/**
 * Format a `Date` as a local {@link DateKey}.
 *
 * Uses the **local** calendar day deliberately: a 23:30 workout belongs to that
 * evening, and `toISOString()` would file it under tomorrow for anyone east of
 * Greenwich.
 *
 * @param date the instant to convert
 * @returns `YYYY-MM-DD` in the device's local time zone
 */
export function toDateKey(date: Date): DateKey {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Shift a {@link DateKey} by a whole number of days.
 *
 * @param dateKey the starting day
 * @param days the offset; negative goes backwards
 * @returns the shifted `YYYY-MM-DD`
 */
export function addDays(dateKey: DateKey, days: number): DateKey {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Canonical metric timeseries repository. */
export const healthMetrics = new HealthMetricRepo();
/** Sleep repository. */
export const sleep = new SleepRepo();
/** Readiness repository. */
export const readiness = new ReadinessRepo();
/** Activity repository. */
export const activities = new ActivityRepo();
