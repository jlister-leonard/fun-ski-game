/**
 * open-food-facts.ts — typed, browser-side Open Food Facts client.
 *
 * Contract per `docs/kg/specs/integration-food-db.md` (owned by the
 * integrations agent — treat it as authoritative; this is its implementation).
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS TO UNDERSTAND BEFORE TOUCHING THIS FILE
 * ---------------------------------------------------------------------------
 *
 * 1. LICENCE BOUNDARY. Open Food Facts is ODbL 1.0, which is share-alike.
 *    Runtime lookups from the user's own device, cached into the user's own
 *    vault, are fine — that is the user querying a public service. BUNDLING
 *    OFF-derived data into our shipped artefact is NOT fine, because ODbL's
 *    share-alike obligation would attach to our distributed database. The seed
 *    DB in `src/data/foods` therefore contains ZERO OFF-derived rows and is
 *    sourced from USDA FoodData Central (US federal work, public domain) and
 *    manufacturers' labels. Do not "improve" the seed DB by importing from here.
 *
 * 2. WE CANNOT COMPLY WITH OFF'S USER-AGENT POLICY, AND WE SAY SO.
 *    OFF asks every client to send `User-Agent: AppName/Version (contact)`.
 *    `User-Agent` is a forbidden header name in the Fetch spec — browsers
 *    silently drop any attempt to set it from JavaScript, and there is no
 *    workaround from a web app. We do the two things we actually can:
 *      (a) send `app_name` / `app_version` query parameters as a good-faith
 *          signal on reads. We deliberately do not send `app_uuid`: even a
 *          random stable identifier would let the vendor link repeated scans.
 *      (b) be exemplary on the axis we do control: volume. One scan is one
 *          request; every resolved barcode is cached in the vault forever;
 *          nothing is ever prefetched or retried in a storm.
 *    This limitation is documented rather than papered over.
 *
 * 3. OFFLINE IS NOT AN ERROR. Every function here resolves to a structured
 *    result and never throws for a network condition. Callers fall back to
 *    local results; the user should not see a stack trace because they are on
 *    a plane.
 *
 * 4. THE SODIUM TRAP. OFF reports sodium in GRAMS per 100 g. Our model uses
 *    MILLIGRAMS. The conversion is x1000 and forgetting it produces a food that
 *    claims 0.6 mg of sodium. `offToFoodItem` handles it; nothing else should
 *    touch `nutriments` directly.
 */

import { UNKNOWN_MICRONUTRIENTS } from '@/data/foods/types';
import type { FoodCategory, FoodItem, FoodServing, Per100g } from '@/data/foods/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OffClientConfig {
  /** Base host. Use the `world` host and pass `cc`/`lc` explicitly. */
  readonly baseUrl: string;
  readonly appName: string;
  readonly appVersion: string;
  /** Country code hint, e.g. "us". */
  readonly countryCode: string;
  /** Language code hint, e.g. "en". */
  readonly languageCode: string;
  /** Per-request timeout in ms. OFF is occasionally slow; a scan must not hang. */
  readonly timeoutMs: number;
}

export const DEFAULT_OFF_CONFIG: OffClientConfig = Object.freeze({
  baseUrl: 'https://world.openfoodfacts.org',
  appName: 'HealthCoach',
  appVersion: '1.0',
  countryCode: 'us',
  languageCode: 'en',
  timeoutMs: 6000,
});

/**
 * Response field allowlist. A full OFF product document is 50-200 KB; this
 * keeps a barcode lookup to roughly 2-5 KB, which matters on mobile data.
 */
const FIELDS = [
  'code', 'product_name', 'product_name_en', 'generic_name', 'brands', 'quantity',
  'product_quantity', 'product_quantity_unit', 'serving_size', 'serving_quantity',
  'nutrition_data_per', 'no_nutrition_data', 'nutriments', 'nutriscore_grade',
  'nova_group', 'categories_tags', 'countries_tags', 'image_front_small_url',
  'ingredients_text', 'allergens_tags', 'completeness', 'last_modified_t',
].join(',');

/**
 * Documented per-IP limits. Because we call OFF directly from the device rather
 * than through a proxy, these apply per user — which is both the privacy-correct
 * and the rate-limit-correct architecture. A proxy would collapse every user
 * onto one IP and cap the entire user base at 15 product reads per minute.
 */
export const OFF_RATE_LIMITS = Object.freeze({
  productReadsPerMinute: 15,
  searchesPerMinute: 10,
});

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * EVERY nutriment is optional. OFF is crowd-sourced with no producer
 * verification gate for most entries, and a 2021 analysis found only ~67% of
 * products had complete macronutrient data. Code defensively or ship bugs.
 */
export interface OffNutriments {
  'energy-kcal_100g'?: number;
  'energy_100g'?: number;
  'energy-kj_100g'?: number;
  proteins_100g?: number;
  carbohydrates_100g?: number;
  'carbohydrates-total_100g'?: number;
  sugars_100g?: number;
  fat_100g?: number;
  'saturated-fat_100g'?: number;
  fiber_100g?: number;
  /** GRAMS per 100 g. Multiply by 1000 for mg. */
  sodium_100g?: number;
  /** GRAMS per 100 g. `salt = sodium x 2.5`. */
  salt_100g?: number;
  [key: string]: number | string | undefined;
}

export interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  generic_name?: string;
  brands?: string;
  quantity?: string;
  product_quantity?: number;
  product_quantity_unit?: string;
  /** Free text as printed, e.g. "30 g (about 12 chips)". Display only. */
  serving_size?: string;
  /** Normalised numeric serving in g or ml. Frequently absent. */
  serving_quantity?: number;
  nutrition_data_per?: string;
  no_nutrition_data?: string | boolean;
  nutriments?: OffNutriments;
  nutriscore_grade?: string;
  nova_group?: number;
  categories_tags?: string[];
  countries_tags?: string[];
  image_front_small_url?: string;
  ingredients_text?: string;
  allergens_tags?: string[];
  /** 0-1. The best single per-product data-quality signal OFF gives us. */
  completeness?: number;
  last_modified_t?: number;
}

export interface OffProductResponse {
  /** STRING — never parse as an integer, leading zeros are significant. */
  code: string;
  /** NUMBER — 1 = found, 0 = not found. */
  status: 0 | 1 | number;
  status_verbose?: string;
  product?: OffProduct;
}

// ---------------------------------------------------------------------------
// Result type — never throws for a network condition
// ---------------------------------------------------------------------------

export type OffFailureReason =
  | 'offline'
  | 'cancelled'
  | 'timeout'
  | 'not-found'
  | 'rate-limited'
  | 'network'
  | 'bad-response'
  | 'invalid-barcode'
  | 'insufficient-data';

export type OffLookupResult =
  | { readonly ok: true; readonly food: FoodItem; readonly quality: number; readonly raw: OffProduct }
  | { readonly ok: false; readonly reason: OffFailureReason; readonly detail?: string };

// ---------------------------------------------------------------------------
// Barcode normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a scanned code before lookup.
 *
 * - UPC-E is expanded to UPC-A by the decoder, not here.
 * - A 12-digit UPC-A is zero-padded to EAN-13, which is how OFF stores it.
 * - EAN-13 codes beginning `02` or `2` are store-internal / weight-embedded and
 *   are meaningless globally — reject them rather than resolving to junk.
 */
export function normalizeBarcode(raw: string): { ok: true; code: string } | { ok: false; reason: OffFailureReason } {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return { ok: false, reason: 'invalid-barcode' };

  let code = digits;
  if (code.length === 12) code = `0${code}`;
  if (code.length === 14 && code.startsWith('0')) code = code.slice(1);

  if (code.length === 13 && (code.startsWith('02') || code.startsWith('2'))) {
    return { ok: false, reason: 'invalid-barcode' };
  }
  return { ok: true, code };
}

// ---------------------------------------------------------------------------
// Mapping OFF -> our FoodItem
// ---------------------------------------------------------------------------

const KJ_PER_KCAL = 4.184;

/**
 * OFF has no category vocabulary that maps cleanly onto ours, and guessing
 * wrong is worse than not guessing: a mislabelled category corrupts the browse
 * view and the search prior. Everything from OFF lands in `prepared` unless a
 * small set of unambiguous tags applies, and the UI lets the user recategorise.
 */
function mapCategory(tags: readonly string[] | undefined): FoodCategory {
  if (!tags || tags.length === 0) return 'prepared';
  const joined = tags.join(' ');
  const has = (needle: string): boolean => joined.includes(needle);
  if (has('beverages') || has('waters') || has('sodas')) return 'beverage';
  if (has('alcoholic')) return 'alcohol';
  if (has('breakfast-cereals')) return 'cereal';
  if (has('breads')) return 'bread';
  if (has('pastas')) return 'pasta';
  if (has('cheeses') || has('yogurts') || has('milks')) return 'dairy';
  if (has('snacks') || has('chips') || has('confectioneries')) return 'snack';
  if (has('nuts') || has('seeds')) return 'nut-seed';
  if (has('sauces') || has('dressings')) return 'sauce';
  if (has('condiments')) return 'condiment';
  if (has('meats') || has('charcuterie')) return 'meat';
  if (has('poultry')) return 'poultry';
  if (has('seafood') || has('fishes')) return 'seafood';
  if (has('legumes')) return 'legume';
  if (has('fruits')) return 'fruit';
  if (has('vegetables')) return 'vegetable';
  if (has('dietary-supplements') || has('protein')) return 'supplement';
  return 'prepared';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Build the serving list. OFF's `serving_size` is free text and not reliably
 * machine-parseable, so we prefer the numeric `serving_quantity` and fall back
 * to a leading number in the text. A "100 g" serving is always present so the
 * user can log by weight regardless.
 */
function buildServings(product: OffProduct): FoodServing[] {
  const servings: FoodServing[] = [];
  const label = product.serving_size?.trim();

  let grams = num(product.serving_quantity);
  if (grams === undefined && label) {
    const match = /^\s*([\d.]+)\s*(g|ml)\b/i.exec(label);
    if (match) {
      const parsed = Number.parseFloat(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) grams = parsed;
    }
  }

  if (grams !== undefined && grams > 0 && grams < 2000) {
    servings.push({ label: label && label.length > 0 ? label : `1 serving (${grams} g)`, grams, isDefault: true });
  }

  const pack = num(product.product_quantity);
  if (pack !== undefined && pack > 0 && pack < 5000 && Math.abs(pack - (grams ?? 0)) > 1) {
    servings.push({ label: `Whole package (${Math.round(pack)} g)`, grams: pack });
  }

  if (servings.length === 0) servings.push({ label: '100 g', grams: 100, isDefault: true });
  else if (!servings.some((s) => s.grams === 100)) servings.push({ label: '100 g', grams: 100 });

  return servings;
}

/**
 * 0-1 confidence. Drives result ranking against seed foods and the UI's
 * "unverified crowd-sourced data" indicator. Presence of the four core macros
 * dominates, because a product with a name and nothing else is worthless.
 */
export function scoreProductQuality(product: OffProduct): number {
  const n = product.nutriments ?? {};
  const core = [
    num(n['energy-kcal_100g']) ?? num(n.energy_100g),
    num(n.proteins_100g),
    num(n.carbohydrates_100g) ?? num(n['carbohydrates-total_100g']),
    num(n.fat_100g),
  ];
  const present = core.filter((v) => v !== undefined).length;
  const coreScore = present / core.length;
  const completeness = num(product.completeness) ?? 0;
  const named = product.product_name || product.product_name_en ? 1 : 0;
  return Math.max(0, Math.min(1, 0.6 * coreScore + 0.25 * completeness + 0.15 * named));
}

/**
 * Convert an OFF response into our canonical `FoodItem`.
 *
 * Returns `undefined` when the product lacks enough data to be worth logging —
 * a food with no energy value is a trap, not a convenience.
 */
export function offToFoodItem(response: OffProductResponse): { food: FoodItem; quality: number; raw: OffProduct } | undefined {
  if (response.status !== 1 || !response.product) return undefined;
  const product = response.product;
  const n = product.nutriments ?? {};

  // Energy: prefer the explicit kcal field; fall back to kJ; `energy_100g` is
  // kJ on most European entries, so it is the last resort and is converted.
  let kcal = num(n['energy-kcal_100g']);
  if (kcal === undefined) {
    const kj = num(n['energy-kj_100g']) ?? num(n.energy_100g);
    if (kj !== undefined) kcal = kj / KJ_PER_KCAL;
  }
  if (kcal === undefined) return undefined;

  // Carbs: US convention is TOTAL carbohydrate. EU entries report NET carbs in
  // `carbohydrates_100g`, so when an explicit total is absent we reconstruct
  // total = net + fibre. This is the single most common source of a food that
  // looks 5-10 g light on carbs.
  const fiber = num(n.fiber_100g) ?? 0;
  const explicitTotal = num(n['carbohydrates-total_100g']);
  const net = num(n.carbohydrates_100g);
  const carbs = explicitTotal ?? (net !== undefined ? net + fiber : undefined);
  if (carbs === undefined) return undefined;

  const protein = num(n.proteins_100g);
  const fat = num(n.fat_100g);
  if (protein === undefined || fat === undefined) return undefined;

  // Sodium: OFF reports GRAMS. We store MILLIGRAMS. If sodium is missing but
  // salt is present, sodium = salt / 2.5.
  const sodiumG = num(n.sodium_100g) ?? (num(n.salt_100g) !== undefined ? (n.salt_100g as number) / 2.5 : undefined);

  const per100g: Per100g = {
    kcal,
    protein_g: protein,
    carbs_g: carbs,
    fat_g: fat,
    fiber_g: fiber,
    sugar_g: num(n.sugars_100g) ?? 0,
    satfat_g: num(n['saturated-fat_100g']) ?? 0,
    sodium_mg: sodiumG !== undefined ? sodiumG * 1000 : 0,
  };

  const name = (product.product_name_en || product.product_name || product.generic_name || '').trim();
  const brand = product.brands ? product.brands.split(',')[0].trim() : null;

  const food: FoodItem = {
    id: `off:${response.code}`,
    name: name.length > 0 ? name : `Unknown product ${response.code}`,
    brand: brand && brand.length > 0 ? brand : null,
    aliases: brand ? [brand] : [],
    category: mapCategory(product.categories_tags),
    per100g,
    // OFF cannot supply these, and that is a fact about OFF rather than a gap
    // we should paper over. It carries no retinol/carotenoid split, no
    // food-folate/folic-acid split, and its `vitamin-a_100g` field is a single
    // conflated total. Since the vitamin A upper limit applies to preformed
    // retinol only and the folate upper limit to synthetic folic acid only, a
    // conflated total is not merely imprecise — it is unusable for the checks
    // those fields exist to drive. All null: the consumer suppresses the check.
    micronutrients: { ...UNKNOWN_MICRONUTRIENTS },
    servings: buildServings(product),
    // OFF gives us no density. Volume entry is disabled for scanned products
    // until the user supplies one; this is honest rather than guessing 1.0.
    density_g_per_ml: null,
    // Crowd-sourced with no producer verification gate. Never `true`.
    verified: false,
    source: `Open Food Facts (barcode ${response.code})`,
  };

  return { food, quality: scoreProductQuality(product), raw: product };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function buildUrl(config: OffClientConfig, path: string, params: Record<string, string>): string {
  const url = new URL(path, config.baseUrl);
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('cc', config.countryCode);
  url.searchParams.set('lc', config.languageCode);
  // The closest good-faith substitute for the User-Agent we are not allowed to
  // set. See the file header.
  url.searchParams.set('app_name', config.appName);
  url.searchParams.set('app_version', config.appVersion);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Look up one barcode.
 *
 * SAFE TO CALL WITH NO NETWORK: returns `{ ok: false, reason: 'offline' }`
 * without attempting a request. Never throws for a network condition, so a
 * caller can always fall through to seed-DB results and manual entry.
 *
 * Cost discipline: exactly one request. The caller must check the vault cache
 * and the seed DB first, and must cache a successful result permanently —
 * product data changes on a scale of months, so there is no freshness argument
 * for re-fetching.
 */
export async function lookupBarcode(
  barcode: string,
  config: Partial<OffClientConfig> = {},
  /**
   * Injected for testing. Pass `null` to assert the no-fetch path explicitly —
   * a default parameter cannot be suppressed by passing `undefined`, and a test
   * that thinks it is offline while quietly hitting the network is worse than
   * no test.
   */
  fetchImpl?: typeof fetch | null,
  /** Abort when the UI operation that owns this request is cancelled. */
  externalSignal?: AbortSignal,
): Promise<OffLookupResult> {
  const merged: OffClientConfig = { ...DEFAULT_OFF_CONFIG, ...config };
  const doFetch = fetchImpl === undefined
    ? (typeof fetch === 'function' ? fetch : null)
    : fetchImpl;

  const normalized = normalizeBarcode(barcode);
  if (!normalized.ok) {
    return { ok: false, reason: 'invalid-barcode', detail: `"${barcode}" is not a usable product barcode` };
  }
  if (!doFetch) return { ok: false, reason: 'network', detail: 'fetch is unavailable in this environment' };
  if (isOffline()) return { ok: false, reason: 'offline' };

  const url = buildUrl(merged, `/api/v2/product/${normalized.code}.json`, {});

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const abortFromOwner = () => controller?.abort();
  externalSignal?.addEventListener('abort', abortFromOwner, { once: true });
  if (externalSignal?.aborted) controller?.abort();
  const timer = controller
    ? setTimeout(() => controller.abort(), merged.timeoutMs)
    : undefined;

  try {
    const response = await doFetch(url, {
      method: 'GET',
      // OFF reads need no credentials, and sending any would be a privacy leak.
      credentials: 'omit',
      cache: 'default',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });

    if (response.status === 429) return { ok: false, reason: 'rate-limited' };
    if (response.status === 404) return { ok: false, reason: 'not-found' };
    if (!response.ok) {
      return { ok: false, reason: 'bad-response', detail: `HTTP ${response.status}` };
    }

    const payload = (await response.json()) as OffProductResponse;
    if (payload.status !== 1 || !payload.product) return { ok: false, reason: 'not-found' };

    const mapped = offToFoodItem(payload);
    if (!mapped) {
      return {
        ok: false,
        reason: 'insufficient-data',
        detail: 'Product found but its nutrition panel is incomplete',
      };
    }
    return { ok: true, food: mapped.food, quality: mapped.quality, raw: mapped.raw };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError') {
      return { ok: false, reason: externalSignal?.aborted ? 'cancelled' : 'timeout' };
    }
    // A CORS rejection, a DNS failure and a dropped connection are all
    // indistinguishable from JS. All of them mean the same thing to the user.
    return { ok: false, reason: 'network', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromOwner);
  }
}

/**
 * Bulk barcode lookup — the one genuinely useful thing `/api/v2/search` does.
 * Use it to re-resolve a handful of cached-but-incomplete products in one
 * request rather than N. Capped at 24 codes to stay well inside the limits.
 *
 * NOTE: v2 search is *faceted only* and has no full-text mode. Free-text search
 * is served by the bundled seed DB, which is faster, works offline, and gives
 * better results for whole foods than OFF's branded catalogue.
 */
export async function lookupBarcodes(
  barcodes: readonly string[],
  config: Partial<OffClientConfig> = {},
  /** See `lookupBarcode`: pass `null` to assert the no-fetch path. */
  fetchImpl?: typeof fetch | null,
): Promise<Map<string, OffLookupResult>> {
  const merged: OffClientConfig = { ...DEFAULT_OFF_CONFIG, ...config };
  const doFetch = fetchImpl === undefined
    ? (typeof fetch === 'function' ? fetch : null)
    : fetchImpl;
  const out = new Map<string, OffLookupResult>();

  const codes: string[] = [];
  for (const raw of barcodes.slice(0, 24)) {
    const normalized = normalizeBarcode(raw);
    if (normalized.ok) codes.push(normalized.code);
    else out.set(raw, { ok: false, reason: 'invalid-barcode' });
  }
  if (codes.length === 0) return out;

  if (!doFetch || isOffline()) {
    for (const code of codes) out.set(code, { ok: false, reason: isOffline() ? 'offline' : 'network' });
    return out;
  }

  const url = buildUrl(merged, '/api/v2/search', { code: codes.join(','), page_size: String(codes.length) });
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), merged.timeoutMs) : undefined;

  try {
    const response = await doFetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!response.ok) {
      const reason: OffFailureReason = response.status === 429 ? 'rate-limited' : 'bad-response';
      for (const code of codes) out.set(code, { ok: false, reason });
      return out;
    }
    const payload = (await response.json()) as { products?: OffProduct[] };
    const found = new Set<string>();
    for (const product of payload.products ?? []) {
      const code = product.code;
      if (!code) continue;
      found.add(code);
      const mapped = offToFoodItem({ code, status: 1, product });
      out.set(
        code,
        mapped
          ? { ok: true, food: mapped.food, quality: mapped.quality, raw: mapped.raw }
          : { ok: false, reason: 'insufficient-data' },
      );
    }
    for (const code of codes) if (!found.has(code)) out.set(code, { ok: false, reason: 'not-found' });
    return out;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const reason: OffFailureReason = name === 'AbortError' ? 'timeout' : 'network';
    for (const code of codes) out.set(code, { ok: false, reason });
    return out;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** User-facing copy for each failure mode. Never surface a raw error string. */
export function describeFailure(reason: OffFailureReason): string {
  switch (reason) {
    case 'cancelled':
      return 'Lookup cancelled.';
    case 'offline':
      return 'You’re offline — searching your local food database instead.';
    case 'timeout':
      return 'The lookup took too long. Try again, or add this food manually.';
    case 'not-found':
      return 'That barcode isn’t in the Open Food Facts database yet. Add it manually and it’s saved for next time.';
    case 'rate-limited':
      return 'Too many lookups just now. Give it a minute.';
    case 'invalid-barcode':
      return 'That looks like a store-internal barcode, which isn’t in any global database.';
    case 'insufficient-data':
      return 'Found the product, but its nutrition information is incomplete. Check the numbers before saving.';
    case 'bad-response':
    case 'network':
    default:
      return 'Couldn’t reach the food database. Your local search still works.';
  }
}
