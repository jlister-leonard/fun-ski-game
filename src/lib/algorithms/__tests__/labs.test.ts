/**
 * labs.test.ts — behavioural assertions for labs.ts and lab-panels.json.
 *
 * Ported verbatim from `docs/kg/specs/algorithms/labs.verify.mjs`. Every
 * assertion, name, expected value and tolerance is preserved one-for-one.
 *
 * These are behavioural assertions, not unit tests of implementation details.
 * The point is to prove three things:
 *   1. conversions round-trip and the known-hard ones (HbA1c, Lp(a), insulin)
 *      behave as specified;
 *   2. the module REFUSES where it is supposed to refuse;
 *   3. range classification and trend gating do not dramatise noise.
 *
 * `lab-panels.json` is read from disk rather than copied here: that file is the
 * single source of truth and is owned elsewhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';
import {
  normalizeUnitString,
  convertToCanonical,
  convertFromCanonical,
  parseReferenceRangeText,
  resolveReferenceRange,
  classifyAgainstRange,
  computeSourceKey,
  utcMinute,
  fnv1a64Hex,
  statusRank,
  buildLoincIndex,
  parseObservation,
  referenceChangeValue,
  trendAnalyte,
  evaluateObservation,
  computeDerivedIndex,
  medicationSuggestion,
  diagnosisFromPattern,
  REFUSED_DERIVED_INDICES,
  LAB_LIMITS,
} from '../labs';
import type {
  Catalogue,
  LabPoint,
  NormalizedObservation,
  NormalizedReferenceRange,
  RawLabInput,
  RcvResult,
} from '../labs';
import type { Finding } from '../guardrails';

/* ------------------------------------------------------------------ */

let currentSection = 'preamble';
function section(title: string): void {
  currentSection = title;
}
function ok(name: string, cond: boolean, detail = ''): void {
  const label = `${currentSection} · ${name}${detail ? ` — ${detail}` : ''}`;
  it(label, () => {
    expect(cond).toBe(true);
  });
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}
function close(name: string, actual: number, expected: number, tol = 1e-6): void {
  const d = Math.abs(actual - expected);
  ok(name, d <= tol, `expected ~${expected}, got ${actual} (|Δ|=${d.toExponential(2)})`);
}

/**
 * The on-disk catalogue carries a crosswalk table alongside the analytes; the
 * module's `Catalogue` type only models what the module itself consumes.
 */
interface CatalogueFile extends Catalogue {
  externalIdAliases?: Record<string, string | string[] | null>;
}

const p = fileURLToPath(new URL('../../../../docs/kg/specs/lab-panels.json', import.meta.url));
const CAT = JSON.parse(readFileSync(p, 'utf8')) as CatalogueFile;
const A = CAT.analytes;
const IDX = buildLoincIndex(CAT);
const NOW = '2026-07-26T12:00:00Z';

/* ================================================================== */
section('1. Catalogue integrity');

eq('catalogue parses', typeof A, 'object');
ok('has >= 40 analytes', Object.keys(A).length >= 40, `${Object.keys(A).length}`);

{
  const dupes: Record<string, string[]> = {};
  for (const [id, a] of Object.entries(A)) (dupes[a.loinc] ??= []).push(id);
  const bad = Object.entries(dupes).filter(([, v]) => v.length > 1);
  ok('no duplicate primary LOINC', bad.length === 0, JSON.stringify(bad));
}
{
  const missing = Object.entries(A).filter(([, a]) => !a.loinc || !a.canonicalUnit || !a.units);
  ok('every analyte has loinc + canonicalUnit + units', missing.length === 0,
    missing.map(([k]) => k).join(','));
}
{
  // The canonical unit must itself be a recognised key, or nothing round-trips.
  const bad = Object.entries(A).filter(([, a]) => {
    const keys = Object.keys(a.units).map((u) => normalizeUnitString(u));
    return !keys.includes(normalizeUnitString(a.canonicalUnit));
  });
  ok('canonicalUnit is present in units map', bad.length === 0, bad.map(([k]) => k).join(','));
}
{
  // §9.4 rule 2: a goalContext without a rationale AND a source must not ship.
  const bad = Object.entries(A).filter(
    ([, a]) => a.goalContext && !(a.goalContext.rationale && a.goalContext.source && a.goalContext.confidence),
  );
  ok('every goalContext has rationale + source + confidence', bad.length === 0,
    bad.map(([k]) => k).join(','));
}
{
  const withGoal = Object.entries(A).filter(([, a]) => a.goalContext);
  ok('goalContext exists for the analytes the spec names', withGoal.length >= 6, `${withGoal.length}`);
  const banned = ['testosterone_total', 'testosterone_free', 'shbg', 'estradiol', 'dhea_s',
    'tsh', 'free_t4', 'egfr', 'alp'];
  const violations = banned.filter((k) => A[k]?.goalContext);
  ok('no goalContext on the analytes §9.4 rule 4 forbids', violations.length === 0,
    violations.join(','));
}
{
  const crit = Object.entries(A).filter(([, a]) => a.critical?.low != null || a.critical?.high != null);
  ok('critical thresholds are a small set', crit.length > 0 && crit.length <= 12, `${crit.length}`);
  ok('creatine kinase has NO critical threshold',
    A.creatine_kinase.critical!.low == null && A.creatine_kinase.critical!.high == null);
  ok('eGFR has NO critical threshold',
    A.egfr.critical!.low == null && A.egfr.critical!.high == null);
}
{
  // Ours must sit outside the CAP envelope, not at it.
  ok('potassium critical wider than CAP typical (2.5 / 6.5)',
    A.potassium.critical!.low! < 2.5 && A.potassium.critical!.high! > 6.5,
    `${A.potassium.critical!.low}/${A.potassium.critical!.high}`);
  ok('sodium critical wider than CAP typical (120 / 160)',
    A.sodium.critical!.low! < 120 && A.sodium.critical!.high! > 160,
    `${A.sodium.critical!.low}/${A.sodium.critical!.high}`);
}
{
  // The crosswalk to medication-effects.json must cover every id that file uses,
  // and every non-null target must exist here — otherwise a medication labEffect
  // silently attaches to nothing.
  const X: Record<string, string | string[] | null> = CAT.externalIdAliases ?? {};
  const targets = Object.entries(X).filter(([k]) => k !== '$comment');
  ok('externalIdAliases crosswalk is present', targets.length >= 10, `${targets.length}`);
  const dangling: string[] = [];
  for (const [ext, mapped] of targets) {
    if (mapped == null) continue;
    for (const t of Array.isArray(mapped) ? mapped : [mapped]) {
      if (!A[t]) dangling.push(`${ext}→${t}`);
    }
  }
  ok('every crosswalk target resolves to a real analyte', dangling.length === 0, dangling.join(','));
  ok('cystatin C exists (§9.6.1 recommends it as the creatine discriminator)', !!A.cystatin_c);
  ok('...and is reachable from the medication-effects vocabulary', X['cystatin-c'] === 'cystatin_c');
}
{
  const unverified = Object.entries(A).filter(([, a]) => a.biologicalVariation?.provenance === 'unverified');
  console.log(`   note: ${unverified.length} analytes carry UNVERIFIED biological-variation figures.`);
  ok('every biologicalVariation declares provenance',
    Object.entries(A).every(([, a]) => !a.biologicalVariation || !!a.biologicalVariation.provenance));
}

/* ================================================================== */
section('2. Unit-string normalization');

eq('mg/dl → mg/dL', normalizeUnitString('mg/dl'), 'mg/dL');
eq('mmol/l → mmol/L', normalizeUnitString('mmol/l'), 'mmol/L');
eq('micro sign U+00B5 folds to u', normalizeUnitString('µg/dL'), 'ug/dL');
eq('Greek mu U+03BC folds to u', normalizeUnitString('μg/dL'), 'ug/dL');
ok('both mu codepoints agree',
  normalizeUnitString('µmol/L') === normalizeUnitString('μmol/L'));
eq('mcg → ug', normalizeUnitString('mcg/dL'), 'ug/dL');
eq('x10E3/uL → 10*3/uL', normalizeUnitString('x10E3/uL'), '10*3/uL');
eq('10^3/uL → 10*3/uL', normalizeUnitString('10^3/uL'), '10*3/uL');
eq('K/uL → 10*3/uL', normalizeUnitString('K/uL'), '10*3/uL');
eq('u[IU]/mL → uIU/mL', normalizeUnitString('u[IU]/mL'), 'uIU/mL');
eq('whitespace collapsed', normalizeUnitString('  mg /  dL '), 'mg/dL');
eq('null → empty', normalizeUnitString(null), '');
// The numerator must NOT be case-folded: mU and MU are different units.
ok('numerator case preserved', normalizeUnitString('mU/L') !== normalizeUnitString('MU/L'));

/* ================================================================== */
section('3. Conversions — values');

close('cholesterol 5.2 mmol/L → 201.1 mg/dL',
  convertToCanonical(A.cholesterol_total, 5.2, 'mmol/L').value as number, 201.084, 1e-3);
close('glucose 5.5 mmol/L → 99.1 mg/dL',
  convertToCanonical(A.glucose_fasting, 5.5, 'mmol/L').value as number, 99.0858, 1e-3);
close('triglycerides 1.7 mmol/L → 150.6 mg/dL',
  convertToCanonical(A.triglycerides, 1.7, 'mmol/L').value as number, 150.569, 1e-3);
close('creatinine 88.4 umol/L → 1.0 mg/dL',
  convertToCanonical(A.creatinine, 88.4, 'umol/L').value as number, 1.0, 2e-3);
close('vitamin D 75 nmol/L → 30.0 ng/mL',
  convertToCanonical(A.vitamin_d_25oh, 75, 'nmol/L').value as number, 30.045, 1e-3);
close('testosterone 20 nmol/L → 576.8 ng/dL',
  convertToCanonical(A.testosterone_total, 20, 'nmol/L').value as number, 576.84, 1e-2);
close('ferritin ng/mL ≡ ug/L (identity)',
  convertToCanonical(A.ferritin, 18, 'ug/L').value as number, 18, 0);
close('TSH mIU/L ≡ uIU/mL (identity)',
  convertToCanonical(A.tsh, 2.1, 'uIU/mL').value as number, 2.1, 0);
close('sodium mEq/L ≡ mmol/L (identity)',
  convertToCanonical(A.sodium, 140, 'mEq/L').value as number, 140, 0);
close('WBC 10*9/L ≡ 10*3/uL (identity)',
  convertToCanonical(A.wbc, 6.4, '10*9/L').value as number, 6.4, 0);
close('albumin 40 g/L → 4.0 g/dL',
  convertToCanonical(A.albumin, 40, 'g/L').value as number, 4.0, 1e-9);
close('ALT 0.5 ukat/L → 30 U/L',
  convertToCanonical(A.alt, 0.5, 'ukat/L').value as number, 30, 1e-9);
// The mu-fold must work end to end, not just in the string normalizer.
close('serum iron with Greek mu unit converts',
  convertToCanonical(A.iron_serum, 15, 'μmol/L').value as number, 83.77, 1e-2);

/* ================================================================== */
section('4. Conversions — round-trips');

{
  let checked = 0;
  const bad: string[] = [];
  for (const [id, a] of Object.entries(A)) {
    for (const [unit, conv] of Object.entries(a.units)) {
      if (conv.kind === 'refuse') continue;
      const probe = 42.5;
      const fwd = convertToCanonical(a, probe, unit);
      if (fwd.refused || fwd.value == null) {
        bad.push(`${id}/${unit}: forward refused`);
        continue;
      }
      const back = convertFromCanonical(a, fwd.value, unit);
      if (back.refused || back.value == null) {
        bad.push(`${id}/${unit}: reverse refused`);
        continue;
      }
      const rel = Math.abs(back.value - probe) / probe;
      if (rel > 1e-9) bad.push(`${id}/${unit}: rel err ${rel.toExponential(2)}`);
      checked++;
    }
  }
  ok(`all ${checked} convertible (analyte,unit) pairs round-trip within 1e-9`,
    bad.length === 0, bad.slice(0, 5).join(' | '));
}

/* ================================================================== */
section('5. HbA1c is affine — the trap the offset exists for');

// The master equation gives 6.543% for 48 mmol/mol; the familiar "48 = 6.5%"
// pairing is that value rounded to one decimal. Assert against the equation,
// and separately assert that it rounds to the published figure.
close('48 mmol/mol → 6.543 % (master equation)',
  convertToCanonical(A.hba1c, 48, 'mmol/mol').value as number, 6.543, 1e-3);
eq('...which rounds to the published 6.5 %',
  Number((convertToCanonical(A.hba1c, 48, 'mmol/mol').value as number).toFixed(1)), 6.5);
close('6.5 % → 47.5 mmol/mol', convertToCanonical(A.hba1c_ifcc, 6.5, '%').value as number, 47.52, 5e-2);
close('39 mmol/mol → 5.72 %', convertToCanonical(A.hba1c, 39, 'mmol/mol').value as number, 5.72, 1e-2);
{
  // The two HbA1c analytes must be exact inverses of each other, or a user with
  // results from a US and a European lab gets two divergent series.
  const pct = convertToCanonical(A.hba1c, 48, 'mmol/mol').value as number;
  close('hba1c and hba1c_ifcc are exact inverses',
    convertToCanonical(A.hba1c_ifcc, pct, '%').value as number, 48, 1e-6);
}
{
  // A naive pure-multiplier model would give 48 * 0.09148 = 4.39%, which reads
  // as reassuringly normal. Prove we are nowhere near that.
  const naive = 48 * 0.09148;
  const actual = convertToCanonical(A.hba1c, 48, 'mmol/mol').value as number;
  ok('affine conversion differs materially from the naive multiplier',
    Math.abs(actual - naive) > 2, `naive ${naive.toFixed(2)}%, actual ${actual.toFixed(2)}%`);
}

/* ================================================================== */
section('6. Refusals — the module declines rather than guessing');

{
  const r = convertToCanonical(A.lipoprotein_a_mass, 40, 'nmol/L');
  ok('Lp(a) mass↔molar refused', r.refused && r.value === null);
  ok('Lp(a) refusal names the isoform reason', /isoform|KIV/i.test(r.note ?? ''));
}
{
  const r = convertToCanonical(A.insulin, 8, 'pmol/L');
  ok('insulin uIU/mL↔pmol/L refused', r.refused && r.value === null);
  ok('insulin refusal names the standard ambiguity', /6\.9|standard/i.test(r.note ?? ''));
}
{
  const r = convertToCanonical(A.shbg, 30, 'ug/dL');
  ok('SHBG mass unit refused', r.refused && r.value === null);
}
{
  const r = convertToCanonical(A.mch, 30, 'fmol');
  ok('MCH fmol refused (monomer convention)', r.refused && r.value === null);
}
{
  const r = convertToCanonical(A.cholesterol_total, 200, 'furlongs/fortnight');
  ok('unknown unit refused', r.refused && r.value === null);
  ok('unknown-unit note explains why', /worse than none/i.test(r.note ?? ''));
}
{
  const r = convertToCanonical(A.cholesterol_total, 200, '');
  ok('missing unit refused', r.refused && r.value === null);
}
{
  const r = convertToCanonical(A.cholesterol_total, Number.NaN, 'mg/dL');
  ok('non-finite value refused', r.refused && r.value === null);
}
{
  // Structural refusals must be real functions, not documentation.
  ok('REFUSED_DERIVED_INDICES lists HOMA-IR', REFUSED_DERIVED_INDICES.includes('HOMA-IR'));
  ok('REFUSED_DERIVED_INDICES lists ASCVD risk score', REFUSED_DERIVED_INDICES.includes('ASCVD risk score'));
  const f = computeDerivedIndex('HOMA-IR');
  ok('computeDerivedIndex blocks', f.level === 'block' && f.ok === false);
  ok('medicationSuggestion blocks', medicationSuggestion().level === 'block');
  ok('medication refusal mentions the prescriber', /prescriber/i.test(medicationSuggestion().message));
  ok('diagnosisFromPattern blocks', diagnosisFromPattern().level === 'block');
}

/* ================================================================== */
section('7. Reference-range text parsing');

{
  const parsed = parseReferenceRangeText('3.1 - 6.2');
  ok('"3.1 - 6.2"', parsed?.low === 3.1 && parsed?.high === 6.2);
}
{
  const parsed = parseReferenceRangeText('13.5–17.5'); // en dash
  ok('en-dash range', parsed?.low === 13.5 && parsed?.high === 17.5);
}
eq('"<100" high only', parseReferenceRangeText('<100')?.high, 100);
eq('"<100" low is null', parseReferenceRangeText('<100')?.low, null);
eq('">40" low only', parseReferenceRangeText('>40')?.low, 40);
eq('"70 to 99"', parseReferenceRangeText('70 to 99')?.high, 99);
eq('thousands separator stripped', parseReferenceRangeText('1,000 - 2,000')?.low, 1000);
eq('"Not Estab." → null', parseReferenceRangeText('Not Estab.'), null);
eq('"See report" → null', parseReferenceRangeText('See report'), null);
eq('empty → null', parseReferenceRangeText(''), null);
eq('null → null', parseReferenceRangeText(null), null);
// The two that matter most: refuse rather than choose a stratum, and refuse a
// reversed range rather than silently swapping it.
eq('sex-stratified string refused', parseReferenceRangeText('Male: 13-17 Female: 12-16'), null);
eq('"Age dependent" refused', parseReferenceRangeText('Age dependent'), null);
eq('reversed range discarded, not swapped', parseReferenceRangeText('6.2 - 3.1'), null);

/* ================================================================== */
section('8. Range precedence and classification');

{
  // The lab's own range must win even where a general range exists.
  const r = resolveReferenceRange(A.glucose_fasting, { low: 65, high: 105, unit: 'mg/dL' }) as NormalizedReferenceRange;
  ok('lab-supplied range wins', r.provenance === 'lab_supplied' && r.low === 65 && r.high === 105);
}
{
  const r = resolveReferenceRange(A.glucose_fasting, null) as NormalizedReferenceRange;
  ok('general fallback used when lab sends nothing', r.provenance === 'general_population');
  ok('general fallback matches the catalogue', r.low === 70 && r.high === 99);
}
{
  const r = resolveReferenceRange(A.ferritin, null);
  ok('no general fallback where the catalogue deliberately omits one (ferritin)', r === null);
}
{
  const r = resolveReferenceRange(A.testosterone_total, null);
  ok('no general fallback for testosterone', r === null);
}
{
  const r = resolveReferenceRange(A.glucose_fasting, { text: '70 - 99', unit: 'mg/dL' }) as NormalizedReferenceRange;
  ok('text-only lab range is parsed and still counts as lab_supplied',
    r.provenance === 'lab_supplied' && r.low === 70 && r.high === 99);
}
{
  const r = resolveReferenceRange(A.glucose_fasting, { text: 'Age dependent', unit: 'mg/dL' }) as NormalizedReferenceRange;
  ok('unparseable lab text does NOT fall through to the general range',
    r.provenance === 'lab_supplied' && r.low === null && r.high === null,
    JSON.stringify(r));
}

const RANGE: NormalizedReferenceRange = { low: 70, high: 99, unit: 'mg/dL', text: null, provenance: 'lab_supplied' };
eq('85 in range', classifyAgainstRange(85, RANGE), 'in_range');
eq('60 below', classifyAgainstRange(60, RANGE), 'below');
eq('120 above', classifyAgainstRange(120, RANGE), 'above');
eq('boundary low is IN range', classifyAgainstRange(70, RANGE), 'in_range');
eq('boundary high is IN range', classifyAgainstRange(99, RANGE), 'in_range');
eq('null value not comparable', classifyAgainstRange(null, RANGE), 'not_comparable');
eq('no range → no_range_supplied', classifyAgainstRange(85, null), 'no_range_supplied');
eq('empty range → no_range_supplied',
  classifyAgainstRange(85, { low: null, high: null, unit: null, text: null, provenance: 'none' }),
  'no_range_supplied');
{
  // Range in mmol/L, value in mg/dL — must convert, not compare blindly.
  const mmolRange: NormalizedReferenceRange = { low: 3.9, high: 5.5, unit: 'mmol/L', text: null, provenance: 'lab_supplied' };
  eq('cross-unit comparison converts correctly',
    classifyAgainstRange(85, mmolRange, { valueUnit: 'mg/dL', meta: A.glucose_fasting }), 'in_range');
  eq('cross-unit comparison detects "above"',
    classifyAgainstRange(120, mmolRange, { valueUnit: 'mg/dL', meta: A.glucose_fasting }), 'above');
  eq('cross-unit with no meta refuses to compare',
    classifyAgainstRange(85, mmolRange, { valueUnit: 'mg/dL' }), 'not_comparable');
  eq('cross-unit with an unconvertible pair refuses',
    classifyAgainstRange(40, { low: 75, high: 125, unit: 'nmol/L', text: null, provenance: 'lab_supplied' },
      { valueUnit: 'mg/dL', meta: A.lipoprotein_a_mass }), 'not_comparable');
}

/* ================================================================== */
section('9. sourceKey — deterministic and idempotent');

type SourceKeyInput = Parameters<typeof computeSourceKey>[0];

const base: SourceKeyInput = {
  loinc: '2276-4', effectiveAt: '2026-03-14T09:30:00-07:00', value: 18, unit: 'ng/mL',
};
eq('16 hex chars', computeSourceKey(base).length, 'obs:'.length + 16);
eq('stable across calls', computeSourceKey(base), computeSourceKey(base));
eq('timezone-equivalent instants collide (idempotent re-import)',
  computeSourceKey(base),
  computeSourceKey({ ...base, effectiveAt: '2026-03-14T16:30:00Z' }));
eq('sub-minute precision collapses',
  computeSourceKey(base),
  computeSourceKey({ ...base, effectiveAt: '2026-03-14T09:30:41-07:00' }));
ok('provider is NOT part of the key (cross-provider dedup)',
  computeSourceKey({ ...base, sourceName: 'Sutter' } as SourceKeyInput) === computeSourceKey({ ...base, sourceName: 'Quest' } as SourceKeyInput));
ok('a different value produces a different key (a repeat run is kept)',
  computeSourceKey(base) !== computeSourceKey({ ...base, value: 19 }));
ok('a different analyte produces a different key',
  computeSourceKey(base) !== computeSourceKey({ ...base, loinc: '2093-3' }));
ok('a different unit produces a different key',
  computeSourceKey(base) !== computeSourceKey({ ...base, unit: 'ug/L' }));
ok('a different minute produces a different key',
  computeSourceKey(base) !== computeSourceKey({ ...base, effectiveAt: '2026-03-14T09:31:00-07:00' }));
eq('utcMinute truncates', utcMinute('2026-03-14T09:30:41-07:00'), '2026-03-14T16:30Z');
eq('utcMinute on junk', utcMinute('not a date'), '');
eq('fnv1a64 is stable', fnv1a64Hex('abc'), fnv1a64Hex('abc'));
ok('fnv1a64 discriminates', fnv1a64Hex('abc') !== fnv1a64Hex('abd'));
ok('statusRank: amended beats final', statusRank('amended') > statusRank('final'));
ok('statusRank: final beats preliminary', statusRank('final') > statusRank('preliminary'));
ok('statusRank: corrected ties amended', statusRank('corrected') === statusRank('amended'));

/* ================================================================== */
section('10. parseObservation');

{
  const o = parseObservation({
    loinc: '2276-4', codeText: 'FERRITIN', effectiveAt: '2026-03-14T09:30:00Z',
    status: 'final', category: 'laboratory', value: 18, unit: 'ng/mL',
    referenceRange: { low: 15, high: 200, unit: 'ng/mL', text: '15 - 200' },
    sourceName: 'Sutter Health', fhirRelease: 'dstu2',
  }, CAT, IDX, NOW) as NormalizedObservation;
  ok('maps LOINC to analyteId', o.analyteId === 'ferritin');
  ok('uses catalogue display name', o.displayName === 'Ferritin');
  ok('converts to canonical', o.quantity!.canonicalValue === 18 && o.quantity!.canonicalUnit === 'ng/mL');
  ok('classifies in range', o.rangeStatus === 'in_range');
  ok('range provenance is the lab', o.referenceRange!.provenance === 'lab_supplied');
}
{
  const o = parseObservation({
    loinc: '9999-9', codeText: 'SOME LOCAL ASSAY', effectiveAt: '2026-03-14T09:30:00Z',
    status: 'final', value: 12, unit: 'widgets/dL',
  }, CAT, IDX, NOW) as NormalizedObservation;
  ok('unknown LOINC yields null analyteId', o.analyteId === null);
  ok('unknown analyte falls back to code text', o.displayName === 'SOME LOCAL ASSAY');
  ok('unknown analyte is not converted', o.quantity!.canonicalValue === null);
  ok('raw value preserved verbatim', o.quantity!.rawValue === 12 && o.quantity!.rawUnit === 'widgets/dL');
}
{
  const o = parseObservation({
    loinc: '2276-4', effectiveAt: null, issuedAt: null, value: 18, unit: 'ng/mL',
  }, CAT, IDX, NOW);
  eq('an undated result is rejected', o, null);
}
{
  const o = parseObservation({
    loinc: '30522-7', effectiveAt: '2026-03-14T09:30:00Z', status: 'final',
    value: 0.2, unit: 'mg/L', comparator: '<',
  }, CAT, IDX, NOW) as NormalizedObservation;
  ok('a censored value is not classified', o.rangeStatus === 'not_comparable');
  ok('comparator retained for display', o.quantity!.comparator === '<');
}
{
  const o = parseObservation({
    loinc: '2823-3', effectiveAt: '2026-03-14T09:30:00Z', status: 'final',
    value: '5.2 mmol/L', unit: 'mmol/L',
  }, CAT, IDX, NOW) as NormalizedObservation;
  ok('numeric string with trailing unit is coerced', o.quantity!.rawValue === 5.2);
}
{
  const o = parseObservation({
    loinc: '2823-3', effectiveAt: '2026-03-14T09:30:00Z', status: 'final',
    value: 'SEE BELOW', unit: null,
  }, CAT, IDX, NOW) as NormalizedObservation;
  ok('a narrative value becomes valueText, not a number', o.quantity === null && o.valueText === 'SEE BELOW');
}
{
  const dstu2 = parseObservation({
    loinc: '2093-3', effectiveAt: '2026-03-14T09:30:00Z', status: 'final',
    value: 5.2, unit: 'mmol/L', interpretationCode: 'H', fhirRelease: 'dstu2',
  }, CAT, IDX, NOW) as NormalizedObservation;
  const r4 = parseObservation({
    loinc: '2093-3', effectiveAt: '2026-03-14T09:30:00Z', status: 'final',
    value: 5.2, unit: 'mmol/L', interpretationCode: 'H', fhirRelease: 'r4',
  }, CAT, IDX, NOW) as NormalizedObservation;
  ok('DSTU2 and R4 normalize identically', dstu2.sourceKey === r4.sourceKey);
  ok("the lab's own H flag is preserved", dstu2.labInterpretation === 'high');
}

/* ================================================================== */
section('11. Reference change value');

{
  // Symmetric form, hand-checked: 1.96 * sqrt(2) * sqrt(3^2 + 4^2) = 13.86%
  const r = referenceChangeValue(4, 3, { z: 1.96, forceLogNormal: false });
  close('symmetric RCV matches the closed form', r.upPct, 1.96 * Math.SQRT2 * 5, 1e-9);
  ok('symmetric is symmetric', Math.abs(r.upPct + r.downPct) < 1e-12);
  ok('flagged as not log-normal', r.logNormal === false);
}
{
  // The ferritin example from the spec: CVi 22, CVa 3, Z 1.96.
  const r = referenceChangeValue(21.8, 3.2, { z: 1.96, forceLogNormal: true });
  ok('log-normal is asymmetric', Math.abs(r.upPct) > Math.abs(r.downPct),
    `${r.upPct.toFixed(1)} / ${r.downPct.toFixed(1)}`);
  ok('upward threshold roughly +70%', r.upPct > 60 && r.upPct < 85, r.upPct.toFixed(1));
  ok('downward threshold roughly -42%', r.downPct < -35 && r.downPct > -50, r.downPct.toFixed(1));
  console.log(`   ferritin RCV (log-normal, Z=1.96): +${r.upPct.toFixed(1)}% / ${r.downPct.toFixed(1)}%`);
}
{
  // The correctness argument: at high CVi the symmetric form is not merely
  // imprecise, it emits a physically impossible downward threshold.
  const sym = referenceChangeValue(44, 22, { z: 1.96, forceLogNormal: false });
  const log = referenceChangeValue(44, 22, { z: 1.96, forceLogNormal: true });
  ok('symmetric form goes below -100% for hs-CRP', sym.downPct < -100, sym.downPct.toFixed(1));
  ok('log-normal form never goes below -100%', log.downPct > -100, log.downPct.toFixed(1));
  console.log(`   hs-CRP: symmetric ${sym.downPct.toFixed(1)}% (impossible) vs log-normal ${log.downPct.toFixed(1)}%`);
}
{
  ok('auto-selects log-normal above the total-CV threshold',
    referenceChangeValue(30, 10).logNormal === true);
  ok('auto-selects symmetric below it', referenceChangeValue(3, 1.5).logNormal === false);
}
eq('default Z is one-sided 95%, not 2.33', LAB_LIMITS.RCV_Z_ONE_SIDED_95, 1.65);
eq('two-sided 99% is 2.58', LAB_LIMITS.RCV_Z_TWO_SIDED_99, 2.58);
ok('default RCV uses Z=1.65', referenceChangeValue(4, 3).z === 1.65);

/* ================================================================== */
section('12. Trend gating — noise is not a trend');

const pt = (d: string, v: number, u: string, src?: string): LabPoint =>
  ({ effectiveAt: d, value: v, unit: u, status: 'final', sourceName: src });

{
  const t = trendAnalyte('sodium', A.sodium, [
    pt('2026-01-10T09:00:00Z', 138, 'mmol/L'),
    pt('2026-06-10T09:00:00Z', 142, 'mmol/L'),
  ]);
  // 138→142 is +2.9%, and sodium's RCV is ~1.5% — statistically significant,
  // clinically meaningless. The clinical floor is what saves us.
  ok('sodium 138→142 is NOT reported as a change', t.direction === 'stable');
  ok('...and it is the clinical floor that suppressed it',
    t.suppressedReason === 'within_clinical_floor', String(t.suppressedReason));
  ok('...with a finding that says so',
    t.findings.some((f) => f.code === 'LAB_TREND_BELOW_CLINICAL_FLOOR'));
  console.log(`   sodium 138→142: ${t.direction} (${t.suppressedReason})`);
}
{
  const t = trendAnalyte('sodium', A.sodium, [
    pt('2026-01-10T09:00:00Z', 140, 'mmol/L'),
    pt('2026-06-10T09:00:00Z', 128, 'mmol/L'),
  ]);
  ok('a genuinely large sodium fall IS reported', t.direction === 'falling' && t.exceedsNoise);
}
{
  const t = trendAnalyte('hs_crp', A.hs_crp, [
    pt('2026-01-10T09:00:00Z', 0.8, 'mg/L'),
    pt('2026-06-10T09:00:00Z', 1.4, 'mg/L'),
  ]);
  ok('hs-CRP with two points refuses to draw a direction', t.direction === 'indeterminate');
  ok('...and says why', /at least 4|varies enough/i.test(t.findings[0].message));
}
{
  const t = trendAnalyte('hs_crp', A.hs_crp, [
    pt('2026-01-10T09:00:00Z', 0.8, 'mg/L'),
    pt('2026-02-10T09:00:00Z', 0.9, 'mg/L'),
    pt('2026-03-10T09:00:00Z', 1.1, 'mg/L'),
    pt('2026-06-10T09:00:00Z', 1.4, 'mg/L'),
  ]);
  ok('hs-CRP with four points still calls a 55% move noise', t.direction === 'stable',
    `${t.direction} Δ=${t.deltaPct?.toFixed(1)}%`);
  ok('...via the RCV, not the floor', t.suppressedReason === 'within_reference_change_value');
}
{
  const t = trendAnalyte('hs_crp', A.hs_crp, [
    pt('2026-01-10T09:00:00Z', 0.8, 'mg/L'),
    pt('2026-02-10T09:00:00Z', 0.9, 'mg/L'),
    pt('2026-03-10T09:00:00Z', 1.0, 'mg/L'),
    pt('2026-06-10T09:00:00Z', 6.0, 'mg/L'),
  ]);
  ok('a 6x hs-CRP move IS reported', t.direction === 'rising' && t.exceedsNoise);
  ok('...against the median of prior points, not the last one',
    Math.abs((t.deltaAbs as number) - 5.1) < 1e-9, `${t.deltaAbs}`);
  ok('...and names common causes', t.findings.some((f) => f.code === 'LAB_TREND_COMMON_CAUSES'));
}
{
  const t = trendAnalyte('ferritin', A.ferritin, [pt('2026-01-10T09:00:00Z', 30, 'ng/mL')]);
  ok('one point is not a trend', t.direction === 'indeterminate' && t.usedPoints === 1);
  ok('...with an insufficient-data finding',
    t.findings.some((f) => f.code === 'LAB_TREND_INSUFFICIENT_DATA'));
}
{
  const t = trendAnalyte('cholesterol_total', A.cholesterol_total, [
    pt('2026-01-10T09:00:00Z', 200, 'mg/dL'),
    pt('2026-06-10T09:00:00Z', 5.2, 'mmol/L'),
  ]);
  ok('a mixed-unit series is not joined into one line', t.mixedUnits === true);
  ok('...and refuses rather than comparing across units', t.direction === 'indeterminate');
}
{
  const a = trendAnalyte('cholesterol_total', A.cholesterol_total, [
    pt('2026-01-10T09:00:00Z', 200, 'mg/dL', 'Quest'),
    pt('2026-06-10T09:00:00Z', 240, 'mg/dL', 'Quest'),
  ]);
  const b = trendAnalyte('cholesterol_total', A.cholesterol_total, [
    pt('2026-01-10T09:00:00Z', 200, 'mg/dL', 'Quest'),
    pt('2026-06-10T09:00:00Z', 240, 'mg/dL', 'LabCorp'),
  ]);
  ok('a mixed-provider series widens the threshold', (b.rcv as RcvResult).upPct > (a.rcv as RcvResult).upPct,
    `${(a.rcv as RcvResult).upPct.toFixed(1)} → ${(b.rcv as RcvResult).upPct.toFixed(1)}`);
  ok('...and says so', b.findings.some((f) => f.code === 'LAB_TREND_MIXED_PROVIDERS'));
}
{
  const t = trendAnalyte('cholesterol_total', A.cholesterol_total, [
    pt('2026-01-10T09:00:00Z', 200, 'mg/dL'),
    { effectiveAt: '2026-06-10T09:00:00Z', value: 260, unit: 'mg/dL', status: 'preliminary' },
  ]);
  ok('preliminary results are excluded from trends', t.usedPoints === 1);
}

/* ================================================================== */
section('13. evaluateObservation — findings and safety');

const mk = (over: RawLabInput): NormalizedObservation => parseObservation({
  loinc: '2823-3', effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
  value: 4.2, unit: 'mmol/L',
  referenceRange: { low: 3.5, high: 5.1, unit: 'mmol/L' }, ...over,
}, CAT, IDX, NOW) as NormalizedObservation;

{
  const f = evaluateObservation(mk({ value: 7.2 }), A.potassium, { now: NOW });
  ok('a far-out potassium fires a critical block', f.some((x) => x.code === 'LAB_CRITICAL_VALUE' && x.level === 'block'));
  const m = (f.find((x) => x.code === 'LAB_CRITICAL_VALUE') as Finding).message;
  ok('critical copy says contact your doctor promptly', /contact your doctor promptly/i.test(m));
  ok('critical copy offers NO explanation', !/because|likely|caused|suggests|indicat/i.test(m));
  ok('critical copy names no condition', !/hyperkal|kidney disease|diabet/i.test(m));
}
{
  const f = evaluateObservation(
    mk({ value: 7.2, effectiveAt: '2022-01-01T09:00:00Z' }), A.potassium, { now: NOW });
  ok('a four-year-old extreme result does NOT fire the urgent prompt',
    !f.some((x) => x.code === 'LAB_CRITICAL_VALUE'));
  ok('...it becomes a historical note', f.some((x) => x.code === 'LAB_CRITICAL_VALUE_HISTORICAL'));
}
{
  const f = evaluateObservation(mk({ value: 7.2, status: 'preliminary' }), A.potassium, { now: NOW });
  ok('a preliminary extreme result does NOT fire the urgent prompt',
    !f.some((x) => x.code === 'LAB_CRITICAL_VALUE'));
}
{
  // A haemolysis artifact must sit ALONGSIDE the critical prompt, never replace it.
  const f = evaluateObservation(mk({ value: 7.2 }), A.potassium,
    { now: NOW, activeTriggers: ['hemolysis_flag_on_result'] });
  ok('haemolysis note does not suppress the critical prompt',
    f.some((x) => x.code === 'LAB_CRITICAL_VALUE'));
  ok('...and the artifact note is present too',
    f.some((x) => x.code === 'LAB_ARTIFACT_CONTEXT'));
}
{
  const obs = parseObservation({
    loinc: '2276-4', effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
    value: 18, unit: 'ng/mL', referenceRange: { low: 15, high: 200, unit: 'ng/mL' },
  }, CAT, IDX, NOW) as NormalizedObservation;
  const f = evaluateObservation(obs, A.ferritin, { now: NOW, goals: ['vo2max'] });
  ok('ferritin 18 is in the lab range', obs.rangeStatus === 'in_range');
  ok('...but flags against the VO2max goal range', f.some((x) => x.code === 'LAB_OUTSIDE_GOAL_RANGE'));
  const g = f.find((x) => x.code === 'LAB_OUTSIDE_GOAL_RANGE') as Finding;
  ok('goal finding is info level, never a warning', g.level === 'info');
  ok('goal finding carries its confidence tag', /reasonable-inference/.test(g.message));
  ok('goal finding carries the caveat', /transferrin saturation/i.test(g.message));
  console.log(`   ferritin 18 (VO2max): "${g.message.slice(0, 120)}…"`);
}
{
  const obs = parseObservation({
    loinc: '2276-4', effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
    value: 18, unit: 'ng/mL', referenceRange: { low: 15, high: 200, unit: 'ng/mL' },
  }, CAT, IDX, NOW) as NormalizedObservation;
  const f = evaluateObservation(obs, A.ferritin, { now: NOW, goals: ['strength'] });
  ok('the goal range is silent when the goal does not apply',
    !f.some((x) => x.code === 'LAB_OUTSIDE_GOAL_RANGE'));
}
{
  const obs = parseObservation({
    loinc: '2160-0', effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
    value: 1.35, unit: 'mg/dL', referenceRange: { low: 0.7, high: 1.25, unit: 'mg/dL' },
  }, CAT, IDX, NOW) as NormalizedObservation;
  const f = evaluateObservation(obs, A.creatinine, {
    now: NOW, activeTriggers: ['creatine_in_supplement_stack'],
  });
  ok('creatinine above range warns', f.some((x) => x.code === 'LAB_OUT_OF_LAB_RANGE'));
  const art = f.find((x) => x.code === 'LAB_ARTIFACT_CONTEXT');
  ok('...with the creatine artifact context', !!art);
  ok('...naming the mechanism', /creatine pool|non-enzymatically/i.test(art!.message));
  ok('...and the discriminating test', /cystatin C/i.test(art!.message));
  ok('...without claiming the result is fine', !/nothing to worry|is fine|no cause for concern/i.test(art!.message));
}
{
  const obs = parseObservation({
    loinc: '2284-8', effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
    value: 3.2, unit: 'ng/mL', referenceRange: { low: 3.9, high: 26.8, unit: 'ng/mL' },
  }, CAT, IDX, NOW) as NormalizedObservation;
  const open = evaluateObservation(obs, A.folate_serum, { now: NOW, edGateActive: false });
  ok('low folate links to the micronutrient screen', open.some((x) => x.code === 'LAB_NUTRIENT_LINK'));
  const gated = evaluateObservation(obs, A.folate_serum, { now: NOW, edGateActive: true });
  ok('with the ED gate active, it routes through guardrails instead',
    gated.some((x) => x.code === 'LAB_NUTRIENT_ROUTED_TO_GUARDRAILS')
    && !gated.some((x) => x.code === 'LAB_NUTRIENT_LINK'));
}
{
  const f = evaluateObservation(mk({}), A.potassium, {
    now: NOW,
    loggedClinicalInstruction: { date: '2026-05-02', text: 'We are monitoring this; no action needed.' },
  });
  ok('a logged clinical instruction is the FIRST finding', f[0].code === 'LAB_DEFER_TO_CLINICIAN');
  ok('...and says the app is deferring', /that's the guidance that applies/i.test(f[0].message));
}
{
  const obs = parseObservation({
    loinc: '1558-6', effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
    value: 115, unit: 'mg/dL', referenceRange: null,
  }, CAT, IDX, NOW) as NormalizedObservation;
  const f = evaluateObservation(obs, A.glucose_fasting, { now: NOW });
  ok('a general-range comparison is labelled as such',
    f.some((x) => x.code === 'LAB_OUT_OF_GENERAL_RANGE'));
  const m = (f.find((x) => x.code === 'LAB_OUT_OF_GENERAL_RANGE') as Finding).message;
  ok('...and explicitly disclaims that it is the lab\'s range', /not your lab's range/i.test(m));
}
{
  const obs = parseObservation({
    loinc: '10835-7', effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
    value: 90, unit: 'nmol/L',
  }, CAT, IDX, NOW) as NormalizedObservation;
  const f = evaluateObservation(obs, A.lipoprotein_a_mass, { now: NOW });
  ok('an unconvertible unit surfaces a finding', f.some((x) => x.code === 'LAB_UNIT_NOT_CONVERTED'));
}
{
  // No finding anywhere in the module may suggest a medication change.
  const all: string[] = [];
  for (const [id, a] of Object.entries(A)) {
    const obs = parseObservation({
      loinc: a.loinc, effectiveAt: '2026-07-20T09:00:00Z', status: 'final',
      value: 1, unit: a.canonicalUnit, referenceRange: { low: 10, high: 20, unit: a.canonicalUnit },
    }, CAT, IDX, NOW);
    if (!obs) continue;
    for (const f of evaluateObservation(obs, a, { now: NOW, goals: ['vo2max', 'fat_loss', 'strength', 'restricted_diet', 'recovery'] })) {
      all.push(`${id}:${f.code}:${f.message}`);
    }
  }
  // The rule is "never SUGGEST starting, stopping or changing a medication".
  // Naming a drug as a known cause of a lab change is education and is allowed
  // (advice-policy.md Tier 1); an imperative is not. Match imperatives.
  const medPat = /\b(stop taking|start taking|come off|increase your dose|reduce your dose|lower your dose|adjust your dose|ask about your (statin|dose)|you should be on)\b/i;
  const offenders = all.filter((m) => medPat.test(m));
  ok(`no generated finding suggests a medication change (${all.length} findings scanned)`,
    offenders.length === 0, offenders.slice(0, 3).join(' | '));

  const dxPat = /\byou have (hypo|hyper|diabet|anaem|anem)/i;
  ok('no generated finding names a diagnosis', !all.some((m) => dxPat.test(m)));

  const reassurePat = /\b(nothing to worry about|no cause for concern|perfectly fine|you're fine)\b/i;
  ok('no generated finding reassures', !all.some((m) => reassurePat.test(m)));
}
