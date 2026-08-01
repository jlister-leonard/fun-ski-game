/**
 * Parse the small Health Auto Export-shaped document built by Shortcuts.
 *
 * This is intentionally a separate boundary from the `export.zip` parser:
 * clipboard text is untrusted input, but it is already a daily aggregate and
 * must not be treated as millions of raw HealthKit samples. Both paths still
 * converge on {@link CanonicalBatch} before anything reaches the vault.
 */

import { parseAppleDate } from './apple-dates';
import { convertDimension, HAE_METRICS } from './hk-map';
import { toKilograms } from './hk-units';
import { MetricAccumulator } from './rollup';
import { batchSize, emptyBatch, type CanonicalBatch } from './types';

/** Keep an accidental clipboard paste from becoming an unbounded parse. */
export const MAX_SHORTCUT_PAYLOAD_CHARS = 1_000_000;
const MAX_METRICS = 100;
const MAX_SAMPLES = 10_000;
const BODY_MASS = 'weight_body_mass';

/** A user-actionable validation failure, safe to show in the import screen. */
export class ShortcutPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortcutPayloadError';
  }
}

/** Parser metadata folded into the normal import receipt. */
export interface ShortcutParseOutcome {
  batch: CanonicalBatch;
  rawSamplesSeen: number;
  unmapped: Record<string, number>;
  failures: number;
  warnings: string[];
}

/** True for JSON records (and not arrays or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Increment a named receipt counter. */
function bump(into: Record<string, number>, key: string, amount = 1): void {
  into[key] = (into[key] ?? 0) + amount;
}

/**
 * Validate and normalize one Shortcut/HAE JSON payload.
 *
 * Unknown metric names are not fatal: they are reported by name in the same
 * receipt used by the ZIP importer. Malformed known samples are counted as
 * failures and skipped, so one empty Health value does not discard the other
 * five values the Shortcut delivered.
 */
export function parseShortcutPayload(text: string): ShortcutParseOutcome {
  const source = text.trim();
  if (!source) throw new ShortcutPayloadError('The pasted text is empty. Run Sync Health, then try again.');
  if (source.length > MAX_SHORTCUT_PAYLOAD_CHARS) {
    throw new ShortcutPayloadError('That clipboard payload is too large for the daily import. Choose export.zip for historical data.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new ShortcutPayloadError('That is not valid Sync Health JSON. Run the Shortcut again or paste its complete Text result.');
  }

  if (!isRecord(decoded) || !isRecord(decoded.data) || !Array.isArray(decoded.data.metrics)) {
    throw new ShortcutPayloadError('This does not match the Sync Health payload. Expected a data.metrics list.');
  }
  if (decoded.data.metrics.length === 0) {
    throw new ShortcutPayloadError('The Sync Health payload contains no metrics.');
  }
  if (decoded.data.metrics.length > MAX_METRICS) {
    throw new ShortcutPayloadError('The daily payload contains too many metric groups. Use export.zip for a historical import.');
  }

  const batch = emptyBatch();
  const accumulator = new MetricAccumulator();
  const weights = new Map<string, CanonicalBatch['weights'][number]>();
  const unmapped: Record<string, number> = {};
  const unknownUnits = new Set<string>();
  let rawSamplesSeen = 0;
  let failures = 0;

  for (const rawMetric of decoded.data.metrics) {
    if (!isRecord(rawMetric) || typeof rawMetric.name !== 'string' || !Array.isArray(rawMetric.data)) {
      throw new ShortcutPayloadError('Every metric must have a name and a data list. Check the Text action in Sync Health.');
    }
    if (rawSamplesSeen + rawMetric.data.length > MAX_SAMPLES) {
      throw new ShortcutPayloadError('The daily payload contains too many samples. Use export.zip for a historical import.');
    }

    const name = rawMetric.name.trim();
    const units = typeof rawMetric.units === 'string' ? rawMetric.units.trim() : '';
    const spec = HAE_METRICS[name];
    if (!spec && name !== BODY_MASS) {
      rawSamplesSeen += rawMetric.data.length;
      bump(unmapped, name || 'unnamed_metric', rawMetric.data.length);
      continue;
    }

    for (const rawDatum of rawMetric.data) {
      rawSamplesSeen++;
      if (
        !isRecord(rawDatum) ||
        typeof rawDatum.date !== 'string' ||
        typeof rawDatum.qty !== 'number' ||
        !Number.isFinite(rawDatum.qty) ||
        !units
      ) {
        failures++;
        continue;
      }

      const date = parseAppleDate(rawDatum.date);
      if (!date) {
        failures++;
        continue;
      }

      if (name === BODY_MASS) {
        const kg = toKilograms(rawDatum.qty, units);
        if (kg === null || kg <= 0) {
          failures++;
          unknownUnits.add(`${name} (${units})`);
          continue;
        }
        const current = weights.get(date.dateKey);
        if (!current || date.ms >= current.measuredAt) {
          weights.set(date.dateKey, {
            dateKey: date.dateKey,
            measuredAt: date.ms,
            kg: Math.round(kg * 1e6) / 1e6,
            bodyFatPct: null,
          });
        }
        continue;
      }

      const value = convertDimension(spec.dimension, rawDatum.qty, units);
      if (value === null) {
        failures++;
        unknownUnits.add(`${name} (${units})`);
        continue;
      }
      accumulator.add(spec.type, date.dateKey, spec.rollup, value, date.ms, date.ms);
    }
  }

  if (rawSamplesSeen === 0) {
    throw new ShortcutPayloadError('The Sync Health payload contains no samples.');
  }

  batch.metrics = accumulator.drain();
  batch.weights = [...weights.values()].sort((a, b) => a.measuredAt - b.measuredAt);
  const warnings = [...unknownUnits].map(
    (label) => `${label} used a unit Keel does not understand, so that value was not imported.`,
  );
  if (batchSize(batch) === 0 && Object.keys(unmapped).length === 0 && failures === 0) {
    throw new ShortcutPayloadError('Nothing in the Sync Health payload could be imported.');
  }

  return { batch, rawSamplesSeen, unmapped, failures, warnings };
}
