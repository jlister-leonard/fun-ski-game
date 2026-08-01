/**
 * @file FHIR → `RawLabInput` adapter for the `clinical-records/` directory.
 *
 * `@/lib/algorithms/labs` is deliberately release-agnostic: it takes a flat
 * {@link RawLabInput} and never sees a FHIR structure. This file is the only
 * place in the codebase that knows DSTU2 from R4, which is what keeps the
 * unit-conversion and reference-range logic testable without FHIR fixtures.
 *
 * ## Why both releases have to work, in the same import
 *
 * Apple's Health Records shipped **DSTU2 (1.0.2)** in iOS 11.3 and added
 * **R4 (4.0.1)** in iOS 14. Records already downloaded under DSTU2 are not
 * rewritten, and a user with two providers — one upgraded, one not — gets a
 * mixed-version directory. The `<ClinicalRecord fhirVersion="…">` index in
 * `export.xml` tells us which is which **per file**, so no sniffing is needed
 * on the zip path (`integration-health-records.md` §3.1).
 *
 * ## `asArray` is not defensiveness for its own sake
 *
 * The releases disagree about cardinality on exactly the fields we read:
 * `category` and `interpretation` are `0..1` objects in DSTU2 and `0..*`
 * arrays in R4. Real producers are sloppier still — a DSTU2-declared payload
 * sometimes carries an R4-shaped array. Accepting both costs nothing and
 * removes a whole class of silent data loss.
 */

import type { RawLabInput } from '../algorithms/labs';

/** Anything parsed out of a FHIR JSON file. */
type Json = Record<string, unknown>;

/** Narrow an unknown to a JSON object. */
function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** Read a string field, or `null`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Read a number field, or `null`. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Accept `undefined`, a single object, or an array, and always yield an array.
 *
 * @param value the field as it arrived
 * @returns the field's members
 */
export function asArray(value: unknown): Json[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(obj).filter((v): v is Json => v !== null);
  const single = obj(value);
  return single ? [single] : [];
}

/** A `CodeableConcept`'s codings, flattened to the shape `labs.ts` expects. */
function codings(concept: unknown): { system: string; code: string; display?: string }[] {
  const c = obj(concept);
  if (!c) return [];
  const out: { system: string; code: string; display?: string }[] = [];
  for (const coding of asArray(c.coding)) {
    const system = str(coding.system);
    const code = str(coding.code);
    if (!system || !code) continue;
    const display = str(coding.display);
    out.push(display ? { system, code, display } : { system, code });
  }
  return out;
}

/** The LOINC code out of a `CodeableConcept`, when one is present. */
function loincOf(concept: unknown): string | null {
  for (const c of codings(concept)) {
    if (c.system.includes('loinc.org')) return c.code;
  }
  return null;
}

/** The first code from a `CodeableConcept`, whatever its system. */
function firstCode(concept: unknown): string | null {
  const c = codings(concept);
  return c.length > 0 ? c[0].code : null;
}

/**
 * The clinical date of an observation.
 *
 * **Never** the HealthKit sample date or `ClinicalRecord@receivedDate` — Apple
 * states plainly that those are the *download* date
 * (`integration-health-records.md` §1.3 ④). A lab drawn in 2019 and downloaded
 * in 2024 must not appear as a 2024 result; that is the kind of error that
 * makes a trend line lie.
 *
 * @param res the Observation resource
 * @returns an ISO-8601 instant, or `null` when the resource carries no date
 */
function effectiveDate(res: Json): string | null {
  const direct = str(res.effectiveDateTime);
  if (direct) return direct;
  const period = obj(res.effectivePeriod);
  const start = period ? str(period.start) : null;
  if (start) return start;
  return str(res.issued);
}

/** Pull `{low, high, unit, text}` out of the first reference range. */
function referenceRange(res: Json): RawLabInput['referenceRange'] {
  const ranges = asArray(res.referenceRange);
  if (ranges.length === 0) return null;
  const r = ranges[0];
  const low = obj(r.low);
  const high = obj(r.high);
  const lowValue = low ? num(low.value) : null;
  const highValue = high ? num(high.value) : null;
  const unit =
    (low ? str(low.unit) ?? str(low.code) : null) ??
    (high ? str(high.unit) ?? str(high.code) : null);
  const text = str(r.text);
  if (lowValue === null && highValue === null && text === null) return null;
  return { low: lowValue, high: highValue, unit, text };
}

/** Free-text lab comment: `comments` in DSTU2, `note[].text` in R4. */
function comment(res: Json): string | null {
  const dstu2 = str(res.comments);
  if (dstu2) return dstu2;
  for (const note of asArray(res.note)) {
    const text = str(note.text);
    if (text) return text;
  }
  return null;
}

/** The performing lab's display name, from `performer[0].display`. */
function performerName(res: Json): string | null {
  for (const p of asArray(res.performer)) {
    const display = str(p.display);
    if (display) return display;
  }
  return null;
}

/**
 * Build a {@link RawLabInput} from an Observation body and a value node.
 *
 * Split out because `Observation.component[]` — how blood pressure and some
 * differential counts are carried — repeats the value/range/interpretation
 * shape under its own `code`, and each component is a separate result.
 */
function buildInput(
  res: Json,
  valueHost: Json,
  code: unknown,
  release: 'dstu2' | 'r4' | 'unknown',
  sourceName: string | null,
): RawLabInput {
  const quantity = obj(valueHost.valueQuantity);
  const codeableValue = obj(valueHost.valueCodeableConcept);
  const codeText = obj(code)?.text;

  return {
    loinc: loincOf(code),
    codings: codings(code),
    codeText: str(codeText) ?? null,
    effectiveAt: effectiveDate(res),
    issuedAt: str(res.issued),
    status: str(res.status),
    category: firstCode(asArray(res.category)[0] ?? res.category),
    value: quantity ? num(quantity.value) : null,
    unit: quantity ? str(quantity.unit) ?? str(quantity.code) : null,
    ucumCode: quantity ? str(quantity.code) : null,
    comparator: quantity ? str(quantity.comparator) : null,
    valueText:
      str(valueHost.valueString) ??
      (codeableValue ? str(codeableValue.text) ?? firstCode(codeableValue) : null),
    referenceRange: referenceRange(valueHost),
    interpretationCode: firstCode(asArray(valueHost.interpretation)[0] ?? valueHost.interpretation),
    comment: comment(res),
    sourceName,
    performerName: performerName(res),
    fhirRelease: release,
  };
}

/**
 * Convert one parsed `clinical-records/*.json` resource into lab inputs.
 *
 * Only `Observation` produces results. `DiagnosticReport` resources reference
 * their members by id rather than containing them, so in v1 they are used for
 * nothing except the *contained* observations some providers inline; the
 * panel-grouping model in `integration-health-records.md` §3.4 needs a
 * cross-file resolve step that is out of scope until labs have a vault table
 * to live in.
 *
 * Never throws. A resource it cannot model yields an empty array and the
 * caller counts one failure.
 *
 * @param resource the parsed JSON
 * @param release which FHIR release the `<ClinicalRecord>` index declared
 * @param sourceName the provider, from `ClinicalRecord@sourceName`
 * @returns zero or more lab inputs, one per value or component
 */
export function observationsFromResource(
  resource: unknown,
  release: 'dstu2' | 'r4' | 'unknown',
  sourceName: string | null,
): RawLabInput[] {
  const res = obj(resource);
  if (!res) return [];

  const type = str(res.resourceType);
  if (type === 'DiagnosticReport') {
    const out: RawLabInput[] = [];
    for (const contained of asArray(res.contained)) {
      out.push(...observationsFromResource(contained, release, sourceName));
    }
    return out;
  }
  if (type !== 'Observation') return [];

  const out: RawLabInput[] = [];
  const components = asArray(res.component);
  // A parent carrying its own value *and* components (blood pressure with a
  // mean arterial pressure, say) yields both — they are different results.
  if (res.valueQuantity !== undefined || res.valueString !== undefined) {
    out.push(buildInput(res, res, res.code, release, sourceName));
  }
  for (const component of components) {
    out.push(buildInput(res, component, component.code, release, sourceName));
  }
  if (out.length === 0 && components.length === 0) {
    // No value at all — still worth surfacing, because `labs.ts` models it as
    // `quantity: null` rather than an error, and the receipt should count it.
    out.push(buildInput(res, res, res.code, release, sourceName));
  }
  return out;
}

/**
 * Map `ClinicalRecord@fhirVersion` onto a release.
 *
 * @param version e.g. `1.0.2` or `4.0.1`
 * @returns the release, or `'unknown'`
 */
export function releaseFromVersion(version: string | null | undefined): 'dstu2' | 'r4' | 'unknown' {
  if (!version) return 'unknown';
  if (version.startsWith('1.0')) return 'dstu2';
  if (version.startsWith('4.')) return 'r4';
  if (version.startsWith('3.')) return 'unknown'; // STU3 — Apple does not emit it.
  return 'unknown';
}
