/**
 * @file Body repositories: weigh-ins and tape measurements.
 */

import type { BodyMeasurement, DateKey, MeasurementSite, WeightEntry } from '../types';
import { Repo, type NewRecord } from './base';

/**
 * One point of the series the trend filter consumes.
 *
 * Shaped to match `WeightEntry` in `docs/kg/specs/algorithms/weight-trend.ts`
 * exactly, so `computeWeightTrend(await weights.getSeries(from, to))` needs no
 * adapter.
 */
export interface WeightSeriesPoint {
  /** `YYYY-MM-DD`. */
  date: DateKey;
  /** Scale reading in kilograms. */
  kg: number;
}

/** Weigh-ins. */
export class WeightRepo extends Repo<WeightEntry> {
  constructor() {
    super('weightEntries');
  }

  /**
   * The daily weight series for a date range, ready for the trend filter.
   *
   * Multiple weigh-ins on one day collapse to the **earliest** reading of that
   * day, which is the convention the algorithm spec assumes: a fasted morning
   * weight is far less noisy than an evening one, and mixing them injects
   * variance the filter would then have to smooth back out.
   *
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns one point per day that has a reading, ascending by date
   */
  async getSeries(from: DateKey, to: DateKey): Promise<WeightSeriesPoint[]> {
    const entries = await this.listByDateRange(from, to);
    const byDay = new Map<DateKey, WeightEntry>();
    for (const e of entries) {
      const existing = byDay.get(e.dateKey);
      if (!existing || e.measuredAt < existing.measuredAt) byDay.set(e.dateKey, e);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, e]) => ({ date, kg: e.kg }));
  }

  /**
   * The most recent weigh-in.
   *
   * @returns the latest entry, or `null`
   */
  async getLatest(): Promise<WeightEntry | null> {
    const rows = await this.listAll({ reverse: true, limit: 50 });
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (b.measuredAt > a.measuredAt ? b : a));
  }

  /**
   * Every weigh-in on one day, earliest first.
   *
   * @param dateKey `YYYY-MM-DD`
   * @returns the day's entries
   */
  async getForDate(dateKey: DateKey): Promise<WeightEntry[]> {
    const rows = await this.listByDate(dateKey);
    return rows.sort((a, b) => a.measuredAt - b.measuredAt);
  }

  /**
   * Record a weigh-in, replacing any existing one from the same source at the
   * same instant.
   *
   * @param input the entry
   * @returns the stored entry
   */
  async log(input: NewRecord<WeightEntry>): Promise<WeightEntry> {
    if (input.sourceKey) {
      return (await this.upsertBySourceKey(input.sourceKey, input)).record;
    }
    return this.create(input);
  }
}

/** Tape measurements. */
export class MeasurementRepo extends Repo<BodyMeasurement> {
  constructor() {
    super('bodyMeasurements');
  }

  /**
   * The series for one measurement site.
   *
   * @param site which body site
   * @param from inclusive `YYYY-MM-DD`
   * @param to inclusive `YYYY-MM-DD`
   * @returns one point per day the site was measured, ascending
   */
  async getSiteSeries(
    site: MeasurementSite,
    from: DateKey,
    to: DateKey,
  ): Promise<Array<{ date: DateKey; cm: number }>> {
    const rows = await this.listByDateRange(from, to);
    return rows
      .filter((r) => typeof r.sitesCm[site] === 'number')
      .sort((a, b) => a.measuredAt - b.measuredAt)
      .map((r) => ({ date: r.dateKey, cm: r.sitesCm[site] as number }));
  }

  /**
   * The most recent value recorded for every site.
   *
   * @returns a sparse map of site → most recent centimetres
   */
  async getLatestBySite(): Promise<Partial<Record<MeasurementSite, { cm: number; date: DateKey }>>> {
    const rows = await this.listAll();
    rows.sort((a, b) => a.measuredAt - b.measuredAt);
    const out: Partial<Record<MeasurementSite, { cm: number; date: DateKey }>> = {};
    for (const row of rows) {
      for (const [site, cm] of Object.entries(row.sitesCm)) {
        if (typeof cm === 'number') {
          out[site as MeasurementSite] = { cm, date: row.dateKey };
        }
      }
    }
    return out;
  }
}

/** Weigh-in repository. */
export const weights = new WeightRepo();
/** Tape-measurement repository. */
export const measurements = new MeasurementRepo();
