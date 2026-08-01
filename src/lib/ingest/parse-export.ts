/**
 * @file The `export.zip` import pipeline — the caller the parsing layer was
 * missing (task graph node **I4**).
 *
 * Everything it needs already existed: `zip.ts` reads the archive, `xml.ts`
 * scans `export.xml` without materialising it, `hk-map.ts` says where a sample
 * type lands, `hk-units.ts` converts it, `fhir.ts` reads the clinical records.
 * This file is the orchestration between them, plus the two things that only
 * make sense once you can see the whole stream: the daily rollup and the
 * sleep-session resolution.
 *
 * ## It runs in a Web Worker and cannot write to the vault
 *
 * The DEK lives in the main thread's session and is deliberately
 * non-extractable (`ingest/types.ts`). So this file produces
 * {@link CanonicalBatch} transport objects and hands them to a callback; the
 * main thread turns them into vault rows in `apply.ts`. The callback is
 * **awaited**, which is what stops a 3M-record export from queueing hundreds of
 * megabytes of batches in the message port while IndexedDB falls behind.
 *
 * ## What it deliberately does not open
 *
 * `export_cda.xml` — HL7 CDA, not FHIR, and observed at 1.6 GB in a published
 * export. The same clinical content is available as FHIR JSON in
 * `clinical-records/`, which is both smaller and far easier to read correctly
 * (`integration-health-records.md` §1.3 ①).
 */

import {
  buildLoincIndex,
  parseObservation,
  type Catalogue,
  type RawLabInput,
} from '../algorithms/labs';
import { maxDateKey, minDateKey, parseAppleDate } from './apple-dates';
import { observationsFromResource, releaseFromVersion } from './fhir';
import {
  HK_BODY_FAT,
  HK_BODY_MASS,
  HK_METRICS,
  HK_MINDFUL,
  HK_SLEEP,
  HK_STAND_HOUR,
  STAND_HOUR_STOOD,
  convertDimension,
  normalizeActivityType,
  shortTypeName,
  sleepStageOf,
} from './hk-map';
import { toKcal, toKilograms, toMetres, toMinutes, toPercent } from './hk-units';
import { MetricAccumulator } from './rollup';
import { resolveNights, type SleepSegment } from './sleep';
import {
  emptyBatch,
  type CanonicalActivity,
  type CanonicalBatch,
  type CanonicalLab,
  type CanonicalWeight,
  type ImportPhase,
  type ImportProgress,
  type ProviderSummary,
} from './types';
import { XmlScanner } from './xml';
import { ZipError, findEntry, openZipEntry, readZipEntryText, readZipDirectory } from './zip';

/** Rows per posted batch. Large enough to amortise the crypto, small enough to
 *  keep the port shallow and the progress bar moving. */
const BATCH_ROWS = 2_000;

/** How often progress is reported, in records scanned. */
const PROGRESS_EVERY = 20_000;

/**
 * Ceiling on retained sleep segments.
 *
 * Sleep is the one record type that cannot be folded as it streams — a night
 * is only resolvable once every overlapping segment has been seen. A decade of
 * a three-device household is still comfortably under this; the cap exists so
 * that a pathological export degrades with a warning rather than by killing
 * the tab.
 */
const MAX_SLEEP_SEGMENTS = 400_000;

/**
 * The analyte catalogue used for lab normalisation.
 *
 * Empty, and honestly so. `lab-panels.json` lives under `docs/kg/specs/`, which
 * is outside the app's module graph, and labs have no vault table to be stored
 * in yet (`channel/070` §6). With no catalogue, `parseObservation` refuses to
 * claim a canonical conversion and preserves the provider's own value and unit
 * verbatim — which is exactly right for data we are reporting but not keeping.
 */
const EMPTY_CATALOGUE: Catalogue = { analytes: {} };
const EMPTY_LOINC_INDEX = buildLoincIndex(EMPTY_CATALOGUE);

/** One `<ClinicalRecord>` element from the `export.xml` index. */
interface ClinicalIndexEntry {
  type: string;
  sourceName: string | null;
  fhirVersion: string | null;
  resourceFilePath: string;
}

/** Resource types worth opening. Everything else is skipped unread. */
const LAB_RESOURCE_TYPES = new Set(['Observation', 'DiagnosticReport']);

/** Callbacks the caller supplies. Both run on the parser's own task. */
export interface ParseCallbacks {
  /** A progress tick. Called on real events only — never on a timer. */
  onProgress(progress: ImportProgress): void;
  /**
   * A batch of parsed rows.
   *
   * **Awaited.** Resolve it only once the rows are durably written; the parser
   * uses the resolution as backpressure and reports the resolved count as
   * `rowsWritten`.
   *
   * @returns how many rows were actually written
   */
  onBatch(batch: CanonicalBatch): Promise<number>;
}

/** Everything the receipt needs that is not a row count. */
export interface ParseOutcome {
  /** Apple's own `<ExportDate>`, when the archive carried one. */
  exportDate: string | null;
  /** `<Record>` elements parsed, before rollup. */
  rawSamplesSeen: number;
  /** Sample types with no home in the canonical model, by short name. */
  unmapped: Record<string, number>;
  /** Per-provider lab counts and date ranges. */
  providers: ProviderSummary[];
  /** Labs parsed. None are stored — there is no table for them yet. */
  labsParsed: number;
  /** Records and resources that could not be read. Counted, never fatal. */
  failures: number;
  /** Non-fatal things the user should be told. */
  warnings: string[];
  /** Earliest and latest day any datum landed on. */
  dateRange: { from: string | null; to: string | null };
  /** Clinical-record JSON files opened. */
  clinicalFilesRead: number;
  /** Rows the callback reported as written. */
  rowsWritten: number;
}

/** Mutable scan state, so the handlers stay readable. */
interface ScanState {
  metrics: MetricAccumulator;
  sleepSegments: SleepSegment[];
  sleepOverflow: boolean;
  weightByDay: Map<string, { kg: number; measuredAt: number }>;
  bodyFatByDay: Map<string, { pct: number; measuredAt: number }>;
  activities: CanonicalActivity[];
  clinical: ClinicalIndexEntry[];
  unmapped: Record<string, number>;
  exportDate: string | null;
  rawSamplesSeen: number;
  failures: number;
  from: string | null;
  to: string | null;
  correlationDepth: number;
  workout: WorkoutDraft | null;
}

/** A `<Workout>` being assembled from its attributes and children. */
interface WorkoutDraft {
  dateKey: string;
  startedAt: number;
  endedAt: number;
  activityType: string;
  durationSec: number;
  distanceM: number | null;
  activeKcal: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  elevationGainM: number | null;
}

/** A number off an attribute, or `null` when it is absent or not a number. */
function numAttr(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a HealthKit metadata value like `"1234 cm"` into value and unit.
 *
 * `MetadataEntry` carries its unit inside the value string rather than in a
 * sibling attribute, which is why this cannot go through `numAttr`.
 *
 * @param raw the `value=` attribute
 * @returns the pair, or `null` when it is not a quantity
 */
function splitQuantity(raw: string | undefined): { value: number; unit: string } | null {
  if (!raw) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? { value, unit: m[2].trim() } : null;
}

/** Widen the running date range to include a day. */
function widen(state: ScanState, dateKey: string | null): void {
  if (!dateKey) return;
  state.from = minDateKey(state.from, dateKey);
  state.to = maxDateKey(state.to, dateKey);
}

/** Fold one `<Record>` into the accumulators. */
function handleRecord(state: ScanState, attrs: Record<string, string>): void {
  state.rawSamplesSeen++;

  const start = parseAppleDate(attrs.startDate);
  if (!start) {
    state.failures++;
    return;
  }
  const end = parseAppleDate(attrs.endDate);
  const endMs = end?.ms ?? start.ms;
  const short = shortTypeName(attrs.type ?? '');
  const unit = attrs.unit ?? '';
  const raw = numAttr(attrs.value);

  if (short === HK_SLEEP) {
    const stage = sleepStageOf(attrs.value);
    if (stage === null) {
      state.failures++;
      return;
    }
    if (state.sleepSegments.length >= MAX_SLEEP_SEGMENTS) {
      state.sleepOverflow = true;
      return;
    }
    state.sleepSegments.push({
      startMs: start.ms,
      endMs: endMs,
      stage,
      endDateKey: end?.dateKey ?? start.dateKey,
      source: attrs.sourceName ?? null,
    });
    widen(state, end?.dateKey ?? start.dateKey);
    return;
  }

  if (short === HK_BODY_MASS) {
    if (raw === null) return;
    const kg = toKilograms(raw, unit);
    if (kg === null) {
      state.failures++;
      return;
    }
    const prior = state.weightByDay.get(start.dateKey);
    if (!prior || start.ms >= prior.measuredAt) {
      state.weightByDay.set(start.dateKey, { kg, measuredAt: start.ms });
    }
    widen(state, start.dateKey);
    return;
  }

  if (short === HK_BODY_FAT) {
    if (raw === null) return;
    const prior = state.bodyFatByDay.get(start.dateKey);
    if (!prior || start.ms >= prior.measuredAt) {
      state.bodyFatByDay.set(start.dateKey, { pct: toPercent(raw), measuredAt: start.ms });
    }
    return;
  }

  if (short === HK_STAND_HOUR) {
    // The sample exists whether or not the user stood; only the "stood" value
    // is a stand hour. Counting every sample would report 24 every day.
    if (attrs.value !== STAND_HOUR_STOOD) return;
    state.metrics.add('stand_hours', start.dateKey, 'sum', 1, start.ms, endMs);
    widen(state, start.dateKey);
    return;
  }

  if (short === HK_MINDFUL) {
    // A mindfulness session carries no value; its duration is the datum.
    const minutes = (endMs - start.ms) / 60_000;
    if (minutes <= 0) return;
    state.metrics.add('mindful_minutes', start.dateKey, 'sum', minutes, start.ms, endMs);
    widen(state, start.dateKey);
    return;
  }

  const spec = HK_METRICS[short];
  if (!spec) {
    if (short !== '') state.unmapped[short] = (state.unmapped[short] ?? 0) + 1;
    return;
  }
  if (raw === null) return;
  const value = convertDimension(spec.dimension, raw, unit);
  if (value === null) {
    // An unrecognised unit is a wrong number waiting to happen. Count it.
    state.failures++;
    return;
  }
  state.metrics.add(spec.type, start.dateKey, spec.rollup, value, start.ms, endMs);
  widen(state, start.dateKey);
}

/** Begin a `<Workout>` from its attributes. */
function startWorkout(attrs: Record<string, string>): WorkoutDraft | null {
  const start = parseAppleDate(attrs.startDate);
  if (!start) return null;
  const end = parseAppleDate(attrs.endDate);
  const endMs = end?.ms ?? start.ms;

  const durationRaw = numAttr(attrs.duration);
  const durationMin =
    durationRaw === null ? null : toMinutes(durationRaw, attrs.durationUnit ?? 'min');
  const durationSec =
    durationMin !== null ? durationMin * 60 : Math.max(0, (endMs - start.ms) / 1000);

  const distanceRaw = numAttr(attrs.totalDistance);
  const energyRaw = numAttr(attrs.totalEnergyBurned);

  return {
    dateKey: start.dateKey,
    startedAt: start.ms,
    endedAt: endMs,
    activityType: normalizeActivityType(attrs.workoutActivityType),
    durationSec: Math.round(durationSec),
    distanceM:
      distanceRaw === null ? null : toMetres(distanceRaw, attrs.totalDistanceUnit ?? 'km'),
    activeKcal: energyRaw === null ? null : toKcal(energyRaw, attrs.totalEnergyBurnedUnit ?? 'kcal'),
    averageHeartRate: null,
    maxHeartRate: null,
    elevationGainM: null,
  };
}

/**
 * Apply a `<WorkoutStatistics>` child to the workout being assembled.
 *
 * From iOS 15 these carry the real per-metric numbers and the legacy
 * `totalDistance` / `totalEnergyBurned` attributes may be absent entirely
 * (`integration-apple-health.md` §3.4), so they take precedence when present.
 */
function applyWorkoutStatistic(draft: WorkoutDraft, attrs: Record<string, string>): void {
  const short = shortTypeName(attrs.type ?? '');
  const unit = attrs.unit ?? '';
  const sum = numAttr(attrs.sum);
  const average = numAttr(attrs.average);
  const maximum = numAttr(attrs.maximum);

  if (short.startsWith('Distance') && sum !== null) {
    const metres = toMetres(sum, unit);
    if (metres !== null) draft.distanceM = metres;
    return;
  }
  if (short === 'ActiveEnergyBurned' && sum !== null) {
    const kcal = toKcal(sum, unit);
    if (kcal !== null) draft.activeKcal = kcal;
    return;
  }
  if (short === 'HeartRate') {
    if (average !== null) draft.averageHeartRate = Math.round(average);
    if (maximum !== null) draft.maxHeartRate = Math.round(maximum);
  }
}

/** Scan `export.xml`, folding as it goes. */
async function scanExportXml(
  entryName: string,
  stream: ReadableStream<Uint8Array>,
  uncompressedSize: number,
  state: ScanState,
  callbacks: ParseCallbacks,
  base: () => ImportProgress,
): Promise<void> {
  const scanner = new XmlScannerFor(state);
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytesRead = 0;
  let nextTick = PROGRESS_EVERY;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    scanner.write(decoder.decode(value, { stream: true }));
    if (state.rawSamplesSeen >= nextTick) {
      nextTick = state.rawSamplesSeen + PROGRESS_EVERY;
      callbacks.onProgress({
        ...base(),
        phase: 'scanning-records',
        bytesRead,
        bytesTotal: uncompressedSize || null,
        recordsSeen: state.rawSamplesSeen,
        detail: entryName,
      });
    }
  }
  const tail = decoder.decode();
  if (tail) scanner.write(tail);
  scanner.end();

  callbacks.onProgress({
    ...base(),
    phase: 'scanning-records',
    bytesRead,
    bytesTotal: uncompressedSize || null,
    recordsSeen: state.rawSamplesSeen,
    detail: entryName,
  });
}

/**
 * The `XmlScanner` wired to the scan state.
 *
 * A thin subclass rather than a closure so the handler methods are named in a
 * stack trace — this is the hot loop, and an exception thrown three million
 * elements into a file is worth being able to locate.
 */
class XmlScannerFor {
  private readonly scanner: XmlScanner;

  constructor(private readonly state: ScanState) {
    this.scanner = new XmlScanner({
      onStart: (name, attrs, selfClosing) => this.onStart(name, attrs, selfClosing),
      onEnd: (name) => this.onEnd(name),
    });
  }

  private onStart(name: string, attrs: Record<string, string>, selfClosing: boolean): void {
    const state = this.state;
    switch (name) {
      case 'Record':
        // Records nested in a Correlation also appear at top level — Apple's
        // own DTD says so. Reading both double-counts blood pressure.
        if (state.correlationDepth === 0) handleRecord(state, attrs);
        return;
      case 'Correlation':
        if (!selfClosing) state.correlationDepth++;
        return;
      case 'Workout':
        state.workout = startWorkout(attrs);
        if (state.workout === null) state.failures++;
        if (selfClosing) this.finishWorkout();
        return;
      case 'WorkoutStatistics':
        if (state.workout) applyWorkoutStatistic(state.workout, attrs);
        return;
      case 'MetadataEntry': {
        if (!state.workout || attrs.key !== 'HKElevationAscended') return;
        const q = splitQuantity(attrs.value);
        if (q) state.workout.elevationGainM = toMetres(q.value, q.unit || 'cm');
        return;
      }
      case 'ExportDate':
        state.exportDate = attrs.value ?? null;
        return;
      case 'ClinicalRecord': {
        const path = attrs.resourceFilePath;
        if (!path) return;
        state.clinical.push({
          type: attrs.type ?? '',
          sourceName: attrs.sourceName ?? null,
          fhirVersion: attrs.fhirVersion ?? null,
          resourceFilePath: path,
        });
        return;
      }
      default:
        return;
    }
  }

  private onEnd(name: string): void {
    if (name === 'Correlation') {
      if (this.state.correlationDepth > 0) this.state.correlationDepth--;
      return;
    }
    if (name === 'Workout') this.finishWorkout();
  }

  private finishWorkout(): void {
    const draft = this.state.workout;
    this.state.workout = null;
    if (!draft) return;
    this.state.activities.push({
      dateKey: draft.dateKey,
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      activityType: draft.activityType,
      durationSec: draft.durationSec,
      distanceM: draft.distanceM,
      activeKcal: draft.activeKcal,
      averageHeartRate: draft.averageHeartRate,
      maxHeartRate: draft.maxHeartRate,
      elevationGainM: draft.elevationGainM,
      name: null,
      externalId: null,
    });
    widen(this.state, draft.dateKey);
  }

  write(chunk: string): void {
    this.scanner.write(chunk);
  }

  end(): void {
    this.scanner.end();
  }
}

/**
 * Read `clinical-records/*.json` and turn the lab results into canonical rows.
 *
 * Uses the `<ClinicalRecord>` index from `export.xml` when it exists, because
 * it carries `fhirVersion` **per file** — so DSTU2 and R4 in the same export
 * are handled without sniffing — plus per-record provider attribution. Falls
 * back to scanning the directory when an export has no index.
 */
async function readClinicalRecords(
  blob: Blob,
  entries: Awaited<ReturnType<typeof readZipDirectory>>,
  index: readonly ClinicalIndexEntry[],
  state: { failures: number },
  onFile: (count: number, detail: string) => void,
): Promise<{ labs: CanonicalLab[]; filesRead: number }> {
  const plan: { path: string; sourceName: string | null; fhirVersion: string | null }[] = [];

  for (const record of index) {
    if (record.type !== '' && !LAB_RESOURCE_TYPES.has(record.type)) continue;
    plan.push({
      path: record.resourceFilePath,
      sourceName: record.sourceName,
      fhirVersion: record.fhirVersion,
    });
  }

  if (plan.length === 0) {
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (!/clinical[-_]records\//.test(lower) || !lower.endsWith('.json')) continue;
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      if (!base.startsWith('observation-') && !base.startsWith('diagnosticreport-')) continue;
      plan.push({ path: entry.name, sourceName: null, fhirVersion: null });
    }
  }

  const labs: CanonicalLab[] = [];
  const importedAt = new Date().toISOString();
  let filesRead = 0;

  for (const item of plan) {
    const entry = findEntry(entries, item.path);
    if (!entry) {
      state.failures++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readZipEntryText(blob, entry));
    } catch {
      state.failures++;
      continue;
    }
    filesRead++;
    if (filesRead % 25 === 0) onFile(filesRead, entry.name);

    const release = releaseFromVersion(item.fhirVersion);
    let inputs: RawLabInput[];
    try {
      inputs = observationsFromResource(parsed, release, item.sourceName);
    } catch {
      state.failures++;
      continue;
    }

    for (const input of inputs) {
      const observation = parseObservation(input, EMPTY_CATALOGUE, EMPTY_LOINC_INDEX, importedAt);
      if (!observation) {
        state.failures++;
        continue;
      }
      labs.push({
        sourceKey: observation.sourceKey,
        displayName: observation.displayName,
        loinc: observation.loinc,
        effectiveAt: observation.effectiveAt,
        rawValue: observation.quantity?.rawValue ?? null,
        rawUnit: observation.quantity?.rawUnit ?? null,
        canonicalValue: observation.quantity?.canonicalValue ?? null,
        canonicalUnit: observation.quantity?.canonicalUnit ?? null,
        valueText: observation.valueText,
        rangeStatus: observation.rangeStatus,
        provider: observation.provider.sourceName ?? observation.provider.performerName,
        fhirRelease: observation.fhirRelease,
      });
    }
  }

  onFile(filesRead, 'clinical records');
  return { labs, filesRead };
}

/** Per-provider counts and date spans, for the "what actually arrived" screen. */
function summariseProviders(labs: readonly CanonicalLab[]): ProviderSummary[] {
  const byProvider = new Map<string, ProviderSummary>();
  for (const lab of labs) {
    const name = lab.provider ?? 'Unattributed';
    let row = byProvider.get(name);
    if (!row) {
      row = { provider: name, count: 0, from: null, to: null };
      byProvider.set(name, row);
    }
    row.count++;
    const day = lab.effectiveAt.slice(0, 10);
    row.from = minDateKey(row.from, day);
    row.to = maxDateKey(row.to, day);
  }
  return [...byProvider.values()].sort((a, b) => b.count - a.count);
}

/**
 * Parse an Apple Health `export.zip` end to end.
 *
 * @param blob the `export.zip` the user picked
 * @param callbacks progress and batch sinks; `onBatch` is awaited
 * @returns everything the receipt needs that is not a row count
 * @throws {ZipError} when the archive is unreadable, with copy that says what
 *   to do next
 */
export async function parseAppleExport(
  blob: Blob,
  callbacks: ParseCallbacks,
): Promise<ParseOutcome> {
  const state: ScanState = {
    metrics: new MetricAccumulator(),
    sleepSegments: [],
    sleepOverflow: false,
    weightByDay: new Map(),
    bodyFatByDay: new Map(),
    activities: [],
    clinical: [],
    unmapped: {},
    exportDate: null,
    rawSamplesSeen: 0,
    failures: 0,
    from: null,
    to: null,
    correlationDepth: 0,
    workout: null,
  };

  let rowsWritten = 0;
  let clinicalFilesRead = 0;
  const warnings: string[] = [];

  const base = (): ImportProgress => ({
    phase: 'reading-archive',
    bytesRead: 0,
    bytesTotal: null,
    recordsSeen: state.rawSamplesSeen,
    clinicalFilesRead,
    rowsWritten,
    detail: null,
  });

  const tick = (phase: ImportPhase, detail: string | null): void => {
    callbacks.onProgress({ ...base(), phase, detail });
  };

  tick('reading-archive', 'export.zip');
  const entries = await readZipDirectory(blob);

  const xmlEntry = findEntry(entries, 'export.xml');
  if (!xmlEntry) {
    throw new ZipError(
      'This archive has no export.xml. Pick the export.zip that the Health app produced, not a folder or a different backup.',
    );
  }

  const stream = await openZipEntry(blob, xmlEntry);
  await scanExportXml(
    xmlEntry.name,
    stream,
    xmlEntry.uncompressedSize,
    state,
    callbacks,
    base,
  );

  if (state.sleepOverflow) {
    warnings.push(
      `This export contains more than ${MAX_SLEEP_SEGMENTS.toLocaleString()} sleep segments; the oldest nights beyond that point were not read. Everything else imported normally.`,
    );
  }

  // --- clinical records ---------------------------------------------------
  tick('reading-clinical-records', 'clinical-records');
  const clinicalState = { failures: state.failures };
  const { labs, filesRead } = await readClinicalRecords(
    blob,
    entries,
    state.clinical,
    clinicalState,
    (count, detail) => {
      clinicalFilesRead = count;
      callbacks.onProgress({ ...base(), phase: 'reading-clinical-records', detail });
    },
  );
  state.failures = clinicalState.failures;
  clinicalFilesRead = filesRead;

  // --- assemble and emit --------------------------------------------------
  tick('writing', null);

  const weights: CanonicalWeight[] = [];
  for (const [dateKey, entry] of state.weightByDay) {
    const fat = state.bodyFatByDay.get(dateKey);
    weights.push({
      dateKey,
      measuredAt: entry.measuredAt,
      kg: Math.round(entry.kg * 1e4) / 1e4,
      bodyFatPct: fat ? Math.round(fat.pct * 100) / 100 : null,
    });
  }
  weights.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));

  const nights = resolveNights(state.sleepSegments);
  state.sleepSegments = [];
  for (const night of nights) widen(state, night.dateKey);

  const metrics = state.metrics.drain();

  const emit = async (batch: CanonicalBatch): Promise<void> => {
    rowsWritten += await callbacks.onBatch(batch);
    callbacks.onProgress({ ...base(), phase: 'writing', detail: null });
  };

  for (let i = 0; i < metrics.length; i += BATCH_ROWS) {
    await emit({ ...emptyBatch(), metrics: metrics.slice(i, i + BATCH_ROWS) });
  }
  for (let i = 0; i < weights.length; i += BATCH_ROWS) {
    await emit({ ...emptyBatch(), weights: weights.slice(i, i + BATCH_ROWS) });
  }
  for (let i = 0; i < nights.length; i += BATCH_ROWS) {
    await emit({
      ...emptyBatch(),
      sleep: nights.slice(i, i + BATCH_ROWS).map((n) => ({
        dateKey: n.dateKey,
        bedtimeAt: n.bedtimeAt,
        wakeAt: n.wakeAt,
        asleepMin: n.asleepMin,
        inBedMin: n.inBedMin,
        efficiency: n.efficiency,
        stages: {
          deepMin: n.deepMin,
          remMin: n.remMin,
          lightMin: n.lightMin,
          awakeMin: n.awakeMin,
        },
        score: null,
        averageHeartRate: null,
        hrvMs: null,
        sourceLabel: n.sourceLabel,
      })),
    });
  }
  for (let i = 0; i < state.activities.length; i += BATCH_ROWS) {
    await emit({ ...emptyBatch(), activities: state.activities.slice(i, i + BATCH_ROWS) });
  }
  if (labs.length > 0) {
    await emit({ ...emptyBatch(), labs });
  }

  if (state.rawSamplesSeen === 0) {
    warnings.push(
      'No health records were found in this export. Health sometimes produces an empty or corrupt archive — try exporting again.',
    );
  }

  tick('done', null);

  return {
    exportDate: state.exportDate,
    rawSamplesSeen: state.rawSamplesSeen,
    unmapped: state.unmapped,
    providers: summariseProviders(labs),
    labsParsed: labs.length,
    failures: state.failures,
    warnings,
    dateRange: { from: state.from, to: state.to },
    clinicalFilesRead,
    rowsWritten,
  };
}
