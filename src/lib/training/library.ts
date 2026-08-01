/**
 * @file The bundled exercise library — 220 movements, searchable offline.
 *
 * ## Why this file is a copy
 *
 * The authoritative library is `docs/kg/specs/exercise-library.json`, but
 * `docs/` is excluded from the build (see `tsconfig.json` — it is a research
 * staging area and "nothing here is imported by the app"). So a byte-identical
 * copy lives next to this module and is imported like any other asset.
 * `__tests__/library.test.ts` reads both files off disk and fails if they ever
 * diverge, which turns the duplication from a drift risk into a checked
 * invariant.
 *
 * ## Why it is unencrypted
 *
 * "The vault contains `rehab-shoulder-external-rotation`" is a health
 * inference, which is why the *user's* exercise rows are blind-indexed. But the
 * library itself is public reference data identical for every install — it
 * carries no information about this user at all. Shipping it in the bundle
 * means search works on a plane, in single-digit milliseconds, with the vault
 * locked. The vault-side `exercises` table exists only so that logged sets have
 * a stable foreign key; it is seeded from here.
 */

import type { Muscle } from '../db/types';
import raw from './exercise-library.json';
import type { LibraryExercise, RepUnit } from './types';

/**
 * The JSON is validated by the R1 build validator against exactly this shape —
 * 220 unique slugs, key order enforced, every `rep_unit` in the four-value
 * vocabulary, every `rom_tracked` entry carrying its measurement sentence. The
 * assertion is load-bearing but checked by a stricter gate than the type system
 * would give us.
 *
 * Casting through `unknown` also stops `tsc` inferring 220 literal object types,
 * which is worth several seconds on every typecheck.
 */
export const EXERCISE_LIBRARY: readonly LibraryExercise[] = Object.freeze(
  raw as unknown as LibraryExercise[],
);

/** Slug → entry. Built once at module load. */
const BY_SLUG: ReadonlyMap<string, LibraryExercise> = new Map(
  EXERCISE_LIBRARY.map((e) => [e.slug, e]),
);

/**
 * Look up one movement.
 *
 * @param slug e.g. `atg-split-squat`
 * @returns the entry, or `null` when the slug is unknown (a user-created
 *   exercise, or a slug from a newer library)
 */
export function exerciseBySlug(slug: string): LibraryExercise | null {
  return BY_SLUG.get(slug) ?? null;
}

/**
 * The rep unit for a slug.
 *
 * Falls back to `reps` for slugs outside the library — user-created movements
 * are conventional by construction, since the picker only offers reps for them.
 *
 * @param slug the movement
 * @returns its unit
 */
export function repUnitFor(slug: string): RepUnit {
  return BY_SLUG.get(slug)?.rep_unit ?? 'reps';
}

/**
 * Whether depth, rather than load, is this movement's progression variable.
 *
 * @param slug the movement
 * @returns true for the 16 `rom_tracked` entries
 */
export function isRomTracked(slug: string): boolean {
  return BY_SLUG.get(slug)?.rom_tracked === true;
}

/**
 * The measurement sentence for a `rom_tracked` movement.
 *
 * Every one of the 16 states what gets measured in its `notes`, in the
 * machine-greppable form `ROM progression: measured as …`. The build validator
 * fails if a tracked entry lacks it or an untracked entry has one, so this
 * extraction is safe — but it still returns `null` rather than throwing, so a
 * future library can never crash the logger.
 *
 * @param slug the movement
 * @returns the sentence after "measured as", or `null`
 */
export function romMeasurementOf(slug: string): string | null {
  const entry = BY_SLUG.get(slug);
  if (!entry?.rom_tracked) return null;
  const match = /ROM progression:\s*measured as\s*([^.]*(?:\.[^ ]|[^.])*)\.?/i.exec(entry.notes);
  const text = match?.[1]?.trim();
  return text && text.length > 0 ? text : null;
}

/**
 * A guessed default unit for a ROM measurement, from its own sentence.
 *
 * Depth measured in centimetres is shown in inches to a US user; an angle is an
 * angle in both systems. Guessing beats forcing the user to pick a unit every
 * time, and they can always override it.
 *
 * @param slug the movement
 * @returns a unit string for the ROM field
 */
export function romUnitHint(slug: string): string {
  const sentence = romMeasurementOf(slug)?.toLowerCase() ?? '';
  if (/angle|degree/.test(sentence)) return 'deg';
  if (/centimetre|centimeter|distance|depth|height|elevation|inch/.test(sentence)) return 'in';
  return 'in';
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Lower-cased haystacks, precomputed so keystroke search never re-allocates. */
interface SearchRow {
  readonly exercise: LibraryExercise;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly slug: string;
}

const SEARCH_ROWS: readonly SearchRow[] = EXERCISE_LIBRARY.map((exercise) => ({
  exercise,
  name: exercise.name.toLowerCase(),
  aliases: exercise.aliases.map((a) => a.toLowerCase()),
  slug: exercise.slug,
}));

/**
 * Score one row against a query. Higher is better; 0 means no match.
 *
 * The ordering that matters in practice: someone typing "bench" wants
 * `Barbell Bench Press` before `Close-Grip Bench Press`, and someone typing
 * "bb bench" — an alias — wants it at least as much. So a name prefix beats a
 * name substring beats an alias match beats a slug match, and shorter names
 * win ties because they are the more generic movement.
 */
function score(row: SearchRow, q: string): number {
  if (row.name.startsWith(q)) return 100;
  for (const alias of row.aliases) {
    if (alias === q) return 95;
  }
  if (row.name.includes(q)) {
    // A match at a word boundary is a real match; mid-word is incidental.
    return / /.test(row.name.slice(0, row.name.indexOf(q))) ? 80 : 70;
  }
  for (const alias of row.aliases) {
    if (alias.startsWith(q)) return 60;
    if (alias.includes(q)) return 50;
  }
  if (row.slug.includes(q)) return 40;
  return 0;
}

/**
 * Search the library by name, alias and slug.
 *
 * Multi-word queries are ANDed across tokens ("cable row" matches
 * `Seated Cable Row`), because that is how people narrow a list — they add a
 * word when there are too many results.
 *
 * @param query free text; empty returns nothing
 * @param limit maximum results. Default 30.
 * @returns matching entries, best first
 */
export function searchLibrary(query: string, limit = 30): LibraryExercise[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: { row: SearchRow; total: number }[] = [];
  for (const row of SEARCH_ROWS) {
    let total = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const s = score(row, token);
      if (s === 0) {
        matchedAll = false;
        break;
      }
      total += s;
    }
    if (matchedAll) scored.push({ row, total });
  }

  scored.sort(
    (a, b) => b.total - a.total || a.row.name.length - b.row.name.length,
  );
  return scored.slice(0, limit).map((s) => s.row.exercise);
}

/**
 * Every movement whose primary or secondary muscles include one of the given
 * muscles, best stimulus-to-fatigue first.
 *
 * Used to answer "the app has three sets of side delts left in the budget —
 * what should it offer?"
 *
 * @param muscles the muscles of interest
 * @param options.primaryOnly exclude movements that only hit it indirectly
 * @param options.limit maximum results
 * @returns matching entries
 */
export function libraryForMuscles(
  muscles: readonly Muscle[],
  options: { primaryOnly?: boolean; limit?: number } = {},
): LibraryExercise[] {
  const wanted = new Set(muscles);
  const hits = EXERCISE_LIBRARY.filter((e) => {
    if (e.primary_muscles.some((m) => wanted.has(m))) return true;
    if (options.primaryOnly) return false;
    return e.secondary_muscles.some((m) => wanted.has(m));
  });
  hits.sort((a, b) => {
    const aPrimary = a.primary_muscles.some((m) => wanted.has(m)) ? 1 : 0;
    const bPrimary = b.primary_muscles.some((m) => wanted.has(m)) ? 1 : 0;
    return bPrimary - aPrimary || b.sfr_rating - a.sfr_rating;
  });
  return options.limit === undefined ? hits : hits.slice(0, options.limit);
}
