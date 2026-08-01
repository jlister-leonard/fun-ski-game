/**
 * nutrition-personalization.test.ts — behavioural assertions for the
 * personalization modules: micronutrients.ts and dietary-guardrails.ts.
 *
 * Ported verbatim from docs/kg/specs/algorithms/verify-personalization.mjs.
 * Every assertion, condition and tolerance is preserved one-for-one.
 *
 * These are behavioural assertions, not unit tests of implementation details.
 * Several of them are safety invariants: if the copy assertions in §7 start
 * failing, that is a product-safety regression, not a cosmetic one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it, expect } from 'vitest';

import {
  computeIntake,
  countsTowardUpperLimit,
  assessAll,
  assessNutrient,
  resolveReference,
  resolveUpperLimit,
  energyScaledFiberTarget,
  expandStack,
  findStackOverlaps,
  analyseStackCoverage,
  adequacyFindings,
  rankGaps,
  gapsSupplementsCannotClose,
  noVegetableRiskProfile,
  GAP_CLOSING_PROTOCOL,
  recommendationExceedsUpperLimit,
  recommendationsForGaps,
  ADEQUACY_THRESHOLDS,
  ADEQUACY_COPY,
} from '../micronutrients';
import type {
  AdequacyAssessment,
  LoggedItem,
  MicronutrientDatabase,
  NutrientDefinition,
  PersonContext,
  Sex,
  StackOverlap,
  SupplementCap,
  SupplementRecommendation,
  SupplementStack,
} from '../micronutrients';

import {
  detectSustainedUnderEating,
  checkMacroFloors,
  checkUpperLimits,
  checkZincCopperBalance,
  checkBiotinAssayInterference,
  checkRestrictedDietPlausibility,
  validateTrackingSafety,
  checkDaySummaryCopy,
  supportPrompt,
  assessOasDisclosure,
  filterReactedFoods,
  validateDietary,
  DIET_LIMITS,
  REQUIRED_TRACKING_SAFETY,
  OAS_COPY,
} from '../dietary-guardrails';
import type { DayIntake, TrackingSafetyConfig } from '../dietary-guardrails';

import type { Finding } from '../guardrails';

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let currentSection = 'preamble';
function section(title: string): void {
  currentSection = title;
}
function check(name: string, condition: boolean, detail = ''): void {
  const label = `${currentSection} · ${name}${detail ? ` (${detail})` : ''}`;
  it(label, () => {
    expect(condition).toBe(true);
  });
}
function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ */
/* Load the reference data                                             */
/* ------------------------------------------------------------------ */

const dbPath = fileURLToPath(new URL('../../../../docs/kg/specs/micronutrients.json', import.meta.url));
const db = JSON.parse(readFileSync(dbPath, 'utf8')) as MicronutrientDatabase;

/**
 * `primaryFoodSources` lives in micronutrients.json but is not part of the
 * module's `NutrientDefinition` surface. Read it through a narrow structural
 * type rather than `any`.
 */
interface FoodSourceEntry {
  food: string;
  serving?: string;
  amount: number;
  vegetable: boolean;
}
function foodSourcesOf(n: NutrientDefinition): readonly FoodSourceEntry[] | undefined {
  return (n as NutrientDefinition & { primaryFoodSources?: readonly FoodSourceEntry[] })
    .primaryFoodSources;
}

/** The user this app is being built for. */
const PERSON: PersonContext = { sex: 'male', ageYears: 38, energyKcal: 2400 };

const byId: Record<string, NutrientDefinition> = Object.fromEntries(
  db.nutrients.map((n) => [n.id, n] as const),
);

/* ================================================================== */
section('1. micronutrients.json integrity');
/* ================================================================== */

check('database has a version', typeof db.version === 'string' && db.version.length > 0);
check('database has nutrients', Array.isArray(db.nutrients) && db.nutrients.length >= 25,
  `got ${db.nutrients.length}`);

const REQUIRED_IDS: readonly string[] = [
  'fiber', 'potassium', 'magnesium', 'folate', 'vitamin_k1', 'vitamin_k2', 'vitamin_c',
  'vitamin_a', 'lutein_zeaxanthin', 'vitamin_d', 'vitamin_e', 'iron', 'zinc', 'calcium',
  'selenium', 'iodine', 'choline', 'omega3_epa_dha', 'dietary_nitrate',
  'thiamin', 'riboflavin', 'niacin', 'pantothenic_acid', 'vitamin_b6', 'biotin', 'vitamin_b12',
];
for (const id of REQUIRED_IDS) {
  check(`required nutrient present: ${id}`, byId[id] !== undefined);
}

const VALID_RISK: readonly string[] = ['none', 'low', 'moderate', 'high', 'severe'];
const VALID_CLOSE: readonly string[] = ['equivalent', 'good', 'partial', 'poor'];
const VALID_BASIS: readonly string[] = [
  'total', 'supplemental-only', 'supplemental-and-fortified-only',
  'synthetic-folic-acid-only', 'preformed-retinol-only',
];

let structureOk = true;
let sourcesOk = true;
let foodSourcesOk = true;
for (const n of db.nutrients) {
  if (typeof n.id !== 'string' || typeof n.name !== 'string' || typeof n.unit !== 'string') structureOk = false;
  if (!VALID_RISK.includes(n.riskWithoutVegetables)) structureOk = false;
  if (!VALID_CLOSE.includes(n.supplementCloseability)) structureOk = false;
  if (n.upperLimit && !VALID_BASIS.includes(n.upperLimitBasis as string)) structureOk = false;
  if (n.referenceType === 'none' && !n.alternativeReference && n.id !== 'x') {
    // every 'none' nutrient must carry an explicit anchor + provenance
    structureOk = false;
  }
  if (!Array.isArray(n.sources) || n.sources.length === 0) sourcesOk = false;
  const primaryFoodSources = foodSourcesOf(n);
  if (!Array.isArray(primaryFoodSources) || primaryFoodSources.length < 3) foodSourcesOk = false;
  for (const s of primaryFoodSources ?? []) {
    if (typeof s.vegetable !== 'boolean') foodSourcesOk = false;
  }
}
check('every nutrient has valid enum values and an anchor where referenceType=none', structureOk);
check('every nutrient cites at least one source', sourcesOk);
check('every nutrient has >=3 food sources, each flagged vegetable/not', foodSourcesOk);

// Reference bands must cover a plausible adult age range for both sexes.
let bandsOk = true;
for (const n of db.nutrients) {
  const ref = n.reference ?? n.alternativeReference;
  if (!ref) continue;
  for (const sex of ['male', 'female'] as const) {
    for (const age of [19, 30, 31, 50, 51, 70, 71, 90]) {
      const hit = ref[sex].find((b) => age >= b.minAge && age <= b.maxAge);
      if (!hit) { bandsOk = false; }
    }
  }
}
check('reference age bands cover ages 19-90 for both sexes with no holes', bandsOk);

// UL must never be below the RDA/AI — that would be an unsatisfiable target.
let ulSaneOk = true;
const ulSaneExceptions: string[] = [];
for (const n of db.nutrients) {
  if (!n.reference || !n.upperLimit) continue;
  const rda = resolveReference(n, PERSON).value;
  const ul = resolveUpperLimit(n, PERSON);
  if (rda === null || ul === null) continue;
  // Legitimate exception: supplemental-only ULs can sit below the total RDA,
  // because the RDA is met from food. Magnesium is the canonical case.
  if (ul < rda && n.upperLimitBasis === 'total') { ulSaneOk = false; ulSaneExceptions.push(n.id); }
}
check('no nutrient has a total-basis UL below its RDA', ulSaneOk, ulSaneExceptions.join(','));
check('magnesium is the expected supplemental-only UL-below-RDA case',
  byId.magnesium.upperLimitBasis === 'supplemental-only' &&
  (resolveUpperLimit(byId.magnesium, PERSON) as number) <
    (resolveReference(byId.magnesium, PERSON).value as number));

/* ================================================================== */
section('2. Known DRI values resolve correctly');
/* ================================================================== */

const driExpectations: readonly (readonly [string, Sex, number, number])[] = [
  ['potassium', 'male', 38, 3400],
  ['potassium', 'female', 38, 2600],
  ['magnesium', 'male', 25, 400],
  ['magnesium', 'male', 38, 420],
  ['magnesium', 'female', 25, 310],
  ['fiber', 'male', 38, 38],
  ['fiber', 'male', 60, 30],
  ['vitamin_k1', 'male', 38, 120],
  ['vitamin_k1', 'female', 38, 90],
  ['vitamin_c', 'male', 38, 90],
  ['vitamin_d', 'male', 38, 15],
  ['vitamin_d', 'male', 80, 20],
  ['folate', 'male', 38, 400],
  ['iron', 'female', 30, 18],
  ['iron', 'female', 60, 8],
  ['zinc', 'male', 38, 11],
  ['choline', 'male', 38, 550],
  ['vitamin_b6', 'male', 38, 1.3],
  ['vitamin_b6', 'male', 60, 1.7],
  ['vitamin_b12', 'male', 38, 2.4],
  ['selenium', 'male', 38, 55],
  ['iodine', 'male', 38, 150],
  ['calcium', 'female', 60, 1200],
];
for (const [id, sex, age, want] of driExpectations) {
  const got = resolveReference(byId[id], { sex, ageYears: age }).value;
  check(`${id} ${sex} age ${age} = ${want}`, got === want, `got ${got}`);
}

const ulExpect: readonly (readonly [string, number])[] = [
  ['magnesium', 350], ['zinc', 40], ['selenium', 400], ['iodine', 1100],
  ['vitamin_d', 100], ['vitamin_c', 2000], ['vitamin_a', 3000], ['vitamin_e', 1000],
  ['folate', 1000], ['niacin', 35], ['vitamin_b6', 100], ['choline', 3500], ['iron', 45],
];
for (const [id, want] of ulExpect) {
  const got = resolveUpperLimit(byId[id], PERSON);
  check(`${id} UL = ${want}`, got === want, `got ${got}`);
}

check('potassium has no UL', resolveUpperLimit(byId.potassium, PERSON) === null);
check('vitamin K1 has no UL', resolveUpperLimit(byId.vitamin_k1, PERSON) === null);
check('vitamin B12 has no UL', resolveUpperLimit(byId.vitamin_b12, PERSON) === null);

/* ================================================================== */
section('3. Upper-limit provenance — the three unit traps');
/* ================================================================== */

// --- Magnesium: supplemental-only -----------------------------------
check('magnesium: food does NOT count toward UL',
  countsTowardUpperLimit('supplemental-only', { nutrientId: 'magnesium', amount: 500, source: 'food' }) === false);
check('magnesium: supplement DOES count toward UL',
  countsTowardUpperLimit('supplemental-only', { nutrientId: 'magnesium', amount: 300, source: 'supplement' }) === true);

// --- Folate: synthetic folic acid only -------------------------------
check('folate: natural food folate does NOT count',
  countsTowardUpperLimit('synthetic-folic-acid-only', { nutrientId: 'folate', amount: 600, source: 'food' }) === false);
check('folate: fortified-grain folic acid DOES count',
  countsTowardUpperLimit('synthetic-folic-acid-only', { nutrientId: 'folate', amount: 400, source: 'fortified' }) === true);
check('folate: explicit food-folate form in a supplement does NOT count',
  countsTowardUpperLimit('synthetic-folic-acid-only', { nutrientId: 'folate', amount: 400, source: 'supplement', form: 'food-folate' }) === false);

// --- Vitamin A: preformed retinol only -------------------------------
check('vitamin A: carotenoids do NOT count toward UL',
  countsTowardUpperLimit('preformed-retinol-only', { nutrientId: 'vitamin_a', amount: 5000, source: 'food', form: 'carotenoid' }) === false);
check('vitamin A: preformed retinol from liver DOES count',
  countsTowardUpperLimit('preformed-retinol-only', { nutrientId: 'vitamin_a', amount: 6582, source: 'food', form: 'preformed' }) === true);

// --- Niacin ----------------------------------------------------------
check('niacin: natural food niacin does NOT count',
  countsTowardUpperLimit('supplemental-and-fortified-only', { nutrientId: 'niacin', amount: 30, source: 'food' }) === true === false ||
  countsTowardUpperLimit('supplemental-and-fortified-only', { nutrientId: 'niacin', amount: 30, source: 'food' }) === false);

/* --- Scenario: the magnesium false alarm the provenance logic prevents --- */
const magDay: LoggedItem[] = [
  { id: 'oats', label: 'Oats', contributions: [{ nutrientId: 'magnesium', amount: 110, source: 'food' }] },
  { id: 'pumpkin', label: 'Pumpkin seeds', contributions: [{ nutrientId: 'magnesium', amount: 156, source: 'food' }] },
  { id: 'almonds', label: 'Almonds', contributions: [{ nutrientId: 'magnesium', amount: 80, source: 'food' }] },
  { id: 'magsupp', label: 'Magnesium glycinate', contributions: [{ nutrientId: 'magnesium', amount: 200, source: 'supplement' }] },
];
const magAssess = assessNutrient(byId.magnesium, computeIntake(magDay, db).get('magnesium'), PERSON);
check('magnesium scenario: total intake 546 mg', magAssess.intake === 546, `got ${magAssess.intake}`);
check('magnesium scenario: only 200 mg counts against the 350 mg UL', magAssess.intakeAgainstUpperLimit === 200);
check('magnesium scenario: NOT flagged over UL despite total > 350', magAssess.upperLimitStatus === 'ok',
  `got ${magAssess.upperLimitStatus}`);
check('magnesium scenario: reference met', magAssess.status === 'met');

/* --- Scenario: liver + retinol multivitamin, the real vitamin A case --- */
const liverDay: LoggedItem[] = [
  { id: 'liver', label: 'Beef liver 85 g', contributions: [{ nutrientId: 'vitamin_a', amount: 6582, source: 'food', form: 'preformed' }] },
  { id: 'carrot', label: 'Carrots', contributions: [{ nutrientId: 'vitamin_a', amount: 918, source: 'food', form: 'carotenoid' }] },
  { id: 'mvi', label: 'Multivitamin', contributions: [{ nutrientId: 'vitamin_a', amount: 900, source: 'supplement', form: 'preformed' }] },
];
const vaAssess = assessNutrient(byId.vitamin_a, computeIntake(liverDay, db).get('vitamin_a'), PERSON);
check('vitamin A scenario: total 8400 mcg RAE', vaAssess.intake === 8400, `got ${vaAssess.intake}`);
check('vitamin A scenario: 7482 counts (carotenoid 918 excluded)', vaAssess.intakeAgainstUpperLimit === 7482,
  `got ${vaAssess.intakeAgainstUpperLimit}`);
check('vitamin A scenario: UL exceeded', vaAssess.upperLimitStatus === 'exceeded');

// A carotenoid-only day must never trip the UL, however large.
const caroteneDay: LoggedItem[] = [
  { id: 'sp', label: 'Sweet potato x4', contributions: [{ nutrientId: 'vitamin_a', amount: 5612, source: 'food', form: 'carotenoid' }] },
];
const caroteneAssess = assessNutrient(byId.vitamin_a, computeIntake(caroteneDay, db).get('vitamin_a'), PERSON);
check('vitamin A: 5612 mcg all-carotenoid does NOT trip the UL', caroteneAssess.upperLimitStatus === 'ok');

/* ================================================================== */
section('4. Potassium is a food problem, not a pill problem');
/* ================================================================== */

const kDef = byId.potassium;
check('potassium documents the 99 mg supplement cap', kDef.supplementCap?.value === 99);
check('potassium closeability rated poor', kDef.supplementCloseability === 'poor');

const kAI = resolveReference(kDef, PERSON).value as number;
const pillsToClose = Math.ceil(kAI / (kDef.supplementCap as SupplementCap).value);
check(`closing the potassium AI from 99 mg units needs ${pillsToClose} units (>30)`, pillsToClose > 30,
  `got ${pillsToClose}`);

// Salt substitute is the actual lever the data supports.
const saltSub = (foodSourcesOf(kDef) ?? []).find((s) => /salt substitute/i.test(s.food));
check('potassium lists a KCl salt substitute as a source', saltSub !== undefined);
check('one 1/4 tsp of salt substitute beats 8 supplement units',
  (saltSub as FoodSourceEntry).amount > (kDef.supplementCap as SupplementCap).value * 8);

check('potassium athlete note exists and does not overstate sweat losses',
  typeof kDef.athleteNote === 'string' && /small/i.test(kDef.athleteNote));

/* ================================================================== */
section('5. Fiber energy-scaling');
/* ================================================================== */

check('14 g/1000 kcal at 2000 kcal = 28 g', energyScaledFiberTarget(38, 2000) === 28);
check('14 g/1000 kcal at 2400 kcal = 34 g', energyScaledFiberTarget(38, 2400) === 34);
check('falls back to tabulated when energy unknown', energyScaledFiberTarget(38, undefined) === 38);

const fiberAssess = assessNutrient(
  byId.fiber,
  computeIntake([{ id: 'f', label: 'Food', contributions: [{ nutrientId: 'fiber', amount: 34, source: 'food' }] }], db).get('fiber'),
  PERSON,
);
check('34 g fiber at 2400 kcal counts as met (not short against the 38 g table value)',
  fiberAssess.status === 'met', `status ${fiberAssess.status}, ref ${fiberAssess.reference}`);

/* ================================================================== */
section('6. Supplement stack: overlap, coverage, remaining gaps');
/* ================================================================== */

const stack: SupplementStack = {
  products: [
    {
      id: 'mvi', label: 'Daily multivitamin', dosesPerDay: 1, timing: 'with-breakfast',
      perDose: [
        { nutrientId: 'zinc', amount: 15, source: 'supplement' },
        { nutrientId: 'vitamin_b6', amount: 50, source: 'supplement' },
        { nutrientId: 'vitamin_k1', amount: 120, source: 'supplement' },
        { nutrientId: 'folate', amount: 400, source: 'supplement', form: 'folic-acid' },
        { nutrientId: 'vitamin_d', amount: 25, source: 'supplement' },
      ],
    },
    {
      id: 'zma', label: 'ZMA', dosesPerDay: 1, timing: 'evening',
      perDose: [
        { nutrientId: 'zinc', amount: 30, source: 'supplement' },
        { nutrientId: 'magnesium', amount: 450, source: 'supplement' },
        { nutrientId: 'vitamin_b6', amount: 10.5, source: 'supplement' },
      ],
    },
    {
      id: 'bcomplex', label: 'B-complex', dosesPerDay: 1, timing: 'morning',
      perDose: [{ nutrientId: 'vitamin_b6', amount: 75, source: 'supplement' }],
    },
    {
      id: 'd3', label: 'Vitamin D3 5000 IU', dosesPerDay: 1, timing: 'with-dinner',
      perDose: [{ nutrientId: 'vitamin_d', amount: 125, source: 'supplement' }],
    },
  ],
};

const expanded = expandStack(stack);
check('expandStack multiplies by dosesPerDay and preserves source', expanded.length === 4);

const overlaps = findStackOverlaps(stack, db, PERSON);
const overlapIds = overlaps.map((o) => o.nutrientId);
check('detects zinc supplied by 2 products', overlapIds.includes('zinc'));
check('detects B6 supplied by 3 products', overlapIds.includes('vitamin_b6'));
check('detects vitamin D supplied by 2 products', overlapIds.includes('vitamin_d'));
check('does NOT flag magnesium as an overlap (single product)', !overlapIds.includes('magnesium'));

const b6Overlap = overlaps.find((o) => o.nutrientId === 'vitamin_b6') as StackOverlap;
check('B6 stack total is 135.5 mg', near(b6Overlap.total, 135.5, 0.01), `got ${b6Overlap.total}`);
check('B6 overlap names all 3 products', b6Overlap.products.length === 3);
check('overlaps are sorted with UL-exceeding first', overlaps[0].total > (overlaps[0].upperLimit as number));

// A realistic no-vegetable day of food.
const foodDay: LoggedItem[] = [
  { id: 'eggs', label: '3 eggs', contributions: [
    { nutrientId: 'choline', amount: 441, source: 'food' },
    { nutrientId: 'vitamin_a', amount: 225, source: 'food', form: 'preformed' },
    { nutrientId: 'vitamin_k1', amount: 1, source: 'food' },
    { nutrientId: 'selenium', amount: 45, source: 'food' },
  ]},
  { id: 'chicken', label: 'Chicken breast 300 g', contributions: [
    { nutrientId: 'potassium', amount: 970, source: 'food' },
    { nutrientId: 'zinc', amount: 3, source: 'food' },
    { nutrientId: 'niacin', amount: 36, source: 'food' },
    { nutrientId: 'vitamin_b6', amount: 1.8, source: 'food' },
  ]},
  { id: 'oats', label: 'Oats 80 g', contributions: [
    { nutrientId: 'fiber', amount: 8, source: 'food' },
    { nutrientId: 'magnesium', amount: 110, source: 'food' },
    { nutrientId: 'thiamin', amount: 0.5, source: 'food' },
  ]},
  { id: 'yog', label: 'Greek yogurt 200 g', contributions: [
    { nutrientId: 'calcium', amount: 220, source: 'food' },
    { nutrientId: 'potassium', amount: 280, source: 'food' },
    { nutrientId: 'riboflavin', amount: 0.5, source: 'food' },
    { nutrientId: 'iodine', amount: 60, source: 'food' },
  ]},
  { id: 'banana', label: 'Banana', contributions: [
    { nutrientId: 'potassium', amount: 422, source: 'food' },
    { nutrientId: 'vitamin_c', amount: 10, source: 'food' },
    { nutrientId: 'fiber', amount: 3, source: 'food' },
  ]},
  { id: 'rice', label: 'Enriched rice 200 g cooked', contributions: [
    { nutrientId: 'folate', amount: 180, source: 'fortified' },
    { nutrientId: 'fiber', amount: 1, source: 'food' },
  ]},
];

const coverage = analyseStackCoverage(foodDay, stack, db, PERSON);

check('vitamin K1 gap is closed by the supplement', coverage.closedBySupplement.includes('vitamin_k1'));
check('folate gap is closed by the supplement', coverage.closedBySupplement.includes('folate'));

const stillShortIds = coverage.stillShort.map((a) => a.nutrientId);
check('potassium still short after supplements', stillShortIds.includes('potassium'));
check('fiber still short after supplements', stillShortIds.includes('fiber'));
check('vitamin K1 NOT still short', !stillShortIds.includes('vitamin_k1'));

const notCloseableIds = coverage.stillShortAndNotSupplementable.map((a) => a.nutrientId);
check('potassium is in the "supplements will not fix this" list', notCloseableIds.includes('potassium'));
check('fiber is in the "supplements will not fix this" list', notCloseableIds.includes('fiber'));

const overIds = coverage.overUpperLimit.map((a) => a.nutrientId);
check('B6 flagged over UL (135.5 > 100)', overIds.includes('vitamin_b6'));
check('zinc flagged over UL (45 supp + 3 food > 40)', overIds.includes('zinc'));
check('vitamin D flagged over UL (150 > 100)', overIds.includes('vitamin_d'));
check('magnesium IS flagged over UL — 450 mg supplemental exceeds the 350 mg supplemental UL',
  overIds.includes('magnesium'));

/* --- Anchored nutrients must never appear as gaps -------------------- */
const allAssess = assessAll([...foodDay, ...expanded], db, PERSON);
const rankedIds = rankGaps(allAssess).map((a) => a.nutrientId);
check('dietary nitrate never listed as a gap (anchor, not a requirement)', !rankedIds.includes('dietary_nitrate'));
check('lutein+zeaxanthin never listed as a gap', !rankedIds.includes('lutein_zeaxanthin'));
check('vitamin K2 never listed as a gap', !rankedIds.includes('vitamin_k2'));

const nitrateAssess = allAssess.find((a) => a.nutrientId === 'dietary_nitrate') as AdequacyAssessment;
check('nitrate assessment is marked as an anchor', nitrateAssess.referenceIsAnchor === true);

/* --- Gap ranking puts severity first --------------------------------- */
const ranked = rankGaps(allAssess);
let rankOrdered = true;
const sev: Record<string, number> = { 'well-short': 0, short: 1, 'slightly-short': 2 };
for (let i = 1; i < ranked.length; i++) {
  if (sev[ranked[i - 1].status] > sev[ranked[i].status]) rankOrdered = false;
}
check('rankGaps orders by severity descending', rankOrdered);
check('gapsSupplementsCannotClose is a subset of rankGaps',
  gapsSupplementsCannotClose(allAssess).every((a) => rankedIds.includes(a.nutrientId)));

/* --- No-vegetable risk profile --------------------------------------- */
const risky = noVegetableRiskProfile(db).map((n) => n.id);
check('vitamin K1 tops the no-vegetable risk profile',
  ['vitamin_k1', 'lutein_zeaxanthin', 'dietary_nitrate'].includes(risky[0]), `got ${risky[0]}`);
check('nitrate rated severe risk without vegetables', byId.dietary_nitrate.riskWithoutVegetables === 'severe');
check('vitamin K1 rated severe risk without vegetables', byId.vitamin_k1.riskWithoutVegetables === 'severe');
check('potassium rated high risk without vegetables', byId.potassium.riskWithoutVegetables === 'high');
check('zinc rated no risk without vegetables', byId.zinc.riskWithoutVegetables === 'none');
check('B12 rated no risk without vegetables', byId.vitamin_b12.riskWithoutVegetables === 'none');
check('risk profile excludes irrelevant nutrients at default threshold', !risky.includes('vitamin_b12'));

/* ================================================================== */
section('6b. Gap-closing protocol — concrete, dosed, UL-safe');
/* ================================================================== */

check('protocol exists and is non-trivial', GAP_CLOSING_PROTOCOL.length >= 8);

let protocolStructureOk = true;
let protocolVagueOk = true;
const VAGUE: readonly string[] = ['consider ', 'you may wish', 'might want to', 'talk to your doctor about whether'];
for (const r of GAP_CLOSING_PROTOCOL) {
  if (!r.compound || !r.formRationale || !r.timingRationale || !r.closes) protocolStructureOk = false;
  if (!(r.doseLow > 0) || !(r.doseHigh >= r.doseLow) || !r.unit) protocolStructureOk = false;
  if (!['well-established', 'reasonable-inference', 'uncertain'].includes(r.confidence)) protocolStructureOk = false;
  if (r.tier !== 1 && r.tier !== 2) protocolStructureOk = false;
  if (r.tier === 2 && !r.caveat) protocolStructureOk = false;
  const text = `${r.compound} ${r.closes}`.toLowerCase();
  if (VAGUE.some((v) => text.includes(v))) protocolVagueOk = false;
}
check('every recommendation names a compound, form, dose range, timing and confidence', protocolStructureOk);
check('every Tier 2 recommendation carries a specific caveat', protocolStructureOk);
check('no recommendation hedges with "consider..."', protocolVagueOk);

// The safety property that matters: the recommended doses must not, on their
// own, breach a UL for someone taking nothing else.
const emptyStack: SupplementStack = { products: [] };
let allWithinUl = true;
const ulBreaches: string[] = [];
for (const r of GAP_CLOSING_PROTOCOL) {
  const breach = recommendationExceedsUpperLimit(r, emptyStack, db, PERSON);
  if (breach) { allWithinUl = false; ulBreaches.push(`${r.id}:${breach.nutrientId}`); }
}
check('every recommended dose is within its UL on an empty stack', allWithinUl, ulBreaches.join(','));

// And the check must actually fire when the user already takes something.
const heavyD3Stack: SupplementStack = {
  products: [{ id: 'x', label: 'D3 5000', dosesPerDay: 1, timing: 'any',
    perDose: [{ nutrientId: 'vitamin_d', amount: 90, source: 'supplement' }] }],
};
const d3Rec = GAP_CLOSING_PROTOCOL.find((r) => r.id === 'vitamin_d') as SupplementRecommendation;
check('recommending D3 on top of an existing 3600 IU dose is caught',
  recommendationExceedsUpperLimit(d3Rec, heavyD3Stack, db, PERSON) !== null);

const gapRecs = recommendationsForGaps(rankGaps(allAssess), stack, db, PERSON);
check('gap matching returns recommendations', gapRecs.safe.length + gapRecs.wouldExceedUpperLimit.length > 0);
check('recommendations are filtered against the existing stack, not blindly emitted',
  gapRecs.safe.every((r) => recommendationExceedsUpperLimit(r, stack, db, PERSON) === null));
check('creatine is never auto-suggested by gap analysis (it closes no gap)',
  ![...gapRecs.safe, ...gapRecs.wouldExceedUpperLimit].some((r) => r.id === 'creatine'));
check('potassium recommendation is the salt substitute, not a pill',
  /salt substitute/i.test((GAP_CLOSING_PROTOCOL.find((r) => r.id === 'potassium_salt') as SupplementRecommendation).compound));

/* --- Honesty checks on specific recommendations ---------------------- */
const nitrateRec = GAP_CLOSING_PROTOCOL.find((r) => r.id === 'nitrate') as SupplementRecommendation;
check('nitrate dose tops out at the 8.4 mmol plateau, not higher', nitrateRec.doseHigh <= 550,
  `got ${nitrateRec.doseHigh}`);
check('nitrate entry explains that doubling the dose buys nothing',
  /buys no extra performance|did not extend/i.test(nitrateRec.elementalNote ?? ''));
check('nitrate caveat leads with the mouthwash interaction',
  /mouthwash/i.test(nitrateRec.caveat ?? ''));
check('nitrate caveat covers the saliva-spitting point', /spitting|swallow your saliva/i.test(nitrateRec.caveat ?? ''));
check('nitrate does NOT claim to raise VO2 max',
  !/raises? VO2|increase[sd]? VO2 ?max|boost.*VO2/i.test(`${nitrateRec.closes} ${nitrateRec.caveat}`));

const k1Rec = GAP_CLOSING_PROTOCOL.find((r) => r.id === 'k1') as SupplementRecommendation;
check('K1 recommendation warns that "vitamin K" products are often K2-only',
  /K2/i.test(k1Rec.formRationale));
check('K1 recommendation carries the warfarin caveat', /warfarin|anticoagulant/i.test(k1Rec.caveat ?? ''));

const magRec = GAP_CLOSING_PROTOCOL.find((r) => r.id === 'magnesium') as SupplementRecommendation;
check('magnesium recommendation names the form to avoid', /oxide/i.test(magRec.formRationale));
check('magnesium recommendation explains elemental vs compound weight',
  /elemental/i.test(magRec.elementalNote ?? ''));

const fibreRec = GAP_CLOSING_PROTOCOL.find((r) => r.id === 'psyllium') as SupplementRecommendation;
check('psyllium entry is honest that PHGG is not gel-forming',
  /not a psyllium equivalent|destroy guar viscosity/i.test(fibreRec.formRationale));
check('psyllium entry gives the inulin gas threshold', /5 g|10 g/.test(fibreRec.formRationale));
check('psyllium entry does not oversell weight loss',
  /adherence aid, not a weight-loss mechanism/i.test(fibreRec.closes));

const kRec = GAP_CLOSING_PROTOCOL.find((r) => r.id === 'potassium_salt') as SupplementRecommendation;
check('potassium caveat names CKD and the RAAS drugs',
  /kidney/i.test(kRec.caveat as string) && /ACE inhibitor/i.test(kRec.caveat as string) &&
  /spironolactone|potassium-sparing/i.test(kRec.caveat as string));
check('potassium caveat flags the iodine side effect of swapping table salt',
  /iodis|iodiz/i.test(kRec.caveat as string));

const creatineRec = GAP_CLOSING_PROTOCOL.find((r) => r.id === 'creatine') as SupplementRecommendation;
check('creatine entry says no loading phase is needed', /no loading phase/i.test(creatineRec.closes));
check('creatine entry is honest that it does not help VO2 max',
  /weak-to-absent|do not count it toward that goal/i.test(creatineRec.caveat ?? ''));

/* ================================================================== */
section('7. Adequacy findings never block, never moralise');
/* ================================================================== */

const findings = adequacyFindings(allAssess, { sustainedShortDays: { potassium: 12, fiber: 9 } });
check('adequacy produces findings', findings.length > 0);
check('NO adequacy finding is ever a block', findings.every((f) => f.level !== 'block'));

const potFinding = findings.find((f) => f.code === 'MICRO_SHORT_POTASSIUM');
check('sustained potassium shortfall escalates to warn', potFinding?.level === 'warn');
check('sustained copy mentions the run of days', /12/.test(potFinding?.message ?? ''));

// A single short day must NOT be a warn.
const oneDayFindings = adequacyFindings(allAssess, {});
const potOneDay = oneDayFindings.find((f) => f.code === 'MICRO_SHORT_POTASSIUM');
check('a single short day is info, not warn', potOneDay?.level === 'info');

const b6Ul = findings.find((f) => f.code === 'MICRO_UL_EXCEEDED_VITAMIN_B6');
check('B6 UL exceedance surfaces as a warn', b6Ul?.level === 'warn');

// Copy safety: no moralising, no food-shaming, no "deficient" from a log.
const allCopy = [
  ...findings.map((f) => f.message),
  ...Object.values(ADEQUACY_COPY).map((v) => (typeof v === 'string' ? v : '')),
].join(' ').toLowerCase();

const BANNED: readonly string[] = [
  'bad food', 'junk', 'cheat', 'guilt', 'guilty', 'naughty', 'sinful', 'clean eating',
  'you should be', 'you failed', 'unhealthy choice', 'deficient', 'deficiency',
];
for (const word of BANNED) {
  check(`adequacy copy avoids "${word}"`, !allCopy.includes(word));
}
check('copy distinguishes intake from status',
  ADEQUACY_COPY.intakeNotStatus.toLowerCase().includes('not what is in your blood'));

/* ================================================================== */
section('8. Sustained under-eating');
/* ================================================================== */

const target = 2400;
function days(pattern: readonly (number | null)[]): DayIntake[] {
  return pattern.map((k, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    kcal: k,
    targetKcal: target,
  }));
}

const onTarget = detectSustainedUnderEating(days(Array<number>(14).fill(2400)));
check('on-target fortnight produces no under-eating finding',
  onTarget.findings.every((f) => f.ok || f.code === 'LOGGING_SPARSE'));
check('on-target: 0 under-eaten days', onTarget.underEatenDays === 0);

const mildlyUnder = detectSustainedUnderEating(days([1800, 2400, 2400, 1850, 2400, 2400, 2400, 2400, 2400, 2400, 2400, 2400, 2400, 2400]));
check('2 low days in 14 does not trigger a finding',
  mildlyUnder.findings.some((f) => f.code === 'UNDEREAT_OK'));

const sustainedUnder = detectSustainedUnderEating(days([1700, 1750, 1800, 1650, 1700, 1900, 1750, 2400, 2400, 2400, 2400, 2400, 2400, 2400]));
check('7 sustained low days triggers a warn',
  sustainedUnder.findings.some((f) => f.code === 'BEHAVIOUR_SUSTAINED_UNDEREATING' && f.level === 'warn'),
  `under=${sustainedUnder.underEatenDays}`);

const severeUnder = detectSustainedUnderEating(days([1100, 1200, 1150, 1300, 1250, 1100, 2400, 2400, 2400, 2400, 2400, 2400, 2400, 2400]));
check('severe under-eating escalates to BEHAVIOUR_SEVERE_UNDEREATING',
  severeUnder.findings.some((f) => f.code === 'BEHAVIOUR_SEVERE_UNDEREATING' && f.level === 'warn'));

// Missing logs are missing data, not zero-calorie days.
const gappy = detectSustainedUnderEating(
  days(Array<number>(14).fill(2400)).map((d, i) => (i % 2 === 0 ? { ...d, kcal: null } : d)),
);
check('unlogged days are excluded, not counted as zero', gappy.underEatenDays === 0);
check('sparse logging is reported separately',
  gappy.findings.some((f) => f.code === 'LOGGING_SPARSE'));

// The invariant that matters most: under-eating must never lower a target.
const underEatCopy = severeUnder.findings.map((f) => f.message).join(' ').toLowerCase();
check('under-eating copy never proposes lowering the target',
  !/lower(ing)? your target|reduce your target|smaller target/.test(underEatCopy));
check('under-eating copy allows for under-logging as an explanation',
  /under-logging|logging/.test(underEatCopy));

/* ================================================================== */
section('9. Macro and fiber floors');
/* ================================================================== */

const goodMacros = checkMacroFloors({
  bodyweightKg: 84, proteinG: 180, fatG: 70, fiberG: 34, energyKcal: 2400, inDeficit: true,
});
check('adequate macros: all floors ok', goodMacros.every((f) => f.ok), JSON.stringify(goodMacros.filter((f) => !f.ok)));

const lowProtein = checkMacroFloors({
  bodyweightKg: 84, proteinG: 90, fatG: 70, fiberG: 34, energyKcal: 2400, inDeficit: true,
});
check('protein 1.07 g/kg trips the hard floor',
  lowProtein.some((f) => f.code === 'PROTEIN_BELOW_HARD_FLOOR' && f.level === 'warn'));

const midProtein = checkMacroFloors({
  bodyweightKg: 84, proteinG: 120, fatG: 70, fiberG: 34, energyKcal: 2400, inDeficit: true,
});
check('protein 1.43 g/kg is info, not warn',
  midProtein.some((f) => f.code === 'PROTEIN_BELOW_FLOOR' && f.level === 'info'));

const lowFat = checkMacroFloors({
  bodyweightKg: 84, proteinG: 180, fatG: 30, fiberG: 34, energyKcal: 2400, inDeficit: true,
});
check('fat 0.36 g/kg trips the fat floor',
  lowFat.some((f) => f.code === 'FAT_BELOW_FLOOR' && f.level === 'warn'));
check('fat floor message explains the fat-soluble vitamin consequence',
  (lowFat.find((f) => f.code === 'FAT_BELOW_FLOOR') as Finding).message.includes('fat-soluble'));

const lowFiber = checkMacroFloors({
  bodyweightKg: 84, proteinG: 180, fatG: 70, fiberG: 12, energyKcal: 2400, inDeficit: true,
});
check('fiber 12 g at 2400 kcal trips the fiber floor',
  lowFiber.some((f) => f.code === 'FIBER_BELOW_FLOOR'));
check('fiber finding is info, framed as hunger not virtue',
  (lowFiber.find((f) => f.code === 'FIBER_BELOW_FLOOR') as Finding).level === 'info' &&
  /hunger/.test((lowFiber.find((f) => f.code === 'FIBER_BELOW_FLOOR') as Finding).message));

/* ================================================================== */
section('10. Upper-limit findings with product attribution');
/* ================================================================== */

const ulFindings = checkUpperLimits({
  assessments: allAssess, stack, db, person: PERSON,
});
const b6Msg = ulFindings.find((f) => f.code === 'UL_EXCEEDED_VITAMIN_B6')?.message ?? '';
check('B6 UL finding names the contributing products',
  b6Msg.includes('B-complex') && b6Msg.includes('ZMA'), b6Msg);
check('B6 UL finding names the actual consequence (nerve damage)', /nerve/.test(b6Msg));
check('B6 UL finding acknowledges the EFSA disagreement', /EFSA|12 mg/.test(b6Msg));

const zincMsg = ulFindings.find((f) => f.code === 'UL_EXCEEDED_ZINC')?.message ?? '';
check('zinc UL finding names copper deficiency as the endpoint', /copper/.test(zincMsg));

const vdMsg = ulFindings.find((f) => f.code === 'UL_EXCEEDED_VITAMIN_D')?.message ?? '';
check('vitamin D UL finding mentions the 5000 IU retail dose', /5,000 IU|5000 IU/.test(vdMsg));

// Clinician-directed downgrades from warn to info, but does not disappear.
const directedFindings = checkUpperLimits({
  assessments: allAssess, stack, db, person: PERSON,
  clinicianDirectedProductIds: ['d3'],
});
const vdDirected = directedFindings.find((f) => f.code === 'UL_EXCEEDED_VITAMIN_D');
check('clinician-directed vitamin D downgrades to info', vdDirected?.level === 'info', `got ${vdDirected?.level}`);
check('clinician-directed finding still appears', vdDirected !== undefined);

check('no UL finding is ever a block', ulFindings.every((f) => f.level !== 'block'));

/* --- Zinc/copper and biotin ------------------------------------------ */
const zc = checkZincCopperBalance(stack, db, PERSON);
check('high supplemental zinc with no copper is flagged',
  zc.some((f) => f.code === 'ZINC_WITHOUT_COPPER' && f.level === 'info'));

const zcWithCopper = checkZincCopperBalance({
  products: [{ id: 'z', label: 'Zinc+Cu', dosesPerDay: 1, timing: 'any', perDose: [
    { nutrientId: 'zinc', amount: 30, source: 'supplement' },
    { nutrientId: 'copper', amount: 2000, source: 'supplement' },
  ]}],
}, db, PERSON);
check('zinc with copper present is not flagged', zcWithCopper.every((f) => f.ok));

const biotinHigh = checkBiotinAssayInterference({
  products: [{ id: 'b', label: 'Hair & nails', dosesPerDay: 1, timing: 'any',
    perDose: [{ nutrientId: 'biotin', amount: 10000, source: 'supplement' }] }],
});
check('high-dose biotin flags assay interference',
  biotinHigh.some((f) => f.code === 'BIOTIN_ASSAY_INTERFERENCE'));
check('biotin finding names troponin/thyroid specifically',
  /troponin|thyroid/.test(biotinHigh[0].message));
check('dietary-level biotin is not flagged',
  checkBiotinAssayInterference({ products: [{ id: 'b', label: 'MVI', dosesPerDay: 1, timing: 'any',
    perDose: [{ nutrientId: 'biotin', amount: 30, source: 'supplement' }] }] }).every((f) => f.ok));

/* ================================================================== */
section('11. Restricted food list + aggressive rate');
/* ================================================================== */

const implausible = checkRestrictedDietPlausibility({
  acceptedFoodCount: 14,
  coveredGroups: ['grains', 'protein', 'dairy'],
  ratePctBwPerWeek: -1.0,
  targetKcal: 1900,
  maintenanceKcal: 2900,
  hasSupplementStack: true,
  shortNutrientCount: 7,
});
check('narrow list + 1.0%/wk is flagged implausible',
  implausible.some((f) => f.code === 'RESTRICTED_DIET_RATE_IMPLAUSIBLE' && f.level === 'warn'));
check('the recommended response is slowing the rate, not eating more foods',
  /slowing|slower|% a week/.test((implausible.find((f) => f.code === 'RESTRICTED_DIET_RATE_IMPLAUSIBLE') as Finding).message));
check('does NOT tell the user to eat more different foods',
  !/eat more (different |new )?foods|try new foods|add vegetables/i.test(
    implausible.map((f) => f.message).join(' ')));
check('many short nutrients at an aggressive rate escalates',
  implausible.some((f) => f.code === 'ADEQUACY_IMPLAUSIBLE_AT_RATE' && f.level === 'warn'));

const plausible = checkRestrictedDietPlausibility({
  acceptedFoodCount: 40,
  coveredGroups: ['grains', 'protein', 'dairy', 'fruit', 'fats'],
  ratePctBwPerWeek: -0.5,
  targetKcal: 2300,
  maintenanceKcal: 2900,
  hasSupplementStack: true,
  shortNutrientCount: 2,
});
check('broad list at 0.5%/wk is not flagged', plausible.every((f) => f.ok));

const noStack = checkRestrictedDietPlausibility({
  acceptedFoodCount: 15,
  coveredGroups: ['grains', 'protein', 'dairy', 'fruit'],
  ratePctBwPerWeek: -0.5,
  targetKcal: 2300, maintenanceKcal: 2900, hasSupplementStack: false,
});
check('narrow list with no stack gets an info nudge to configure supplements',
  noStack.some((f) => f.code === 'RESTRICTED_DIET_NO_STACK' && f.level === 'info'));
check('group-coverage copy is framed as information, not instruction',
  checkRestrictedDietPlausibility({
    acceptedFoodCount: 30, coveredGroups: ['grains', 'protein', 'dairy'],
    ratePctBwPerWeek: -0.4, targetKcal: 2300, maintenanceKcal: 2700, hasSupplementStack: true,
  }).find((f) => f.code === 'FOOD_GROUP_COVERAGE_THIN')?.message.includes('rather than telling you what to eat') ?? false);

/* ================================================================== */
section('12. ARFID-aware tracking safety invariants');
/* ================================================================== */

check('shipped config passes its own invariants',
  validateTrackingSafety(REQUIRED_TRACKING_SAFETY).every((f) => f.ok));

check('streaks are a hard block',
  validateTrackingSafety({ ...REQUIRED_TRACKING_SAFETY, streaks: true } as unknown as TrackingSafetyConfig)
    .some((f) => f.code === 'SAFETY_STREAKS_ENABLED' && f.level === 'block'));
check('gamification is a hard block',
  validateTrackingSafety({ ...REQUIRED_TRACKING_SAFETY, gamification: true } as unknown as TrackingSafetyConfig)
    .some((f) => f.code === 'SAFETY_GAMIFICATION_ENABLED' && f.level === 'block'));
check('celebrating under-budget is a hard block',
  validateTrackingSafety({ ...REQUIRED_TRACKING_SAFETY, celebrateUnderBudget: true } as unknown as TrackingSafetyConfig)
    .some((f) => f.code === 'SAFETY_CELEBRATES_UNDER_BUDGET' && f.level === 'block'));
check('deprioritising adequacy is a hard block',
  validateTrackingSafety({ ...REQUIRED_TRACKING_SAFETY, adequacyProminence: 'lower' } as unknown as TrackingSafetyConfig)
    .some((f) => f.code === 'SAFETY_ADEQUACY_DEPRIORITISED' && f.level === 'block'));
check('weight projections warn',
  validateTrackingSafety({ ...REQUIRED_TRACKING_SAFETY, weightProjections: true })
    .some((f) => f.code === 'SAFETY_WEIGHT_PROJECTION_ENABLED' && f.level === 'warn'));
check('hideCalories is permitted in both states (it is a user affordance)',
  validateTrackingSafety({ ...REQUIRED_TRACKING_SAFETY, hideCalories: true }).every((f) => f.ok));

/* --- Copy lint ------------------------------------------------------- */
const badCopy: readonly string[] = [
  'Great job staying under today!',
  'Nice work — you saved 600 calories.',
  'Keep the streak going!',
  'You came in under budget.',
];
for (const c of badCopy) {
  check(`copy lint blocks: "${c.slice(0, 30)}..."`,
    checkDaySummaryCopy(c).some((f) => f.code === 'COPY_CELEBRATES_DEFICIT' && f.level === 'block'));
}
const okCopy: readonly string[] = [
  'You logged 2,310 kcal against a 2,400 target. Protein 182 g.',
  'Potassium and fibre are the two still short today.',
];
for (const c of okCopy) {
  check(`copy lint passes: "${c.slice(0, 30)}..."`, checkDaySummaryCopy(c).every((f) => f.ok));
}

/* ================================================================== */
section('13. Support prompt: once, dismissible, never nagging');
/* ================================================================== */

const severeFindings = severeUnder.findings;
const first = supportPrompt(severeFindings, { shown: false, dismissed: false });
check('prompt appears on severe under-eating', first !== null);
check('prompt is dismissible', first?.dismissible === true);
check('prompt says it will not come up again', /will not come up again/i.test(first?.body ?? ''));
check('prompt shows resources for the strong case', first?.showResources === true);

check('prompt does NOT reappear once shown',
  supportPrompt(severeFindings, { shown: true, dismissed: false }) === null);
check('prompt does NOT reappear once dismissed',
  supportPrompt(severeFindings, { shown: true, dismissed: true }) === null);
check('no prompt when nothing warrants it',
  supportPrompt(onTarget.findings, { shown: false, dismissed: false }) === null);

const moderate = supportPrompt(
  checkRestrictedDietPlausibility({
    acceptedFoodCount: 14, coveredGroups: ['grains', 'protein'], ratePctBwPerWeek: -1.0,
    targetKcal: 1900, maintenanceKcal: 2900, hasSupplementStack: true,
  }),
  { shown: false, dismissed: false },
);
check('moderate case gets the softer prompt', moderate?.code === 'SUPPORT_PROMPT_CONSIDER');
check('moderate prompt names ARFID-experienced dietitians specifically',
  /ARFID/.test(moderate?.body ?? ''));
check('moderate prompt states it is mentioned once',
  /once/i.test(moderate?.body ?? ''));

/* ================================================================== */
section('14. Oral allergy syndrome — the safety boundary');
/* ================================================================== */

const oasCopyAll = Object.values(OAS_COPY).join(' ').toLowerCase();

// The absolute prohibitions.
check('OAS copy never says a food is safe to eat',
  !/is safe to eat|are safe to eat|safe for you to eat/.test(oasCopyAll));
check('OAS copy never suggests trying a food',
  !/try (it|the food|a small)|give it a go|test it yourself/.test(oasCopyAll));
check('OAS copy explicitly refuses to declare foods safe',
  /will not tell you a food is safe/.test(oasCopyAll));
check('OAS copy explicitly warns against self-directed challenges',
  // Same pattern and same `s` (dotAll) flag as the source script; built via the
  // RegExp constructor because a literal `/…/s` needs an ES2018 target and the
  // app compiles to ES2017.
  new RegExp('do not use this app.*as a reason to try a food', 's').test(oasCopyAll));
check('OAS copy points to an allergist', /allergist/.test(oasCopyAll));
check('OAS copy explains the LTP exception to the cooking rule',
  /lipid transfer protein/.test(oasCopyAll) && /survives cooking/.test(oasCopyAll));
check('OAS copy never characterises reactions as merely mild',
  !/usually mild|only mild|just mild|nothing to worry/.test(oasCopyAll));
check('OAS copy names the systemic red flags',
  /throat tightness/.test(oasCopyAll) && /breathing/.test(oasCopyAll));

const systemic = assessOasDisclosure({
  reactedFoods: ['apple', 'hazelnut', 'peach'],
  seenAllergist: false,
  reportedSystemicSymptoms: true,
  hasEpinephrine: false,
});
check('systemic symptoms produce a warn', systemic.some((f) => f.code === 'OAS_SYSTEMIC_REPORTED' && f.level === 'warn'));
check('systemic + no epinephrine produces a second warn',
  systemic.some((f) => f.code === 'OAS_SYSTEMIC_NO_EPINEPHRINE' && f.level === 'warn'));
check('no-allergist prompt appears', systemic.some((f) => f.code === 'OAS_NO_ALLERGIST'));

const oralOnly = assessOasDisclosure({
  reactedFoods: ['apple'], seenAllergist: true, reportedSystemicSymptoms: false,
});
check('oral-only + seen allergist produces no warn', oralOnly.every((f) => f.level !== 'warn'));
check('reacted foods are acknowledged as excluded from suggestions',
  oralOnly.some((f) => f.code === 'OAS_FOODS_EXCLUDED'));

// No OAS finding may ever predict tolerance.
const oasMsgs = [...systemic, ...oralOnly].map((f) => f.message).join(' ').toLowerCase();
check('OAS findings never predict a food will be tolerated cooked',
  !/should be fine cooked|will be fine|you can eat it cooked/.test(oasMsgs));

/* --- Suggestion filtering -------------------------------------------- */
const candidates = [
  { label: 'Apple' }, { label: 'Apple sauce' }, { label: 'Green apple slices' },
  { label: 'Banana' }, { label: 'Greek yogurt' }, { label: 'Hazelnut butter' },
  { label: 'Chicken breast' },
];
const filtered = filterReactedFoods(candidates, ['apple', 'hazelnut']);
const labels = filtered.map((c) => c.label);
check('exact match excluded', !labels.includes('Apple'));
check('preparation variant excluded (apple sauce)', !labels.includes('Apple sauce'));
check('descriptor variant excluded (green apple slices)', !labels.includes('Green apple slices'));
check('hazelnut butter excluded', !labels.includes('Hazelnut butter'));
check('unrelated foods retained', labels.includes('Banana') && labels.includes('Chicken breast'));
check('empty reaction list is a no-op', filterReactedFoods(candidates, []).length === candidates.length);

/* ================================================================== */
section('15. End-to-end validateDietary');
/* ================================================================== */

const e2e = validateDietary({
  days: days([1700, 1750, 1800, 1650, 1700, 1900, 1750, 2400, 2400, 2400, 2400, 2400, 2400, 2400]),
  macros: { bodyweightKg: 84, proteinG: 130, fatG: 35, fiberG: 16, energyKcal: 2000, inDeficit: true },
  assessments: allAssess,
  stack, db, person: PERSON,
  restriction: {
    acceptedFoodCount: 16,
    coveredGroups: ['grains', 'protein', 'dairy', 'fruit'],
    ratePctBwPerWeek: -1.0,
    targetKcal: 2000, maintenanceKcal: 2950, hasSupplementStack: true, shortNutrientCount: 6,
  },
  oas: { reactedFoods: ['apple', 'peach'], seenAllergist: false, reportedSystemicSymptoms: false },
  trackingConfig: REQUIRED_TRACKING_SAFETY,
  supportPromptState: { shown: false, dismissed: false },
});

check('end-to-end produces findings', e2e.findings.length > 10, `got ${e2e.findings.length}`);
check('end-to-end is not blocked by a safe config', e2e.blocked === false);
check('actionable findings are sorted with warns first',
  e2e.actionable.length > 0 && e2e.actionable[0].level !== 'info');
check('end-to-end surfaces a support prompt', e2e.supportPrompt !== null);
check('every finding has a stable code', e2e.findings.every((f) => typeof f.code === 'string' && f.code.length > 0));
check('every non-ok finding has a message', e2e.findings.every((f) => f.ok || f.message.length > 0));

const e2eCodes = e2e.findings.map((f) => f.code);
check('e2e catches sustained under-eating', e2eCodes.includes('BEHAVIOUR_SUSTAINED_UNDEREATING'));
check('e2e catches the fat floor', e2eCodes.includes('FAT_BELOW_FLOOR'));
check('e2e catches restricted-diet implausibility', e2eCodes.includes('RESTRICTED_DIET_RATE_IMPLAUSIBLE'));
check('e2e catches the B6 upper limit', e2eCodes.includes('UL_EXCEEDED_VITAMIN_B6'));
check('e2e catches the biotin-free stack correctly (no false positive)', !e2eCodes.includes('BIOTIN_ASSAY_INTERFERENCE'));

// A bad build must fail loudly.
const badBuild = validateDietary({
  trackingConfig: { ...REQUIRED_TRACKING_SAFETY, streaks: true, celebrateUnderBudget: true } as unknown as TrackingSafetyConfig,
});
check('a build with streaks is blocked', badBuild.blocked === true);

/* ================================================================== */
section('16. Constants are exported and self-consistent');
/* ================================================================== */

check('ADEQUACY_THRESHOLDS ordering is sane',
  ADEQUACY_THRESHOLDS.MET_PCT > ADEQUACY_THRESHOLDS.SLIGHTLY_SHORT_PCT &&
  ADEQUACY_THRESHOLDS.SLIGHTLY_SHORT_PCT > ADEQUACY_THRESHOLDS.SHORT_PCT);
check('DIET_LIMITS under-eating fractions are ordered',
  DIET_LIMITS.UNDEREAT_DAY_FRACTION > DIET_LIMITS.SEVERE_UNDEREAT_DAY_FRACTION);
check('DIET_LIMITS protein floors are ordered',
  DIET_LIMITS.PROTEIN_FLOOR_G_PER_KG > DIET_LIMITS.PROTEIN_HARD_FLOOR_G_PER_KG);
check('escalation threshold exceeds warn threshold',
  DIET_LIMITS.UNDEREAT_DAYS_ESCALATE > DIET_LIMITS.UNDEREAT_DAYS_WARN);
check('restricted-diet rate ceiling is below the population max loss rate (1.0%/wk)',
  DIET_LIMITS.RESTRICTED_DIET_RATE_CEILING_PCT < 1.0);
