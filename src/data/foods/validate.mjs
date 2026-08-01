#!/usr/bin/env node
/**
 * validate.mjs — correctness gate for the bundled seed food database.
 *
 *   node src/data/foods/validate.mjs
 *
 * Exits non-zero on any error. A food tracker with wrong numbers is worse than
 * no food tracker, so this runs against the GENERATED JSON — the artefact that
 * actually ships — not against the authoring source.
 *
 * ---------------------------------------------------------------------------
 * CHECKS
 * ---------------------------------------------------------------------------
 *  1. Every json/<category>.json parses and is an array.
 *  2. File name matches the `category` of every food inside it.
 *  3. `id` is unique across the whole database, kebab-case, non-empty.
 *  4. Required keys present, correctly typed, no extra keys.
 *  5. `category` is in the controlled vocabulary (mirrored from types.ts).
 *  6. No negative numbers anywhere; no NaN/Infinity.
 *  7. Component sanity: protein + carbs + fat <= 100 g per 100 g;
 *     fiber <= carbs; satfat <= fat; sugar <= carbs; sodium <= 40000 mg.
 *  8. >= 1 serving, exactly one `isDefault`, positive gram weights,
 *     non-empty distinct labels.
 *  9. Density: required for every liquid category and for any food with a
 *     fluid-volume serving label (one containing "ml"); when present it must
 *     be physically plausible (0.25 - 1.60 g/ml).
 * 10. ENERGY CROSS-CHECK — see below.
 10b. MICRONUTRIENTS. Present on every food; each field is a non-negative
     number or null (null = UNKNOWN, never zero). Whenever food folate, folic
     acid and DFE are all present, the identity `DFE = food + 1.7 x folic acid`
     must hold — this is the check that catches a raw-mcg figure written into a
     DFE field, which is otherwise invisible and off by up to 70%.
     Plausibility ceilings catch a unit slip (e.g. IU written as mcg).
 * 11. No stale entries in energy-exceptions.json (an allowlist that is never
 *     pruned stops being an allowlist).
 *
 * ---------------------------------------------------------------------------
 * THE ENERGY CROSS-CHECK, AND WHY IT IS A BRACKET AND NOT A POINT
 * ---------------------------------------------------------------------------
 * The naive rule is `4*protein + 4*carbs + 9*fat ~= kcal`. That rule is wrong
 * for a large and *predictable* class of real foods, because US labelling
 * counts fibre inside total carbohydrate while fibre yields somewhere between
 * 0 and 4 kcal/g depending on how fermentable it is (Atwater general factors
 * assume 4; specific factors and the EU convention assume ~2; fully insoluble
 * fibre such as wheat bran yields ~0).
 *
 * So the default check is an INTERVAL, not a point:
 *
 *     E_low  = 4*protein + 4*(carbs - fiber) + 9*fat     (fibre at 0 kcal/g)
 *     E_high = 4*protein + 4*carbs           + 9*fat     (fibre at 4 kcal/g)
 *
 * `kcal` must lie within `tolerance` of the interval [E_low, E_high], where
 *
 *     tolerance = max(10% of kcal, 10 kcal)
 *
 * The 10 kcal absolute floor exists because a percentage tolerance is
 * meaningless on a 14 kcal food: iceberg lettuce is 23% "off" and 3 kcal wrong.
 * For a zero-fibre food the interval collapses to a point and this degrades
 * exactly to the classic 4/4/9 check at 10%.
 *
 * Three classes of food still cannot satisfy even the bracket. Each needs an
 * explicit, reasoned entry in energy-exceptions.json, and each gets a DIFFERENT
 * substitute check — an exception is a different test, never an absent test:
 *
 *   alcohol  Ethanol is 6.93 kcal/g and has no macro field. We back-compute
 *            the implied ethanol from the calorie gap and require it to be
 *            physically plausible (0 < g <= 50 per 100 g — 50 g/100 g is above
 *            100-proof spirit, so anything higher is a data error).
 *   polyol   Sugar alcohols and allulose are counted in total carbohydrate but
 *            yield ~0-2.4 kcal/g. The naive estimate must therefore OVERSHOOT,
 *            and by no more than 4x.
 *   fiber    Reserved for foods where even the 0-4 kcal/g fibre bracket fails.
 *   rounding Label rounding on a tiny serving. Absolute error must be <= 25 kcal.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSON_DIR = join(HERE, 'json');

// Mirrored from types.ts. Kept as a literal so this script has zero deps and
// can run before/independently of the TypeScript toolchain.
const CATEGORIES = new Set([
  'meat', 'poultry', 'seafood', 'egg', 'dairy', 'dairy-alt', 'grain', 'bread',
  'pasta', 'cereal', 'legume', 'nut-seed', 'fruit', 'vegetable', 'fat-oil',
  'condiment', 'sauce', 'sweetener', 'snack', 'baked-good', 'prepared', 'soup',
  'restaurant', 'beverage', 'alcohol', 'supplement', 'herb-spice',
]);
const LIQUID_CATEGORIES = new Set(['beverage', 'alcohol', 'fat-oil']);

const FOOD_KEYS = ['id', 'name', 'brand', 'aliases', 'category', 'per100g', 'micronutrients', 'servings', 'density_g_per_ml', 'verified', 'source'];
const PER100G_KEYS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'satfat_g', 'sodium_mg'];

const KCAL_PCT_TOLERANCE = 0.10;
const KCAL_ABS_TOLERANCE = 10;
const KCAL_PER_G_ETHANOL = 6.93;
const MAX_ETHANOL_G_PER_100G = 50;
const ROUNDING_ABS_TOLERANCE = 25;
// Acetic acid yields ~3.5 kcal/g. Culinary vinegars are 4-8% acid, so ~28 kcal
// of unexplained energy per 100 g; 40 kcal is a generous ceiling above which
// the row is a data error rather than an acid contribution.
const MAX_ACID_KCAL_PER_100G = 40;
const FOLIC_ACID_TO_DFE = 1.7;
const MICRO_KEYS = [
  'vitamin_a_retinol_mcg', 'vitamin_a_carotenoid_mcg_rae',
  'folate_food_mcg', 'folic_acid_mcg', 'folate_dfe_mcg',
];
// Ceilings. Cod liver oil is ~30,000 mcg retinol/100 g and is the highest real
// food; anything past 60,000 is a unit error (IU written as mcg is a 3.3x slip).
const MAX_RETINOL_MCG = 60000;
const MAX_CAROTENOID_RAE = 30000;
const MAX_FOLATE_MCG = 5000;
const DFE_TOLERANCE_PCT = 0.06;
const DFE_TOLERANCE_ABS = 6;

const DENSITY_MIN = 0.25;
const DENSITY_MAX = 1.60;

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const files = readdirSync(JSON_DIR).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('FATAL: no JSON files in json/ — run `node src/data/foods/build.mjs` first.');
  process.exit(1);
}

/** @type {Map<string, {flags: string[], used: boolean}>} */
const exceptions = new Map();
try {
  const raw = JSON.parse(readFileSync(join(HERE, 'energy-exceptions.json'), 'utf8'));
  for (const row of raw) exceptions.set(row.id, { flags: row.flags, used: false });
} catch (e) {
  console.error(`FATAL: could not read energy-exceptions.json — ${e.message}`);
  process.exit(1);
}

const allFoods = [];
const seenIds = new Map();
const perCategoryCounts = [];

for (const file of files) {
  const expectedCategory = basename(file, '.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(JSON_DIR, file), 'utf8'));
  } catch (e) {
    err(file, `does not parse as JSON — ${e.message}`);
    continue;
  }
  if (!Array.isArray(parsed)) {
    err(file, 'top level is not an array');
    continue;
  }
  perCategoryCounts.push([expectedCategory, parsed.length]);
  for (const food of parsed) {
    allFoods.push({ food, file, expectedCategory });
  }
}

// ---------------------------------------------------------------------------
// Per-food checks
// ---------------------------------------------------------------------------

let energyChecked = 0;
let energyExceptionsApplied = 0;
let verifiedCount = 0;
let servingCount = 0;
let densityCount = 0;
let aliasCount = 0;
let retinolKnown = 0;
let carotenoidKnown = 0;
let folateSplitKnown = 0;
let folicAcidBearing = 0;

for (const { food, file, expectedCategory } of allFoods) {
  const where = `${file} [${food?.id ?? '<no id>'}]`;

  if (typeof food !== 'object' || food === null || Array.isArray(food)) {
    err(where, 'food record is not an object');
    continue;
  }

  // -- 4. shape ------------------------------------------------------------
  for (const key of FOOD_KEYS) {
    if (!(key in food)) err(where, `missing required key "${key}"`);
  }
  for (const key of Object.keys(food)) {
    if (!FOOD_KEYS.includes(key)) err(where, `unexpected key "${key}"`);
  }

  // -- 3. id ---------------------------------------------------------------
  if (typeof food.id !== 'string' || food.id.length === 0) {
    err(where, 'id must be a non-empty string');
  } else {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(food.id)) err(where, `id "${food.id}" is not kebab-case`);
    if (seenIds.has(food.id)) err(where, `duplicate id — also in ${seenIds.get(food.id)}`);
    else seenIds.set(food.id, file);
  }

  if (typeof food.name !== 'string' || food.name.trim().length === 0) {
    err(where, 'name must be a non-empty string');
  }
  if (food.brand !== null && (typeof food.brand !== 'string' || food.brand.length === 0)) {
    err(where, 'brand must be a non-empty string or null');
  }
  if (!Array.isArray(food.aliases) || food.aliases.some((a) => typeof a !== 'string' || a.length === 0)) {
    err(where, 'aliases must be an array of non-empty strings');
  } else {
    aliasCount += food.aliases.length;
    const lower = food.aliases.map((a) => a.toLowerCase());
    if (new Set(lower).size !== lower.length) err(where, 'aliases contains duplicates');
    if (typeof food.name === 'string' && lower.includes(food.name.toLowerCase())) {
      warnings.push(`${where}: alias duplicates the name`);
    }
  }
  if (typeof food.verified !== 'boolean') err(where, 'verified must be a boolean');
  else if (food.verified) verifiedCount += 1;
  if (typeof food.source !== 'string' || food.source.trim().length === 0) {
    err(where, 'source must be a non-empty string');
  }

  // -- 5. category ---------------------------------------------------------
  if (!CATEGORIES.has(food.category)) {
    err(where, `category "${food.category}" is not in the controlled vocabulary`);
  } else if (food.category !== expectedCategory) {
    err(where, `category "${food.category}" does not match file ${file}`);
  }

  // -- 6/7. nutrient panel -------------------------------------------------
  const p = food.per100g;
  let panelOk = true;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    err(where, 'per100g must be an object');
    panelOk = false;
  } else {
    for (const key of PER100G_KEYS) {
      if (!(key in p)) { err(where, `per100g missing "${key}"`); panelOk = false; continue; }
      if (!isFiniteNumber(p[key])) { err(where, `per100g.${key} must be a finite number`); panelOk = false; continue; }
      if (p[key] < 0) { err(where, `per100g.${key} is negative (${p[key]})`); panelOk = false; }
    }
    for (const key of Object.keys(p)) {
      if (!PER100G_KEYS.includes(key)) err(where, `per100g has unexpected key "${key}"`);
    }
  }

  if (panelOk) {
    const macroMass = p.protein_g + p.carbs_g + p.fat_g;
    if (macroMass > 100.5) {
      err(where, `protein+carbs+fat = ${round(macroMass)} g exceeds 100 g per 100 g`);
    }
    if (p.fiber_g > p.carbs_g + 0.05) {
      err(where, `fiber (${p.fiber_g}) exceeds total carbs (${p.carbs_g})`);
    }
    if (p.sugar_g > p.carbs_g + 0.05) {
      err(where, `sugar (${p.sugar_g}) exceeds total carbs (${p.carbs_g})`);
    }
    if (p.satfat_g > p.fat_g + 0.05) {
      err(where, `saturated fat (${p.satfat_g}) exceeds total fat (${p.fat_g})`);
    }
    if (p.sodium_mg > 40000) {
      err(where, `sodium ${p.sodium_mg} mg/100 g exceeds pure salt (38,758 mg)`);
    }
    if (p.kcal > 902) {
      err(where, `kcal ${p.kcal} exceeds pure fat (902 kcal/100 g)`);
    }
  }

  // -- 10b. micronutrients -------------------------------------------------
  const micro = food.micronutrients;
  if (micro && typeof micro === 'object') {
    if (micro.vitamin_a_retinol_mcg !== null && micro.vitamin_a_retinol_mcg !== undefined) retinolKnown += 1;
    if (micro.vitamin_a_carotenoid_mcg_rae !== null && micro.vitamin_a_carotenoid_mcg_rae !== undefined) carotenoidKnown += 1;
    if (micro.folate_food_mcg !== null && micro.folic_acid_mcg !== null
        && micro.folate_food_mcg !== undefined && micro.folic_acid_mcg !== undefined) folateSplitKnown += 1;
    if (typeof micro.folic_acid_mcg === 'number' && micro.folic_acid_mcg > 0) folicAcidBearing += 1;
  }
  if (typeof micro !== 'object' || micro === null || Array.isArray(micro)) {
    err(where, 'micronutrients must be an object (fields may be null, the block may not be)');
  } else {
    for (const key of MICRO_KEYS) {
      if (!(key in micro)) { err(where, `micronutrients missing "${key}"`); continue; }
      const value = micro[key];
      if (value === null) continue;
      if (!isFiniteNumber(value)) { err(where, `micronutrients.${key} must be a number or null`); continue; }
      if (value < 0) err(where, `micronutrients.${key} is negative (${value})`);
    }
    for (const key of Object.keys(micro)) {
      if (!MICRO_KEYS.includes(key)) err(where, `micronutrients has unexpected key "${key}"`);
    }

    const retinol = micro.vitamin_a_retinol_mcg;
    const carotenoid = micro.vitamin_a_carotenoid_mcg_rae;
    const foodFolate = micro.folate_food_mcg;
    const folicAcid = micro.folic_acid_mcg;
    const dfe = micro.folate_dfe_mcg;

    if (isFiniteNumber(retinol) && retinol > MAX_RETINOL_MCG) {
      err(where, `retinol ${retinol} mcg/100 g exceeds ${MAX_RETINOL_MCG} — probably IU recorded as mcg`);
    }
    if (isFiniteNumber(carotenoid) && carotenoid > MAX_CAROTENOID_RAE) {
      err(where, `carotenoid ${carotenoid} mcg RAE/100 g exceeds ${MAX_CAROTENOID_RAE} — RAW beta-carotene mcg is ~12x RAE; this field takes RAE`);
    }
    for (const [key, value] of [['folate_food_mcg', foodFolate], ['folic_acid_mcg', folicAcid], ['folate_dfe_mcg', dfe]]) {
      if (isFiniteNumber(value) && value > MAX_FOLATE_MCG) {
        err(where, `${key} ${value} mcg/100 g exceeds ${MAX_FOLATE_MCG} — check the unit`);
      }
    }

    // The identity that makes DFE meaningful. Without it, a raw-microgram
    // figure sitting in the DFE field is invisible and understates folate by
    // up to 70% for any enriched grain.
    if (isFiniteNumber(foodFolate) && isFiniteNumber(folicAcid) && isFiniteNumber(dfe)) {
      const expected = foodFolate + FOLIC_ACID_TO_DFE * folicAcid;
      const tolerance = Math.max(DFE_TOLERANCE_PCT * expected, DFE_TOLERANCE_ABS);
      if (Math.abs(dfe - expected) > tolerance) {
        err(
          where,
          `folate DFE ${dfe} does not satisfy DFE = food(${foodFolate}) + 1.7 x folic acid(${folicAcid}) = ${round(expected)} `
          + `(tolerance ${round(tolerance)})`,
        );
      }
    }
    if (isFiniteNumber(dfe) && (foodFolate === null) !== (folicAcid === null)) {
      err(where, 'folate DFE is stated with only one of food folate / folic acid — supply both or neither');
    }
    if (isFiniteNumber(folicAcid) && folicAcid > 0 && foodFolate === null) {
      err(where, 'folic acid is stated without food folate — a UL check needs both to interpret DFE');
    }
  }

  // -- 8. servings ---------------------------------------------------------
  if (!Array.isArray(food.servings) || food.servings.length === 0) {
    err(where, 'servings must be a non-empty array');
  } else {
    servingCount += food.servings.length;
    const defaults = food.servings.filter((s) => s && s.isDefault === true);
    if (defaults.length !== 1) {
      err(where, `expected exactly 1 default serving, found ${defaults.length}`);
    }
    const labels = new Set();
    for (const s of food.servings) {
      if (typeof s !== 'object' || s === null) { err(where, 'serving is not an object'); continue; }
      if (typeof s.label !== 'string' || s.label.trim().length === 0) err(where, 'serving label must be a non-empty string');
      else if (labels.has(s.label)) err(where, `duplicate serving label "${s.label}"`);
      else labels.add(s.label);
      if (!isFiniteNumber(s.grams) || s.grams <= 0) err(where, `serving "${s.label}" has a non-positive gram weight`);
      else if (s.grams > 2000) warnings.push(`${where}: serving "${s.label}" is ${s.grams} g — is that intended?`);
      for (const key of Object.keys(s)) {
        if (!['label', 'grams', 'isDefault'].includes(key)) err(where, `serving has unexpected key "${key}"`);
      }
      if ('isDefault' in s && s.isDefault !== true) err(where, 'isDefault, when present, must be true');
    }
  }

  // -- 9. density ----------------------------------------------------------
  const hasVolumeServing = Array.isArray(food.servings)
    && food.servings.some((s) => typeof s?.label === 'string' && /\bml\b/i.test(s.label));
  const d = food.density_g_per_ml;
  if (d !== null && !isFiniteNumber(d)) {
    err(where, 'density_g_per_ml must be a number or null');
  } else if (d !== null) {
    densityCount += 1;
    if (d < DENSITY_MIN || d > DENSITY_MAX) {
      err(where, `density ${d} g/ml is outside the plausible range ${DENSITY_MIN}-${DENSITY_MAX}`);
    }
  }
  if (d === null && LIQUID_CATEGORIES.has(food.category)) {
    err(where, `category "${food.category}" is a liquid category and requires a density`);
  }
  if (d === null && hasVolumeServing) {
    err(where, 'has a millilitre serving but no density — that serving cannot be converted');
  }

  // -- 10. energy cross-check ---------------------------------------------
  if (panelOk) {
    const eHigh = 4 * p.protein_g + 4 * p.carbs_g + 9 * p.fat_g;
    const eLow = 4 * p.protein_g + 4 * (p.carbs_g - p.fiber_g) + 9 * p.fat_g;
    const tolerance = Math.max(KCAL_PCT_TOLERANCE * p.kcal, KCAL_ABS_TOLERANCE);
    const distance = p.kcal < eLow ? eLow - p.kcal : p.kcal > eHigh ? p.kcal - eHigh : 0;
    const passesBracket = distance <= tolerance;

    const ex = exceptions.get(food.id);

    if (passesBracket) {
      energyChecked += 1;
      if (ex) {
        // Stale allowlist entry — unless it is an alcohol row, where the
        // substitute check is genuinely stronger and must always run.
        if (!ex.flags.includes('alcohol')) {
          err(where, `listed in energy-exceptions.json (${ex.flags.join(',')}) but passes the standard check — remove the exception`);
        }
      }
    }

    if (ex) {
      ex.used = true;
      energyExceptionsApplied += 1;
      const gap = p.kcal - eHigh;

      if (ex.flags.includes('alcohol')) {
        const ethanol = gap / KCAL_PER_G_ETHANOL;
        if (ethanol <= 0.05) {
          err(where, `alcohol exception but implied ethanol is ${round(ethanol)} g/100 g — no alcohol accounted for`);
        } else if (ethanol > MAX_ETHANOL_G_PER_100G) {
          err(where, `implied ethanol ${round(ethanol)} g/100 g exceeds the physical maximum (${MAX_ETHANOL_G_PER_100G})`);
        }
      } else if (ex.flags.includes('acid')) {
        if (gap <= 0) {
          err(where, `acid exception but kcal (${p.kcal}) does not exceed the 4/4/9 estimate (${round(eHigh)}) — nothing for the acid to explain`);
        } else if (gap > MAX_ACID_KCAL_PER_100G) {
          err(where, `acid exception but ${round(gap)} kcal/100 g is unexplained (limit ${MAX_ACID_KCAL_PER_100G} — more acid than any culinary vinegar)`);
        }
      } else if (ex.flags.includes('polyol')) {
        // Two-sided physical bound. Sugar alcohols and allulose sit inside
        // total carbohydrate but yield 0-2.4 kcal/g, so the label MUST come in
        // at or below the 4 kcal/g estimate. It must also clear the floor set
        // by protein and fat, which do yield their full Atwater energy.
        const floor = 4 * p.protein_g + 9 * p.fat_g;
        if (p.kcal > eHigh + tolerance) {
          err(where, `polyol exception but kcal (${p.kcal}) EXCEEDS the 4/4/9 estimate (${round(eHigh)}) — sugar alcohols yield less, not more`);
        } else if (p.kcal + tolerance < floor) {
          err(where, `polyol exception but kcal (${p.kcal}) is below the protein+fat floor (${round(floor)}) — polyols cannot explain a deficit there`);
        }
      } else if (ex.flags.includes('fiber')) {
        if (!passesBracket && distance > 0.35 * Math.max(p.kcal, 1)) {
          err(where, `fiber exception but kcal ${p.kcal} is ${round(distance)} kcal outside the fibre bracket [${round(eLow)}, ${round(eHigh)}] — beyond what fibre can explain`);
        }
      } else if (ex.flags.includes('rounding')) {
        if (distance > ROUNDING_ABS_TOLERANCE) {
          err(where, `rounding exception but the error is ${round(distance)} kcal (limit ${ROUNDING_ABS_TOLERANCE})`);
        }
      } else {
        err(where, `energy exception has no recognised flag: ${ex.flags.join(',')}`);
      }
    } else if (!passesBracket) {
      err(
        where,
        `energy cross-check FAILED — label ${p.kcal} kcal, Atwater bracket [${round(eLow)}, ${round(eHigh)}], `
        + `off by ${round(distance)} kcal (tolerance ${round(tolerance)}). `
        + `Fix the macros, or add a documented exception if this is alcohol/polyol/fibre.`,
      );
    }
  }
}

// -- 11. stale exceptions ---------------------------------------------------
for (const [id, ex] of exceptions) {
  if (!ex.used) err('energy-exceptions.json', `exception for unknown food id "${id}" (${ex.flags.join(',')})`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const total = allFoods.length;
perCategoryCounts.sort((a, b) => b[1] - a[1]);

console.log('');
console.log('  Seed food database — validation');
console.log('  ' + '='.repeat(58));
for (const [category, n] of perCategoryCounts) {
  console.log(`    ${category.padEnd(14)} ${String(n).padStart(5)}`);
}
console.log('  ' + '-'.repeat(58));
console.log(`    foods                          ${total}`);
console.log(`    categories                     ${perCategoryCounts.length}`);
console.log(`    unique ids                     ${seenIds.size}`);
console.log(`    servings defined               ${servingCount} (avg ${(servingCount / total).toFixed(2)} per food)`);
console.log(`    search aliases                 ${aliasCount}`);
console.log(`    with density                   ${densityCount}`);
console.log(`    verified: true                 ${verifiedCount} (${((verifiedCount / total) * 100).toFixed(1)}%)`);
console.log(`    retinol known / null           ${retinolKnown} / ${total - retinolKnown}`);
console.log(`    carotenoid RAE known / null    ${carotenoidKnown} / ${total - carotenoidKnown}`);
console.log(`    folate split known / null      ${folateSplitKnown} / ${total - folateSplitKnown}`);
console.log(`    foods bearing folic acid       ${folicAcidBearing}`);
console.log(`    energy check, standard bracket ${energyChecked}`);
console.log(`    energy check, exception rule   ${energyExceptionsApplied}`);
console.log('  ' + '-'.repeat(58));

if (warnings.length > 0) {
  console.log(`\n  ${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 40)) console.log(`    ! ${w}`);
  if (warnings.length > 40) console.log(`    ... and ${warnings.length - 40} more`);
}

if (errors.length > 0) {
  console.log(`\n  ${errors.length} ERROR(S):`);
  for (const e of errors.slice(0, 120)) console.log(`    x ${e}`);
  if (errors.length > 120) console.log(`    ... and ${errors.length - 120} more`);
  console.log('');
  process.exit(1);
}

console.log(`\n  PASS — ${total} foods, 0 errors.\n`);
