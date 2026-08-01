/**
 * @file The ingest layer's data contract (task graph node **I4**).
 *
 * Three producers — the `export.zip` reader, the Shortcuts clipboard payload
 * and a hand-pasted JSON blob — all converge on the **canonical batch** below
 * before anything is written to the vault. One normaliser, one writer, one set
 * of idempotency keys.
 *
 * ## Two rules this file encodes
 *
 * 1. **Everything here is already SI.** Apple's `unit=` attribute is
 *    locale-dependent (`Cal` vs `kcal`, `mi` vs `km`, `mmol<180.155>/L`), so
 *    conversion happens at the *parse* boundary in `hk-units.ts` and nothing
 *    downstream ever sees a source unit. `AGENTS.md` requires storage in SI;
 *    this is where that becomes true.
 * 2. **Nothing here is a vault record.** These are plain transport objects that
 *    survive `structuredClone`, because they are posted from a Web Worker to
 *    the main thread — the worker cannot write to the vault, since the DEK
 *    lives in the main thread's session and is deliberately non-extractable.
 *    `apply.ts` turns them into `NewRecord<T>` and writes them.
 */

import type {
  DataSource,
  DateKey,
  HealthMetricType,
  IngestFidelity,
  Millis,
  SleepStages,
} from '../db/types';

/**
 * How much a source can be trusted when two of them describe the same day.
 *
 * `channel/011-integrations-research.md` rule 5: a lower-fidelity write must
 * never overwrite a higher-fidelity one. The daily Shortcut will constantly
 * re-touch days the user already backfilled from `export.zip`, and without a
 * rank the aggregate would clobber the detail.
 */
export type Fidelity = IngestFidelity;

/** Numeric rank for {@link Fidelity}. Higher wins. */
export const FIDELITY_RANK: Readonly<Record<Fidelity, number>> = {
  'export-zip': 3,
  'hae-file': 2,
  shortcut: 1,
  manual: 0,
};

/** Which pipeline a batch came in through. Mirrors `IngestLogEntry.channel`. */
export type IngestChannel = 'fragment' | 'paste' | 'export-zip' | 'vendor-api' | 'backup-import';

// ---------------------------------------------------------------------------
// Canonical rows
// ---------------------------------------------------------------------------

/** A daily (or interval) metric value, already in the unit implied by `type`. */
export interface CanonicalMetric {
  type: HealthMetricType;
  /** Local calendar day at capture, `YYYY-MM-DD`. */
  dateKey: DateKey;
  value: number;
  startedAt: Millis | null;
  endedAt: Millis | null;
  aggregation: 'sum' | 'average' | 'min' | 'max' | 'latest' | 'raw';
  /** How many raw samples were folded into `value`. Receipt only. */
  sampleCount: number;
}

/** One night, attributed to the day the user woke up. */
export interface CanonicalSleep {
  dateKey: DateKey;
  bedtimeAt: Millis;
  wakeAt: Millis;
  asleepMin: number;
  inBedMin: number;
  efficiency: number | null;
  stages: SleepStages;
  score: number | null;
  averageHeartRate: number | null;
  hrvMs: number | null;
  /** Pipe-joined source names, as HAE emits them. */
  sourceLabel: string | null;
}

/** A discrete cardio session — a run, a ride, a walk. */
export interface CanonicalActivity {
  dateKey: DateKey;
  startedAt: Millis;
  endedAt: Millis;
  /** Vendor type normalised to lower_snake_case, e.g. `traditional_strength_training`. */
  activityType: string;
  durationSec: number;
  distanceM: number | null;
  activeKcal: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  elevationGainM: number | null;
  name: string | null;
  /** Stable identity from the source, when one exists (HAE v2 workout `id`). */
  externalId: string | null;
}

/** A weigh-in. Body fat from a smart scale rides along when it is same-day. */
export interface CanonicalWeight {
  dateKey: DateKey;
  measuredAt: Millis;
  kg: number;
  bodyFatPct: number | null;
}

/**
 * A lab result, normalised by `@/lib/algorithms/labs`.
 *
 * Carried through the worker boundary and persisted by `apply.ts` in the
 * encrypted `labRecords` table.
 */
export interface CanonicalLab {
  /** `labs.computeSourceKey` output — provider-independent, value-inclusive. */
  sourceKey: string;
  displayName: string;
  loinc: string | null;
  /** ISO-8601 clinical date, taken from inside the FHIR resource. */
  effectiveAt: string;
  rawValue: number | null;
  rawUnit: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  valueText: string | null;
  rangeStatus: string;
  /** Provider attribution from `ClinicalRecord@sourceName`. */
  provider: string | null;
  fhirRelease: 'dstu2' | 'r4' | 'unknown';
}

/** One chunk of parsed, normalised, SI data. */
export interface CanonicalBatch {
  metrics: CanonicalMetric[];
  sleep: CanonicalSleep[];
  activities: CanonicalActivity[];
  weights: CanonicalWeight[];
  labs: CanonicalLab[];
}

/** An empty batch. */
export function emptyBatch(): CanonicalBatch {
  return { metrics: [], sleep: [], activities: [], weights: [], labs: [] };
}

/** Total rows across every collection in a batch. */
export function batchSize(batch: CanonicalBatch): number {
  return (
    batch.metrics.length +
    batch.sleep.length +
    batch.activities.length +
    batch.weights.length +
    batch.labs.length
  );
}

// ---------------------------------------------------------------------------
// Progress and receipts
// ---------------------------------------------------------------------------

/** What the parser is doing right now, for an honest progress UI. */
export type ImportPhase =
  | 'reading-archive'
  | 'scanning-records'
  | 'reading-clinical-records'
  | 'writing'
  | 'done';

/** A progress tick. Deliberately carries real numbers, never a fake percentage. */
export interface ImportProgress {
  phase: ImportPhase;
  /**
   * Bytes of the entry consumed so far, **after decompression**.
   *
   * Measured post-inflate rather than on the compressed stream because that is
   * the number that tracks work actually done: `export.xml` compresses at
   * wildly different ratios depending on how much of it is workout metadata,
   * so compressed bytes advance in lurches while decompressed bytes advance
   * with the record count.
   */
  bytesRead: number;
  /** The entry's uncompressed size from the archive directory, or `null`. */
  bytesTotal: number | null;
  /** `<Record>` elements seen. The number the user recognises from the export. */
  recordsSeen: number;
  /** Clinical-record JSON files opened. */
  clinicalFilesRead: number;
  /** Rows already written into the vault. */
  rowsWritten: number;
  /** Human-readable current step, e.g. `apple_health_export/export.xml`. */
  detail: string | null;
}

/** A per-provider slice of the clinical-record import, per `channel/070` §2. */
export interface ProviderSummary {
  provider: string;
  count: number;
  /** ISO date of the earliest result, or `null`. */
  from: string | null;
  /** ISO date of the latest result, or `null`. */
  to: string | null;
}

/** What the import actually did — the screen shown when it finishes. */
export interface ImportReceipt {
  channel: IngestChannel;
  fidelity: Fidelity;
  /** True when a content hash proved this exact batch was already applied. */
  duplicate: boolean;
  /** ISO-8601 instant the import finished. */
  finishedAt: string;
  /** Apple's own `<ExportDate>`, when the source carried one. */
  exportDate: string | null;
  /** `<Record>` elements parsed, before daily rollup. */
  rawSamplesSeen: number;
  /** Rows inserted, by vault table. */
  created: Record<string, number>;
  /** Rows updated in place because the `sourceKey` already existed. */
  updated: Record<string, number>;
  /** Rows skipped to preserve a deletion or a higher-fidelity existing value. */
  skipped: number;
  /** Earliest and latest day any datum landed on. */
  dateRange: { from: DateKey | null; to: DateKey | null };
  /** Sample types seen that the canonical model has no home for, with counts. */
  unmapped: Record<string, number>;
  /** Per-provider lab counts and date ranges. */
  providers: ProviderSummary[];
  /** Legacy receipt field. Always zero now that labs are persisted. */
  labsParsedNotStored: number;
  /** Resources that could not be parsed. Counted, never fatal. */
  failures: number;
  /** Non-fatal things the user should know. */
  warnings: string[];
}

/** An empty receipt to accumulate into. */
export function emptyReceipt(channel: IngestChannel, fidelity: Fidelity): ImportReceipt {
  return {
    channel,
    fidelity,
    duplicate: false,
    finishedAt: new Date().toISOString(),
    exportDate: null,
    rawSamplesSeen: 0,
    created: {},
    updated: {},
    skipped: 0,
    dateRange: { from: null, to: null },
    unmapped: {},
    providers: [],
    labsParsedNotStored: 0,
    failures: 0,
    warnings: [],
  };
}

/** The `DataSource` every Apple-derived row is tagged with. */
export const APPLE_SOURCE: DataSource = 'apple-health';

// ---------------------------------------------------------------------------
// Health Auto Export wire format — the shared shape all three producers emit
// ---------------------------------------------------------------------------

/** Top-level HAE document. Every key optional; an empty export is `{"data":{}}`. */
export interface HaeEnvelope {
  data: {
    metrics?: HaeMetric[];
    workouts?: HaeWorkout[];
    [k: string]: unknown;
  };
}

/** One named metric and its data points. */
export interface HaeMetric {
  /** HAE snake_case name, e.g. `heart_rate_variability`. Never an HK identifier. */
  name: string;
  units?: string;
  data: HaeDatum[];
}

/**
 * A datum. **Branch on the parent metric's `name`, never on datum shape** —
 * `integration-apple-health.md` §4.2. The shapes overlap and guessing produces
 * silent misreads.
 */
export interface HaeDatum {
  date?: string;
  qty?: number;
  source?: string;
  /** `heart_rate` and friends use capitalised keys. */
  Min?: number;
  Avg?: number;
  Max?: number;
  systolic?: number;
  diastolic?: number;
  /** Sleep: all durations are **hours as floats**, stage keys lowercase. */
  sleepStart?: string;
  sleepEnd?: string;
  inBedStart?: string;
  inBedEnd?: string;
  inBed?: number;
  totalSleep?: number;
  /** Uncategorised sleep, **not** the total. */
  asleep?: number;
  core?: number;
  deep?: number;
  rem?: number;
  awake?: number;
  [k: string]: unknown;
}

/** A `{qty, units}` pair. The unit string is authoritative, never assumed. */
export interface HaeQuantity {
  qty?: number;
  units?: string;
}

/** A workout in HAE v1 or v2 shape. */
export interface HaeWorkout {
  id?: string;
  name?: string;
  start?: string;
  end?: string;
  /** Float **seconds** in v2; absent in v1. */
  duration?: number;
  isIndoor?: boolean;
  activeEnergyBurned?: HaeQuantity;
  totalEnergy?: HaeQuantity;
  distance?: HaeQuantity;
  elevationUp?: HaeQuantity;
  avgHeartRate?: HaeQuantity;
  maxHeartRate?: HaeQuantity;
  heartRate?: { min?: number; avg?: number; max?: number };
  [k: string]: unknown;
}
