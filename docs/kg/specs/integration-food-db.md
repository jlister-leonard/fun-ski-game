# Integration Spec: Food & Nutrition Data

**Status:** Draft for implementation — revised for the local-first PWA architecture
**Owner:** Integrations research
**Last updated:** 2026-07-26
**Governing doc:** [`docs/kg/ARCHITECTURE.md`](../ARCHITECTURE.md) — health data never leaves the device.

> **Verification note.** `world.openfoodfacts.org` and `api.nal.usda.gov` are blocked by this environment's egress proxy,
> so **no live API call was made**. Field names and schemas below come from Open Food Facts' own repo documentation and
> YAML schemas, the USDA FDC OpenAPI specification, and real captured payloads — all read via GitHub mirrors. Unconfirmed
> items are tagged `[UNVERIFIED]`.

---

## 0. Architecture summary

Three layers, in the order the app consults them:

| Layer | When | Network? | Notes |
|---|---|---|---|
| **1. Bundled seed DB** (~1,000 common foods) | Always available, instant | **No** | Ships in the bundle. Covers whole foods, staples, generics. |
| **2. Vault cache** of previously resolved foods | After first lookup | **No** | Every OFF hit is cached into the vault forever. |
| **3. Open Food Facts** live lookup | Barcode scan / long-tail search | Yes — **browser → OFF directly** | No key, no auth. Reveals only the barcode, never the user's log. |

**USDA FoodData Central is NOT a runtime integration** — it requires an API key, which cannot be shipped in a static
bundle. It is used **offline, at build time, as the source for the seed DB** (§3), and its nutrient-ID mapping is
retained in Appendix A for that purpose.

**Privacy note to surface in the UI:** an OFF barcode lookup sends one barcode to `openfoodfacts.org`. It does not
reveal who scanned it, what else they ate, or anything from the vault. The food *log* never leaves the device. This is
the one deliberate, bounded network egress in the app and it should be disclosable in a settings screen — including an
"offline only" toggle that restricts the app to layers 1 and 2.

---

## 1. Open Food Facts from the browser

### 1.1 Endpoints

Base host: `https://world.openfoodfacts.org` (use this and pass `lc=`/`cc=` explicitly rather than relying on country
subdomains, whose exact semantics are `[UNVERIFIED]`).

**Barcode lookup — the primary path:**

```
GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json?fields=<allowlist>
```

Response envelope:

```jsonc
{
  "code": "3017620422003",     // STRING — never parse as int, leading zeros matter
  "status": 1,                 // NUMBER — 1 = found, 0 = not found
  "status_verbose": "product found",
  "product": { /* ... */ }     // absent or empty when status = 0
}
```

**Search.** This is genuinely messy right now and worth stating plainly:

- **`GET /api/v2/search`** is *structured/faceted only* — it filters on tag fields (`categories_tags_en`, `brands_tags`,
  `labels_tags`, `nutrition_grades_tags`) with `fields`, `page`, `page_size`, `sort_by`. **It cannot do full-text
  search.** There is no `search_terms` equivalent in v2.
  It *does* support **bulk barcode lookup**, which is genuinely useful:
  `/api/v2/search?code=3263859883713,8437011606013&fields=code,product_name`
- **`GET /cgi/search.pl?search_terms=...&json=1&page_size=20`** is the legacy Perl endpoint and the **only** full-text
  search on the main server. OFF explicitly calls it "not recommended for new integrations", and the Perl backend behind
  it is effectively deprecated.
- **`search.openfoodfacts.org`** (project "Search-a-licious", Elasticsearch-backed) is where full-text search is moving.

**Our decision:** barcode scan → `/api/v2/product/{code}.json`. That is the only OFF endpoint we truly need, because
free-text search is served by the **bundled seed DB** (§3), which is faster, works offline, and produces better results
for whole foods than OFF's crowd-sourced branded catalogue. Treat OFF text search as an optional later enhancement
pointed at Search-a-licious.

### 1.2 CORS

`[UNVERIFIED — could not reach live API]` I could not confirm OFF's `Access-Control-Allow-Origin` headers, and the
session's search budget was exhausted before I could find community confirmation.

**Assessment: very likely fine.** OFF is explicitly designed for third-party and client-side reuse, documents
no-auth reads, and its own web clients and numerous browser-based demos call it directly. But *verify before shipping* —
apply the same runtime probe pattern as §2.3 of the Oura spec and degrade to seed-DB-only if it fails.

### 1.3 The User-Agent problem — a real, unavoidable conflict

OFF's documented policy is that **every call, including reads, must carry a descriptive custom User-Agent**:

```
AppName/Version (ContactEmail)      e.g.  HealthCoach/1.0 (me@example.com)
```

Generic agents get treated as bot traffic and blocked or throttled.

**We cannot comply.** `User-Agent` is a [forbidden header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)
in the Fetch spec — browsers silently ignore any attempt to set it from JavaScript. `fetch(url, {headers: {'User-Agent': ...}})`
does nothing. There is no workaround from a web app, and this is not a bug we can engineer around.

**What we do about it:**

1. **Send app labels, but no stable client identifier.** `app_name` and `app_version` are the closest available
   good-faith signal. We deliberately omit `app_uuid` because it would let the vendor link a person's scans:
   ```
   ?fields=...&app_name=Keel&app_version=0.1.0
   ```
2. **Be an exemplary client on the dimension we *can* control: volume.** See §1.4.
3. **Document the limitation honestly** rather than pretending compliance.

### 1.4 Rate limits — and why our architecture is the *good* case

Documented per-IP limits:

| Route class | Limit |
|---|---|
| Product reads (`/api/v*/product/…`) | **15 req / min / IP** |
| Search (`/api/v*/search`, `/cgi/search.pl`) | **10 req / min / IP** |
| Facet queries | **2 req / min** `[UNVERIFIED]` — third-party docs only |

> OFF: *"If these limits are reached, we reserve the right to deny you access to the website and the API through IP
> address ban."*

**Critically:** OFF states that for mobile apps where requests originate from the user's own device, limits apply
**per user rather than per IP** — but this **does not apply if you proxy through your own server**, where every user
collapses onto a single IP.

**This is a strong independent argument for our architecture.** Calling OFF directly from the device is not merely
privacy-preferable, it is the *rate-limit-correct* design. A proxy would cap the entire user base at 15 product reads
per minute; we get 15 per user.

Our budget discipline:

- One barcode scan = **one** request. Never speculative or prefetch.
- **Cache every resolved barcode in the vault permanently.** Repeat scans of the same product cost zero requests. Food
  data changes on a scale of months; there is no freshness argument for re-fetching.
- Debounce the scan loop so a single scanning session produces one lookup, not one per decoded frame (§4.6).
- On `429`, back off and fall through to the seed DB / manual entry. Never retry-storm.

### 1.5 Auth

**Reads require no authentication.** Writes require credentials — we do not write.

### 1.6 `product.nutriments` field naming

For any nutrient `N`, OFF generates a family of keys:

| Key | Meaning |
|---|---|
| `N` | value in standard unit, on the `nutrition_data_per` basis |
| `N_value` | **raw contributor-entered value**, in `N_unit` |
| `N_unit` | contributor's original unit (`g`, `mg`, `ml`, `%`, `kJ`, `kcal`…) |
| **`N_100g`** | **normalized per-100g (or per-100ml), standard unit, server-computed** |
| **`N_serving`** | **normalized per-serving, standard unit, server-computed** |
| `N_prepared`, `N_prepared_100g`, `N_prepared_serving` | same, for the prepared form (e.g. soup made with water) |

> **Use `_100g` and `_serving` exclusively.** The bare key and `_value` are on the contributor's basis in the
> contributor's unit, and will silently hand you mg where you expected g.

Keys relevant to a macro tracker (note the **hyphens** — these must be quoted in TypeScript):

```
energy-kcal_100g   energy-kj_100g   energy_100g
proteins_100g      carbohydrates_100g   carbohydrates-total_100g
sugars_100g        fat_100g         saturated-fat_100g   trans-fat_100g
fiber_100g         salt_100g        sodium_100g          cholesterol_100g
calcium_100g       iron_100g        potassium_100g       alcohol_100g
nova-group         nutrition-score-fr_100g
```

### 1.7 Three traps that will produce wrong numbers

**(a) `carbohydrates` is NET carbs, not total.** OFF's schema is explicit:
- `carbohydrates` = "Available carbohydrates **excluding fiber** (net carbohydrates)" — the EU definition.
- `carbohydrates-total` = "Includes fiber (gross carbohydrates, **US/Canada definition**)".

A US user reading a US package label will see *total* carbs. An EU-sourced OFF product returns *net*. These differ by
the fiber content. **Decision required: our canonical `carbs_g` is TOTAL carbohydrate (US convention),** because the
user reads US labels. On ingest: prefer `carbohydrates-total_100g`; if absent, use
`carbohydrates_100g + (fiber_100g ?? 0)`. Record which path was used so the UI can flag lower-confidence values.

**(b) `sodium_100g` is in GRAMS, not milligrams.** A product with 0.5 g/100g returns `0.5`, not `500`.
**Multiply by 1000 for mg.** Note `sodium_unit` may say `mg` — that unit describes `sodium_value`, *not* `sodium_100g`.
This is the single most likely source of a 1000× error in the app.

**(c) salt and sodium are auto-derived from each other** (`salt = sodium × 2.5`), as are `energy_100g` (kJ) and
`energy-kcal_100g`. They are **never independent evidence** — if one is wrong, both are. Do not "cross-validate" them
and conclude the data is trustworthy.

### 1.8 Serving-size fields

- `nutrition_data_per`: `"100g"` | `"serving"` — the basis the contributor used. Governs the bare key, **not** `_100g`.
- `no_nutrition_data`: `"on"` when the package genuinely has no nutrition table. **Check this before treating missing
  nutriments as a data error.**
- `serving_size`: free text as printed — `"30 g (about 12 chips)"`. **Not machine-parseable.** Display only.
- `serving_quantity`: numeric normalized serving in g/ml. `[UNVERIFIED against schema]` but widely present in real
  payloads. Type as `number | undefined` and fall back to parsing `serving_size`.
- `product_quantity` / `product_quantity_unit`: numeric whole-package size and `"g"`/`"ml"`.
- `quantity`: free text — `"250 g"`, `"6 x 33 cl"`.

**Practical rule:** compute everything from `*_100g × (grams_consumed / 100)`. Only surface `*_serving` alongside the
`serving_size` text, and always guard against `serving_quantity` being absent.

### 1.9 Recommended `fields=` allowlist

Full product documents are routinely 50–200 KB. On mobile data that is unacceptable for a barcode scan. This allowlist
keeps responses to roughly 2–5 KB:

```
code,product_name,brands,quantity,product_quantity,product_quantity_unit,
serving_size,serving_quantity,nutrition_data_per,no_nutrition_data,nutriments,
nutriscore_grade,nova_group,categories_tags,countries_tags,
image_front_small_url,ingredients_text,allergens_tags,completeness,last_modified_t
```

### 1.10 Data-quality caveats — be honest with users

OFF is fully crowd-sourced with no producer verification gate for most entries.

- **Incompleteness is the norm.** A 2021 analysis found only **~67%** of entries had complete macronutrient data, and
  **<20%** had micronutrients beyond sodium. The `completeness` field (0–1 float) is the best per-product signal.
- **Unverified edits.** Any user can change any field; there is no approval queue for most changes. `?blame=1` shows
  per-field attribution.
- **Label error is inherited** even when transcription is perfect — industry rounding rules and processing variance.
- **Regional divergence.** The same product name has different formulations and barcodes per country; a US scan can
  resolve to an EU formulation. Check `countries_tags`.
- **Duplicates and junk barcodes** — store-internal codes and weight-embedded EAN-13s (prefix `02`/`2`) produce
  nonsense entries.
- **`nutriscore_grade` is frequently `"unknown"`/`"not-applicable"`.** Never render without a null check.
- **Coverage skews European** (France especially); US branded coverage is materially thinner.

**Design implications:** every nutriment is `number | undefined`. Show a confidence indicator driven by `completeness`
plus presence of core macros. Offer a "looks wrong? edit on Open Food Facts" link. Always allow the user to override
any value — their correction is authoritative and stays in the vault.

---

## 2. TypeScript interfaces

```ts
// ---------------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------------

export interface OffProductResponse {
  code: string;
  /** 1 = found, 0 = not found. */
  status: 0 | 1;
  status_verbose: string;
  product?: OffProduct;
}

/**
 * Every nutriment key is optional — absence is the norm, not the exception.
 * Hyphenated keys MUST be quoted.
 */
export interface OffNutriments {
  'energy-kcal_100g'?: number;
  'energy-kcal_serving'?: number;
  'energy-kj_100g'?: number;
  energy_100g?: number;

  proteins_100g?: number;
  proteins_serving?: number;

  /** NET carbs (EU definition — excludes fiber). See §1.7(a). */
  carbohydrates_100g?: number;
  /** TOTAL carbs (US definition — includes fiber). Often absent. */
  'carbohydrates-total_100g'?: number;
  sugars_100g?: number;

  fat_100g?: number;
  'saturated-fat_100g'?: number;
  'trans-fat_100g'?: number;

  fiber_100g?: number;

  /** GRAMS, not mg. Multiply by 1000. See §1.7(b). */
  sodium_100g?: number;
  /** GRAMS. salt = sodium * 2.5, auto-derived. */
  salt_100g?: number;

  cholesterol_100g?: number;
  calcium_100g?: number;
  iron_100g?: number;
  potassium_100g?: number;
  alcohol_100g?: number;

  'nova-group'?: number;

  /** Units are the CONTRIBUTOR's, and apply to *_value, not *_100g. */
  [key: string]: number | string | undefined;
}

export interface OffProduct {
  code?: string;
  product_name?: string;
  generic_name?: string;
  brands?: string;
  brands_tags?: string[];

  quantity?: string;              // free text: "250 g"
  product_quantity?: number;      // numeric whole-package size
  product_quantity_unit?: 'g' | 'ml' | string;

  serving_size?: string;          // free text — display only
  serving_quantity?: number;      // numeric grams/ml; may be absent
  nutrition_data_per?: '100g' | 'serving' | string;
  /** "on" when the package genuinely has no nutrition table. */
  no_nutrition_data?: string;

  nutriments?: OffNutriments;

  categories_tags?: string[];
  countries_tags?: string[];
  allergens_tags?: string[];
  ingredients_text?: string;

  image_front_small_url?: string;
  image_front_url?: string;

  nutriscore_grade?: string;   // often "unknown"
  nova_group?: number;
  ecoscore_grade?: string;

  /** 0-1. Best available per-product quality signal. */
  completeness?: number;
  last_modified_t?: number;    // unix SECONDS
}

// ---------------------------------------------------------------------------
// Bundled seed database
// ---------------------------------------------------------------------------

/** Compact per-100g nutrient panel. All values per 100 GRAMS. */
export interface NutrientPanel {
  energy_kcal?: number;
  protein_g?: number;
  /** TOTAL carbohydrate (US convention, includes fiber). */
  carbs_g?: number;
  sugar_g?: number;
  fat_g?: number;
  saturated_fat_g?: number;
  fiber_g?: number;
  /** MILLIGRAMS. */
  sodium_mg?: number;
  cholesterol_mg?: number;
  potassium_mg?: number;
  calcium_mg?: number;
  iron_mg?: number;
}

/** One row in the shipped seed file. Kept deliberately small. */
export interface SeedFood {
  /** Stable slug, e.g. "chicken-breast-roasted". */
  id: string;
  /** Display name, e.g. "Chicken breast, roasted". */
  n: string;
  /** Search aliases / common names, e.g. ["chicken", "poultry"]. */
  a?: string[];
  /** Coarse category for grouping/filtering. */
  c?: string;
  /** Per-100g panel. */
  p: NutrientPanel;
  /** Common household portions, for quick entry. */
  portions?: Array<{ label: string; grams: number }>;
  /** Provenance: USDA fdcId the row was derived from. */
  src?: string;
}

export interface SeedFoodFile {
  version: number;
  /** ISO date the seed was generated. */
  generated: string;
  /** Licence string, surfaced in the app's about screen. */
  license: string;
  foods: SeedFood[];
}

// ---------------------------------------------------------------------------
// Canonical, source-agnostic food model (stored in the vault)
// ---------------------------------------------------------------------------

export type FoodSource = 'seed' | 'off' | 'manual';

export interface FoodItem {
  id: string;
  source: FoodSource;
  /** OFF: barcode. seed: slug. manual: uuid. */
  source_external_id: string;

  name: string;
  brand?: string | null;
  barcode?: string | null;

  /** ALL nutrients normalized PER 100 GRAMS. */
  per_100g: NutrientPanel;

  serving_size_g?: number | null;
  serving_label?: string | null;

  image_url?: string | null;
  categories?: string[] | null;

  /**
   * 0-1 heuristic. Drives ranking and the UI confidence indicator.
   * seed rows = 1.0; OFF = f(completeness, presence of core macros).
   */
  quality?: number | null;
  /** True when carbs_g was reconstructed as net + fiber (§1.7a). */
  carbs_derived?: boolean;

  fetched_at: string;
  /** User edits win over source data, permanently. */
  user_overridden?: boolean;
}

export interface FoodLogEntry {
  id: string;
  food_item_id?: string | null;
  /** Denormalized snapshot so history survives food_item changes. */
  name: string;
  local_date: string;          // 'YYYY-MM-DD'
  consumed_at: string;
  meal?: 'breakfast' | 'lunch' | 'dinner' | 'snack' | null;
  quantity_g: number;
  /** Computed = per_100g * quantity_g / 100, FROZEN at log time. */
  nutrients: NutrientPanel;
  source: FoodSource;
}
```

### 2.1 OFF → `FoodItem` mapping

```ts
export function offToFoodItem(res: OffProductResponse): FoodItem | null {
  if (res.status !== 1 || !res.product) return null;
  const p = res.product;
  const n = p.nutriments ?? {};

  // Total carbs (US convention). Prefer the explicit total; else net + fiber.
  const totalCarbs = n['carbohydrates-total_100g'];
  const netCarbs = n.carbohydrates_100g;
  const fiber = n.fiber_100g;
  const carbs = totalCarbs ?? (netCarbs != null ? netCarbs + (fiber ?? 0) : undefined);

  return {
    id: `off:${res.code}`,
    source: 'off',
    source_external_id: res.code,
    name: p.product_name?.trim() || `Unknown product ${res.code}`,
    brand: p.brands ?? null,
    barcode: res.code,
    per_100g: {
      energy_kcal: n['energy-kcal_100g'],
      protein_g: n.proteins_100g,
      carbs_g: carbs,
      sugar_g: n.sugars_100g,
      fat_g: n.fat_100g,
      saturated_fat_g: n['saturated-fat_100g'],
      fiber_g: fiber,
      // GRAMS -> MILLIGRAMS. The 1000x trap.
      sodium_mg: n.sodium_100g != null ? n.sodium_100g * 1000 : undefined,
      cholesterol_mg: n.cholesterol_100g != null ? n.cholesterol_100g * 1000 : undefined,
      potassium_mg: n.potassium_100g != null ? n.potassium_100g * 1000 : undefined,
      calcium_mg: n.calcium_100g != null ? n.calcium_100g * 1000 : undefined,
      iron_mg: n.iron_100g != null ? n.iron_100g * 1000 : undefined,
    },
    serving_size_g: p.serving_quantity ?? null,
    serving_label: p.serving_size ?? null,
    image_url: p.image_front_small_url ?? null,
    categories: p.categories_tags ?? null,
    quality: scoreOffQuality(p),
    carbs_derived: totalCarbs == null && netCarbs != null,
    fetched_at: new Date().toISOString(),
  };
}

/** Core macros present matter more than OFF's own completeness figure. */
function scoreOffQuality(p: OffProduct): number {
  const n = p.nutriments ?? {};
  const core = ['energy-kcal_100g', 'proteins_100g', 'fat_100g'] as const;
  const present = core.filter((k) => n[k] != null).length / core.length;
  const carbsOk = n.carbohydrates_100g != null || n['carbohydrates-total_100g'] != null;
  return Math.min(1, present * 0.7 + (carbsOk ? 0.2 : 0) + (p.completeness ?? 0) * 0.1);
}
```

---

## 3. The bundled offline seed database

> **Ownership note.** The `food-db` agent has claimed **I7 (seed food DB)** and the search half of **I8**, owning
> `src/data/foods/**`, `src/lib/food/**` and `docs/kg/specs/food-database.md` (see `channel/040-food-db.md`).
> **This section is a research input for them, not a competing implementation.** The licence analysis in §3.2 is the
> part that most needs to survive — it is a legal constraint, not a preference. If their spec and this one disagree on
> schema details, theirs wins.

### 3.1 Why it exists

Search must work instantly, on a plane, with zero network. It is also the answer to "OFF text search is deprecated and
messy" (§1.1) and to "OFF's coverage of plain whole foods is weak compared to its branded catalogue."

### 3.2 Source and licence — the decisive criterion

| Candidate | Licence | Verdict |
|---|---|---|
| **USDA FoodData Central** (SR Legacy + Foundation) | **US federal government work → public domain.** FDC states its data are not copyrighted and may be used freely, with attribution requested but not required. | **RECOMMENDED.** No share-alike, no attribution obligation, no redistribution constraint. |
| Open Food Facts | **ODbL 1.0 — SHARE-ALIKE.** | **Avoid for bundling.** ODbL's share-alike obligation attaches to derived databases. Bundling an OFF-derived dataset would impose licence obligations on our shipped artefact. Fine to *query at runtime*; problematic to *redistribute*. |
| CIQUAL (France) | Open Licence / Etalab — permissive with attribution | Viable alternative; French-language food names are a poor fit for a US/UK user. |
| CoFID (UK) | Open Government Licence — permissive with attribution | Viable; smaller and UK-centric. |
| FRIDA (Denmark) | Permissive with attribution `[UNVERIFIED]` | Danish naming; poor fit. |

**Decision: build the seed from USDA FoodData Central — SR Legacy and Foundation Foods.** Public domain, US-English
food names, strong coverage of whole/generic foods, and analytically-derived (not label-transcribed) values.

`[UNVERIFIED]` The exact wording of FDC's current licence/usage statement could not be fetched. **Confirm the licence
text and record it verbatim in the seed file's `license` field before shipping.**

### 3.3 Build-time pipeline (offline, not shipped)

FDC publishes full CSV/JSON bulk downloads — **no API key is required for the bulk files**, only for the live API. So the
seed can be built with no credential at all.

```
scripts/build-seed-food-db.ts   (dev-only, run manually, output committed)
  1. Download the FDC "SR Legacy" + "Foundation Foods" bulk CSV/JSON export.
  2. Filter to a curated allowlist of ~1,000 common foods
     (staples, proteins, produce, grains, dairy, fats, common prepared foods).
  3. For each, extract nutrients by ID (Appendix A):
       1008 kcal, 1003 protein, 1005 carbs, 1079 fiber,
       2000→1063 sugars, 1004 fat, 1258 sat fat, 1093 sodium,
       1253 cholesterol, 1092 potassium, 1087 calcium, 1089 iron
  4. Normalize: FDC Foundation/SR values are already PER 100 G. Sodium etc. already mg.
  5. Attach household portions from `foodPortions` where sensible.
  6. Shorten keys, round to 1-2 dp, drop nulls.
  7. Emit public/data/seed-foods.v1.json  (+ a .gz served with Content-Encoding)
```

**Curation is the hard part and it is a judgement call, not an algorithm.** ~1,000 hand-picked foods beat 7,800
auto-included ones, because SR Legacy contains a long tail of items ("Beef, chuck, arm pot roast, separable lean only,
trimmed to 1/8" fat, choice, cooked, braised") that pollute search results. Suggest seeding the allowlist from a
frequency list of commonly logged foods and iterating.

### 3.4 Size

Per row: id + name + ~8 numbers + optional aliases/portions ≈ **120–200 bytes** of minified JSON.

| Rows | Raw JSON | Gzipped (est.) |
|---|---|---|
| 500 | ~80 KB | ~25 KB |
| 1,000 | ~160 KB | ~45 KB |
| 1,500 | ~240 KB | ~65 KB |

`[UNVERIFIED]` — estimates, not measured. **At 1,000 rows this is roughly the weight of one medium photograph.** Ship it
as a plain JSON asset fetched once and inserted into IndexedDB on first run, rather than inlining it into the JS bundle
(keeps the critical-path bundle small and makes the seed independently cacheable/updatable).

### 3.5 Offline search strategy

At 1,000 rows, **do not reach for a search library.** A linear scan over 1,000 short strings is sub-millisecond, and any
index would cost more bytes than it saves.

```ts
/**
 * Token-prefix scoring over the seed DB. No dependencies, no index.
 * Rank: exact name > name starts-with > all query tokens prefix-match a name
 * token > alias match. Ties broken by shorter name (more generic food wins).
 */
export function searchSeed(foods: SeedFood[], query: string, limit = 20): SeedFood[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);

  const scored: Array<{ f: SeedFood; s: number }> = [];
  for (const f of foods) {
    const name = f.n.toLowerCase();
    let s = 0;

    if (name === q) s = 1000;
    else if (name.startsWith(q)) s = 500;
    else {
      const nameTokens = name.split(/[\s,()]+/).filter(Boolean);
      const allMatch = tokens.every((t) =>
        nameTokens.some((nt) => nt.startsWith(t)),
      );
      if (allMatch) s = 200;
      else if (f.a?.some((al) => al.toLowerCase().startsWith(q))) s = 150;
    }

    if (s > 0) scored.push({ f, s: s - Math.min(name.length, 99) / 100 });
  }

  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.f);
}
```

Normalize input (lowercase, strip accents via `String.prototype.normalize('NFD')` + combining-mark strip) before
matching. If the seed ever grows past ~5,000 rows, revisit with a prebuilt inverted index on 3-char prefixes — still no
external dependency needed.

---

## 4. Barcode scanning in mobile Safari on iPhone

### 4.1 `BarcodeDetector` — assume it does not exist

**Definitive guidance: treat `BarcodeDetector` as unavailable on iOS. Ship a WASM decoder as the PRIMARY path, not a
fallback.**

Evidence:
- WebKit does not implement the Shape Detection API in any shipping configuration. Since **all** iOS browsers are
  WebKit-backed, this covers Chrome/Firefox/Edge on iOS too.
- iOS 17 briefly exposed it behind *Settings → Safari → Advanced → Feature Flags → Shape Detection API*. That
  implementation **broke in iOS 18** and did not work even when enabled.
- The feature lists for **Safari 26.0, 26.2, 26.4 and 26.5** (the current 2026 line) were reviewed. **None mention
  BarcodeDetector or Shape Detection.**
- `[UNVERIFIED]` A hypothetical Safari 27 change could not be checked. Do not plan around it.

Correct feature detection — never `if ('BarcodeDetector' in window)` alone, since a present-but-useless implementation
may not support the formats we need:

```ts
async function nativeDetectorUsable(): Promise<boolean> {
  if (!('BarcodeDetector' in globalThis)) return false;
  try {
    const fmts = await (globalThis as any).BarcodeDetector.getSupportedFormats();
    return fmts.includes('ean_13') && fmts.includes('upc_a');
  } catch {
    return false;
  }
}
```

### 4.2 `getUserMedia` on iOS — the constraint list

- **HTTPS required** (or `http://localhost`). Without a secure context `navigator.mediaDevices` is `undefined` — check
  existence, don't try/catch.
- **User gesture required.** The permission prompt only appears from a user-initiated handler. Calling `getUserMedia`
  in a `useEffect` on mount silently fails. **Put it behind an explicit "Scan" button.**
- **`playsinline` is mandatory** on the `<video>`, or iOS hijacks playback into the fullscreen native player:
  ```html
  <video playsinline autoplay muted></video>
  ```
  Set `muted` **before** assigning `srcObject`, and still call and `catch` `video.play()`.
- **Rear camera:** `{ video: { facingMode: { ideal: 'environment' } } }`. Use `ideal`, **not `exact`** — `exact` throws
  `OverconstrainedError` on devices that report oddly.
- **Resolution:** `width: { ideal: 1280 }, height: { ideal: 720 }`. Higher is worse — 1080p+ costs frame time with no
  EAN-13 accuracy gain.
- **Torch/flash: NOT supported on iOS.** `getCapabilities()` doesn't advertise `torch`; `applyConstraints` fails.
  Platform-level, affects every iOS browser. **Do not render a torch button on iOS.**
- **`ImageCapture`: not supported on iOS.** No `grabFrame()`/`takePhoto()`. Draw the `<video>` to a canvas instead.
- **Zoom / focusMode / exposureMode: not supported on iOS.** Guard every `applyConstraints` behind a
  `getCapabilities()` check. No tap-to-focus, no zoom slider.
- **WKWebView / in-app browsers:** the old "Safari only" rule is **obsolete but conditional**. Since **iOS 14.3**
  `getUserMedia` is exposed to WKWebView, but only if the host app declares `NSCameraUsageDescription` and sets
  `allowsInlineMediaPlayback`. **Third-party in-app browsers (Instagram, Facebook, TikTok, LinkedIn) remain
  unreliable** `[UNVERIFIED for 2026]`. **Mitigation: detect in-app browsers by UA, prompt "Open in Safari", and always
  offer the file-input fallback (§4.7).**

### 4.3 Recommended decoder stack

```
barcode-detector/ponyfill   →  zxing-wasm reader build, SELF-HOSTED .wasm
```

| Library | Engine | Size | Verdict |
|---|---|---|---|
| **`zxing-wasm`** (Sec-ant) | ZXing-**C++** → WASM | reader ~**1.04 MiB** wasm | Best OSS 1D accuracy. Actively maintained. |
| **`barcode-detector`** (Sec-ant) | wraps `zxing-wasm` | same + thin JS | **Recommended.** Implements the `BarcodeDetector` interface, so one API surface. |
| `@zxing/library` + `@zxing/browser` | ZXing ported to JS | ~250–400 KB `[UNVERIFIED]` | Noticeably worse on blurry/angled 1D. |
| `html5-qrcode` | fork of ZXing-JS | ~300 KB+ `[UNVERIFIED]` | Weak on 1D. **Unmaintained.** Avoid. |
| `quagga2` | custom JS | ~200–300 KB `[UNVERIFIED]` | 1D only; decent historically, but not a 2026 primary. |

Use the **ponyfill**, not the polyfill: the polyfill defers to native `BarcodeDetector` when present, while the ponyfill
always uses WASM. Since native is absent on iOS and the ponyfill is more capable than Chrome's native detector anyway,
**always use the ponyfill** — one code path, identical behaviour everywhere, less to test.

**CSP / self-hosting — mandatory for us.** By default `zxing-wasm` fetches its `.wasm` from the **jsDelivr CDN** at
runtime. Our architecture forbids that (§6.2 of ARCHITECTURE.md: no CDN fetches, strict CSP), and it would break
offline. Override it:

```ts
import { prepareZXingModule } from 'barcode-detector/ponyfill';

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? '/wasm/zxing_reader.wasm' : prefix + path,
  },
});
```

(`setZXingModuleOverrides` is deprecated — use `prepareZXingModule`.) Serve with `Content-Type: application/wasm` and a
long-lived immutable cache header, and add `'wasm-unsafe-eval'` to the CSP `script-src`. **Warm the module** with a dummy
1×1 decode while the user is still tapping "Scan", so the ~1 MB fetch and compile overlaps the camera permission prompt.

### 4.4 Scan loop

- **Downscale.** Decode at **640×480**, not native resolution. EAN-13 bars are well resolved at 640px wide; 1080p roughly
  triples per-frame cost for no gain.
- **ROI crop — the single biggest win.** Render a wide, short viewfinder box (EAN-13 is ~2:1–3:1) and pass **only that
  region** via `drawImage`'s source-rect arguments. Typical ROI: full width × ~30% height, centred. Cuts decode work
  3–4× and removes background false positives. Make the on-screen guide match the ROI exactly, accounting for
  `object-fit: cover` letterboxing.
- **Throttle.** Prefer `video.requestVideoFrameCallback()` (fires only on genuinely new frames). Fall back to
  `requestAnimationFrame` with a self-imposed budget of **~8–12 decodes/sec**, and never start a decode while one is in
  flight (`if (busy) return;`). **Avoid `setInterval`** — it queues behind slow decodes and keeps firing when hidden.
- **Battery.** Back off to ~4 fps after ~10 s without a hit. Stop all tracks
  (`stream.getTracks().forEach(t => t.stop())`) on success, on `visibilitychange → hidden`, and on unmount. Hard 30–45 s
  timeout that surfaces the photo fallback.
- **`OffscreenCanvas` + Worker** is an optimization, not a requirement. Available in Safari from 16.4
  `[UNVERIFIED — feature-detect]`. You cannot pass a `MediaStream` to a worker; grab an `ImageBitmap` on the main thread
  and `postMessage` it as a transferable.

### 4.5 Accepting a read

- **Validate the EAN-13/UPC-A check digit client-side** before any network call. Free, instant, kills a class of misreads.
- **Require N-of-M agreement** — only accept a code after it decodes identically **2–3 times consecutively**. Cheap and
  removes almost all bad reads.
- **Debounce identical results** within ~2000 ms.
- On acceptance: stop the stream and give **visual + audible** confirmation. `navigator.vibrate` is **not supported on
  iOS** `[UNVERIFIED for 2026]` — never rely on haptics alone.

### 4.6 Barcode normalization before lookup

UPC-A (12 digits) is EAN-13 with a leading `0`. OFF generally stores EAN-13.

1. Strip whitespace; reject non-numeric.
2. Zero-pad a 12-digit UPC-A to 13 and **query that first**; fall back to the 12-digit form.
3. **Reject store-internal / weight-embedded codes** (EAN-13 prefixes `02` and `2x`) — not globally meaningful, and they
   will return wrong matches. Route these straight to manual entry.

### 4.7 Fallbacks — both are mandatory

**Photo fallback.** This is not optional on iOS:

```html
<input type="file" accept="image/*" capture="environment">
```

Opens the camera for a single photo; the resulting `File` goes straight into `detector.detect(file)` (the ponyfill
accepts `Blob`/`File`). Needs **no `getUserMedia`, no camera-permission dance**, and works inside every in-app browser.
Use it as the automatic fallback when live scanning is unavailable or denied, as an always-visible secondary action, and
as the recovery path after a scan timeout. Note `capture` is a hint — some contexts open the photo library instead,
which is fine.

**Manual entry.** A numeric field (`inputmode="numeric"`) with check-digit validation. Scanning fails on crumpled,
curved, glossy and shrink-wrapped packaging regardless of decoder quality.

---

## 5. Resolution order

```
barcode scanned
  └─ normalize + checksum
      ├─ vault cache hit?            → done, 0 requests
      ├─ seed DB barcode match?      → done, 0 requests (seed has few barcodes; whole foods rarely have them)
      └─ OFF /api/v2/product/{code}
            ├─ status 1 and core macros present → cache in vault, done
            ├─ status 1 but sparse  → show with a low-confidence flag + invite user to complete
            └─ status 0 / 429 / network error
                  └─ offer seed search, then manual entry
```

Manual "search by name" always queries the **seed DB first**, since it is instant and offline; OFF text search is not
wired up at all in v1 (§1.1).

**User overrides are permanent and authoritative.** If the user corrects a value, set `user_overridden` and never
overwrite it from a later fetch.

---

## Appendix A — USDA nutrient ID mapping (build-time only)

Retained for the seed-DB build script (§3.3). Verified against FDC's own `nutrient.csv` and live payloads.

| Nutrient | `id` (`nutrientId`) | `number` (string) | unit |
|---|---|---|---|
| Energy | **1008** | `"208"` | KCAL |
| Energy | 1062 | `"268"` | kJ |
| Energy (Atwater General) | 2047 | `"957"` | KCAL |
| Energy (Atwater Specific) | 2048 | `"958"` | KCAL |
| Protein | **1003** | `"203"` | G |
| Total lipid (fat) | **1004** | `"204"` | G |
| Carbohydrate, by difference | **1005** | `"205"` | G |
| Fiber, total dietary | **1079** | `"291"` | G |
| Sugars, total including NLEA | **2000** | `"269"` | G |
| Sugars, Total NLEA | 1063 | `"269.3"` | G |
| Sodium, Na | **1093** | `"307"` | MG |
| Fatty acids, total saturated | **1258** | `"606"` | G |
| Cholesterol | **1253** | `"601"` | MG |
| Calcium, Ca | 1087 | `"301"` | MG |
| Iron, Fe | 1089 | `"303"` | MG |
| Potassium, K | 1092 | `"306"` | MG |

**Notes for the build script:**

- **`nutrientNumber` is a STRING** — `"269.3"` has a decimal. Never type it as a number.
- **Sugars is messy.** `2000`/`"269"` ("Sugars, total including NLEA") is what Branded and SR use; Foundation reports
  `1063`/`"269.3"` ("Sugars, Total NLEA"). **Match `2000` first, fall back to `1063`.**
- **Energy can appear up to four times on one food** with different values. Resolution order:
  **1008 → 2048 → 2047 → (1062 ÷ 4.184)**.
- `unitName` casing is inconsistent between endpoints (`"KCAL"` vs `"kcal"`). **Compare case-insensitively.**
- In the food-detail response the outer `id` on a `foodNutrients[]` entry is the *food-nutrient row id*, **not** the
  nutrient id. Always read `nutrient.id`. This is the classic bug.
- Foundation/SR `foodNutrients` are **per 100 g** — exactly what the seed needs, no conversion.

### A.1 If USDA is ever reinstated as a runtime path

It would require a proxy to hold the API key, which this architecture forbids. Recorded only so the decision is
traceable: `POST /fdc/v1/foods/search` with `{query: <barcode>, dataType: ["Branded"]}`, then verify `gtinUpc` with
zero-padding-tolerant comparison. Branded `foodNutrients` are **per 100 g** while `labelNutrients` are **per serving**
(`per100g = labelValue / servingSize * 100`) — mixing them is a silent, large error. And `labelNutrients.postassium` is
misspelled in the API itself, in both the spec and live data.

---

## Sources

- [Open Food Facts API documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/) (read via GitHub mirror)
- [OFF API cheatsheet](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-cheatsheet/)
- OFF schemas `docs/api/ref/schemas/product_nutrition.yaml`, `product_base.yaml`, `nutrients.yaml`
- [Nutrients handling in Open Food Facts (wiki)](https://wiki.openfoodfacts.org/Nutrients_handling_in_Open_Food_Facts)
- [openfoodfacts/search-a-licious](https://github.com/openfoodfacts/search-a-licious)
- [Are there conditions to use the API? (OFF support)](https://support.openfoodfacts.org/help/en-gb/12-api-data-reuse/94-are-there-conditions-to-use-the-api)
- [MDN: Forbidden header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)
- [USDA FoodData Central API Guide](https://fdc.nal.usda.gov/api-guide/) and OpenAPI spec; FDC `nutrient.csv`
- [MDN: BarcodeDetector](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector) · [caniuse](https://caniuse.com/mdn-api_barcodedetector)
- [Apple Developer Forums — Shape Detection API, Safari 18.x](https://developer.apple.com/forums/thread/767761)
- WebKit release notes: [Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/), [26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/), [26.5](https://webkit.org/blog/17938/webkit-features-for-safari-26-5/)
- [WebKit bug 208667 — getUserMedia in WKWebView](https://bugs.webkit.org/show_bug.cgi?id=208667)
- [Sec-ant/barcode-detector](https://github.com/Sec-ant/barcode-detector) · [zxing-wasm](https://www.npmjs.com/package/zxing-wasm)
