import { describe, expect, it } from 'vitest';
import { MetricAccumulator } from '../rollup';
import { sourceKeys } from '../apply';

describe('MetricAccumulator', () => {
  it('sums step samples into one value per day', () => {
    const acc = new MetricAccumulator();
    acc.add('steps', '2026-03-01', 'sum', 1200, 1, 2);
    acc.add('steps', '2026-03-01', 'sum', 800, 3, 4);
    acc.add('steps', '2026-03-02', 'sum', 2500, 5, 6);

    const out = acc.drain();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      dateKey: '2026-03-01',
      value: 2000,
      aggregation: 'sum',
      sampleCount: 2,
    });
    expect(out[1].value).toBe(2500);
  });

  it('averages a heart rate instead of summing it', () => {
    // The bug this guards: 54 + 58 = 112 bpm is not a resting heart rate.
    const acc = new MetricAccumulator();
    acc.add('resting_heart_rate', '2026-03-01', 'average', 54, 1, 1);
    acc.add('resting_heart_rate', '2026-03-01', 'average', 58, 2, 2);

    const [row] = acc.drain();
    expect(row.value).toBe(56);
    expect(row.aggregation).toBe('average');
  });

  it('takes the most recent sample for a latest-rollup metric', () => {
    const acc = new MetricAccumulator();
    acc.add('vo2max', '2026-03-01', 'latest', 44, 1_000, 1_000);
    acc.add('vo2max', '2026-03-01', 'latest', 48.2, 9_000, 9_000);
    acc.add('vo2max', '2026-03-01', 'latest', 46, 5_000, 5_000);

    expect(acc.drain()[0].value).toBe(48.2);
  });

  it('keeps the widest interval the day’s samples covered', () => {
    const acc = new MetricAccumulator();
    acc.add('steps', '2026-03-01', 'sum', 10, 500, 600);
    acc.add('steps', '2026-03-01', 'sum', 10, 100, 200);

    const [row] = acc.drain();
    expect(row.startedAt).toBe(100);
    expect(row.endedAt).toBe(600);
  });

  it('ignores a non-finite value rather than poisoning the day', () => {
    const acc = new MetricAccumulator();
    acc.add('steps', '2026-03-01', 'sum', Number.NaN, 1, 2);
    acc.add('steps', '2026-03-01', 'sum', 100, 1, 2);

    const [row] = acc.drain();
    expect(row.value).toBe(100);
    expect(row.sampleCount).toBe(1);
  });

  it('rounds away float noise', () => {
    const acc = new MetricAccumulator();
    for (let i = 0; i < 3; i++) acc.add('water_ml', '2026-03-01', 'sum', 0.1, 1, 2);
    expect(acc.drain()[0].value).toBe(0.3);
  });

  it('empties itself on drain, so a second import starts clean', () => {
    const acc = new MetricAccumulator();
    acc.add('steps', '2026-03-01', 'sum', 10, 1, 2);
    expect(acc.drain()).toHaveLength(1);
    expect(acc.size).toBe(0);
    expect(acc.drain()).toHaveLength(0);
  });
});

describe('sourceKeys', () => {
  it('is deterministic, which is what makes a re-import a no-op', () => {
    expect(sourceKeys.metric('steps', '2026-03-01')).toBe(
      sourceKeys.metric('steps', '2026-03-01'),
    );
    expect(sourceKeys.metric('steps', '2026-03-01')).toBe('apple-health:metric:steps:2026-03-01');
  });

  it('separates metrics, days and record kinds', () => {
    const keys = new Set([
      sourceKeys.metric('steps', '2026-03-01'),
      sourceKeys.metric('steps', '2026-03-02'),
      sourceKeys.metric('hrv_sdnn_ms', '2026-03-01'),
      sourceKeys.weight('2026-03-01'),
      sourceKeys.sleep('2026-03-01'),
      sourceKeys.activity(1_700_000_000_000, 'running'),
    ]);
    expect(keys.size).toBe(6);
  });

  it('gives two workouts that started at the same instant different keys by type', () => {
    // A strength session and a walk can genuinely overlap; the start alone is
    // not an identity.
    expect(sourceKeys.activity(1_000, 'walking')).not.toBe(
      sourceKeys.activity(1_000, 'traditional_strength_training'),
    );
  });
});
