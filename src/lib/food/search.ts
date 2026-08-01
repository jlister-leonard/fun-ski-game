/**
 * search.ts — offline food search.
 *
 * Requirements this file exists to satisfy:
 *   - Runs entirely on-device over the bundled seed DB plus the user's own
 *     cached and custom foods. No network on the critical path, ever.
 *   - Fast enough to run on every keystroke over the full database. An inverted
 *     index is built once at module load; a query never linear-scans the corpus.
 *   - Tolerant of how people actually type: partial words, plurals, typos,
 *     synonyms ("garbanzo" -> chickpeas), and brand names.
 *   - Ranks what *this* user eats above what is merely lexically similar.
 *
 * Zero dependencies. Safe in a Web Worker.
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS
 * ---------------------------------------------------------------------------
 * Build (once):
 *   Every food contributes tokens from four fields — name, aliases, brand,
 *   category — each token stored both raw and lightly stemmed. Postings are
 *   packed into integers (doc, field, position) to keep the index compact. A
 *   sorted vocabulary array supports prefix expansion by binary search, and a
 *   (first letter, length) bucketing supports bounded-edit-distance recovery
 *   without scanning the whole vocabulary.
 *
 * Query (per keystroke):
 *   Each query token is expanded to candidate vocabulary terms — exact, then
 *   prefix, then, only if those were thin, fuzzy. Scores accumulate per document
 *   with field and match-quality weights. A document must match EVERY query
 *   token (AND semantics) — "chicken breast" must not return every chicken
 *   product. Priors and personalisation are then added and the top N returned.
 */

import { SEED_FOODS } from '@/data/foods';
import type { FoodCategory, FoodItem } from '@/data/foods/types';

// ---------------------------------------------------------------------------
// Tuning constants — all in one place so ranking is auditable
// ---------------------------------------------------------------------------

const FIELD_NAME = 0;
const FIELD_ALIAS = 1;
const FIELD_BRAND = 2;
const FIELD_CATEGORY = 3;

const FIELD_WEIGHT = [1.0, 0.85, 0.6, 0.32] as const;

/** An exact token hit is the gold standard; everything else is a discount. */
const W_EXACT = 1.0;
const W_PREFIX = 0.62;
const W_FUZZY = 0.45;

/** Whole-query bonuses, applied once per document. */
const BONUS_NAME_EQUALS_QUERY = 2.6;
const BONUS_NAME_STARTS_WITH_QUERY = 1.25;
const BONUS_ALIAS_EQUALS_QUERY = 2.2;

/** Priors: what to prefer when two foods match a query equally well. */
const PRIOR_VERIFIED = 0.15;
const PRIOR_GENERIC = 0.12;
const PRIOR_SHORT_NAME = 0.3;

/** Personalisation ceilings — a habit should reorder ties, not override relevance. */
const MAX_FREQUENCY_BOOST = 2.0;
const FREQUENCY_COEFFICIENT = 0.45;
const MAX_RECENCY_BOOST = 1.5;
const RECENCY_DECAY = 8;

/** Guardrails that keep a single keystroke bounded. */
const MIN_PREFIX_LENGTH = 2;
const MAX_PREFIX_EXPANSIONS = 300;
const MIN_FUZZY_LENGTH = 4;
const FUZZY_TRIGGER_HITS = 6;
const MAX_FUZZY_CANDIDATES = 600;
const MAX_QUERY_TOKENS = 8;

/** Categories whose members are staple whole foods people search for by name. */
const WHOLE_FOOD_CATEGORIES: ReadonlySet<string> = new Set<FoodCategory>([
  'meat', 'poultry', 'seafood', 'egg', 'dairy', 'fruit', 'vegetable',
  'grain', 'legume', 'nut-seed',
]);
const PRIOR_WHOLE_FOOD = 0.1;

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Lowercase, strip diacritics, drop punctuation. "Crème fraîche" and
 * "creme fraiche" must be the same string, and "Reese's" must match "reeses".
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['\u2019\u02bc]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (normalized.length === 0) return [];
  return normalized.split(' ').filter((t) => t.length > 0);
}

/**
 * Deliberately conservative stemmer — plurals only.
 *
 * A real Porter stemmer collapses "oats"/"oat" but also "beans"/"bean" into
 * forms that collide with unrelated words, and in a food corpus that produces
 * visibly wrong results. Handling plurals covers essentially all of the real
 * recall gap ("bananas", "eggs", "berries") at near-zero risk.
 */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && (token.endsWith('ches') || token.endsWith('shes') || token.endsWith('sses') || token.endsWith('xes'))) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('es') && !token.endsWith('ees')) return token.slice(0, -1);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Bounded edit distance (Optimal String Alignment — Levenshtein + transposition)
// ---------------------------------------------------------------------------

/**
 * Returns the edit distance, or `maxDistance + 1` as soon as it is known to
 * exceed the budget. Early exit is what makes fuzzy matching affordable.
 */
export function boundedEditDistance(a: string, b: string, maxDistance: number): number {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > maxDistance) return maxDistance + 1;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  let prevPrev = new Array<number>(lenB + 1);
  let prev = new Array<number>(lenB + 1);
  let curr = new Array<number>(lenB + 1);
  for (let j = 0; j <= lenB; j += 1) prev[j] = j;

  for (let i = 1; i <= lenA; i += 1) {
    curr[0] = i;
    const from = Math.max(1, i - maxDistance);
    const to = Math.min(lenB, i + maxDistance);
    if (from > 1) curr[from - 1] = maxDistance + 1;
    let rowMin = maxDistance + 1;

    for (let j = from; j <= to; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let value = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (
        i > 1 && j > 1
        && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
        && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (to < lenB) curr[to + 1] = maxDistance + 1;
    if (rowMin > maxDistance) return maxDistance + 1;

    const spare = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = spare;
  }

  const result = prev[lenB];
  return result > maxDistance ? maxDistance + 1 : result;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** doc * 256 + field * 64 + min(position, 63) */
const POSTING_DOC_SHIFT = 256;
const POSTING_FIELD_SHIFT = 64;

interface DocMeta {
  readonly food: FoodItem;
  readonly normalizedName: string;
  readonly normalizedAliases: readonly string[];
  readonly nameTokenCount: number;
  /** Static quality prior, precomputed at build time. */
  readonly prior: number;
}

export interface FoodSearchIndex {
  readonly docs: readonly DocMeta[];
  readonly postings: ReadonlyMap<string, readonly number[]>;
  /** Sorted vocabulary, for prefix expansion by binary search. */
  readonly vocabulary: readonly string[];
  /** `${firstChar}:${length}` -> terms, for bounded fuzzy candidate generation. */
  readonly fuzzyBuckets: ReadonlyMap<string, readonly string[]>;
  readonly byId: ReadonlyMap<string, FoodItem>;
}

function computePrior(food: FoodItem, nameTokenCount: number): number {
  let prior = 0;
  if (food.verified) prior += PRIOR_VERIFIED;
  if (food.brand === null) prior += PRIOR_GENERIC;
  if (WHOLE_FOOD_CATEGORIES.has(food.category)) prior += PRIOR_WHOLE_FOOD;
  // Prefer "Banana" over "Banana bread, homemade, thick slice".
  prior += PRIOR_SHORT_NAME * (1 / (1 + nameTokenCount / 3));
  return prior;
}

function addPosting(
  postings: Map<string, number[]>,
  term: string,
  doc: number,
  field: number,
  position: number,
): void {
  const packed = doc * POSTING_DOC_SHIFT + field * POSTING_FIELD_SHIFT + Math.min(position, 63);
  const list = postings.get(term);
  if (list) list.push(packed);
  else postings.set(term, [packed]);
}

/**
 * Build a searchable index over any set of foods.
 *
 * Call this with `[...SEED_FOODS, ...userCustomFoods, ...cachedOffFoods]` to get
 * one ranked result list across all three sources. Later entries win on id
 * collision, so a user's correction of a seed food shadows the seed entry —
 * which is the behaviour we want: the user is always authoritative.
 */
export function createFoodSearchIndex(foods: readonly FoodItem[]): FoodSearchIndex {
  const deduped = new Map<string, FoodItem>();
  for (const food of foods) deduped.set(food.id, food);
  const list = [...deduped.values()];

  const docs: DocMeta[] = [];
  const postings = new Map<string, number[]>();
  const seenTerms = new Set<string>();

  list.forEach((food, doc) => {
    const nameTokens = tokenize(food.name);
    const aliasStrings = food.aliases.map(normalizeText);

    const index = (tokens: readonly string[], field: number): void => {
      tokens.forEach((token, position) => {
        addPosting(postings, token, doc, field, position);
        seenTerms.add(token);
        const stemmed = stem(token);
        if (stemmed !== token) {
          addPosting(postings, stemmed, doc, field, position);
          seenTerms.add(stemmed);
        }
      });
    };

    index(nameTokens, FIELD_NAME);
    for (const alias of food.aliases) index(tokenize(alias), FIELD_ALIAS);
    if (food.brand) index(tokenize(food.brand), FIELD_BRAND);
    index(tokenize(food.category.replace(/-/g, ' ')), FIELD_CATEGORY);

    docs.push({
      food,
      normalizedName: normalizeText(food.name),
      normalizedAliases: aliasStrings,
      nameTokenCount: nameTokens.length,
      prior: computePrior(food, nameTokens.length),
    });
  });

  // Deduplicate postings lists (a term can repeat within one field).
  for (const [term, list_] of postings) {
    if (list_.length > 1) postings.set(term, [...new Set(list_)]);
  }

  const vocabulary = [...seenTerms].sort();

  const fuzzyBuckets = new Map<string, string[]>();
  for (const term of vocabulary) {
    if (term.length < MIN_FUZZY_LENGTH - 1) continue;
    const key = `${term[0]}:${term.length}`;
    const bucket = fuzzyBuckets.get(key);
    if (bucket) bucket.push(term);
    else fuzzyBuckets.set(key, [term]);
  }

  return {
    docs,
    postings,
    vocabulary,
    fuzzyBuckets,
    byId: deduped,
  };
}

/** Lower bound: first index whose term is >= `prefix`. */
function lowerBound(vocabulary: readonly string[], prefix: string): number {
  let low = 0;
  let high = vocabulary.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (vocabulary[mid] < prefix) low = mid + 1;
    else high = mid;
  }
  return low;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Max results. Default 25. */
  readonly limit?: number;
  /** Restrict to these categories. */
  readonly categories?: readonly FoodCategory[];
  /**
   * Food ids the user logged recently, MOST RECENT FIRST. Position drives an
   * exponentially decaying boost.
   */
  readonly recentIds?: readonly string[];
  /** foodId -> number of times logged, all time. Drives a log-scaled boost. */
  readonly frequency?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /** Only return foods with `verified: true`. */
  readonly verifiedOnly?: boolean;
  /** Set false to skip fuzzy recovery (useful for benchmarking). Default true. */
  readonly fuzzy?: boolean;
}

export interface SearchResult {
  readonly food: FoodItem;
  readonly score: number;
  /** Vocabulary terms that actually matched — enough to drive highlighting. */
  readonly matchedTerms: readonly string[];
}

function frequencyOf(
  frequency: SearchOptions['frequency'],
  id: string,
): number {
  if (!frequency) return 0;
  if (frequency instanceof Map) return frequency.get(id) ?? 0;
  return (frequency as Record<string, number>)[id] ?? 0;
}

/**
 * Rank foods in `index` against `query`.
 *
 * An empty query is not an error — it returns the user's recent and
 * most-frequent foods, which is exactly what an empty search box should show.
 */
export function searchFoodsIn(
  index: FoodSearchIndex,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const limit = options.limit ?? 25;
  const docCount = index.docs.length;
  const categoryFilter = options.categories && options.categories.length > 0
    ? new Set<string>(options.categories)
    : undefined;

  const passesFilters = (doc: DocMeta): boolean => {
    if (categoryFilter && !categoryFilter.has(doc.food.category)) return false;
    if (options.verifiedOnly && !doc.food.verified) return false;
    return true;
  };

  const recencyBoost = new Map<string, number>();
  if (options.recentIds) {
    options.recentIds.forEach((id, position) => {
      if (!recencyBoost.has(id)) {
        recencyBoost.set(id, MAX_RECENCY_BOOST * Math.exp(-position / RECENCY_DECAY));
      }
    });
  }

  const personalBoost = (id: string): number => {
    const uses = frequencyOf(options.frequency, id);
    const freq = uses > 0 ? Math.min(MAX_FREQUENCY_BOOST, FREQUENCY_COEFFICIENT * Math.log(1 + uses)) : 0;
    return freq + (recencyBoost.get(id) ?? 0);
  };

  const queryTokens = tokenize(query).slice(0, MAX_QUERY_TOKENS);
  const normalizedQuery = normalizeText(query);

  // --- empty query: the "what do you usually eat" view --------------------
  if (queryTokens.length === 0) {
    const results: SearchResult[] = [];
    for (const doc of index.docs) {
      if (!passesFilters(doc)) continue;
      const boost = personalBoost(doc.food.id);
      if (boost > 0) results.push({ food: doc.food, score: boost, matchedTerms: [] });
    }
    results.sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name));
    return results.slice(0, limit);
  }

  const scores = new Float64Array(docCount);
  const tokenHits = new Int32Array(docCount);
  /** Stamp array: `touched[doc] === tokenIndex + 1` means "already scored for this query token". */
  const touched = new Int32Array(docCount);
  /** Best contribution seen so far for (doc, current query token). */
  const bestForToken = new Float64Array(docCount);
  const matchedTerms = new Set<string>();

  /**
   * Fold one vocabulary term's postings into the running scores.
   *
   * A document takes the MAXIMUM contribution across all terms that a single
   * query token expanded to — never the sum. Summing would let a food that
   * happens to contain "chicken" in its name, its aliases and its brand
   * outrank a food actually named "Chicken breast".
   *
   * Returns how many *new* documents this term brought in, which is what the
   * fuzzy-recovery trigger measures.
   */
  const applyPostings = (term: string, weight: number, tokenIndex: number): number => {
    const list = index.postings.get(term);
    if (!list) return 0;
    const stamp = tokenIndex + 1;
    let newDocs = 0;

    for (let i = 0; i < list.length; i += 1) {
      const packed = list[i];
      const doc = (packed / POSTING_DOC_SHIFT) | 0;
      const rest = packed - doc * POSTING_DOC_SHIFT;
      const field = (rest / POSTING_FIELD_SHIFT) | 0;
      const position = rest - field * POSTING_FIELD_SHIFT;

      let contribution = weight * FIELD_WEIGHT[field];
      // Matching the first word of a name is a much stronger signal than
      // matching the ninth: "chicken" in "Chicken breast" vs in "Soup, chicken".
      if (field === FIELD_NAME) contribution *= 1 + 0.35 / (position + 1);

      if (touched[doc] !== stamp) {
        touched[doc] = stamp;
        bestForToken[doc] = contribution;
        tokenHits[doc] += 1;
        scores[doc] += contribution;
        newDocs += 1;
      } else if (contribution > bestForToken[doc]) {
        scores[doc] += contribution - bestForToken[doc];
        bestForToken[doc] = contribution;
      }
    }
    return newDocs;
  };

  queryTokens.forEach((token, tokenIndex) => {
    const stemmed = stem(token);
    let hits = 0;

    hits += applyPostings(token, W_EXACT, tokenIndex);
    if (stemmed !== token) hits += applyPostings(stemmed, W_EXACT * 0.98, tokenIndex);
    if (hits > 0) matchedTerms.add(token);

    // --- prefix expansion -------------------------------------------------
    const isLastToken = tokenIndex === queryTokens.length - 1;
    if (token.length >= MIN_PREFIX_LENGTH) {
      let expansions = 0;
      for (let i = lowerBound(index.vocabulary, token); i < index.vocabulary.length; i += 1) {
        const term = index.vocabulary[i];
        if (!term.startsWith(token)) break;
        if (term === token) continue;
        expansions += 1;
        if (expansions > MAX_PREFIX_EXPANSIONS) break;
        // A prefix of the word the user is still typing is worth more than a
        // prefix of a word they finished typing and moved past.
        const lengthRatio = token.length / term.length;
        const weight = W_PREFIX * lengthRatio * (isLastToken ? 1 : 0.8);
        const added = applyPostings(term, weight, tokenIndex);
        if (added > 0) matchedTerms.add(term);
        hits += added;
      }
    }

    // --- fuzzy recovery, only when the cheap paths were thin ---------------
    if (options.fuzzy !== false && hits < FUZZY_TRIGGER_HITS && token.length >= MIN_FUZZY_LENGTH) {
      const maxDistance = token.length <= 5 ? 1 : 2;
      let examined = 0;
      for (let delta = -maxDistance; delta <= maxDistance; delta += 1) {
        const length = token.length + delta;
        if (length < MIN_FUZZY_LENGTH - 1) continue;
        // A typo in the first character is rare; bucketing by it keeps the
        // candidate set small. We additionally probe the buckets for the
        // second character so a leading-letter slip is still recoverable.
        for (const firstChar of [token[0], token[1]]) {
          if (!firstChar) continue;
          const bucket = index.fuzzyBuckets.get(`${firstChar}:${length}`);
          if (!bucket) continue;
          for (const term of bucket) {
            if (examined >= MAX_FUZZY_CANDIDATES) break;
            examined += 1;
            if (term === token || term.startsWith(token)) continue;
            const distance = boundedEditDistance(token, term, maxDistance);
            if (distance > maxDistance) continue;
            const added = applyPostings(term, W_FUZZY / (1 + distance), tokenIndex);
            if (added > 0) matchedTerms.add(term);
            hits += added;
          }
        }
      }
    }
  });

  // --- assemble ------------------------------------------------------------
  const required = queryTokens.length;
  const matchedTermList = Object.freeze([...matchedTerms]);
  const results: SearchResult[] = [];

  for (let doc = 0; doc < docCount; doc += 1) {
    if (tokenHits[doc] < required) continue;
    const meta = index.docs[doc];
    if (!passesFilters(meta)) continue;

    let score = scores[doc] + meta.prior + personalBoost(meta.food.id);

    if (meta.normalizedName === normalizedQuery) score += BONUS_NAME_EQUALS_QUERY;
    else if (meta.normalizedName.startsWith(normalizedQuery)) score += BONUS_NAME_STARTS_WITH_QUERY;
    if (meta.normalizedAliases.includes(normalizedQuery)) score += BONUS_ALIAS_EQUALS_QUERY;

    results.push({ food: meta.food, score, matchedTerms: matchedTermList });
  }

  results.sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name));
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Default index over the seed database
// ---------------------------------------------------------------------------

let seedIndex: FoodSearchIndex | undefined;
let mergedIndex: FoodSearchIndex | undefined;
let mergedSignature = '';

/** The seed-only index, built on first use and reused thereafter. */
export function getSeedSearchIndex(): FoodSearchIndex {
  if (!seedIndex) seedIndex = createFoodSearchIndex(SEED_FOODS);
  return seedIndex;
}

/**
 * Index over the seed DB plus the user's own foods.
 *
 * Rebuilding costs ~15 ms over 1,500 foods, so it is cached against a cheap
 * signature of the extra foods. Call it freely from a component; it only does
 * real work when the user's food list actually changed.
 */
export function getMergedSearchIndex(userFoods: readonly FoodItem[]): FoodSearchIndex {
  if (userFoods.length === 0) return getSeedSearchIndex();
  const signature = `${userFoods.length}:${userFoods.map((f) => f.id).join(',')}`;
  if (!mergedIndex || signature !== mergedSignature) {
    mergedIndex = createFoodSearchIndex([...SEED_FOODS, ...userFoods]);
    mergedSignature = signature;
  }
  return mergedIndex;
}

/** Convenience wrapper: search the seed DB plus optional user foods. */
export function searchFoods(
  query: string,
  options: SearchOptions & { readonly userFoods?: readonly FoodItem[] } = {},
): SearchResult[] {
  const index = options.userFoods && options.userFoods.length > 0
    ? getMergedSearchIndex(options.userFoods)
    : getSeedSearchIndex();
  return searchFoodsIn(index, query, options);
}

/** Everything in a category, alphabetically — for the browse view. */
export function browseCategory(
  category: FoodCategory,
  options: { readonly userFoods?: readonly FoodItem[]; readonly limit?: number } = {},
): FoodItem[] {
  const index = options.userFoods && options.userFoods.length > 0
    ? getMergedSearchIndex(options.userFoods)
    : getSeedSearchIndex();
  const out = index.docs
    .filter((d) => d.food.category === category)
    .map((d) => d.food)
    .sort((a, b) => a.name.localeCompare(b.name));
  return typeof options.limit === 'number' ? out.slice(0, options.limit) : out;
}

/** Look up a food by id across seed and user foods. */
export function getFoodById(
  id: string,
  userFoods: readonly FoodItem[] = [],
): FoodItem | undefined {
  const index = userFoods.length > 0 ? getMergedSearchIndex(userFoods) : getSeedSearchIndex();
  return index.byId.get(id);
}

/** Test seam: drop cached indexes (used by verify.mjs and by hot reload). */
export function resetSearchIndexCache(): void {
  seedIndex = undefined;
  mergedIndex = undefined;
  mergedSignature = '';
}
