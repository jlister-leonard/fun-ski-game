#!/usr/bin/env node
/**
 * verify.mjs — executable proof that the pure food logic is correct.
 *
 *   node src/lib/food/verify.mjs
 *
 * Covers `portions.ts`, `nutrition-math.ts`, `search.ts` and the pure mapping
 * half of `open-food-facts.ts` (the network half is exercised with an injected
 * fetch stub, so this runs with the radio off).
 *
 * The modules under test are TypeScript. Rather than add a test runner or a
 * build step, this script transpiles them with the `typescript` package that is
 * already a devDependency, rewrites the `@/` path alias, and imports the result
 * from a temp directory. No new dependencies, and it exercises the real source
 * rather than a copy.
 *
 * Exits non-zero on any failure.
 */

import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const FOODS_JSON = join(REPO, 'src/data/foods/json');

// ---------------------------------------------------------------------------
// Transpile the modules under test
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'food-verify-'));

function compile(name, sourcePath = join(HERE, `${name}.ts`), outName = name) {
  const source = readFileSync(sourcePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
    fileName: `${name}.ts`,
  });
  const rewritten = outputText
    .replace(/(['"])@\/data\/foods\/types\1/g, "'./__types.mjs'")
    .replace(/(['"])@\/data\/foods\1/g, "'./__seed.mjs'")
    .replace(/from '\.\/(portions|nutrition-math|search|open-food-facts)'/g, "from './$1.mjs'");
  writeFileSync(join(work, `${outName}.mjs`), rewritten);
  return pathToFileURL(join(work, `${outName}.mjs`)).href;
}

// A shim standing in for `src/data/foods/index.ts`: same exports, but it reads
// the generated JSON off disk instead of relying on `resolveJsonModule`.
writeFileSync(
  join(work, '__seed.mjs'),
  `import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const DIR = ${JSON.stringify(FOODS_JSON)};
const all = [];
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  all.push(...JSON.parse(readFileSync(join(DIR, f), 'utf8')));
}
export const SEED_FOODS = Object.freeze(all);
export const SEED_FOODS_BY_ID = new Map(all.map((f) => [f.id, f]));
export const SEED_FOOD_COUNT = all.length;
`,
);
// types.ts carries real runtime exports (the category vocabulary and the
// micronutrient derivation helpers), so transpile it rather than stubbing it.
const typesUrl = compile('types', join(REPO, 'src/data/foods/types.ts'), '__types');

const portionsUrl = compile('portions');
const mathUrl = compile('nutrition-math');
const searchUrl = compile('search');
const offUrl = compile('open-food-facts');

const P = await import(portionsUrl);
const M = await import(mathUrl);
const S = await import(searchUrl);
const OFF = await import(offUrl);
const T = await import(typesUrl);

const SEED_FOODS = JSON.parse(
  JSON.stringify(
    readdirSync(FOODS_JSON)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .flatMap((f) => JSON.parse(readFileSync(join(FOODS_JSON, f), 'utf8'))),
  ),
);
const byId = new Map(SEED_FOODS.map((f) => [f.id, f]));
const food = (id) => {
  const f = byId.get(id);
  if (!f) throw new Error(`verify.mjs references a missing seed food: ${id}`);
  return f;
};

// ---------------------------------------------------------------------------
// Micro test harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
let group = '';

const describe = (name) => {
  group = name;
  console.log(`\n  ${name}`);
};

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`    ok   ${label}`);
  } catch (error) {
    failures.push(`[${group}] ${label}: ${error.message}`);
    console.log(`    FAIL ${label}\n         ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

function near(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message ?? 'value'}: expected ${expected} +/- ${tolerance}, got ${actual}`);
  }
}

function throws(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(message ?? 'expected a throw');
}

// ---------------------------------------------------------------------------
// portions.ts
// ---------------------------------------------------------------------------

describe('portions.ts — unit conversion');

await check('scaleMacros scales linearly (1 medium banana = 118 g)', () => {
  const banana = food('banana-raw');
  const m = P.scaleMacros(banana.per100g, 118);
  near(m.kcal, 89 * 1.18, 1e-9, 'kcal');
  near(m.protein_g, 1.09 * 1.18, 1e-9, 'protein');
  near(m.sodium_mg, 1 * 1.18, 1e-9, 'sodium');
});

await check('scaleMacros(0) is all zeroes', () => {
  const m = P.scaleMacros(food('banana-raw').per100g, 0);
  for (const value of Object.values(m)) assert(value === 0, 'expected zero');
});

await check('scaleMacros rejects negative grams', () => {
  throws(() => P.scaleMacros(food('banana-raw').per100g, -1));
});

await check('quantityToGrams handles grams, servings and millilitres', () => {
  const banana = food('banana-raw');
  assert(P.quantityToGrams(banana, { unit: 'g', amount: 137 }) === 137);
  near(
    P.quantityToGrams(banana, { unit: 'serving', amount: 2, servingLabel: '1 medium, 7-8 in (118 g)' }),
    236, 1e-9, 'two bananas',
  );
  const milk = food('milk-whole');
  near(P.quantityToGrams(milk, { unit: 'ml', amount: 240 }), 240 * 1.03, 1e-9, '240 ml of milk');
});

await check('millilitre entry is refused when a food has no density', () => {
  throws(() => P.quantityToGrams(food('banana-raw'), { unit: 'ml', amount: 100 }));
});

await check('unknown serving label is an error, not a silent zero', () => {
  throws(() => P.quantityToGrams(food('banana-raw'), { unit: 'serving', amount: 1, servingLabel: 'nope' }));
});

await check('ml <-> g round-trips through density', () => {
  const d = food('oil-olive-extra-virgin').density_g_per_ml;
  near(P.gramsToMl(P.mlToGrams(15, d), d), 15, 1e-9, 'round trip');
});

await check('gramsToServings inverts serving entry', () => {
  const banana = food('banana-raw');
  near(P.gramsToServings(banana, 236, '1 medium, 7-8 in (118 g)'), 2, 1e-9, 'servings');
});

await check('scale -> unscale recovers the original per-100 g panel', () => {
  for (const id of ['chicken-breast-cooked', 'olives-green', 'wine-red', 'psyllium-husk']) {
    const original = food(id).per100g;
    const back = P.unscaleToPer100g(P.scaleMacros(original, 173), 173);
    for (const key of Object.keys(original)) near(back[key], original[key], 1e-9, `${id}.${key}`);
  }
});

await check('unscaleToPer100g rejects a zero weight', () => {
  throws(() => P.unscaleToPer100g(P.ZERO_MACROS, 0));
});

await check('macrosForQuantity matches the manual computation', () => {
  const oats = food('oats-rolled-dry');
  const viaQuantity = P.macrosForQuantity(oats, { unit: 'g', amount: 40 });
  const manual = P.scaleMacros(oats.per100g, 40);
  for (const key of Object.keys(manual)) near(viaQuantity[key], manual[key], 1e-12, key);
});

await check('closestServing prefers a near-whole count', () => {
  const banana = food('banana-raw');
  const hit = P.closestServing(banana, 236);
  assert(hit !== undefined, 'expected a serving');
  near(hit.count, 2, 0.001, 'count');
});

await check('closestServing returns undefined for an out-of-range weight', () => {
  assert(P.closestServing(food('banana-raw'), 100000) === undefined, 'expected undefined');
});

await check('display rounding is applied once and sensibly', () => {
  const rounded = P.roundMacrosForDisplay({
    kcal: 105.02, protein_g: 1.2862, carbs_g: 26.904, fat_g: 0.3894,
    fiber_g: 3.068, sugar_g: 14.396, satfat_g: 0.1298, sodium_mg: 1.18,
  });
  assert(rounded.kcal === 105, `kcal ${rounded.kcal}`);
  assert(rounded.protein_g === 1.3, `protein ${rounded.protein_g}`);
  assert(rounded.sodium_mg === 1, `sodium ${rounded.sodium_mg}`);
});

describe('portions.ts — against the whole seed database');

await check('every seed food has a resolvable default serving', () => {
  for (const f of SEED_FOODS) {
    const serving = P.defaultServing(f);
    assert(serving.grams > 0, `${f.id} default serving has no weight`);
    assert(P.quantityToGrams(f, { unit: 'serving', amount: 1, servingLabel: serving.label }) === serving.grams, f.id);
  }
});

await check('every millilitre serving in the seed DB converts to grams', () => {
  let checked = 0;
  for (const f of SEED_FOODS) {
    for (const s of f.servings) {
      const m = /\((\d+(?:\.\d+)?)\s*ml\)/i.exec(s.label);
      if (!m) continue;
      checked += 1;
      const grams = P.mlToGrams(Number(m[1]), f.density_g_per_ml);
      // The stated gram weight must agree with density x volume within 4%,
      // which catches a transposed density or a mistyped gram weight.
      const drift = Math.abs(grams - s.grams) / s.grams;
      assert(drift < 0.04, `${f.id} "${s.label}": ${grams.toFixed(1)} g from density vs ${s.grams} g stated`);
    }
  }
  assert(checked > 100, `expected many ml servings, checked ${checked}`);
});

await check('no seed food has a default serving above 1 kg', () => {
  for (const f of SEED_FOODS) assert(P.defaultServing(f).grams <= 1000, `${f.id}`);
});

// ---------------------------------------------------------------------------
// nutrition-math.ts
// ---------------------------------------------------------------------------

describe('nutrition-math.ts — summation');

const entry = (id, grams) => ({ macros: P.scaleMacros(food(id).per100g, grams) });

await check('sumMacros of nothing is all zeroes', () => {
  const total = M.sumMacros([]);
  for (const value of Object.values(total)) assert(value === 0, 'expected zero');
});

await check('sumMacros matches a hand-computed day', () => {
  const day = [
    entry('oats-rolled-dry', 80),
    entry('milk-skim', 244),
    entry('banana-raw', 118),
    entry('chicken-breast-cooked', 170),
    entry('rice-white-long-cooked', 158),
    entry('oil-olive-extra-virgin', 13.5),
  ];
  const total = M.sumMacros(day);
  const expectedKcal =
    379 * 0.8 + 34 * 2.44 + 89 * 1.18 + 165 * 1.7 + 130 * 1.58 + 884 * 0.135;
  near(total.kcal, expectedKcal, 1e-9, 'kcal');
  assert(total.protein_g > 60 && total.protein_g < 100, `protein ${total.protein_g}`);
});

await check('summation is order-independent (no accumulated drift)', () => {
  const day = SEED_FOODS.slice(0, 200).map((f, i) => ({ macros: P.scaleMacros(f.per100g, 7 + (i % 53)) }));
  const forward = M.sumMacros(day);
  const backward = M.sumMacros([...day].reverse());
  for (const key of Object.keys(forward)) near(backward[key], forward[key], 1e-6, key);
});

await check('addMacros and subtractMacros are inverses', () => {
  const a = P.scaleMacros(food('cheese-cheddar').per100g, 31);
  const b = P.scaleMacros(food('bread-whole-wheat').per100g, 56);
  const back = M.subtractMacros(M.addMacros(a, b), b);
  for (const key of Object.keys(a)) near(back[key], a[key], 1e-9, key);
});

await check('multiplyMacros scales every field', () => {
  const a = P.scaleMacros(food('almonds-raw').per100g, 28);
  const doubled = M.multiplyMacros(a, 2);
  for (const key of Object.keys(a)) near(doubled[key], a[key] * 2, 1e-9, key);
  throws(() => M.multiplyMacros(a, Number.NaN));
});

await check('sumMacrosBy groups and the groups re-sum to the whole', () => {
  const entries = [
    { meal: 'breakfast', ...entry('egg-whole-raw', 100) },
    { meal: 'breakfast', ...entry('bread-white', 56) },
    { meal: 'lunch', ...entry('chicken-breast-cooked', 170) },
    { meal: 'lunch', ...entry('rice-brown-long-cooked', 195) },
    { meal: 'dinner', ...entry('salmon-atlantic-farmed-cooked', 170) },
  ];
  const grouped = M.sumMacrosBy(entries, (e) => e.meal);
  assert(grouped.size === 3, `expected 3 meals, got ${grouped.size}`);
  const regrouped = M.sumMacros([...grouped.values()].map((macros) => ({ macros })));
  const direct = M.sumMacros(entries);
  for (const key of Object.keys(direct)) near(regrouped[key], direct[key], 1e-9, key);
});

describe('nutrition-math.ts — targets and energy split');

await check('macroProgress reports remaining and fraction', () => {
  const consumed = P.scaleMacros(food('chicken-breast-cooked').per100g, 200);
  const progress = M.macroProgress(consumed, { kcal: 2400, protein_g: 180, carbs_g: 250, fat_g: 70 });
  near(progress.kcal.consumed, 330, 1e-9, 'kcal consumed');
  near(progress.kcal.remaining, 2070, 1e-9, 'kcal remaining');
  near(progress.protein_g.fraction, 62 / 180, 1e-9, 'protein fraction');
});

await check('macroProgress allows going over target (negative remaining)', () => {
  const progress = M.macroProgress({ ...P.ZERO_MACROS, kcal: 3000 }, { kcal: 2400, protein_g: 1, carbs_g: 1, fat_g: 1 });
  assert(progress.kcal.remaining === -600, `remaining ${progress.kcal.remaining}`);
  assert(progress.kcal.fraction > 1, 'fraction should exceed 1');
});

await check('energySplit sums to ~1 for a normal food', () => {
  const split = M.energySplit(P.scaleMacros(food('salmon-atlantic-farmed-cooked').per100g, 170));
  const sum = split.protein + split.carbs + split.fat + split.other;
  near(sum, 1, 0.12, 'split sum');
  assert(split.other < 0.12, `an ordinary food should have little unaccounted energy, got ${split.other}`);
});

await check('energySplit surfaces alcohol as unaccounted energy', () => {
  const split = M.energySplit(P.scaleMacros(food('wine-red').per100g, 148));
  assert(split.other > 0.5, `wine should be mostly unaccounted (alcohol), got other=${split.other}`);
});

await check('energySplit on nothing is all zeroes', () => {
  const split = M.energySplit(P.ZERO_MACROS);
  assert(split.protein === 0 && split.carbs === 0 && split.fat === 0 && split.other === 0, 'expected zeroes');
});

describe('nutrition-math.ts — recipes');

const proteinOats = {
  id: 'r-protein-oats',
  name: 'Protein oats, batch of 4',
  servings: 4,
  ingredients: [
    { foodId: 'oats-rolled-dry', name: 'Rolled oats', grams: 160, per100g: food('oats-rolled-dry').per100g },
    { foodId: 'whey-isolate-vanilla', name: 'Whey isolate', grams: 124, per100g: food('whey-isolate-vanilla').per100g },
    { foodId: 'peanut-butter-smooth', name: 'Peanut butter', grams: 64, per100g: food('peanut-butter-smooth').per100g },
    { foodId: 'banana-raw', name: 'Banana', grams: 236, per100g: food('banana-raw').per100g },
    { foodId: 'milk-skim', name: 'Skim milk', grams: 488, per100g: food('milk-skim').per100g },
  ],
};

await check('recipe total equals the sum of its ingredients', () => {
  const result = M.computeRecipeMacros(proteinOats);
  const manual = M.sumMacros(
    proteinOats.ingredients.map((i) => ({ macros: P.scaleMacros(i.per100g, i.grams) })),
  );
  for (const key of Object.keys(manual)) near(result.total[key], manual[key], 1e-9, key);
});

await check('per-serving is total / servings', () => {
  const result = M.computeRecipeMacros(proteinOats);
  for (const key of Object.keys(result.total)) {
    near(result.perServing[key], result.total[key] / 4, 1e-9, key);
  }
  near(result.rawWeightGrams, 160 + 124 + 64 + 236 + 488, 1e-9, 'raw weight');
  near(result.gramsPerServing, 1072 / 4, 1e-9, 'grams per serving');
});

await check('per-100 g panel re-scales back to the total', () => {
  const result = M.computeRecipeMacros(proteinOats);
  const back = P.scaleMacros(result.per100g, result.finishedWeightGrams);
  for (const key of Object.keys(result.total)) near(back[key], result.total[key], 1e-6, key);
});

await check('a measured cooked weight concentrates the per-100 g panel', () => {
  const raw = M.computeRecipeMacros(proteinOats);
  const cooked = M.computeRecipeMacros({ ...proteinOats, cookedWeightGrams: 800 });
  assert(cooked.cookedWeightMeasured === true, 'flag should be set');
  assert(raw.cookedWeightMeasured === false, 'flag should be clear');
  // Same food, less water -> more kcal per 100 g, but identical totals.
  assert(cooked.per100g.kcal > raw.per100g.kcal, 'cooked should be denser');
  near(cooked.total.kcal, raw.total.kcal, 1e-9, 'totals must not change');
});

await check('scaleRecipe leaves per-serving macros invariant', () => {
  const four = M.computeRecipeMacros(proteinOats);
  const six = M.computeRecipeMacros(M.scaleRecipe(proteinOats, 6));
  for (const key of Object.keys(four.perServing)) {
    near(six.perServing[key], four.perServing[key], 1e-9, key);
  }
  near(six.total.kcal, four.total.kcal * 1.5, 1e-9, 'total scales by 1.5');
});

await check('scaleRecipe carries a measured cooked weight proportionally', () => {
  const scaled = M.scaleRecipe({ ...proteinOats, cookedWeightGrams: 800 }, 8);
  near(scaled.cookedWeightGrams, 1600, 1e-9, 'cooked weight');
});

await check('recipes reject zero or negative servings', () => {
  throws(() => M.computeRecipeMacros({ ...proteinOats, servings: 0 }));
  throws(() => M.scaleRecipe(proteinOats, -1));
});

await check('recipes reject a negative ingredient weight', () => {
  throws(() => M.computeRecipeMacros({
    ...proteinOats,
    ingredients: [{ ...proteinOats.ingredients[0], grams: -5 }],
  }));
});

await check('an empty recipe is zero, not NaN', () => {
  const result = M.computeRecipeMacros({ id: 'empty', name: 'Empty', servings: 2, ingredients: [] });
  for (const value of Object.values(result.total)) assert(value === 0, 'total');
  for (const value of Object.values(result.per100g)) assert(value === 0, 'per100g');
});

await check('rankIngredientContributions is sorted and its shares sum to 1', () => {
  const ranked = M.rankIngredientContributions(proteinOats, 'kcal');
  for (let i = 1; i < ranked.length; i += 1) {
    assert(ranked[i - 1].value >= ranked[i].value, 'not sorted descending');
  }
  near(ranked.reduce((a, r) => a + r.share, 0), 1, 1e-9, 'shares');
  assert(ranked[0].foodId === 'oats-rolled-dry', `expected oats to dominate, got ${ranked[0].foodId}`);
});

// ---------------------------------------------------------------------------
// Micronutrients — the vitamin A and folate provenance split
// ---------------------------------------------------------------------------

describe('micronutrients — schema and provenance');

const MICRO_KEYS = [
  'vitamin_a_retinol_mcg', 'vitamin_a_carotenoid_mcg_rae',
  'folate_food_mcg', 'folic_acid_mcg', 'folate_dfe_mcg',
];

await check('every food carries the block with all five fields', () => {
  for (const f of SEED_FOODS) {
    assert(f.micronutrients && typeof f.micronutrients === 'object', `${f.id} has no block`);
    for (const key of MICRO_KEYS) assert(key in f.micronutrients, `${f.id} missing ${key}`);
  }
});

await check('null means unknown — it is never silently coerced to zero by scaling', () => {
  const unknown = SEED_FOODS.find((f) => f.micronutrients.vitamin_a_retinol_mcg === null);
  assert(unknown !== undefined, 'expected some unknown foods');
  const scaled = P.scaleMicronutrients(unknown.micronutrients, 250);
  assert(scaled.vitamin_a_retinol_mcg === null, 'null must survive scaling');
});

await check('DFE identity holds wherever all three folate fields are known', () => {
  let checked = 0;
  for (const f of SEED_FOODS) {
    const m = f.micronutrients;
    if (m.folate_food_mcg === null || m.folic_acid_mcg === null || m.folate_dfe_mcg === null) continue;
    checked += 1;
    const expected = m.folate_food_mcg + 1.7 * m.folic_acid_mcg;
    near(m.folate_dfe_mcg, expected, Math.max(0.06 * expected, 6), `${f.id} DFE`);
  }
  assert(checked > 100, `expected many populated foods, checked ${checked}`);
});

await check('THE FAILURE MODE THAT MATTERS: 85 g of beef liver exceeds the retinol UL', () => {
  // The vitamin A UL for adults is 3,000 mcg/day of PREFORMED RETINOL.
  const UL_RETINOL_MCG = 3000;
  const liver = food('beef-liver-cooked');
  const portion = P.scaleMicronutrients(liver.micronutrients, 85);
  assert(
    portion.vitamin_a_retinol_mcg > UL_RETINOL_MCG,
    `85 g of beef liver must trip the retinol UL; got ${portion.vitamin_a_retinol_mcg} mcg`,
  );
  near(portion.vitamin_a_retinol_mcg, 8025.7, 1, 'retinol in 85 g');
});

await check('THE OTHER FAILURE MODE: a carotenoid-heavy day must NOT trip it', () => {
  const UL_RETINOL_MCG = 3000;
  const day = [
    { grams: 400, food: food('sweet-potato-baked') },
    { grams: 300, food: food('carrot-raw') },
    { grams: 200, food: food('spinach-raw') },
    { grams: 200, food: food('pumpkin-canned') },
    { grams: 150, food: food('cantaloupe-raw') },
  ].map((e) => ({ grams: e.grams, micronutrients: P.scaleMicronutrients(e.food.micronutrients, e.grams) }));

  const totals = M.sumMicronutrients(day);
  assert(totals.vitamin_a_retinol_mcg.known === 0, `retinol should be 0, got ${totals.vitamin_a_retinol_mcg.known}`);
  assert(totals.vitamin_a_retinol_mcg.known < UL_RETINOL_MCG, 'must not trip the UL');
  // ...while total vitamin A is enormous, which is exactly why a conflated
  // total would have false-alarmed here.
  assert(
    totals.vitamin_a_carotenoid_mcg_rae.known > 3 * UL_RETINOL_MCG,
    `carotenoid RAE should be very high, got ${totals.vitamin_a_carotenoid_mcg_rae.known}`,
  );
});

await check('folate: enriched grains carry folic acid, whole grains do not', () => {
  assert(food('bread-white').micronutrients.folic_acid_mcg > 0, 'enriched white bread');
  assert(food('rice-white-long-cooked').micronutrients.folic_acid_mcg > 0, 'enriched white rice');
  assert(food('pasta-spaghetti-dry').micronutrients.folic_acid_mcg > 0, 'enriched pasta');
  assert(food('bread-whole-wheat').micronutrients.folic_acid_mcg === 0, 'whole wheat is not enriched');
  assert(food('rice-brown-long-cooked').micronutrients.folic_acid_mcg === 0, 'brown rice is not enriched');
  assert(food('lentils-cooked').micronutrients.folic_acid_mcg === 0, 'lentils are food folate only');
  assert(food('lentils-cooked').micronutrients.folate_food_mcg > 150, 'lentils are folate-rich');
});

await check('a lentil-heavy day does not trip the folic acid UL', () => {
  const day = [
    { grams: 400, food: food('lentils-cooked') },
    { grams: 300, food: food('chickpeas-cooked') },
    { grams: 200, food: food('spinach-raw') },
    { grams: 150, food: food('edamame-cooked') },
  ].map((e) => ({ grams: e.grams, micronutrients: P.scaleMicronutrients(e.food.micronutrients, e.grams) }));
  const totals = M.sumMicronutrients(day);
  assert(totals.folic_acid_mcg.known === 0, `folic acid should be 0, got ${totals.folic_acid_mcg.known}`);
  assert(totals.folate_dfe_mcg.known > 1500, `DFE should be high, got ${totals.folate_dfe_mcg.known}`);
});

await check('a fortified-cereal day does trip the folic acid UL', () => {
  const UL_FOLIC_ACID_MCG = 1000;
  const day = [
    { grams: 60, food: food('cereal-total') },
    { grams: 120, food: food('bread-white') },
    { grams: 250, food: food('pasta-spaghetti-cooked') },
  ].map((e) => ({ grams: e.grams, micronutrients: P.scaleMicronutrients(e.food.micronutrients, e.grams) }));
  const totals = M.sumMicronutrients(day);
  assert(
    totals.folic_acid_mcg.known > UL_FOLIC_ACID_MCG,
    `expected the UL to be exceeded, got ${totals.folic_acid_mcg.known}`,
  );
});

await check('sumMicronutrients reports what it did not know, and known is a lower bound', () => {
  const day = [
    { grams: 85, micronutrients: P.scaleMicronutrients(food('beef-liver-cooked').micronutrients, 85) },
    { grams: 200, micronutrients: P.scaleMicronutrients(food('pizza-cheese-slice').micronutrients, 200) },
    { grams: 120, micronutrients: P.scaleMicronutrients(food('lasagna-meat').micronutrients, 120) },
  ];
  const totals = M.sumMicronutrients(day);
  assert(totals.vitamin_a_retinol_mcg.unknownEntries === 2, `unknown ${totals.vitamin_a_retinol_mcg.unknownEntries}`);
  near(totals.vitamin_a_retinol_mcg.unknownGrams, 320, 1e-9, 'unknown grams');
  // The liver alone already exceeds the UL, so a partial day is still a true
  // positive — this is the whole reason `known` is a lower bound.
  assert(totals.vitamin_a_retinol_mcg.known > 3000, 'the known part alone must trip the UL');
});

await check('derivation helpers propagate unknown correctly', () => {
  const known = { vitamin_a_retinol_mcg: 100, vitamin_a_carotenoid_mcg_rae: 50, folate_food_mcg: 20, folic_acid_mcg: 10, folate_dfe_mcg: null };
  assert(T.totalVitaminARae(known) === 150, 'total RAE');
  near(T.folateDfeMcg(known), 37, 1e-9, 'derived DFE');
  assert(T.preformedRetinolMcg(known) === 100, 'retinol accessor');
  assert(T.folicAcidMcg(known) === 10, 'folic acid accessor');

  // A partial total would be silently wrong, so it must be null, not 100.
  const partial = { ...known, vitamin_a_carotenoid_mcg_rae: null };
  assert(T.totalVitaminARae(partial) === null, 'partial total must be null');
  assert(T.preformedRetinolMcg(partial) === 100, 'retinol is still known');

  const noFolate = { ...T.UNKNOWN_MICRONUTRIENTS };
  assert(T.folateDfeMcg(noFolate) === null, 'unknown DFE');
  assert(T.folicAcidMcg(noFolate) === null, 'unknown folic acid -> suppress the check');
  assert(T.FOLIC_ACID_TO_DFE === 1.7, 'DFE multiplier');
});

await check('a stored DFE is preferred over re-derivation', () => {
  const flour = food('flour-all-purpose').micronutrients;
  assert(T.folateDfeMcg(flour) === flour.folate_dfe_mcg, 'stored value should win');
  assert(flour.folate_dfe_mcg === 291, `USDA published DFE, got ${flour.folate_dfe_mcg}`);
});

await check('no seed food records raw beta-carotene where RAE was expected', () => {
  // Raw beta-carotene micrograms are ~12x the RAE figure. Anything above
  // 3,000 mcg RAE in a whole food is a unit slip; cod liver oil is retinol,
  // not carotenoid, so nothing legitimately lands here.
  for (const f of SEED_FOODS) {
    const c = f.micronutrients.vitamin_a_carotenoid_mcg_rae;
    if (c === null) continue;
    assert(c < 3000, `${f.id} carotenoid ${c} mcg RAE looks like raw beta-carotene`);
  }
});

// ---------------------------------------------------------------------------
// search.ts
// ---------------------------------------------------------------------------

describe('search.ts — relevance');

const topId = (query, options) => {
  const results = S.searchFoods(query, options);
  return results.length > 0 ? results[0].food.id : undefined;
};
const idsFor = (query, options) => S.searchFoods(query, options).map((r) => r.food.id);

await check('exact name wins', () => {
  assert(topId('banana') === 'banana-raw', `got ${topId('banana')}`);
  assert(topId('avocado') === 'avocado-raw', `got ${topId('avocado')}`);
  assert(topId('olive oil') === 'oil-olive-extra-virgin', `got ${topId('olive oil')}`);
});

await check('multi-word queries are AND, not OR', () => {
  const results = S.searchFoods('chicken breast', { limit: 40 });
  assert(results.length > 0, 'no results');
  assert(results[0].food.id.startsWith('chicken-breast'), `top result ${results[0].food.id}`);
  for (const r of results) {
    const haystack = `${r.food.name} ${r.food.aliases.join(' ')}`.toLowerCase();
    assert(
      haystack.includes('breast') || haystack.includes('chicken'),
      `${r.food.id} matched neither term`,
    );
  }
  // A food that only matches "chicken" must not appear.
  assert(!results.some((r) => r.food.id === 'chicken-nuggets'), 'nuggets should not match "chicken breast"');
});

await check('raw and cooked are both findable and distinct', () => {
  const ids = idsFor('chicken breast', { limit: 20 });
  assert(ids.includes('chicken-breast-raw'), 'missing raw');
  assert(ids.includes('chicken-breast-cooked'), 'missing cooked');
  assert(food('chicken-breast-raw').per100g.kcal !== food('chicken-breast-cooked').per100g.kcal, 'raw and cooked must differ');
});

await check('prefixes work while the user is still typing', () => {
  assert(idsFor('chick', { limit: 30 }).some((id) => id.startsWith('chicken')), 'chick -> chicken');
  assert(idsFor('brocc', { limit: 20 }).includes('broccoli-raw'), 'brocc -> broccoli');
  assert(idsFor('gree yog', { limit: 20 }).some((id) => id.startsWith('yogurt-greek')), 'gree yog -> greek yogurt');
});

await check('plurals match singulars and vice versa', () => {
  assert(idsFor('eggs', { limit: 10 }).includes('egg-whole-raw'), 'eggs -> egg');
  assert(idsFor('blueberries', { limit: 10 }).includes('blueberries-raw'), 'blueberries');
  assert(idsFor('almond', { limit: 10 }).includes('almonds-raw'), 'almond -> almonds');
  assert(idsFor('strawberry', { limit: 10 }).includes('strawberries-raw'), 'strawberry -> strawberries');
});

await check('typos are recovered', () => {
  assert(idsFor('brocoli', { limit: 20 }).includes('broccoli-raw'), 'brocoli');
  assert(idsFor('chiken', { limit: 30 }).some((id) => id.startsWith('chicken')), 'chiken');
  assert(idsFor('avacado', { limit: 20 }).includes('avocado-raw'), 'avacado');
  assert(idsFor('yoghurt', { limit: 30 }).some((id) => id.startsWith('yogurt')), 'yoghurt');
});

await check('transpositions are recovered', () => {
  assert(idsFor('bananna', { limit: 20 }).includes('banana-raw'), 'bananna');
  assert(idsFor('salomn', { limit: 25 }).some((id) => id.startsWith('salmon')), 'salomn');
});

await check('aliases give access to synonyms', () => {
  assert(idsFor('garbanzo', { limit: 10 }).some((id) => id.startsWith('chickpeas')), 'garbanzo -> chickpeas');
  assert(idsFor('cilantro', { limit: 10 }).includes('cilantro-fresh'), 'cilantro');
  assert(idsFor('pepitas', { limit: 10 }).includes('pumpkin-seeds'), 'pepitas');
  assert(idsFor('zoodles', { limit: 10 }).includes('noodle-zucchini'), 'zoodles');
  assert(idsFor('acv', { limit: 10 }).includes('vinegar-apple-cider'), 'acv');
});

await check('brands are searchable', () => {
  assert(idsFor('fage', { limit: 10 }).some((id) => id.startsWith('yogurt-fage')), 'fage');
  assert(idsFor('chipotle chicken', { limit: 10 }).includes('chipotle-chicken'), 'chipotle chicken');
  assert(idsFor('big mac', { limit: 5 }).includes('mcd-big-mac'), 'big mac');
});

await check('diacritics and punctuation are ignored', () => {
  assert(idsFor('creme fraiche', { limit: 10 }).includes('cream-creme-fraiche'), 'creme fraiche');
  assert(idsFor('reeses', { limit: 15 }).some((id) => id.includes('reeses')), 'reeses');
  assert(idsFor("cap'n crunch", { limit: 10 }).includes('cereal-captain-crunch'), "cap'n crunch");
});

await check('category filter restricts results', () => {
  const results = S.searchFoods('chicken', { categories: ['soup'], limit: 20 });
  assert(results.length > 0, 'no soup results');
  for (const r of results) assert(r.food.category === 'soup', `${r.food.id} is ${r.food.category}`);
});

await check('verifiedOnly excludes estimates', () => {
  const results = S.searchFoods('chicken', { verifiedOnly: true, limit: 30 });
  assert(results.length > 0, 'no results');
  for (const r of results) assert(r.food.verified === true, `${r.food.id} is not verified`);
});

await check('an unmatchable query returns nothing rather than noise', () => {
  assert(S.searchFoods('zzzqqxwv', { limit: 10 }).length === 0, 'expected no results');
});

describe('search.ts — personalisation');

await check('frequency reorders otherwise-similar results', () => {
  const plain = idsFor('yogurt', { limit: 10 });
  const personalised = idsFor('yogurt', {
    limit: 10,
    frequency: { 'yogurt-fage-total-0': 250 },
  });
  assert(personalised[0] === 'yogurt-fage-total-0', `got ${personalised[0]}`);
  assert(plain[0] !== 'yogurt-fage-total-0', 'baseline should differ, otherwise the test proves nothing');
});

await check('frequency cannot promote an irrelevant food', () => {
  const results = idsFor('banana', { limit: 10, frequency: { 'beef-ribeye-cooked': 100000 } });
  assert(!results.includes('beef-ribeye-cooked'), 'a non-matching food must never surface');
});

await check('recency boosts, and decays with position', () => {
  const results = idsFor('rice', {
    limit: 10,
    recentIds: ['rice-brown-long-cooked', ...Array.from({ length: 30 }, () => 'rice-white-long-dry')],
  });
  assert(results[0] === 'rice-brown-long-cooked', `got ${results[0]}`);
});

await check('an empty query returns the user\'s own recent and frequent foods', () => {
  const results = S.searchFoods('', {
    limit: 5,
    recentIds: ['chicken-breast-cooked', 'rice-white-long-cooked'],
    frequency: { 'oats-rolled-dry': 90 },
  });
  const ids = results.map((r) => r.food.id);
  assert(ids.includes('chicken-breast-cooked'), 'missing recent');
  assert(ids.includes('oats-rolled-dry'), 'missing frequent');
  assert(results.length <= 5, 'limit not respected');
});

await check('an empty query with no history returns nothing', () => {
  assert(S.searchFoods('', { limit: 10 }).length === 0, 'expected no results');
});

describe('search.ts — user foods merge with the seed set');

const customFood = {
  id: 'custom-moms-chili',
  name: "Mom's chili",
  brand: null,
  aliases: ['family chili'],
  category: 'soup',
  per100g: { kcal: 120, protein_g: 9, carbs_g: 10, fat_g: 5, fiber_g: 3, sugar_g: 2, satfat_g: 1.8, sodium_mg: 400 },
  servings: [{ label: '1 bowl (350 g)', grams: 350, isDefault: true }],
  density_g_per_ml: null,
  verified: false,
  source: 'user entry',
};

await check('a custom food is searchable alongside seed foods', () => {
  S.resetSearchIndexCache();
  const results = S.searchFoods('chili', { userFoods: [customFood], limit: 10 });
  const ids = results.map((r) => r.food.id);
  assert(ids.includes('custom-moms-chili'), 'custom food missing');
  assert(ids.includes('chili-con-carne-beans'), 'seed food missing');
});

await check('a custom food is reachable by its own alias', () => {
  assert(
    S.searchFoods('family chili', { userFoods: [customFood], limit: 5 })[0].food.id === 'custom-moms-chili',
    'alias lookup failed',
  );
});

await check('a user override with a seed id shadows the seed entry', () => {
  const override = { ...food('banana-raw'), per100g: { ...food('banana-raw').per100g, kcal: 95 }, source: 'user correction' };
  S.resetSearchIndexCache();
  const hit = S.getFoodById('banana-raw', [override]);
  assert(hit.per100g.kcal === 95, `expected the override, got ${hit.per100g.kcal}`);
  assert(S.searchFoods('banana', { userFoods: [override], limit: 5 }).filter((r) => r.food.id === 'banana-raw').length === 1, 'duplicated');
  S.resetSearchIndexCache();
});

await check('browseCategory returns a sorted category listing', () => {
  const list = S.browseCategory('egg');
  assert(list.length === SEED_FOODS.filter((f) => f.category === 'egg').length, 'wrong count');
  for (let i = 1; i < list.length; i += 1) {
    assert(list[i - 1].name.localeCompare(list[i].name) <= 0, 'not sorted');
  }
});

describe('search.ts — helpers');

await check('boundedEditDistance is correct and bails out at the budget', () => {
  assert(S.boundedEditDistance('kitten', 'sitting', 3) === 3, 'kitten/sitting');
  assert(S.boundedEditDistance('chiken', 'chicken', 2) === 1, 'chiken/chicken');
  assert(S.boundedEditDistance('bananna', 'banana', 2) === 1, 'bananna/banana');
  assert(S.boundedEditDistance('ab', 'ba', 2) === 1, 'transposition costs 1');
  assert(S.boundedEditDistance('abc', 'abc', 2) === 0, 'identical');
  assert(S.boundedEditDistance('abcdef', 'uvwxyz', 2) === 3, 'over budget returns max+1');
});

await check('the stemmer only touches plurals', () => {
  const cases = [['eggs', 'egg'], ['berries', 'berry'], ['peaches', 'peach'], ['oats', 'oat'], ['glass', 'glass'], ['hummus', 'hummus'], ['rice', 'rice']];
  for (const [input, expected] of cases) {
    assert(S.stem(input) === expected, `stem("${input}") = "${S.stem(input)}", expected "${expected}"`);
  }
});

await check('normalizeText strips diacritics and punctuation', () => {
  assert(S.normalizeText('Crème Fraîche') === 'creme fraiche', S.normalizeText('Crème Fraîche'));
  assert(S.normalizeText("Reese's  Puffs!") === 'reeses puffs', S.normalizeText("Reese's  Puffs!"));
});

// ---------------------------------------------------------------------------
// open-food-facts.ts — pure mapping and offline safety
// ---------------------------------------------------------------------------

describe('open-food-facts.ts');

await check('barcode normalisation pads UPC-A and rejects store codes', () => {
  assert(OFF.normalizeBarcode('012345678905').code === '0012345678905', 'UPC-A padding');
  assert(OFF.normalizeBarcode('3017620422003').code === '3017620422003', 'EAN-13 passthrough');
  assert(OFF.normalizeBarcode('0201234500009').ok === false, 'store-internal 02 prefix');
  assert(OFF.normalizeBarcode('12').ok === false, 'too short');
  assert(OFF.normalizeBarcode('abc-def').ok === false, 'no digits');
});

await check('sodium is converted from grams to milligrams', () => {
  const mapped = OFF.offToFoodItem({
    code: '1234567890123',
    status: 1,
    product: {
      product_name: 'Test crisps',
      brands: 'Testco',
      nutriments: {
        'energy-kcal_100g': 530, proteins_100g: 6, carbohydrates_100g: 50,
        fat_100g: 34, fiber_100g: 4, sugars_100g: 1, 'saturated-fat_100g': 3, sodium_100g: 0.6,
      },
      serving_size: '30 g', serving_quantity: 30, completeness: 0.9,
    },
  });
  assert(mapped !== undefined, 'mapping failed');
  near(mapped.food.per100g.sodium_mg, 600, 1e-9, 'sodium mg');
  assert(mapped.food.verified === false, 'OFF data must never be marked verified');
  assert(mapped.food.id === 'off:1234567890123', mapped.food.id);
  assert(mapped.food.servings.some((s) => s.grams === 30 && s.isDefault), 'serving from serving_quantity');
  assert(mapped.food.servings.some((s) => s.grams === 100), 'a 100 g serving is always offered');
});

await check('salt is used when sodium is absent', () => {
  const mapped = OFF.offToFoodItem({
    code: '1234567890123', status: 1,
    product: { product_name: 'X', nutriments: { 'energy-kcal_100g': 100, proteins_100g: 1, carbohydrates_100g: 20, fat_100g: 1, salt_100g: 2.5 } },
  });
  near(mapped.food.per100g.sodium_mg, 1000, 1e-9, 'salt / 2.5 -> sodium');
});

await check('net carbs are reconstructed to total carbs', () => {
  const mapped = OFF.offToFoodItem({
    code: '1234567890123', status: 1,
    product: { product_name: 'EU cereal', nutriments: { 'energy-kcal_100g': 350, proteins_100g: 10, carbohydrates_100g: 60, fiber_100g: 10, fat_100g: 5 } },
  });
  near(mapped.food.per100g.carbs_g, 70, 1e-9, 'net + fibre');
});

await check('kilojoules are converted when kcal is absent', () => {
  const mapped = OFF.offToFoodItem({
    code: '1234567890123', status: 1,
    product: { product_name: 'kJ only', nutriments: { 'energy-kj_100g': 2000, proteins_100g: 5, carbohydrates_100g: 50, fat_100g: 10 } },
  });
  near(mapped.food.per100g.kcal, 2000 / 4.184, 0.01, 'kJ -> kcal');
});

await check('a product with no usable macros is rejected, not half-mapped', () => {
  assert(OFF.offToFoodItem({ code: '1', status: 1, product: { product_name: 'Mystery' } }) === undefined, 'no nutriments');
  assert(OFF.offToFoodItem({ code: '1', status: 0 }) === undefined, 'status 0');
  assert(
    OFF.offToFoodItem({ code: '1', status: 1, product: { product_name: 'X', nutriments: { 'energy-kcal_100g': 100 } } }) === undefined,
    'energy but no macros',
  );
});

await check('quality score rewards completeness', () => {
  const full = OFF.scoreProductQuality({
    product_name: 'X', completeness: 1,
    nutriments: { 'energy-kcal_100g': 100, proteins_100g: 1, carbohydrates_100g: 1, fat_100g: 1 },
  });
  const sparse = OFF.scoreProductQuality({ nutriments: { 'energy-kcal_100g': 100 } });
  assert(full > 0.95, `full ${full}`);
  assert(sparse < 0.3, `sparse ${sparse}`);
});

await check('a lookup with no fetch available resolves instead of throwing', async () => {
  const result = await OFF.lookupBarcode('3017620422003', {}, null);
  assert(result.ok === false, 'expected failure');
  assert(result.reason === 'network', `reason ${result.reason}`);
});

await check('bulk lookup with no fetch degrades per code', async () => {
  const out = await OFF.lookupBarcodes(['3017620422003', '0012345678905'], {}, null);
  assert(out.size === 2, `size ${out.size}`);
  for (const r of out.values()) assert(r.ok === false, 'expected failure');
});

await check('a fetch rejection degrades to a structured failure', async () => {
  const result = await OFF.lookupBarcode('3017620422003', {}, async () => { throw new TypeError('Failed to fetch'); });
  assert(result.ok === false && result.reason === 'network', `got ${JSON.stringify(result)}`);
  assert(typeof OFF.describeFailure(result.reason) === 'string', 'copy exists');
});

await check('a 429 is reported as rate-limited, not as a generic error', async () => {
  const result = await OFF.lookupBarcode('3017620422003', {}, async () => ({ ok: false, status: 429 }));
  assert(result.ok === false && result.reason === 'rate-limited', `got ${JSON.stringify(result)}`);
});

await check('a successful lookup maps end to end', async () => {
  let requested = '';
  const result = await OFF.lookupBarcode('3017620422003', {}, async (url) => {
    requested = url;
    return {
      ok: true, status: 200,
      json: async () => ({
        code: '3017620422003', status: 1,
        product: {
          product_name: 'Nutella', brands: 'Ferrero', serving_quantity: 15, serving_size: '15 g',
          completeness: 0.95, categories_tags: ['en:spreads', 'en:sweet-spreads'],
          nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3, 'saturated-fat_100g': 10.6, sodium_100g: 0.0428 },
        },
      }),
    };
  });
  assert(result.ok === true, `lookup failed: ${JSON.stringify(result)}`);
  assert(result.food.name === 'Nutella', result.food.name);
  assert(result.food.brand === 'Ferrero', String(result.food.brand));
  near(result.food.per100g.sodium_mg, 42.8, 0.01, 'sodium');
  assert(requested.includes('app_name=HealthCoach'), 'app_name identification is sent');
  assert(!requested.includes('app_uuid'), 'no stable installation identifier is sent');
  assert(requested.includes('fields='), 'field allowlist is sent');
  assert(!requested.includes('user_id') && !requested.includes('password'), 'no credentials in the URL');
});

await check('a mapped OFF product is fully usable by portions and math', () => {
  const mapped = OFF.offToFoodItem({
    code: '1234567890123', status: 1,
    product: { product_name: 'Test bar', serving_quantity: 60, nutriments: { 'energy-kcal_100g': 350, proteins_100g: 30, carbohydrates_100g: 40, fat_100g: 10, fiber_100g: 12 } },
  });
  const macros = P.macrosForQuantity(mapped.food, { unit: 'serving', amount: 1, servingLabel: P.defaultServing(mapped.food).label });
  near(macros.kcal, 210, 1e-9, 'one bar');
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('search.ts — latency over the full seed database');

await check('index build is a one-off cost under 250 ms', () => {
  S.resetSearchIndexCache();
  const t0 = performance.now();
  S.getSeedSearchIndex();
  const elapsed = performance.now() - t0;
  console.log(`         index build: ${elapsed.toFixed(1)} ms for ${SEED_FOODS.length} foods`);
  assert(elapsed < 250, `index build took ${elapsed.toFixed(1)} ms`);
});

await check('a keystroke stays under the 16 ms frame budget at p95', () => {
  // Every prefix of a set of realistic queries — i.e. what actually happens as
  // someone types, including the short prefixes that expand the most.
  const queries = [];
  for (const phrase of [
    'chicken breast', 'greek yogurt', 'olive oil', 'brown rice', 'banana',
    'peanut butter', 'whey protein', 'sweet potato', 'ground beef 93',
    'starbucks latte', 'chipotle bowl', 'quest bar', 'broccoli', 'salmon',
    'oatmeal', 'cheddar cheese', 'black beans', 'ipa', 'red wine', 'almonds',
  ]) {
    for (let i = 1; i <= phrase.length; i += 1) queries.push(phrase.slice(0, i));
  }

  // Warm up so we measure steady state, not the JIT.
  for (const q of queries) S.searchFoods(q, { limit: 25 });

  const timings = [];
  for (const q of queries) {
    const t0 = performance.now();
    S.searchFoods(q, { limit: 25, frequency: { 'banana-raw': 12 }, recentIds: ['oats-rolled-dry'] });
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.5)];
  const p95 = timings[Math.floor(timings.length * 0.95)];
  const max = timings[timings.length - 1];
  console.log(`         ${timings.length} keystrokes — p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
  assert(p95 < 16, `p95 was ${p95.toFixed(2)} ms`);
});

await check('the worst case — a 2-character prefix — is still bounded', () => {
  const timings = [];
  for (const q of ['ch', 'ba', 'be', 'co', 'ca', 'pr', 'sa', 'st', 'wh', 'gr']) {
    S.searchFoods(q, { limit: 25 });
    const t0 = performance.now();
    S.searchFoods(q, { limit: 25 });
    timings.push(performance.now() - t0);
  }
  const max = Math.max(...timings);
  console.log(`         worst 2-char prefix: ${max.toFixed(2)} ms`);
  assert(max < 32, `worst case ${max.toFixed(2)} ms`);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

rmSync(work, { recursive: true, force: true });

console.log('');
console.log('  ' + '='.repeat(58));
if (failures.length > 0) {
  console.log(`  ${failures.length} FAILURE(S), ${passed} passed\n`);
  for (const failure of failures) console.log(`    x ${failure}`);
  console.log('');
  process.exit(1);
}
console.log(`  PASS — ${passed} checks, 0 failures.\n`);
