#!/usr/bin/env node
/**
 * build.mjs — expand the pipe-delimited authoring files in `source/` into the
 * runtime JSON in `json/`.
 *
 *   node src/data/foods/build.mjs
 *
 * WHY A BUILD STEP?
 * The runtime artefact must be JSON (one file per category, imported by
 * `index.ts`). But 1,400 hand-written JSON objects is 1,400 opportunities to
 * fat-finger a brace, and the serving lists are highly repetitive within a
 * category. So the *editing surface* is a terse pipe-delimited file with
 * per-category defaults, and the JSON is generated from it. Both are committed.
 * `validate.mjs` validates the generated JSON — the thing that actually ships.
 *
 * SOURCE FILE FORMAT
 * ------------------
 * Header directives (any order, before the rows):
 *   #category: vegetable
 *   #source: USDA FoodData Central (SR Legacy)
 *   #servings: 1 cup chopped@150*;100 g@100
 *   #density:  1.03            (optional; per-category default)
 *   #verified: 1               (optional; default 1)
 *
 * Rows — pipe-delimited, leading/trailing whitespace on each cell is trimmed:
 *   id|name|aliases|kcal|protein|carbs|fat|fiber|sugar|satfat|sodium|servings|extra
 *
 *   aliases   ';'-separated, may be empty
 *   servings  ';'-separated `label@grams`, '*' suffix marks the default.
 *             Empty -> the category default from #servings.
 *   extra     ';'-separated `key=value` overrides:
 *               brand=Fage            -> brand (default null)
 *               d=1.03                -> density_g_per_ml
 *               d=-                   -> force density null
 *               v=0                   -> verified false
 *               src=manufacturer label-> source override
 *               fl=alcohol,fiber      -> energy-check exception flags
 *
 * `#` at the start of a line is a comment. Blank lines ignored.
 *
 * OUTPUTS
 *   json/<category>.json        the food records
 *   energy-exceptions.json      { id, flags[] } for foods the 4/4/9 check
 *                               cannot apply naively (see validate.mjs)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, 'source');
const OUT_DIR = join(HERE, 'json');

const VALID_FLAGS = new Set(['alcohol', 'fiber', 'polyol', 'rounding', 'acid']);

/** Micronutrient extras. All default to null — "unknown", never "zero". */
const MICRO_KEYS = {
  ret: 'vitamin_a_retinol_mcg',
  car: 'vitamin_a_carotenoid_mcg_rae',
  ffol: 'folate_food_mcg',
  fac: 'folic_acid_mcg',
  dfe: 'folate_dfe_mcg',
};
const FOLIC_ACID_TO_DFE = 1.7;

/** @param {string} spec */
function parseServings(spec, where) {
  const parts = spec
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error(`${where}: empty serving list`);

  const servings = parts.map((part) => {
    const isDefault = part.endsWith('*');
    const body = isDefault ? part.slice(0, -1) : part;
    const at = body.lastIndexOf('@');
    if (at < 0) throw new Error(`${where}: serving "${part}" is missing "@grams"`);
    const label = body.slice(0, at).trim();
    const grams = Number(body.slice(at + 1).trim());
    if (!label) throw new Error(`${where}: serving "${part}" has an empty label`);
    if (!Number.isFinite(grams) || grams <= 0) {
      throw new Error(`${where}: serving "${part}" has a non-positive gram weight`);
    }
    return isDefault ? { label, grams, isDefault: true } : { label, grams };
  });

  const defaults = servings.filter((s) => s.isDefault);
  if (defaults.length > 1) throw new Error(`${where}: more than one default serving`);
  if (defaults.length === 0) servings[0].isDefault = true;
  return servings;
}

/** @param {string} spec */
function parseExtra(spec, where) {
  /** @type {{brand: string|null, density: number|null|undefined, verified: boolean|undefined, source: string|undefined, flags: string[]}} */
  const out = {
    brand: null, density: undefined, verified: undefined, source: undefined, flags: [],
    micro: {
      vitamin_a_retinol_mcg: null,
      vitamin_a_carotenoid_mcg_rae: null,
      folate_food_mcg: null,
      folic_acid_mcg: null,
      folate_dfe_mcg: null,
    },
  };
  for (const pair of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq < 0) throw new Error(`${where}: extra "${pair}" is not key=value`);
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    switch (key) {
      case 'brand':
        out.brand = value;
        break;
      case 'd':
        out.density = value === '-' ? null : Number(value);
        if (out.density !== null && !Number.isFinite(out.density)) {
          throw new Error(`${where}: density "${value}" is not a number`);
        }
        break;
      case 'v':
        out.verified = value === '1' || value === 'true';
        break;
      case 'src':
        out.source = value;
        break;
      case 'fl':
        out.flags = value.split(',').map((f) => f.trim()).filter(Boolean);
        for (const f of out.flags) {
          if (!VALID_FLAGS.has(f)) {
            throw new Error(`${where}: unknown flag "${f}" (allowed: ${[...VALID_FLAGS].join(', ')})`);
          }
        }
        break;
      default: {
        const microField = MICRO_KEYS[key];
        if (!microField) throw new Error(`${where}: unknown extra key "${key}"`);
        if (value === '-' || value === '') {
          out.micro[microField] = null;
        } else {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0) {
            throw new Error(`${where}: ${key}="${value}" must be a non-negative number or "-"`);
          }
          out.micro[microField] = parsed;
        }
        break;
      }
    }
  }
  return out;
}

function num(cell, where, field) {
  const trimmed = cell.trim();
  if (trimmed === '') throw new Error(`${where}: ${field} is empty`);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`${where}: ${field} "${cell}" is not a number`);
  return value;
}

function buildFile(fileName) {
  const raw = readFileSync(join(SRC_DIR, fileName), 'utf8');
  const lines = raw.split('\n');

  const header = { category: null, source: null, servings: null, density: undefined, verified: true };
  const foods = [];
  /** @type {Array<{id: string, flags: string[]}>} */
  const exceptions = [];

  lines.forEach((line, i) => {
    const where = `${fileName}:${i + 1}`;
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('#')) {
      const m = /^#\s*(category|source|servings|density|verified)\s*:\s*(.*)$/.exec(trimmed);
      if (!m) return; // plain comment
      const [, key, value] = m;
      if (key === 'density') header.density = value.trim() === '-' ? null : Number(value.trim());
      else if (key === 'verified') header.verified = value.trim() === '1';
      else header[key] = value.trim();
      return;
    }

    const cells = trimmed.split('|');
    if (cells.length < 12) {
      throw new Error(`${where}: expected at least 12 columns, got ${cells.length}`);
    }
    const [id, name, aliases, kcal, protein, carbs, fat, fiber, sugar, satfat, sodium] = cells;
    const servingsCell = (cells[11] ?? '').trim();
    const extraCell = (cells[12] ?? '').trim();

    if (!header.category) throw new Error(`${where}: file is missing a "#category:" directive`);
    if (!header.servings && !servingsCell) {
      throw new Error(`${where}: no servings and no "#servings:" default`);
    }

    const extra = parseExtra(extraCell, where);
    const density = extra.density !== undefined ? extra.density : (header.density ?? null);

    foods.push({
      id: id.trim(),
      name: name.trim(),
      brand: extra.brand,
      aliases: aliases.split(';').map((a) => a.trim()).filter(Boolean),
      category: header.category,
      per100g: {
        kcal: num(kcal, where, 'kcal'),
        protein_g: num(protein, where, 'protein'),
        carbs_g: num(carbs, where, 'carbs'),
        fat_g: num(fat, where, 'fat'),
        fiber_g: num(fiber, where, 'fiber'),
        sugar_g: num(sugar, where, 'sugar'),
        satfat_g: num(satfat, where, 'satfat'),
        sodium_mg: num(sodium, where, 'sodium'),
      },
      micronutrients: (() => {
        const micro = extra.micro;
        // Convenience: derive DFE when both components are known and DFE was
        // not stated. Rows that carry USDA's own published DFE state it
        // explicitly, which keeps validate.mjs's identity check meaningful
        // rather than tautological.
        if (
          micro.folate_dfe_mcg === null
          && micro.folate_food_mcg !== null
          && micro.folic_acid_mcg !== null
        ) {
          micro.folate_dfe_mcg = Math.round(
            (micro.folate_food_mcg + FOLIC_ACID_TO_DFE * micro.folic_acid_mcg) * 10,
          ) / 10;
        }
        return micro;
      })(),
      servings: parseServings(servingsCell || header.servings, where),
      density_g_per_ml: density,
      verified: extra.verified !== undefined ? extra.verified : header.verified,
      source: extra.source ?? header.source ?? 'author estimate',
    });

    if (extra.flags.length > 0) exceptions.push({ id: id.trim(), flags: extra.flags });
  });

  return { category: header.category, foods, exceptions };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.psv')).sort();

  let total = 0;
  const allExceptions = [];
  const counts = [];

  for (const file of files) {
    const { category, foods, exceptions } = buildFile(file);
    writeFileSync(join(OUT_DIR, `${category}.json`), `${JSON.stringify(foods, null, 1)}\n`);
    allExceptions.push(...exceptions);
    counts.push([category, foods.length]);
    total += foods.length;
  }

  allExceptions.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(HERE, 'energy-exceptions.json'), `${JSON.stringify(allExceptions, null, 1)}\n`);

  counts.sort((a, b) => b[1] - a[1]);
  for (const [category, n] of counts) {
    console.log(`  ${category.padEnd(14)} ${String(n).padStart(5)}`);
  }
  console.log(`  ${'—'.repeat(14)} ${'—'.repeat(5)}`);
  console.log(`  ${'TOTAL'.padEnd(14)} ${String(total).padStart(5)}  across ${files.length} files`);
  console.log(`  energy-check exceptions: ${allExceptions.length}`);
}

main();
