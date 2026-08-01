import { describe, expect, it } from 'vitest';
import {
  groupSleepSegments,
  resolveNights,
  resolveSleepSession,
  type SleepSegment,
} from '../sleep';

/** Build a segment from wall-clock hours on a fixed day, for readability. */
function seg(
  stage: SleepSegment['stage'],
  startHour: number,
  endHour: number,
  source = 'Watch',
): SleepSegment {
  const base = Date.UTC(2026, 2, 1, 0, 0, 0);
  const hour = 3_600_000;
  return {
    startMs: base + startHour * hour,
    endMs: base + endHour * hour,
    stage,
    endDateKey: '2026-03-01',
    source,
  };
}

describe('resolveSleepSession', () => {
  it('sums stages and never adds inBed to them', () => {
    // 23:00→07:00 in bed, with 7 hours of actual stages inside it. Summing
    // everything would report 15 hours.
    const night = resolveSleepSession([
      seg('inBed', 0, 8),
      seg('light', 0.5, 3),
      seg('deep', 3, 4.5),
      seg('rem', 4.5, 6),
      seg('awake', 6, 6.25),
      seg('light', 6.25, 7.5),
    ]);

    expect(night).not.toBeNull();
    expect(night!.asleepMin).toBe(150 + 90 + 90 + 75);
    expect(night!.inBedMin).toBe(480);
    expect(night!.deepMin).toBe(90);
    expect(night!.remMin).toBe(90);
    expect(night!.awakeMin).toBe(15);
  });

  it('counts a window claimed by two sources once, at the better stage', () => {
    // The Watch says deep, the iPhone says undifferentiated light, for the very
    // same 90 minutes. Summing double-counts; the priority sweep does not.
    const night = resolveSleepSession([
      seg('inBed', 0, 8),
      seg('deep', 2, 3.5, 'Watch'),
      seg('light', 2, 3.5, 'iPhone'),
      seg('light', 3.5, 7, 'Watch'),
    ]);

    expect(night!.asleepMin).toBe(90 + 210);
    expect(night!.deepMin).toBe(90);
    expect(night!.lightMin).toBe(210);
    expect(night!.sourceLabel).toBe('Watch|iPhone');
  });

  it('falls back to the sleep span when no source reported time in bed', () => {
    const night = resolveSleepSession([seg('light', 1, 7), seg('awake', 7, 7.5)]);
    expect(night!.inBedMin).toBe(360 + 30);
    expect(night!.efficiency).toBeCloseTo(360 / 390, 3);
  });

  it('reports an unreported stage as null rather than zero', () => {
    // "We do not know" and "you got none" are different claims.
    const night = resolveSleepSession([seg('inBed', 0, 8), seg('light', 0.5, 7)]);
    expect(night!.deepMin).toBeNull();
    expect(night!.remMin).toBeNull();
    expect(night!.lightMin).toBe(390);
  });

  it('rejects a nap', () => {
    expect(resolveSleepSession([seg('light', 13, 13.5)])).toBeNull();
  });

  it('attributes the night to the wake day, from the source string', () => {
    const night = resolveSleepSession([
      { ...seg('light', 0, 7), endDateKey: '2026-03-01' },
    ]);
    expect(night!.dateKey).toBe('2026-03-01');
  });
});

describe('groupSleepSegments', () => {
  it('splits on a gap longer than three hours', () => {
    const sessions = groupSleepSegments([
      seg('light', 0, 6),
      seg('light', 14, 15),
    ]);
    expect(sessions).toHaveLength(2);
  });

  it('keeps segments separated by a short awakening together', () => {
    const sessions = groupSleepSegments([
      seg('light', 0, 3),
      seg('light', 3.5, 7),
    ]);
    expect(sessions).toHaveLength(1);
  });

  it('does not depend on input order', () => {
    const ordered = groupSleepSegments([seg('light', 0, 6), seg('light', 14, 20)]);
    const shuffled = groupSleepSegments([seg('light', 14, 20), seg('light', 0, 6)]);
    expect(shuffled.map((s) => s.length)).toEqual(ordered.map((s) => s.length));
  });
});

describe('resolveNights', () => {
  it('keeps only the longest session per wake day', () => {
    const nights = resolveNights([
      seg('light', 0, 7),
      // A three-hour afternoon sleep on the same day — long enough to clear the
      // nap threshold, but not the night.
      seg('light', 13, 16),
    ]);
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMin).toBe(420);
  });

  it('returns nothing for an export with no sleep', () => {
    expect(resolveNights([])).toEqual([]);
  });
});
