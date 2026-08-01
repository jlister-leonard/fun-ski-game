/**
 * labs.ts
 *
 * Lab result parsing, unit normalization, reference-range classification and
 * trend analysis.
 *
 * Companion spec: `docs/kg/specs/integration-health-records.md`
 * Companion data: `docs/kg/specs/lab-panels.json`
 * Governing policy: `docs/kg/specs/advice-policy.md`
 *
 * Design rules baked in here:
 *
 * - **A wrong conversion on a lab value is worse than no conversion.** Every
 *   conversion is keyed by (analyte, unit), never by unit alone, and an
 *   unrecognised pair returns `canonicalValue: null` with a reason. `mg/dL` is
 *   not a conversion; `mg/dL of cholesterol` is.
 * - **The user's own lab's reference range always wins.** A general-population
 *   range is a labelled fallback, never a replacement, and can never fire a
 *   critical prompt.
 * - **Two results differing slightly is noise.** Every trend statement passes a
 *   reference-change-value gate AND an absolute clinical floor, because for
 *   tightly-controlled analytes the statistical threshold is smaller than
 *   physiologically trivial movement.
 * - **Interpretation, not diagnosis.** This module emits findings that describe
 *   what a value is and what commonly moves it. It refuses, structurally, to
 *   emit a diagnosis, a medication change, or a computed clinical index.
 *
 * Zero dependencies. Pure functions. No I/O. No Date.now() — every function
 * that needs "now" takes it as an argument, so results are reproducible.
 *
 * @module labs
 */

import type { Finding } from './guardrails.js';

/* ------------------------------------------------------------------ */
/* Finding helpers (same shape as guardrails.ts, which keeps its own    */
/* constructors module-private)                                        */
/* ------------------------------------------------------------------ */

function info(code: string, message: string): Finding {
  return { ok: false, level: 'info', code, message };
}
function warn(code: string, message: string): Finding {
  return { ok: false, level: 'warn', code, message };
}
function block(code: string, message: string): Finding {
  return { ok: false, level: 'block', code, message };
}

/* ------------------------------------------------------------------ */
/* Catalogue types — the shape of lab-panels.json                      */
/* ------------------------------------------------------------------ */

export type Conversion =
  | { kind: 'identity'; note?: string }
  | { kind: 'linear'; factor: number; offset?: number; note?: string }
  | { kind: 'refuse'; reason: string };

export interface GoalContext {
  low: number | null;
  high: number | null;
  unit: string;
  goals: string[];
  rationale: string;
  source: string;
  confidence: 'well-established' | 'reasonable-inference' | 'uncertain';
  caveat?: string;
  /** True when only the direction matters and no numeric bound is meaningful. */
  directionalOnly?: boolean;
  strata?: { max: number | null; label: string }[];
}

export interface GeneralRange {
  low: number | null;
  high: number | null;
  unit: string;
  note?: string;
  confidence?: string;
}

export interface BiologicalVariation {
  /** Within-subject biological CV, %. */
  cvi: number;
  /** Analytical CV, %. */
  cva: number;
  provenance: 'verified' | 'unverified' | 'derived';
  source?: string;
  /** Use the log-normal RCV form. Required above roughly 20% total CV. */
  logNormal?: boolean;
  /** Refuse to draw a direction from fewer than MIN_RESULTS_FOR_VOLATILE points. */
  singlePairTrendUnreliable?: boolean;
  /**
   * Absolute delta below which no change is reported, however statistically
   * significant. Exists because for sodium, calcium, albumin, MCV and HbA1c the
   * RCV is smaller than physiologically trivial day-to-day movement.
   */
  clinicalFloor?: number | null;
  clinicalFloorUnit?: string;
  methodDependent?: boolean;
  methodNote?: string;
}

export interface ArtifactRule {
  trigger: string;
  mechanism: string;
  discriminator: string;
  confidence: string;
  note?: string;
}

export interface AnalyteMeta {
  displayName: string;
  loinc: string;
  loincDisplay?: string;
  loincConfidence?: string;
  altLoinc?: { code: string; note?: string }[];
  aliases?: string[];
  panels?: string[];
  canonicalUnit: string;
  units: Record<string, Conversion>;
  whatItMeasures?: string;
  movedUpBy?: string[];
  movedDownBy?: string[];
  controllable?: string[];
  notControllable?: string[];
  generalRange?: GeneralRange | null;
  goalContext?: GoalContext | null;
  biologicalVariation?: BiologicalVariation;
  critical?: { low: number | null; high: number | null; unit?: string; note?: string };
  artifactRules?: ArtifactRule[];
  micronutrientKey?: string | null;
  relevanceToGoals?: string[];
  doNotMergeWith?: string[];
  neverCompute?: boolean;
  neverComputeDerived?: string[];
}

export interface Catalogue {
  analytes: Record<string, AnalyteMeta>;
}

/** Reverse index: LOINC (primary and alternate) → analyteId. Built once. */
export function buildLoincIndex(cat: Catalogue): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [id, a] of Object.entries(cat.analytes)) {
    if (!idx.has(a.loinc)) idx.set(a.loinc, id);
    for (const alt of a.altLoinc ?? []) {
      if (!idx.has(alt.code)) idx.set(alt.code, id);
    }
  }
  return idx;
}

/* ------------------------------------------------------------------ */
/* Internal model                                                      */
/* ------------------------------------------------------------------ */

export type RangeStatus =
  | 'in_range'
  | 'below'
  | 'above'
  | 'no_range_supplied'
  | 'not_comparable';

export type RangeProvenance = 'lab_supplied' | 'general_population' | 'none';

export type LabInterpretation =
  | 'normal'
  | 'high'
  | 'low'
  | 'critical_high'
  | 'critical_low'
  | 'abnormal'
  | 'other';

export interface NormalizedQuantity {
  rawValue: number;
  rawUnit: string;
  ucumCode: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  conversionNote: string | null;
  comparator: '<' | '<=' | '>=' | '>' | null;
}

export interface NormalizedReferenceRange {
  low: number | null;
  high: number | null;
  unit: string | null;
  text: string | null;
  provenance: RangeProvenance;
  generalRangeSource?: string;
}

export interface NormalizedObservation {
  sourceKey: string;
  loinc: string | null;
  codings: { system: string; code: string; display?: string }[];
  analyteId: string | null;
  displayName: string;
  effectiveAt: string;
  issuedAt: string | null;
  status: string;
  category: string | null;
  quantity: NormalizedQuantity | null;
  valueText: string | null;
  referenceRange: NormalizedReferenceRange | null;
  rangeStatus: RangeStatus;
  labInterpretation: LabInterpretation | null;
  labComment: string | null;
  provider: { sourceName: string | null; performerName: string | null };
  panelKeys: string[];
  fhirRelease: 'dstu2' | 'r4' | 'unknown';
  importedAt: string;
}

/**
 * Release-agnostic input to the parser. The FHIR-shaped adapter lives in the
 * ingest worker; this module never sees DSTU2 or R4 structures directly, which
 * keeps it testable without FHIR fixtures.
 */
export interface RawLabInput {
  loinc?: string | null;
  codings?: { system: string; code: string; display?: string }[];
  codeText?: string | null;
  effectiveAt?: string | null;
  issuedAt?: string | null;
  status?: string | null;
  category?: string | null;
  value?: number | string | null;
  unit?: string | null;
  ucumCode?: string | null;
  comparator?: string | null;
  valueText?: string | null;
  referenceRange?: {
    low?: number | null;
    high?: number | null;
    unit?: string | null;
    text?: string | null;
  } | null;
  interpretationCode?: string | null;
  comment?: string | null;
  sourceName?: string | null;
  performerName?: string | null;
  fhirRelease?: 'dstu2' | 'r4' | 'unknown';
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const LAB_LIMITS = {
  /** Z for a one-sided 95% reference change value. NOT 2.33 — that is one-sided 99%. */
  RCV_Z_ONE_SIDED_95: 1.65,
  RCV_Z_TWO_SIDED_95: 1.96,
  RCV_Z_TWO_SIDED_99: 2.58,
  /** Above this total CV the symmetric RCV misbehaves; use the log-normal form. */
  LOGNORMAL_TOTAL_CV_THRESHOLD: 20,
  /** Results older than this never fire a critical prompt. */
  CRITICAL_PROMPT_MAX_AGE_DAYS: 14,
  /** Volatile analytes need at least this many results before a direction is drawn. */
  MIN_RESULTS_FOR_VOLATILE: 4,
  /** Statuses whose values may be shown and trended. */
  TRENDABLE_STATUSES: ['final', 'amended', 'corrected'] as readonly string[],
  /** Statuses that may be shown but never trended. */
  DISPLAY_ONLY_STATUSES: ['preliminary', 'unknown'] as readonly string[],
} as const;

/** Rank used to decide whether an incoming result replaces a stored one. */
export function statusRank(status: string | null | undefined): number {
  switch ((status ?? '').toLowerCase()) {
    case 'corrected':
    case 'amended':
      return 3;
    case 'final':
      return 2;
    case 'preliminary':
      return 1;
    default:
      return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Unit string normalization — purely syntactic, lossless              */
/* ------------------------------------------------------------------ */

/**
 * Tidy a unit string for lookup. This is string hygiene, NOT conversion:
 * nothing here changes the physical quantity a value represents.
 *
 * The mu-folding matters in practice — U+00B5 (micro sign) and U+03BC (Greek
 * small letter mu) are visually identical and both occur in real lab feeds.
 */
export function normalizeUnitString(raw: string | null | undefined): string {
  if (raw == null) return '';
  let u = String(raw).trim().replace(/\s+/g, ' ');
  if (u === '') return '';
  // Remove whitespace either side of the solidus: "mg / dL" and "mg/dL" are one unit.
  u = u.replace(/\s*\/\s*/g, '/');

  // Fold both mu codepoints and the ASCII stand-in to 'u'.
  u = u.replace(/[µμ]/g, 'u');
  // 'mc' prefix (mcg) is another ASCII stand-in for micro.
  u = u.replace(/\bmcg\b/g, 'ug').replace(/\bmcmol\b/g, 'umol');

  // Case-fold ONLY the volume denominator. Never the numerator: mU and MU differ.
  u = u.replace(/\/\s*d\s*l\b/gi, '/dL').replace(/\/\s*l\b/gi, '/L');
  u = u.replace(/\/\s*m\s*l\b/gi, '/mL').replace(/\/\s*u\s*l\b/gi, '/uL');

  // Unify UCUM exponent spellings for cell counts.
  u = u
    .replace(/x?10\s*[\^*eE]\s*3/g, '10*3')
    .replace(/x?10\s*[\^*eE]\s*6/g, '10*6')
    .replace(/x?10\s*[\^*eE]\s*9/g, '10*9')
    .replace(/x?10\s*[\^*eE]\s*12/g, '10*12');
  if (/^K\/uL$/i.test(u)) u = '10*3/uL';
  if (/^M\/uL$/i.test(u)) u = '10*6/uL';

  // Percent spellings.
  if (/^percent$/i.test(u) || u === '%') u = '%';

  // UCUM curly-brace annotations on the eGFR unit.
  u = u.replace(/\{1\.73_m2\}/g, '1.73m2').replace(/1\.73\s*m2/gi, '1.73m2');

  // Strip UCUM square brackets used for arbitrary units: u[IU]/mL → uIU/mL.
  u = u.replace(/\[(IU|iU)\]/g, 'IU');

  return u;
}

/* ------------------------------------------------------------------ */
/* Unit conversion — with an explicit refusal path                     */
/* ------------------------------------------------------------------ */

export interface ConversionResult {
  /** null when we declined to convert. This is a first-class, expected outcome. */
  value: number | null;
  unit: string | null;
  /** Populated when `value` is null, or when the conversion carries a caveat. */
  note: string | null;
  /** Discriminates "refused" from "converted with a note". */
  refused: boolean;
}

/**
 * Convert a value into the analyte's canonical unit.
 *
 * Returns `{ value: null, refused: true }` for any (analyte, unit) pair not in
 * the catalogue, and for pairs explicitly marked `refuse`. The caller MUST
 * display the raw value and unit in that case, and MUST NOT guess.
 */
export function convertToCanonical(
  meta: AnalyteMeta,
  rawValue: number,
  rawUnit: string,
): ConversionResult {
  const canonical = meta.canonicalUnit;
  const u = normalizeUnitString(rawUnit);

  if (!Number.isFinite(rawValue)) {
    return { value: null, unit: null, note: 'Value is not a finite number.', refused: true };
  }

  if (u === '') {
    return {
      value: null,
      unit: null,
      note: 'The lab did not supply a unit, so this value cannot be normalized.',
      refused: true,
    };
  }

  // Exact match first, then a case-insensitive pass over the catalogue keys —
  // labs are inconsistent about capitalisation in ways normalizeUnitString
  // deliberately does not "fix" (it would be unsafe on the numerator).
  let conv: Conversion | undefined = meta.units[u];
  if (!conv) {
    for (const [k, v] of Object.entries(meta.units)) {
      if (normalizeUnitString(k).toLowerCase() === u.toLowerCase()) {
        conv = v;
        break;
      }
    }
  }

  if (!conv) {
    return {
      value: null,
      unit: null,
      note:
        `We don't have a verified conversion from "${rawUnit}" for ${meta.displayName}, ` +
        `so this is shown exactly as your lab reported it. A wrong conversion on a lab ` +
        `value is worse than none.`,
      refused: true,
    };
  }

  switch (conv.kind) {
    case 'identity':
      return { value: rawValue, unit: canonical, note: conv.note ?? null, refused: false };
    case 'linear': {
      const out = rawValue * conv.factor + (conv.offset ?? 0);
      return { value: out, unit: canonical, note: conv.note ?? null, refused: false };
    }
    case 'refuse':
      return { value: null, unit: null, note: conv.reason, refused: true };
  }
}

/**
 * Invert a conversion. Used for round-trip verification and for rendering a
 * canonical value back in the lab's own unit.
 */
export function convertFromCanonical(
  meta: AnalyteMeta,
  canonicalValue: number,
  targetUnit: string,
): ConversionResult {
  const u = normalizeUnitString(targetUnit);
  let conv: Conversion | undefined = meta.units[u];
  if (!conv) {
    for (const [k, v] of Object.entries(meta.units)) {
      if (normalizeUnitString(k).toLowerCase() === u.toLowerCase()) {
        conv = v;
        break;
      }
    }
  }
  if (!conv) {
    return { value: null, unit: null, note: 'Unknown target unit.', refused: true };
  }
  switch (conv.kind) {
    case 'identity':
      return { value: canonicalValue, unit: u, note: null, refused: false };
    case 'linear':
      return {
        value: (canonicalValue - (conv.offset ?? 0)) / conv.factor,
        unit: u,
        note: null,
        refused: false,
      };
    case 'refuse':
      return { value: null, unit: null, note: conv.reason, refused: true };
  }
}

/* ------------------------------------------------------------------ */
/* Reference-range parsing                                             */
/* ------------------------------------------------------------------ */

const NUM = String.raw`-?\d[\d,]*(?:\.\d+)?`;

/**
 * Conservatively parse a lab's printed range string.
 *
 * Real feeds populate `text` more reliably than the structured `low`/`high`
 * fields, so this exists as a fallback rather than a curiosity. Anything not
 * matched returns null — we never guess, and in particular we never pick a sex
 * or age stratum out of a string like "Male: 13-17 Female: 12-16".
 */
export function parseReferenceRangeText(
  text: string | null | undefined,
): { low: number | null; high: number | null } | null {
  if (!text) return null;
  const t = String(text).trim();
  if (t === '') return null;
  if (/not\s*estab/i.test(t)) return null;
  if (/see\s*(report|below|note)/i.test(t)) return null;
  // Sex- or age-stratified strings: refuse rather than choose.
  if (/(male|female|men|women)\s*:/i.test(t)) return null;
  if (/age\s*(dependent|specific)/i.test(t)) return null;

  const strip = (s: string) => parseFloat(s.replace(/,/g, ''));

  // "3.1 - 6.2", "13.5–17.5", "70 to 99"
  const range = new RegExp(`^(${NUM})\\s*(?:-|–|—|to)\\s*(${NUM})$`, 'i').exec(t);
  if (range) {
    const a = strip(range[1]);
    const b = strip(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    // A reversed range signals a format we don't understand. Discard, don't swap.
    if (a > b) return null;
    return { low: a, high: b };
  }

  // "<100", "<= 5.7", "less than 100"
  const upper = new RegExp(`^(?:<|<=|≤|less\\s+than)\\s*(${NUM})$`, 'i').exec(t);
  if (upper) {
    const b = strip(upper[1]);
    return Number.isFinite(b) ? { low: null, high: b } : null;
  }

  // ">40", ">= 60", "greater than 40"
  const lower = new RegExp(`^(?:>|>=|≥|greater\\s+than)\\s*(${NUM})$`, 'i').exec(t);
  if (lower) {
    const a = strip(lower[1]);
    return Number.isFinite(a) ? { low: a, high: null } : null;
  }

  return null;
}

/**
 * Resolve the range to use, honouring the precedence rule: the user's own lab
 * always wins; a general-population range is a labelled fallback.
 */
export function resolveReferenceRange(
  meta: AnalyteMeta | null,
  labRange: RawLabInput['referenceRange'],
): NormalizedReferenceRange | null {
  // 1. Structured low/high from the lab.
  if (labRange && (labRange.low != null || labRange.high != null)) {
    return {
      low: labRange.low ?? null,
      high: labRange.high ?? null,
      unit: labRange.unit ?? null,
      text: labRange.text ?? null,
      provenance: 'lab_supplied',
    };
  }
  // 2. The lab's printed text, parsed conservatively.
  if (labRange?.text) {
    const parsed = parseReferenceRangeText(labRange.text);
    if (parsed) {
      return {
        low: parsed.low,
        high: parsed.high,
        unit: labRange.unit ?? null,
        text: labRange.text,
        provenance: 'lab_supplied',
      };
    }
    // Text present but unparseable — keep it for display, but do not classify.
    return {
      low: null,
      high: null,
      unit: labRange.unit ?? null,
      text: labRange.text,
      provenance: 'lab_supplied',
    };
  }
  // 3. General-population fallback, only where the catalogue defines one.
  const g = meta?.generalRange;
  if (g && (g.low != null || g.high != null)) {
    return {
      low: g.low,
      high: g.high,
      unit: g.unit,
      text: null,
      provenance: 'general_population',
      generalRangeSource: g.note,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Range classification                                                */
/* ------------------------------------------------------------------ */

/**
 * Compare a value against a range.
 *
 * Boundary values classify `in_range` — `value === low` and `value === high`
 * are both inside. There is no "borderline" and no "high-normal" band; those
 * are interpretations dressed as classifications.
 */
export function classifyAgainstRange(
  value: number | null,
  range: NormalizedReferenceRange | null,
  opts?: { valueUnit?: string | null; meta?: AnalyteMeta | null },
): RangeStatus {
  if (value == null || !Number.isFinite(value)) return 'not_comparable';
  if (!range || (range.low == null && range.high == null)) return 'no_range_supplied';

  // Unit mismatch: try to convert the range, and refuse to compare if we can't.
  let low = range.low;
  let high = range.high;
  const vUnit = normalizeUnitString(opts?.valueUnit);
  const rUnit = normalizeUnitString(range.unit);
  if (vUnit && rUnit && vUnit !== rUnit) {
    const meta = opts?.meta;
    if (!meta) return 'not_comparable';
    const canonVal = convertToCanonical(meta, value, vUnit);
    const canonLow = low == null ? null : convertToCanonical(meta, low, rUnit);
    const canonHigh = high == null ? null : convertToCanonical(meta, high, rUnit);
    if (canonVal.refused) return 'not_comparable';
    if (canonLow?.refused || canonHigh?.refused) return 'not_comparable';
    const v = canonVal.value as number;
    low = canonLow?.value ?? null;
    high = canonHigh?.value ?? null;
    if (low != null && v < low) return 'below';
    if (high != null && v > high) return 'above';
    return 'in_range';
  }

  if (low != null && value < low) return 'below';
  if (high != null && value > high) return 'above';
  return 'in_range';
}

/* ------------------------------------------------------------------ */
/* Source key — deterministic, content-derived, idempotent             */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a 64-bit, implemented on BigInt so it is exact and dependency-free.
 *
 * Not a cryptographic hash: this is an identity key inside an already-encrypted
 * store, not a security boundary. SubtleCrypto is async and unavailable inside
 * a pure synchronous function.
 */
export function fnv1a64Hex(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    // Hash UTF-16 code units as two bytes so non-ASCII is handled deterministically.
    const c = input.charCodeAt(i);
    h = ((h ^ BigInt(c & 0xff)) * PRIME) & MASK;
    h = ((h ^ BigInt((c >> 8) & 0xff)) * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/** ISO 8601 → UTC, truncated to the minute. Throws nothing; returns '' on junk. */
export function utcMinute(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(Math.floor(t / 60000) * 60000).toISOString().slice(0, 16) + 'Z';
}

/**
 * Deterministic identity for a lab result.
 *
 * Deliberately EXCLUDES the provider name, the provider's resource id, and any
 * import timestamp — including any of them would let the same result arrive
 * twice from two connected providers. Deliberately INCLUDES the value, so two
 * genuinely different results at the same minute (a repeat run on a haemolysed
 * specimen) are kept as two results rather than one being silently discarded.
 */
export function computeSourceKey(input: {
  loinc?: string | null;
  codings?: { system: string; code: string }[];
  codeText?: string | null;
  effectiveAt?: string | null;
  value?: number | null;
  valueText?: string | null;
  unit?: string | null;
}): string {
  let identity: string;
  if (input.loinc) {
    identity = `loinc:${input.loinc}`;
  } else if (input.codings && input.codings.length > 0) {
    const c = input.codings[0];
    identity = `local:${c.system}#${c.code}`;
  } else {
    identity = `text:${(input.codeText ?? '').trim().toLowerCase()}`;
  }
  const valuePart =
    input.value != null && Number.isFinite(input.value)
      ? input.value.toPrecision(12)
      : (input.valueText ?? '').trim();
  const parts = [identity, utcMinute(input.effectiveAt), valuePart, normalizeUnitString(input.unit)];
  return 'obs:' + fnv1a64Hex(parts.join('|'));
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function coerceNumber(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Values arrive as strings in the wild: "6.3", "6.3 mg/dL", "<0.2".
  const m = /-?\d+(?:\.\d+)?/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

const INTERPRETATION_MAP: Record<string, LabInterpretation> = {
  N: 'normal',
  H: 'high',
  L: 'low',
  HH: 'critical_high',
  LL: 'critical_low',
  '>': 'high',
  '<': 'low',
  A: 'abnormal',
  AA: 'abnormal',
};

/**
 * Parse a release-agnostic raw lab input into the internal model.
 *
 * Never throws. A result that cannot be modelled returns with `quantity: null`
 * and `valueText` populated, or with `rangeStatus: 'not_comparable'` — the
 * import pipeline counts these rather than failing.
 */
export function parseObservation(
  raw: RawLabInput,
  cat: Catalogue,
  loincIndex: Map<string, string>,
  importedAt: string,
): NormalizedObservation | null {
  const effectiveAt = raw.effectiveAt ?? raw.issuedAt ?? null;
  // A lab value without a date cannot be trended and must not sit beside dated
  // values as though it were current. Reject rather than guess.
  if (!effectiveAt || Number.isNaN(Date.parse(effectiveAt))) return null;

  const loinc = raw.loinc ?? null;
  const analyteId = loinc ? (loincIndex.get(loinc) ?? null) : null;
  const meta = analyteId ? cat.analytes[analyteId] : null;

  const numeric = coerceNumber(raw.value);
  let quantity: NormalizedQuantity | null = null;
  let valueText: string | null = raw.valueText ?? null;

  if (numeric != null) {
    const rawUnit = raw.ucumCode ?? raw.unit ?? '';
    const conv = meta
      ? convertToCanonical(meta, numeric, rawUnit)
      : {
          value: null,
          unit: null,
          note:
            'This result is not in our analyte catalogue, so it is shown exactly as your lab reported it.',
          refused: true,
        };
    quantity = {
      rawValue: numeric,
      rawUnit: String(rawUnit),
      ucumCode: raw.ucumCode ?? null,
      canonicalValue: conv.value,
      canonicalUnit: conv.unit,
      conversionNote: conv.note,
      comparator: (raw.comparator as NormalizedQuantity['comparator']) ?? null,
    };
  } else if (typeof raw.value === 'string' && raw.value.trim() !== '') {
    valueText = raw.value.trim();
  }

  const referenceRange = resolveReferenceRange(meta, raw.referenceRange ?? null);

  // Classify in canonical space when we have it, otherwise in raw space.
  const compareValue = quantity?.canonicalValue ?? quantity?.rawValue ?? null;
  const compareUnit = quantity?.canonicalValue != null ? quantity.canonicalUnit : quantity?.rawUnit;
  // A censored value ("<0.2") is not a measurement; it is not classified.
  const rangeStatus =
    quantity?.comparator != null
      ? 'not_comparable'
      : classifyAgainstRange(compareValue, referenceRange, {
          valueUnit: compareUnit ?? null,
          meta,
        });

  const interpCode = (raw.interpretationCode ?? '').trim().toUpperCase();
  const labInterpretation = interpCode ? (INTERPRETATION_MAP[interpCode] ?? 'other') : null;

  const displayName =
    meta?.displayName ?? raw.codeText ?? raw.codings?.[0]?.display ?? '(unnamed result)';

  return {
    sourceKey: computeSourceKey({
      loinc,
      codings: raw.codings,
      codeText: raw.codeText,
      effectiveAt,
      value: numeric,
      valueText,
      unit: raw.ucumCode ?? raw.unit,
    }),
    loinc,
    codings: raw.codings ?? [],
    analyteId,
    displayName,
    effectiveAt,
    issuedAt: raw.issuedAt ?? null,
    status: (raw.status ?? 'unknown').toLowerCase(),
    category: raw.category ?? null,
    quantity,
    valueText,
    referenceRange,
    rangeStatus,
    labInterpretation,
    labComment: raw.comment ?? null,
    provider: {
      sourceName: raw.sourceName ?? null,
      performerName: raw.performerName ?? null,
    },
    panelKeys: [],
    fhirRelease: raw.fhirRelease ?? 'unknown',
    importedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Reference change value                                              */
/* ------------------------------------------------------------------ */

export interface RcvResult {
  /** Percentage rise that exceeds noise. Positive. */
  upPct: number;
  /** Percentage fall that exceeds noise. Negative. */
  downPct: number;
  /** True when the log-normal (asymmetric) form was used. */
  logNormal: boolean;
  z: number;
}

/**
 * Reference change value.
 *
 * Symmetric (Fraser–Harris):  RCV% = Z · √2 · √(CVa² + CVi²)
 * Log-normal (Fokkema/Lund):  RCV%(±) = 100·(exp(±Z·√2·√(ln(1+CVa²)+ln(1+CVi²))) − 1)
 *
 * The log-normal form is what EFLM currently recommends, and above roughly 20%
 * total CV it is a correctness requirement rather than a refinement: the
 * symmetric form can emit a downward threshold beyond −100%, which is
 * physically impossible.
 *
 * Z defaults to 1.65 (one-sided 95%) because the clinical question is
 * directional. NOT 2.33 — that is one-sided 99%.
 */
export function referenceChangeValue(
  cviPct: number,
  cvaPct: number,
  opts?: { z?: number; forceLogNormal?: boolean },
): RcvResult {
  const z = opts?.z ?? LAB_LIMITS.RCV_Z_ONE_SIDED_95;
  const totalCv = Math.sqrt(cviPct * cviPct + cvaPct * cvaPct);
  const useLog =
    opts?.forceLogNormal ?? totalCv >= LAB_LIMITS.LOGNORMAL_TOTAL_CV_THRESHOLD;

  if (!useLog) {
    const rcv = z * Math.SQRT2 * totalCv;
    return { upPct: rcv, downPct: -rcv, logNormal: false, z };
  }

  const ci = cviPct / 100;
  const ca = cvaPct / 100;
  const sd = Math.sqrt(Math.log(1 + ca * ca) + Math.log(1 + ci * ci));
  const k = z * Math.SQRT2 * sd;
  return {
    upPct: 100 * (Math.exp(k) - 1),
    downPct: 100 * (Math.exp(-k) - 1),
    logNormal: true,
    z,
  };
}

/* ------------------------------------------------------------------ */
/* Trend                                                               */
/* ------------------------------------------------------------------ */

export type TrendDirection = 'rising' | 'falling' | 'stable' | 'indeterminate';

export interface LabPoint {
  effectiveAt: string;
  /** Canonical value. Points with a null value or a comparator are excluded upstream. */
  value: number;
  unit: string;
  status?: string;
  /** Provider, used to widen the threshold when a series spans labs. */
  sourceName?: string | null;
}

export interface TrendResult {
  analyteId: string;
  direction: TrendDirection;
  /** Change from the previous comparable point, in canonical units. */
  deltaAbs: number | null;
  deltaPct: number | null;
  /** The RCV thresholds actually applied. */
  rcv: RcvResult | null;
  /** True when the change cleared BOTH the RCV and the clinical floor. */
  exceedsNoise: boolean;
  /** Populated when we declined to draw a direction, with the reason. */
  suppressedReason: string | null;
  /** Points actually used, after filtering. */
  usedPoints: number;
  /** True when the series spans more than one reporting unit. */
  mixedUnits: boolean;
  /** True when the series spans more than one provider (widens the threshold). */
  mixedProviders: boolean;
  findings: Finding[];
}

/**
 * Trend a single analyte.
 *
 * Refuses to draw a direction when:
 *  - fewer than two comparable points exist;
 *  - the analyte is flagged `singlePairTrendUnreliable` and there are fewer
 *    than four points (hs-CRP, serum iron, ferritin, insulin, triglycerides…);
 *  - the change is within the reference change value;
 *  - the change is within the analyte's absolute clinical floor, however
 *    statistically significant (sodium, calcium, albumin, MCV, HbA1c).
 *
 * The series is filtered to a single unit — mixed-unit series are never joined
 * into one line, because a unit change is not a data point.
 */
export function trendAnalyte(
  analyteId: string,
  meta: AnalyteMeta,
  points: readonly LabPoint[],
): TrendResult {
  const empty = (reason: string, used: number, mixedUnits = false): TrendResult => ({
    analyteId,
    direction: 'indeterminate',
    deltaAbs: null,
    deltaPct: null,
    rcv: null,
    exceedsNoise: false,
    suppressedReason: reason,
    usedPoints: used,
    mixedUnits,
    mixedProviders: false,
    findings: [info('LAB_TREND_INSUFFICIENT_DATA', reason)],
  });

  const trendable = points
    .filter(
      (p) =>
        Number.isFinite(p.value) &&
        (p.status == null ||
          LAB_LIMITS.TRENDABLE_STATUSES.includes(p.status.toLowerCase())),
    )
    .slice()
    .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));

  if (trendable.length < 2) {
    return empty(
      `One result isn't a trend. ${meta.displayName} needs at least two comparable results.`,
      trendable.length,
    );
  }

  // Split by unit and keep the largest single-unit run. Never join across units.
  const byUnit = new Map<string, LabPoint[]>();
  for (const p of trendable) {
    const u = normalizeUnitString(p.unit);
    const arr = byUnit.get(u) ?? [];
    arr.push(p);
    byUnit.set(u, arr);
  }
  const mixedUnits = byUnit.size > 1;
  let series = trendable;
  if (mixedUnits) {
    let best: LabPoint[] = [];
    for (const arr of byUnit.values()) if (arr.length > best.length) best = arr;
    series = best;
    if (series.length < 2) {
      return empty(
        `These results came from labs reporting ${meta.displayName} in different units, and we ` +
          `couldn't convert between them, so there aren't two comparable results to trend.`,
        series.length,
        true,
      );
    }
  }

  const bv = meta.biologicalVariation;
  if (!bv) {
    return empty(
      `We don't have biological-variation data for ${meta.displayName}, so we can't tell a real ` +
        `change from assay noise. The values are shown without a trend.`,
      series.length,
      mixedUnits,
    );
  }

  if (bv.singlePairTrendUnreliable && series.length < LAB_LIMITS.MIN_RESULTS_FOR_VOLATILE) {
    return empty(
      `${meta.displayName} varies enough between draws that two or three results can't ` +
        `distinguish a real change from noise — it typically has to move by more than half ` +
        `again to mean anything. We'll show a direction once there are at least ` +
        `${LAB_LIMITS.MIN_RESULTS_FOR_VOLATILE} results.`,
      series.length,
      mixedUnits,
    );
  }

  const providers = new Set(series.map((p) => p.sourceName ?? '').filter((s) => s !== ''));
  const mixedProviders = providers.size > 1;
  // A series spanning providers spans assay platforms; widen the analytical CV.
  const cva = mixedProviders ? bv.cva * 1.5 : bv.cva;

  const rcv = referenceChangeValue(bv.cvi, cva, {
    forceLogNormal: bv.logNormal ?? undefined,
  });

  // Compare the most recent point against the previous one. For volatile
  // analytes we compare against the median of the prior points instead, which
  // is the standard mitigation for a large CVi.
  const latest = series[series.length - 1];
  const prior = series.slice(0, -1);
  let baseline: number;
  let baselineLabel: string;
  if (bv.singlePairTrendUnreliable) {
    const sorted = prior.map((p) => p.value).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    baseline =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    baselineLabel = 'the median of your earlier results';
  } else {
    baseline = prior[prior.length - 1].value;
    baselineLabel = 'your previous result';
  }

  const deltaAbs = latest.value - baseline;
  const deltaPct = baseline === 0 ? null : (deltaAbs / baseline) * 100;

  const findings: Finding[] = [];
  let direction: TrendDirection = 'stable';
  let exceedsNoise = false;
  let suppressedReason: string | null = null;

  const floor = bv.clinicalFloor ?? null;
  const withinFloor = floor != null && Math.abs(deltaAbs) < floor;
  const withinRcv =
    deltaPct == null ? true : deltaPct >= rcv.downPct && deltaPct <= rcv.upPct;

  if (withinRcv) {
    direction = 'stable';
    suppressedReason = 'within_reference_change_value';
    findings.push(
      info(
        'LAB_TREND_WITHIN_NOISE',
        `${meta.displayName} moved from ${fmt(baseline)} to ${fmt(latest.value)} ${latest.unit} ` +
          `compared with ${baselineLabel}. That's within the normal variation for this test — ` +
          `the assay itself and ordinary day-to-day biology account for a swing of about ` +
          `${fmt(Math.abs(rcv.downPct))}–${fmt(rcv.upPct)}%, so this isn't a change.`,
      ),
    );
  } else if (withinFloor) {
    direction = 'stable';
    suppressedReason = 'within_clinical_floor';
    findings.push(
      info(
        'LAB_TREND_BELOW_CLINICAL_FLOOR',
        `${meta.displayName} moved by ${fmt(Math.abs(deltaAbs))} ${latest.unit}. That is large ` +
          `enough to be statistically detectable — this test is very tightly controlled — but a ` +
          `move that small doesn't mean anything on its own.`,
      ),
    );
  } else {
    exceedsNoise = true;
    direction = deltaAbs > 0 ? 'rising' : 'falling';
    const dirWord = direction === 'rising' ? 'higher' : 'lower';
    findings.push(
      info(
        'LAB_TREND_EXCEEDS_NOISE',
        `${meta.displayName} is ${fmt(Math.abs(deltaPct ?? 0))}% ${dirWord} than ${baselineLabel} ` +
          `(${fmt(baseline)} → ${fmt(latest.value)} ${latest.unit}). That's more than the assay ` +
          `and normal biology would produce on their own, so it's a real move.`,
      ),
    );
    if (meta.movedUpBy?.length && meta.movedDownBy?.length) {
      const causes = direction === 'rising' ? meta.movedUpBy : meta.movedDownBy;
      findings.push(
        info(
          'LAB_TREND_COMMON_CAUSES',
          `Things that commonly move ${meta.displayName} ${direction === 'rising' ? 'up' : 'down'}: ` +
            `${causes.join('; ')}.`,
        ),
      );
    }
  }

  if (mixedProviders) {
    findings.push(
      info(
        'LAB_TREND_MIXED_PROVIDERS',
        `These results came from more than one lab. Different platforms measure ` +
          `${meta.displayName} slightly differently, so we've widened the threshold for calling ` +
          `something a real change.`,
      ),
    );
  }
  if (mixedUnits) {
    findings.push(
      info(
        'LAB_TREND_MIXED_UNITS',
        `Some of your ${meta.displayName} results were reported in a different unit that we ` +
          `don't convert. Only the results sharing one unit are trended here.`,
      ),
    );
  }
  if (bv.provenance === 'unverified') {
    findings.push(
      info(
        'LAB_BV_UNVERIFIED',
        `The variation figures behind this comparison for ${meta.displayName} are widely used ` +
          `but were not verified against the source database, so treat the threshold as ` +
          `approximate.`,
      ),
    );
  }

  return {
    analyteId,
    direction,
    deltaAbs,
    deltaPct,
    rcv,
    exceedsNoise,
    suppressedReason,
    usedPoints: series.length,
    mixedUnits,
    mixedProviders,
    findings,
  };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/* ------------------------------------------------------------------ */
/* Evaluation → Findings                                               */
/* ------------------------------------------------------------------ */

export interface EvaluationContext {
  /** ISO 8601. Passed in so the module stays pure. */
  now: string;
  /** Trigger keys the app can evidence, e.g. 'creatine_in_supplement_stack'. */
  activeTriggers?: readonly string[];
  /** Goals from the athlete profile, used to select goalContext entries. */
  goals?: readonly string[];
  /** True when guardrails.ts has produced ED_SCREEN_POSITIVE or ED_HISTORY. */
  edGateActive?: boolean;
  /** A clinician instruction the user logged about this analyte, if any. */
  loggedClinicalInstruction?: { date: string; text: string } | null;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(b - a) / 86_400_000;
}

/**
 * Evaluate one observation and return findings.
 *
 * Ordering is load-bearing: a logged clinical instruction comes first and the
 * app's own commentary is subordinated to it; a critical prompt comes next and
 * is never suppressed by anything below it.
 */
export function evaluateObservation(
  obs: NormalizedObservation,
  meta: AnalyteMeta | null,
  ctx: EvaluationContext,
): Finding[] {
  const out: Finding[] = [];
  const name = obs.displayName;
  const q = obs.quantity;
  const unit = q?.canonicalUnit ?? q?.rawUnit ?? '';
  const value = q?.canonicalValue ?? q?.rawValue ?? null;

  /* 1. A logged clinical instruction outranks everything the app has to say. */
  if (ctx.loggedClinicalInstruction) {
    out.push(
      info(
        'LAB_DEFER_TO_CLINICIAN',
        `Your clinician's note on this, from ${ctx.loggedClinicalInstruction.date}: ` +
          `"${ctx.loggedClinicalInstruction.text}" That's the guidance that applies. Anything ` +
          `below is general context, not a second opinion.`,
      ),
    );
  }

  /* 2. Critical values. Never suppressed, never explained. */
  const crit = meta?.critical;
  const ageDays = daysBetween(obs.effectiveAt, ctx.now);
  const statusOk = LAB_LIMITS.TRENDABLE_STATUSES.includes(obs.status);
  if (
    crit &&
    value != null &&
    statusOk &&
    obs.quantity?.comparator == null &&
    ((crit.low != null && value < crit.low) || (crit.high != null && value > crit.high))
  ) {
    if (ageDays <= LAB_LIMITS.CRITICAL_PROMPT_MAX_AGE_DAYS) {
      out.push(
        block(
          'LAB_CRITICAL_VALUE',
          `This result is a long way outside the reference range. Your ${name} was ` +
            `${fmt(value)} ${unit}. Please contact your doctor promptly about this result. If ` +
            `you feel unwell, seek urgent medical care rather than waiting. We're not going to ` +
            `guess what it means — that's a question for someone who can examine you and see ` +
            `your whole record.`,
        ),
      );
    } else {
      out.push(
        warn(
          'LAB_CRITICAL_VALUE_HISTORICAL',
          `This result, from ${obs.effectiveAt.slice(0, 10)}, was well outside the range at the ` +
            `time. Your care team would have seen it then. If it hasn't been followed up, it's ` +
            `worth asking about.`,
        ),
      );
    }
  }

  /* 3. Conversion refusal. */
  if (q && q.canonicalValue == null && q.conversionNote) {
    out.push(info('LAB_UNIT_NOT_CONVERTED', q.conversionNote));
  }

  /* 4. Censored value. */
  if (q?.comparator) {
    out.push(
      info(
        'LAB_VALUE_CENSORED',
        `Reported as ${q.comparator}${fmt(q.rawValue)} ${q.rawUnit} — the result was outside what ` +
          `the assay measures precisely. Shown as reported, and left out of trend calculations.`,
      ),
    );
  }

  /* 5. Range classification. */
  const rr = obs.referenceRange;
  const rangeStr =
    rr && (rr.low != null || rr.high != null)
      ? rr.low != null && rr.high != null
        ? `${fmt(rr.low)}–${fmt(rr.high)}`
        : rr.low != null
          ? `above ${fmt(rr.low)}`
          : `below ${fmt(rr.high as number)}`
      : null;

  if (obs.rangeStatus === 'above' || obs.rangeStatus === 'below') {
    const word = obs.rangeStatus === 'above' ? 'above' : 'below';
    if (rr?.provenance === 'general_population') {
      out.push(
        warn(
          'LAB_OUT_OF_GENERAL_RANGE',
          `${name} is ${word} a general adult range (${rangeStr} ${rr.unit ?? unit}). Your lab ` +
            `didn't send a range with this result, so that's what it's compared against — it is ` +
            `not your lab's range, and ranges are specific to the assay and the lab.`,
        ),
      );
    } else {
      const parts = [`${name} is ${word} your lab's range — ${fmt(value ?? 0)} ${unit}, against ` +
        `their ${rangeStr}.`];
      if (meta?.whatItMeasures) parts.push(meta.whatItMeasures);
      const causes = obs.rangeStatus === 'above' ? meta?.movedUpBy : meta?.movedDownBy;
      if (causes?.length) {
        parts.push(
          `Things that commonly move it in that direction: ${causes.join('; ')}.`,
        );
      }
      if (meta?.controllable?.length) {
        parts.push(`Of those, what you can influence: ${meta.controllable.join('; ')}.`);
      }
      out.push(warn('LAB_OUT_OF_LAB_RANGE', parts.join(' ')));
    }
  } else if (obs.rangeStatus === 'no_range_supplied') {
    out.push(
      info(
        'LAB_NO_RANGE_SUPPLIED',
        `Your lab didn't include a reference range with this result, and this isn't an analyte ` +
          `we're confident enough to supply a general one for. The value is ${fmt(value ?? 0)} ${unit}.`,
      ),
    );
  } else if (obs.rangeStatus === 'not_comparable' && q && !q.comparator) {
    out.push(
      info(
        'LAB_RANGE_NOT_COMPARABLE',
        `Your lab's range for ${name} is in a different unit from the result, and we don't have a ` +
          `verified conversion between them — so both are shown, uncompared.`,
      ),
    );
  } else if (obs.rangeStatus === 'in_range' && rr?.provenance === 'general_population') {
    out.push(
      info(
        'LAB_GENERAL_RANGE_USED',
        `Compared against a general adult range (${rangeStr} ${rr.unit ?? unit}) — your lab ` +
          `didn't supply one. That's not your lab's range, and theirs is the one that applies.`,
      ),
    );
  }

  /* 6. Goal-relevant range. In-range on the lab's scale but outside a goal
        range is information, never an alert — it can never escalate past info. */
  const gc = meta?.goalContext;
  if (gc && value != null && !gc.directionalOnly && ctx.goals?.some((g) => gc.goals.includes(g))) {
    const belowGoal = gc.low != null && value < gc.low;
    const aboveGoal = gc.high != null && value > gc.high;
    if (belowGoal || aboveGoal) {
      const bound = belowGoal ? `${fmt(gc.low as number)}` : `${fmt(gc.high as number)}`;
      const rel = belowGoal ? 'below' : 'above';
      let msg =
        `${name} is ${fmt(value)} ${unit}. ` +
        (obs.rangeStatus === 'in_range'
          ? `That's inside your lab's range, but ${rel} ${bound} ${gc.unit}, `
          : `That's ${rel} ${bound} ${gc.unit}, `) +
        `which is the figure that matters for what you're training for. ${gc.rationale} ` +
        `[${gc.confidence}]`;
      if (gc.caveat) msg += ` One thing worth knowing before acting on it: ${gc.caveat}`;
      out.push(info('LAB_OUTSIDE_GOAL_RANGE', msg));
    }
  }

  /* 7. Artifact rules — alongside the finding, never instead of it. */
  const triggers = new Set(ctx.activeTriggers ?? []);
  for (const rule of meta?.artifactRules ?? []) {
    if (rule.trigger === 'always' || triggers.has(rule.trigger)) {
      out.push(
        info(
          'LAB_ARTIFACT_CONTEXT',
          `${rule.mechanism} What would settle it: ${rule.discriminator}. [${rule.confidence}]`,
        ),
      );
    }
  }

  /* 8. Nutrient link. Routed through the ED gate rather than emitted here when
        the gate is active — advice-policy.md makes those rules non-overridable
        by any recommendation tier. */
  if (meta?.micronutrientKey && obs.rangeStatus === 'below' && rr?.provenance === 'lab_supplied') {
    if (ctx.edGateActive) {
      out.push(
        info(
          'LAB_NUTRIENT_ROUTED_TO_GUARDRAILS',
          `This result is relevant to your ${meta.micronutrientKey} intake. We're handling that ` +
            `through your nutrition screen rather than here.`,
        ),
      );
    } else {
      out.push(
        info(
          'LAB_NUTRIENT_LINK',
          `${name} is one of the nutrients tracked on your micronutrient screen, which has your ` +
            `intake for it alongside this result and can suggest how to close a gap.`,
        ),
      );
    }
  }

  /* 9. Preliminary / status caveats. */
  if (obs.status === 'preliminary') {
    out.push(
      info('LAB_STATUS_PRELIMINARY', 'Your lab marked this result preliminary — it may be revised.'),
    );
  } else if (obs.status === 'unknown') {
    out.push(info('LAB_STATUS_UNKNOWN', "Your lab didn't say whether this result is final."));
  }

  /* 10. The lab's own flag wins over ours where they disagree. */
  if (obs.labInterpretation && obs.labInterpretation !== 'normal') {
    out.push(
      info(
        'LAB_OWN_INTERPRETATION',
        `Your lab flagged this result as ${obs.labInterpretation.replace('_', ' ')}.`,
      ),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Structural refusals                                                 */
/* ------------------------------------------------------------------ */

/**
 * Clinical indices this module refuses to compute, per
 * `advice-policy.md` Tier 3 and `integration-health-records.md` §9.2.
 *
 * These are not merely "not implemented". A computed number sitting in a
 * results table is indistinguishable from a measured one, and every entry here
 * is a clinical calculation validated for populations and conditions that do
 * not include "a fitness app". Where the LAB reports one, we display it like
 * any other result.
 */
export const REFUSED_DERIVED_INDICES: readonly string[] = [
  'HOMA-IR',
  'QUICKI',
  'TyG index',
  'FIB-4',
  'Free androgen index',
  'Friedewald LDL',
  'Martin-Hopkins LDL',
  'Non-HDL cholesterol',
  'ASCVD risk score',
  'FRAX',
  'MELD',
  'Biological age',
  'Metabolic health score',
  'Inflammation score',
];

/** Always returns a refusal. Exists so the refusal is testable, not just documented. */
export function computeDerivedIndex(name: string): Finding {
  return block(
    'LAB_DERIVED_INDEX_REFUSED',
    `We don't calculate ${name} here. It's a clinical calculation, and a number we worked out ` +
      `ourselves sitting in a results table would look exactly like one your lab measured. If ` +
      `your lab reports it, we'll show it.`,
  );
}

/**
 * Always returns a refusal. Tier 3 rule 1 is absolute: no medication
 * suggestion, hedged or otherwise.
 */
export function medicationSuggestion(): Finding {
  return block(
    'LAB_MEDICATION_REFUSED',
    `We don't give guidance on prescription medication — not starting it, not stopping it, and ` +
      `not changing a dose. If you're on any prescription, that's worth raising with the ` +
      `prescriber alongside this result.`,
  );
}

/** Always returns a refusal. Tier 3 rule 2. */
export function diagnosisFromPattern(): Finding {
  return block(
    'LAB_DIAGNOSIS_REFUSED',
    `We describe what a result is and what a panel measures, but we don't name conditions from ` +
      `lab patterns. That needs someone who can examine you and see your whole record.`,
  );
}
