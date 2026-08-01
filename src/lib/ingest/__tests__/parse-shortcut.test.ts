import { describe, expect, it } from 'vitest';
import {
  MAX_SHORTCUT_PAYLOAD_CHARS,
  ShortcutPayloadError,
  parseShortcutPayload,
} from '../parse-shortcut';

const DATE = '2026-08-01 09:30:00 -0400';

function payload(metrics: unknown[]): string {
  return JSON.stringify({ data: { metrics } });
}

describe('parseShortcutPayload', () => {
  it('parses the exact ShortcutsWizard contract and converts US units to SI', () => {
    const result = parseShortcutPayload(
      payload([
        { name: 'step_count', units: 'count', data: [{ date: DATE, qty: 7200 }] },
        { name: 'active_energy', units: 'kcal', data: [{ date: DATE, qty: 540 }] },
        { name: 'resting_heart_rate', units: 'count/min', data: [{ date: DATE, qty: 52 }] },
        { name: 'heart_rate_variability', units: 'ms', data: [{ date: DATE, qty: 61 }] },
        { name: 'apple_exercise_time', units: 'min', data: [{ date: DATE, qty: 43 }] },
        { name: 'weight_body_mass', units: 'lb', data: [{ date: DATE, qty: 180 }] },
      ]),
    );

    expect(result.rawSamplesSeen).toBe(6);
    expect(result.failures).toBe(0);
    expect(result.batch.metrics).toHaveLength(5);
    expect(result.batch.metrics.find((row) => row.type === 'steps')?.value).toBe(7200);
    expect(result.batch.weights).toEqual([
      expect.objectContaining({ dateKey: '2026-08-01', kg: 81.646627, bodyFatPct: null }),
    ]);
  });

  it('rolls up repeated samples and keeps the latest weigh-in for the day', () => {
    const result = parseShortcutPayload(
      payload([
        {
          name: 'step_count',
          units: 'count',
          data: [
            { date: '2026-08-01 08:00:00 -0400', qty: 400 },
            { date: '2026-08-01 18:00:00 -0400', qty: 600 },
          ],
        },
        {
          name: 'weight_body_mass',
          units: 'kg',
          data: [
            { date: '2026-08-01 07:00:00 -0400', qty: 82 },
            { date: '2026-08-01 08:00:00 -0400', qty: 81.8 },
          ],
        },
      ]),
    );

    expect(result.batch.metrics[0]).toMatchObject({ value: 1000, sampleCount: 2 });
    expect(result.batch.weights[0].kg).toBe(81.8);
  });

  it('reports unknown metrics and malformed known values without hiding valid data', () => {
    const result = parseShortcutPayload(
      payload([
        { name: 'step_count', units: 'count', data: [{ date: DATE, qty: 1000 }] },
        { name: 'blood_pressure', units: 'mmHg', data: [{ date: DATE, qty: 120 }] },
        { name: 'active_energy', units: 'bananas', data: [{ date: DATE, qty: 10 }] },
        { name: 'resting_heart_rate', units: 'count/min', data: [{ date: DATE, qty: '52' }] },
      ]),
    );

    expect(result.batch.metrics).toHaveLength(1);
    expect(result.unmapped).toEqual({ blood_pressure: 1 });
    expect(result.failures).toBe(2);
    expect(result.warnings).toEqual([
      'active_energy (bananas) used a unit Keel does not understand, so that value was not imported.',
    ]);
  });

  it('rejects invalid, structurally wrong, empty, and oversized clipboard text', () => {
    for (const text of [
      '',
      '{not json}',
      '{}',
      payload([]),
      'x'.repeat(MAX_SHORTCUT_PAYLOAD_CHARS + 1),
    ]) {
      expect(() => parseShortcutPayload(text)).toThrow(ShortcutPayloadError);
    }
  });
});
