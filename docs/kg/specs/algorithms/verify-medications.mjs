/**
 * verify-medications.mjs — runnable assertions for medication-interactions.ts
 * and medication-effects.json.
 *
 * Separate from verify.mjs (nutrition-algorithms) and verify-personalization.mjs
 * (nutrition-personalization) so the three fail independently.
 *
 * Usage:
 *   cd docs/kg/specs/algorithms
 *   npx tsc -p tsconfig.medications.json
 *   node verify-medications.mjs
 *
 * These are behavioural and safety assertions, not unit tests of internals.
 * §7 (the copy lint) and §8 (the refusal-to-invent-a-factor rules) are
 * product-safety invariants: a failure there is a shipping blocker, not a
 * cosmetic regression.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AGENTS,
  LAB_EFFECTS,
  INTERACTIONS,
  CONFOUNDER_DEFINITIONS,
  ANTIPLATELET_STACK_RULE,
  ORAL_MEDICATION_IDS,
  SUPPLEMENTS_WITH_UL_CONSIDERATIONS,
  PRESCRIPTION_BOUNDARY_SHORT,
  resolveAgentId,
  resolveSupplementId,
  resolveStack,
  correctLabValue,
  checkStack,
  checkNewSupplement,
  activeConfounders,
  assessMedicationAwareness,
  assertNoMedicationDirective,
  allUserFacingCopy,
  prescriptionBoundaryResponse,
  isActiveOn,
} from './build/medication-interactions.js';

const here = dirname(fileURLToPath(import.meta.url));
const effects = JSON.parse(
  readFileSync(join(here, '..', 'medication-effects.json'), 'utf8'),
);

let passed = 0;
const failures = [];
let section = '';

function s(name) {
  section = name;
  console.log(`\n— ${name}`);
}
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failures.push(`[${section}] ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`   FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ================================================================== */
s('1. Catalogue integrity');

ok('four agents defined', AGENTS.length === 4);
ok('every agent id is unique', new Set(AGENTS.map((a) => a.id)).size === AGENTS.length);
ok('every interaction code is unique', new Set(INTERACTIONS.map((r) => r.code)).size === INTERACTIONS.length);
ok('every interaction id is unique', new Set(INTERACTIONS.map((r) => r.id)).size === INTERACTIONS.length);
ok('every confounder id is unique', new Set(CONFOUNDER_DEFINITIONS.map((c) => c.id)).size === CONFOUNDER_DEFINITIONS.length);
ok(
  'every interaction references a known agent or the wildcard',
  INTERACTIONS.every((r) => r.agentId === '*' || AGENTS.some((a) => a.id === r.agentId)),
);
ok(
  'every lab effect references a known agent',
  LAB_EFFECTS.every((e) => AGENTS.some((a) => a.id === e.agentId)),
);
ok(
  'every confounder references a known agent',
  CONFOUNDER_DEFINITIONS.every((c) => AGENTS.some((a) => a.id === c.agentId)),
);
ok('oral medication list contains only prescriptions', ORAL_MEDICATION_IDS.every((id) => AGENTS.find((a) => a.id === id)?.kind === 'prescription'));
ok('UL cross-reference list is non-empty', SUPPLEMENTS_WITH_UL_CONSIDERATIONS.length > 0);

/* ================================================================== */
s('2. Free-text resolution');

eq('"Zoloft" resolves to sertraline', resolveAgentId('Zoloft'), 'sertraline');
eq('"Propecia 1mg" resolves to finasteride', resolveAgentId('Propecia 1mg'), 'finasteride');
eq('"Rogaine foam" resolves to topical minoxidil', resolveAgentId('Rogaine foam'), 'minoxidil-topical');
eq('"creatine monohydrate" resolves', resolveAgentId('creatine monohydrate'), 'creatine');
eq('nonsense resolves to null', resolveAgentId('blue widget'), null);
eq('"5-HTP" resolves', resolveSupplementId('5-HTP'), '5-htp');
eq('"Griffonia simplicifolia extract" resolves to 5-HTP', resolveSupplementId('Griffonia simplicifolia extract'), '5-htp');
eq("\"St. John's Wort\" resolves", resolveSupplementId("St. John's Wort"), 'st-johns-wort');
eq('"Serenoa repens" resolves to saw palmetto', resolveSupplementId('Serenoa repens'), 'saw-palmetto');
eq('"psyllium husk powder" resolves to fibre', resolveSupplementId('psyllium husk powder'), 'fibre-supplement');

/* ================================================================== */
s('3. THE headline assertion — 5-HTP + sertraline is a block');

const f5htp = checkStack([{ id: 'sertraline' }], [{ id: '5-htp' }]);
const b = f5htp.find((x) => x.code === 'MED_SEROTONERGIC_STACK_5HTP');
ok('a finding is returned', !!b);
eq('its level is block', b?.level, 'block');
eq('ok is false', b?.ok, false);
ok('the copy explains the mechanism', /serotonin/i.test(b?.message ?? ''));
ok('the copy routes to a prescriber or pharmacist', /prescriber or pharmacist/i.test(b?.message ?? ''));
ok('the copy is not alarming — no shouting, no "danger"', !/\bDANGER\b|!!/.test(b?.message ?? ''));
ok('block findings sort first', f5htp[0].level === 'block');

for (const id of ['l-tryptophan', 'st-johns-wort', 'sam-e', 'kratom']) {
  const fs = checkStack([{ id: 'sertraline' }], [{ id }]);
  ok(`${id} + sertraline is a block`, fs.some((x) => x.level === 'block'), JSON.stringify(fs.map((x) => x.level)));
}
ok(
  'rhodiola is a warn, not a block — the evidence does not support a block',
  checkStack([{ id: 'sertraline' }], [{ id: 'rhodiola' }]).some((x) => x.level === 'warn'),
);
ok(
  'no serotonergic block fires without sertraline in the list',
  checkStack([{ id: 'finasteride' }], [{ id: '5-htp' }]).every((x) => x.ok || x.level !== 'block'),
);

/* ================================================================== */
s('4. THE other headline assertion — PSA on finasteride is corrected');

const psa = correctLabValue(
  'psa-total',
  1.2,
  [{ id: 'finasteride', startedOn: '2023-01-01' }],
  { drawnOn: '2026-07-26' },
);
ok('a correction is returned', psa !== null);
eq('corrected is true', psa?.corrected, true);
eq('the factor is 2', psa?.factor, 2);
eq('1.2 becomes 2.4', psa?.value, 2.4);
eq('the raw value is preserved untouched', psa?.rawValue, 1.2);
ok('the copy makes the doubling explicit', /double/i.test(psa?.note ?? ''));
ok('the copy names the falsely-reassuring failure mode', /falsely reassuring/i.test(psa?.note ?? ''));
ok('the copy is honest about the 1 mg extrapolation', /1 mg/.test(psa?.note ?? ''));
eq('confidence is stated', psa?.confidence, 'well-established');
eq('attributed to finasteride', psa?.attributedTo.join(','), 'finasteride');

const psaViaLoinc = correctLabValue('2857-1', 1.2, [{ id: 'finasteride', startedOn: '2023-01-01' }], { drawnOn: '2026-07-26' });
eq('the same correction is reachable by LOINC', psaViaLoinc?.value, 2.4);

eq('no medication → null, cheaply', correctLabValue('psa-total', 1.2, []), null);
eq('unaffected analyte → null', correctLabValue('haemoglobin', 15, [{ id: 'finasteride' }]), null);

/* ================================================================== */
s('5. PSA correction guards — when NOT to double');

const early = correctLabValue('psa-total', 1.2, [{ id: 'finasteride', startedOn: '2026-05-01' }], { drawnOn: '2026-07-26' });
eq('86 days on drug: not corrected', early?.corrected, false);
eq('86 days on drug: value unchanged', early?.value, 1.2);
ok('and it says why', /settle|between/i.test(early?.note ?? ''));

const withSawPalmetto = correctLabValue(
  'psa-total',
  1.2,
  [{ id: 'finasteride', startedOn: '2023-01-01' }],
  { drawnOn: '2026-07-26', supplements: [{ id: 'saw-palmetto' }] },
);
eq('saw palmetto invalidates the correction', withSawPalmetto?.corrected, false);
ok('and names it', /saw palmetto/i.test(withSawPalmetto?.note ?? ''));

const withBiotin = correctLabValue(
  'psa-total',
  1.2,
  [{ id: 'finasteride', startedOn: '2023-01-01' }],
  { drawnOn: '2026-07-26', supplements: [{ id: 'biotin-high-dose' }] },
);
eq('high-dose biotin invalidates the correction', withBiotin?.corrected, false);
ok('and names it', /biotin/i.test(withBiotin?.note ?? ''));

const stopped = correctLabValue(
  'psa-total',
  1.2,
  [{ id: 'finasteride', startedOn: '2020-01-01', stoppedOn: '2025-01-01' }],
  { drawnOn: '2026-07-26' },
);
eq('a stopped medication does not correct a later draw', stopped, null);

/* ================================================================== */
s('6. Refusing to invent a factor — the analytes with no defensible correction');

const egfr = correctLabValue('egfr-creatinine', 78, [{ id: 'creatine', startedOn: '2024-01-01' }], { drawnOn: '2026-07-26' });
ok('eGFR on creatine returns a finding', egfr !== null);
eq('eGFR is NOT numerically corrected', egfr?.corrected, false);
eq('no factor is invented', egfr?.factor, null);
eq('the value is passed through untouched', egfr?.value, 78);
ok('it routes to cystatin C', /cystatin C/i.test(egfr?.note ?? ''));
eq('the flag behaviour is a bounded downgrade, not suppression', egfr?.flagBehaviour, 'downgrade-mild');
eq('the downgrade band is 60-89', JSON.stringify(egfr?.downgradeBand), '[60,89]');

const sodium = correctLabValue('sodium', 133, [{ id: 'sertraline', startedOn: '2020-01-01' }], { drawnOn: '2026-07-26' });
eq('sodium on an SSRI is not numerically corrected', sodium?.corrected, false);
ok('it explains the SIADH mechanism in plain words', /water/i.test(sodium?.note ?? ''));
ok('it connects to the training/sweat picture', /sweat/i.test(sodium?.note ?? ''));

const dht = correctLabValue('dht', 12, [{ id: 'finasteride', startedOn: '2023-01-01' }], { drawnOn: '2026-07-26' });
eq('DHT is not corrected', dht?.corrected, false);
eq('a low DHT on finasteride has its low flag suppressed', dht?.flagBehaviour, 'suppress-low-flag');
ok('and the copy says why', /doing its job|success looks like/i.test(dht?.note ?? ''));

const testo = correctLabValue('testosterone-total', 24, [{ id: 'finasteride', startedOn: '2023-01-01' }], { drawnOn: '2026-07-26' });
eq('testosterone is annotated, not corrected', testo?.corrected, false);
eq('flag behaviour is annotate-only', testo?.flagBehaviour, 'annotate-only');
ok('and it warns against reading it as a training signal', /training or nutrition/i.test(testo?.note ?? ''));

const negative = correctLabValue('lh-fsh', 5, [{ id: 'finasteride', startedOn: '2023-01-01' }], { drawnOn: '2026-07-26' });
eq('the explicit no-effect entry is reachable', negative?.flagBehaviour, 'no-effect');
ok('and says finasteride is not the explanation', /not the explanation/i.test(negative?.note ?? ''));

ok(
  'no lab effect claims a correction factor without a confidence tag',
  LAB_EFFECTS.every((e) => e.correctionFactor === null || !!e.confidence),
);
ok(
  'the ONLY correction factor in the whole table is the PSA doubling',
  LAB_EFFECTS.filter((e) => e.correctionFactor !== null).map((e) => `${e.agentId}:${e.analyteId}:${e.correctionFactor}`).join('|') ===
    'finasteride:psa-total:2',
);
ok(
  'topical minoxidil claims no lab effects at all',
  LAB_EFFECTS.every((e) => e.agentId !== 'minoxidil-topical'),
);

/* ================================================================== */
s('7. Copy lint — Tier 3 rule 1, enforced');

const copy = allUserFacingCopy();
ok('there is copy to lint', copy.length > 25);
for (const text of copy) {
  const hit = assertNoMedicationDirective(text);
  ok(`no medication directive in: "${text.slice(0, 48)}…"`, hit === null, hit ?? '');
}
ok('the lint actually catches a violation', assertNoMedicationDirective('You should stop your sertraline before the test.') !== null);
ok('the lint catches a re-timing violation', assertNoMedicationDirective('Take your sertraline at night instead.') !== null);
ok('the lint permits supplement timing', assertNoMedicationDirective('Take the psyllium two hours away from anything else you swallow.') === null);

// No diagnosis language anywhere, and nothing about WHY sertraline is taken.
const forbiddenWords = /\b(depression|depressive|anxiety disorder|OCD|PTSD|mental illness|psychiatric condition|your condition)\b/i;
for (const text of copy) {
  ok(`no diagnosis language in: "${text.slice(0, 40)}…"`, !forbiddenWords.test(text));
}
ok(
  'JSON copy is clean too',
  JSON.stringify(effects).match(forbiddenWords) === null,
  JSON.stringify(effects).match(forbiddenWords)?.[0] ?? '',
);

/* ================================================================== */
s('8. Saying "that is your prescriber\'s call" rather than going quiet');

for (const topic of ['dose', 'timing', 'stopping', 'switching', 'side-effect', 'interaction-with-supplement']) {
  const r = prescriptionBoundaryResponse(topic);
  ok(`${topic}: returns info, not block`, r.level === 'info');
  ok(`${topic}: says something rather than nothing`, r.message.length > 60);
  ok(`${topic}: names who to ask`, /prescriber|pharmacist/i.test(r.message));
}
ok(
  'the timing answer draws the supplement/medication line explicitly',
  /supplement/i.test(prescriptionBoundaryResponse('timing').message),
);
ok('the short form exists and states both halves', /prescriber/i.test(PRESCRIPTION_BOUNDARY_SHORT) && /fair game/i.test(PRESCRIPTION_BOUNDARY_SHORT));

/* ================================================================== */
s('9. Stack checking — graceful degradation and incremental adds');

const clean = checkStack([{ id: 'sertraline' }, { id: 'finasteride' }], []);
eq('an empty stack returns exactly one finding', clean.length, 1);
eq('and it is an ok marker, distinguishable from "not run"', clean[0].ok, true);
eq('with a stable code', clean[0].code, 'MED_STACK_OK');

const noMeds = checkStack([], [{ id: '5-htp' }]);
ok('supplements with no medications produce no medication findings', noMeds.every((x) => x.ok || !x.code.startsWith('MED_SEROTONERGIC')));

const partial = resolveStack([
  { id: 'Zoloft-something' },
  { id: 'x', label: 'Vitamin D3 4000 IU' },
  { id: 'y', label: 'BrandName Hair Complex' },
]);
ok('resolveStack reports what it could not read', partial.unrecognised.includes('BrandName Hair Complex'));
ok('resolveStack still resolves what it can', partial.resolved.some((r) => r.id === 'fat-soluble'));

const existing = [{ id: 'omega-3' }, { id: 'creatine' }];
const beforeAdd = checkStack([{ id: 'sertraline' }], existing).filter((f) => !f.ok);
const delta = checkNewSupplement([{ id: 'sertraline' }], existing, { id: '5-htp' });
ok('an incremental add returns only the new findings', delta.every((f) => !beforeAdd.some((p) => p.code === f.code)));
ok('and the new finding is the block', delta.some((f) => f.level === 'block'));
eq('adding nothing new returns nothing', checkNewSupplement([{ id: 'sertraline' }], existing, { id: 'omega-3' }).length, 0);

/* ================================================================== */
s('10. Bleeding: the downgrade, and where the real warning lives');

const omega = checkStack([{ id: 'sertraline' }], [{ id: 'omega-3' }]);
const om = omega.find((x) => x.code === 'MED_BLEEDING_OMEGA3');
eq('omega-3 alone is info, not warn — the evidence does not support a warn', om?.level, 'info');
ok('and it says why, citing the regulator review', /5 g a day|EPA plus DHA/i.test(om?.message ?? ''));

const stacked = checkStack([{ id: 'sertraline' }], [{ id: 'omega-3' }, { id: 'ginkgo' }, { id: 'curcumin' }]);
const st = stacked.find((x) => x.code === ANTIPLATELET_STACK_RULE.code);
ok('three antiplatelet items on an SSRI trigger the stacking rule', !!st);
eq('at warn level', st?.level, 'warn');
ok('and it lists them', /Ginkgo/i.test(st?.message ?? '') && /Curcumin/i.test(st?.message ?? ''));
ok(
  'one antiplatelet item alone does NOT trigger it',
  !checkStack([{ id: 'sertraline' }], [{ id: 'omega-3' }]).some((x) => x.code === ANTIPLATELET_STACK_RULE.code),
);
ok(
  'the stacking rule needs an SSRI',
  !checkStack([{ id: 'finasteride' }], [{ id: 'omega-3' }, { id: 'ginkgo' }]).some((x) => x.code === ANTIPLATELET_STACK_RULE.code),
);

/* ================================================================== */
s('11. Dose thresholds');

eq(
  'biotin at 30 mcg does not fire',
  checkStack([{ id: 'finasteride' }], [{ id: 'biotin-high-dose', amountPerDay: 30, unit: 'mcg' }]).filter((f) => !f.ok).length,
  0,
);
ok(
  'biotin at 5000 mcg fires',
  checkStack([{ id: 'finasteride' }], [{ id: 'biotin-high-dose', amountPerDay: 5000, unit: 'mcg' }]).some(
    (f) => f.code === 'MED_BIOTIN_PSA_INTERFERENCE',
  ),
);
ok(
  'biotin with an UNKNOWN dose fires — a hair product is more likely 5000 than 30',
  checkStack([{ id: 'finasteride' }], [{ id: 'biotin-high-dose' }]).some((f) => f.code === 'MED_BIOTIN_PSA_INTERFERENCE'),
);
const biotinMsg = checkStack([{ id: 'finasteride' }], [{ id: 'biotin-high-dose' }]).find(
  (f) => f.code === 'MED_BIOTIN_PSA_INTERFERENCE',
)?.message;
ok('biotin copy states the direction of the PSA error (falsely LOW)', /falsely low/i.test(biotinMsg ?? ''));
ok('biotin copy gives supplement timing, which is in our lane', /8 hours|48-72 hours/i.test(biotinMsg ?? ''));

/* ================================================================== */
s('12. Timing rules');

const fibreWithMed = checkStack([{ id: 'sertraline' }], [{ id: 'fibre-supplement' }]);
ok('psyllium alongside an oral medication warns about spacing', fibreWithMed.some((f) => f.code === 'SUP_TIMING_FIBRE_MEDICATION'));
const fibreMsg = fibreWithMed.find((f) => f.code === 'SUP_TIMING_FIBRE_MEDICATION')?.message;
ok('and gives two hours', /two hours/i.test(fibreMsg ?? ''));
ok('and moves the SUPPLEMENT, never the medication', /the fibre is the thing that moves/i.test(fibreMsg ?? ''));
ok(
  'psyllium with only a topical medication does not fire the medication-spacing rule',
  !checkStack([{ id: 'minoxidil-topical' }], [{ id: 'fibre-supplement' }]).some((f) => f.code === 'SUP_TIMING_FIBRE_MEDICATION'),
);
ok(
  'timing rules can be switched off for a screen that does not want them',
  !checkStack([{ id: 'sertraline' }], [{ id: 'fibre-supplement' }], { includeTimingRules: false }).some(
    (f) => f.code === 'SUP_TIMING_FIBRE_MEDICATION',
  ),
);

/* ================================================================== */
s('13. Confounders — transitions fire, stable baselines mostly do not');

const longStanding = [
  { id: 'sertraline', startedOn: '2019-03-01' },
  { id: 'finasteride', startedOn: '2023-01-01' },
  { id: 'minoxidil-topical', startedOn: '2023-01-01' },
  { id: 'creatine', startedOn: '2024-06-01' },
];
const cf = activeConfounders(longStanding, '2026-07-26');
const ids = cf.map((c) => c.id);
ok('sweating is always active on an SSRI', ids.includes('sertraline-sweating'));
ok('the weight-drift note has expired after 7 years', !ids.includes('sertraline-weight-drift'));
ok('the HRV note has expired — no recent transition', !ids.includes('sertraline-autonomic'));
ok('minoxidil confounders have expired after 3 years', !ids.includes('minoxidil-fluid-retention'));
ok('creatine offset has expired after 2 years', !ids.includes('creatine-water-retention'));
ok('finasteride registers no confounders at all', !cf.some((c) => c.agentId === 'finasteride'));

const justStarted = activeConfounders(
  [{ id: 'minoxidil-topical', startedOn: '2026-07-01' }, { id: 'creatine', startedOn: '2026-07-10' }],
  '2026-07-26',
);
const jIds = justStarted.map((c) => c.id);
ok('a fresh minoxidil start registers the fluid confounder', jIds.includes('minoxidil-fluid-retention'));
ok('a fresh minoxidil start registers the heart-rate confounder', jIds.includes('minoxidil-heart-rate'));
ok('a fresh creatine start registers the water confounder', jIds.includes('creatine-water-retention'));

const minox = justStarted.find((c) => c.id === 'minoxidil-fluid-retention');
eq('minoxidil fluid is annotate-only', minox?.action, 'annotate-only');
eq('with NO invented kg figure', minox?.perturbation, null);
eq('and it must be user-confirmed before use', minox?.requiresUserConfirmation, true);
eq('evidence is honestly tagged uncertain', minox?.evidence, 'uncertain');
ok('the copy states how weak the topical evidence is', /1-2%|case reports/i.test(minox?.message ?? ''));

const creat = justStarted.find((c) => c.id === 'creatine-water-retention');
eq('creatine offers a trend offset', creat?.action, 'offer-trend-offset');
ok('with a PerturbationEvent-shaped seed', !!creat?.perturbation);
eq('deferring to weight-trend.ts for the type', creat?.perturbation?.type, 'creatine-start');
eq('and deliberately NOT restating its magnitude', creat?.perturbation?.expectedShiftKg, undefined);
ok('with a dedupe key so a user-logged event is not double counted', typeof creat?.dedupeKey === 'string' && creat.dedupeKey.length > 0);

const autonomic = activeConfounders([{ id: 'sertraline', startedOn: '2019-03-01', doseChangedOn: '2026-07-01' }], '2026-07-26').find(
  (c) => c.id === 'sertraline-autonomic',
);
ok('a recent DOSE CHANGE re-arms the HRV confounder', !!autonomic);
eq('but it still adjusts nothing', autonomic?.action, 'do-not-adjust');

ok(
  'no confounder anywhere offers a numeric readiness adjustment',
  activeConfounders(longStanding.concat([{ id: 'sertraline', startedOn: '2026-07-20' }]), '2026-07-26')
    .filter((c) => c.domain === 'readiness')
    .every((c) => c.action === 'do-not-adjust' || c.action === 'annotate-only'),
);
ok(
  'the only confounder permitted to shift a number is one whose magnitude another module owns',
  CONFOUNDER_DEFINITIONS.filter((c) => c.action === 'offer-trend-offset').every((c) => c.agentId === 'creatine'),
);

/* ================================================================== */
s('14. isActiveOn');

ok('open-ended entry is active', isActiveOn({ id: 'x' }, '2026-07-26'));
ok('entry not yet started is inactive', !isActiveOn({ id: 'x', startedOn: '2026-08-01' }, '2026-07-26'));
ok('stopped entry is inactive', !isActiveOn({ id: 'x', stoppedOn: '2026-06-01' }, '2026-07-26'));
ok('entry stopped in the future is still active today', isActiveOn({ id: 'x', stoppedOn: '2026-08-01' }, '2026-07-26'));

/* ================================================================== */
s('15. The whole-user convenience call');

const whole = assessMedicationAwareness(
  [
    { id: 'sertraline', startedOn: '2019-03-01' },
    { id: 'finasteride', startedOn: '2023-01-01' },
    { id: 'minoxidil-topical', startedOn: '2023-01-01' },
    { id: 'creatine', startedOn: '2024-06-01' },
  ],
  [],
  '2026-07-26',
);
ok('an unknown stack still yields the lab-awareness surface', whole.affectedAnalytes.length >= 8);
ok('PSA is flagged as correctable', whole.affectedAnalytes.some((a) => a.analyteId === 'psa-total' && a.hasCorrection));
ok('eGFR is flagged as affected but NOT correctable', whole.affectedAnalytes.some((a) => a.analyteId === 'egfr-creatinine' && !a.hasCorrection));
ok('no-effect analytes are excluded from the pre-flag list', !whole.affectedAnalytes.some((a) => a.analyteId === 'lh-fsh'));
eq('an empty stack is reported as checked-and-clean', whole.stackFindings[0].code, 'MED_STACK_OK');

/* ================================================================== */
s('16. JSON ↔ TypeScript parity');

const jsonAgents = new Set(effects.agents.map((a) => a.id));
ok('every TS agent exists in the JSON', AGENTS.every((a) => jsonAgents.has(a.id)));
eq('agent counts match', effects.agents.length, AGENTS.length);

const jsonEffectKeys = new Set(
  effects.agents.flatMap((a) => (a.labEffects ?? []).map((e) => `${a.id}:${e.analyteId}`)),
);
const tsEffectKeys = new Set(LAB_EFFECTS.map((e) => `${e.agentId}:${e.analyteId}`));
ok(
  'every JSON lab effect has a TS entry',
  [...jsonEffectKeys].every((k) => tsEffectKeys.has(k)),
  [...jsonEffectKeys].filter((k) => !tsEffectKeys.has(k)).join(', '),
);
ok(
  'every TS lab effect has a JSON entry',
  [...tsEffectKeys].every((k) => jsonEffectKeys.has(k)),
  [...tsEffectKeys].filter((k) => !jsonEffectKeys.has(k)).join(', '),
);

const jsonInteractionCodes = new Set(effects.interactions.map((i) => i.code));
const tsInteractionCodes = new Set(INTERACTIONS.map((i) => i.code));
ok(
  'interaction codes match in both directions',
  [...jsonInteractionCodes].every((c) => tsInteractionCodes.has(c)) &&
    [...tsInteractionCodes].every((c) => jsonInteractionCodes.has(c)),
);
for (const i of effects.interactions) {
  const t = INTERACTIONS.find((x) => x.code === i.code);
  if (t) eq(`level agrees for ${i.code}`, t.level, i.level);
}

const jsonConfounderIds = new Set(effects.confounders.map((c) => c.id));
ok(
  'confounder ids match in both directions',
  CONFOUNDER_DEFINITIONS.every((c) => jsonConfounderIds.has(c.id)) &&
    [...jsonConfounderIds].every((id) => CONFOUNDER_DEFINITIONS.some((c) => c.id === id)),
);

// The PSA correction is the one number in this system that must never drift
// between the two files without someone noticing.
const jsonPsa = effects.agents
  .find((a) => a.id === 'finasteride')
  .labEffects.find((e) => e.analyteId === 'psa-total');
eq('JSON PSA factor is 2.0', jsonPsa.correction.factor, 2);
eq('JSON PSA minimum days matches TS', jsonPsa.correction.minDaysOnDrug, LAB_EFFECTS.find((e) => e.analyteId === 'psa-total').correctionMinDays);
eq('JSON PSA invalidator count matches TS', jsonPsa.correction.invalidatedBy.length, LAB_EFFECTS.find((e) => e.analyteId === 'psa-total').correctionInvalidatedBy.length);

/* ================================================================== */
s('17. JSON hygiene');

ok('every JSON lab effect carries a confidence tag', effects.agents.every((a) => (a.labEffects ?? []).every((e) => !!e.confidence)));
ok('every JSON interaction carries a confidence tag', effects.interactions.every((i) => !!i.confidence));
ok('every JSON confounder carries an engine instruction', effects.confounders.every((c) => !!c.engineInstruction));
ok('every JSON confounder states what it is NOT', effects.confounders.every((c) => !!c.notThis));
ok('the re-verification list is populated and ranked', effects.reVerifyBeforeLaunch.length >= 5 && effects.reVerifyBeforeLaunch[0].rank === 1);
ok('the PSA item is rank 1 on the re-verification list', /PSA/.test(effects.reVerifyBeforeLaunch[0].item));
ok('the policy block restates Tier 3 rule 1', /start|stop|dose/i.test(effects.policy.tier3Rule1));
ok('the non-interaction list exists so folklore does not get re-added', effects.nonInteractions.entries.length >= 5);
ok('boundaries name the owning module for upper limits', /micronutrients/i.test(effects.boundaries.upperLimitStacking));
ok('boundaries name the owning module for weight perturbations', /weight-trend/i.test(effects.boundaries.weightPerturbations));
ok('minoxidil records zero lab effects deliberately, with a note', effects.agents.find((a) => a.id === 'minoxidil-topical').labEffects.length === 0);
ok(
  'minoxidil evidence honesty explicitly disowns the oral-minoxidil incidence figures',
  /LOW-DOSE ORAL/i.test(effects.agents.find((a) => a.id === 'minoxidil-topical').evidenceHonesty),
);
ok(
  'every uncertain-confidence lab effect refuses a correction factor',
  effects.agents.every((a) =>
    (a.labEffects ?? []).every((e) => !/^uncertain$/.test(e.confidence) || e.correction.defensible === false),
  ),
);

/* ================================================================== */
console.log(`\n${'='.repeat(58)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All assertions passed.');
