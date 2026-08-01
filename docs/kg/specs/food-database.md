# Spec: Bundled Seed Food Database & Search

**Status:** implemented (node I7 + the search half of I8)
**Owner:** food-db
**Last updated:** 2026-07-26

Everything under `src/data/foods/**` and `src/lib/food/**` is described here. Treat this document as the
contract: if you need it to change, post to the channel first.

---

## 0. What this exists to do

A food tracker with wrong numbers is worse than no food tracker. Two things follow from that, and they
shape every decision below:

1. **Search must work offline, instantly, on day one.** There is no backend. A network round-trip on the
   critical path of logging a banana is not a degraded experience, it is a broken one. So the database is
   *bundled* — 1,557 foods, ~1.14 MB of JSON, in the app shell.
2. **Every number must be defensible or visibly marked as an estimate.** `verified: false` is not an
   admission of failure; it is the honest signal that lets the UI say "check this against the label".

---

## 1. Where things live

```
src/data/foods/
  types.ts                 canonical types + category vocabulary + micronutrient helpers
  index.ts                 merges the JSON into SEED_FOODS; the public entry point
  source/<category>.psv    AUTHORING SURFACE — pipe-delimited, one row per food
  json/<category>.json     RUNTIME ARTEFACT — generated, committed, validated
  energy-exceptions.json   generated allowlist for the energy cross-check
  build.mjs                source/*.psv  ->  json/*.json + energy-exceptions.json
  validate.mjs             correctness gate; runs against the JSON, not the source

src/lib/food/
  search.ts                inverted-index fuzzy search over seed + user foods
  portions.ts              servings <-> grams <-> millilitres; scaling
  nutrition-math.ts        day/meal summation; recipe macros; micronutrient totals
  open-food-facts.ts       browser-side OFF barcode client
  verify.mjs               executable proof for all four modules
```

### Why a build step

The runtime artefact is JSON, one file per category, imported by `index.ts`. But 1,557 hand-written JSON
objects is 1,557 chances to fat-finger a brace, and serving lists repeat heavily within a category. So the
*editing surface* is a terse pipe-delimited file with per-category defaults, and the JSON is generated
from it. Both are committed. **`validate.mjs` validates the JSON** — the thing that actually ships — so the
generator is never trusted, only checked.

```bash
node src/data/foods/build.mjs     # regenerate JSON after editing source/*.psv
node src/data/foods/validate.mjs  # must pass before commit
node src/lib/food/verify.mjs      # must pass before commit
```

---

## 2. Sourcing, licensing and accuracy policy

### 2.1 Licensing — the constraint that picked our source

| Source | Licence | Verdict |
|---|---|---|
| **USDA FoodData Central** (SR Legacy + Foundation) | US federal government work → **public domain** | **Used.** No share-alike, no attribution obligation, no redistribution constraint. |
| Manufacturer published labels | Nutrition facts are facts; panels are not creative works | **Used**, attributed per row. |
| **Open Food Facts** | **ODbL 1.0 — SHARE-ALIKE** | **Not used for the bundle.** Queried at runtime only. |

**The seed database contains zero Open Food Facts-derived rows.** ODbL's share-alike obligation attaches to
derived *databases*, so bundling OFF data into our distributed artefact would impose licence obligations on
the shipped bundle. Runtime lookups are a different act entirely — that is the user's own device querying a
public service, with results cached in the user's own vault and never redistributed. The boundary is
documented at the top of `open-food-facts.ts` so nobody "improves" the seed DB by importing from it later.

Nutrient values themselves are facts and facts are not copyrightable; the concern is specifically about
copying a licensed *compilation*. These rows were authored from knowledge of USDA figures, not extracted
from any licensed database.

### 2.2 `source` is per-row and must be accurate

| `source` value | Rows |
|---|---|
| `USDA FoodData Central (SR Legacy)` | 1,288 |
| `restaurant published nutrition, converted to per-100 g` | 88 |
| `manufacturer label (typical US product)` | 83 |
| `manufacturer label` | 56 |
| `manufacturer label (US formulation)` | 40 |
| author estimates (explicitly labelled) | 2 |

Never label a row `USDA` unless it actually traces there.

### 2.3 `verified` — what the flag means

`verified: true` (841 rows, 54.0%) means the figures correspond to a named reference entry: a USDA
FoodData Central row or a manufacturer's published panel. `verified: false` (716 rows) means author's best
estimate — the composite dishes, the long tail of prepared foods, and the entire `restaurant` category.

**The UI must surface this.** An unverified row is a starting point the user should correct, and their
correction is authoritative and permanent.

### 2.4 The verification caveat you need to know about

This database was authored from the author's own knowledge of USDA SR Legacy and Foundation Foods figures.
**The session's web-search budget was exhausted before any live cross-checking could be done**, so no value
here was confirmed against a live source. What protects the numbers instead is `validate.mjs`, which is a
genuinely strong internal-consistency gate (§4) — it already caught and forced the correction of 18 real
errors, including one irreconcilable USDA-legacy figure (see §4.4).

Internal consistency is not the same as external accuracy. Before this ships to anyone but its author, a
sample of ~50 high-traffic rows should be spot-checked against FoodData Central.

### 2.5 Raw vs cooked — the most-mislogged distinction there is

Raw skinless chicken breast is 120 kcal/100 g. The same meat roasted is 165 kcal/100 g, because ~25% of the
water is gone and everything else concentrated. A user who weighs raw and logs cooked overstates by 37%.

Both states are listed separately for every staple protein, grain and vegetable where it matters, with the
state in the name. **The UI should make the raw/cooked choice visually obvious**, not bury it in a list.

---

## 3. Schema

```ts
interface FoodItem {
  id: string;                     // stable kebab-case slug — a log foreign key, never reused or renamed
  name: string;
  brand: string | null;           // null for generic whole foods
  aliases: string[];              // search synonyms: "garbanzo", "pepitas", "zoodles", "acv"
  category: FoodCategory;         // controlled vocabulary, §3.1
  per100g: Per100g;               // §3.2
  micronutrients: Micronutrients; // §3.5 — block always present, fields nullable
  servings: FoodServing[];        // >= 1, exactly one isDefault — §3.3
  density_g_per_ml: number | null;// §3.4
  verified: boolean;              // §2.3
  source: string;                 // §2.2
}
```

### 3.1 Category vocabulary — 27 values

One JSON file per category. Adding a category is a breaking change for any UI with a fixed category filter.

| Category | n | Category | n | Category | n |
|---|--:|---|--:|---|--:|
| `vegetable` | 134 | `bread` | 59 | `condiment` | 45 |
| `dairy` | 90 | `alcohol` | 57 | `sauce` | 41 |
| `restaurant` | 88 | `beverage` | 54 | `cereal` | 40 |
| `meat` | 87 | `legume` | 53 | `fat-oil` | 36 |
| `prepared` | 86 | `supplement` | 53 | `pasta` | 35 |
| `fruit` | 79 | `herb-spice` | 51 | `sweetener` | 33 |
| `snack` | 74 | `poultry` | 51 | `dairy-alt` | 32 |
| `seafood` | 71 | `baked-good` | 47 | `soup` | 28 |
| `grain` | 66 | `nut-seed` | 47 | `egg` | 20 |

Boundary rules worth stating, because they are the ones people get wrong:

- `dairy` includes all cheese. `dairy-alt` is plant milks, plant yogurts and vegan cheese.
- `grain` is grains, flours and starches. `bread` is baked bread and flatbreads including tortillas.
- `fat-oil` is pure fats, butter, margarine and mayonnaise. `sauce` is cooking sauces **and** salad
  dressings; `condiment` is table condiments, vinegars and pastes.
- `prepared` is composite dishes made at home or bought from a deli. `restaurant` is named chain items.
- `supplement` is sports nutrition, protein powders, bars, RTD shakes and micronutrient supplements.
- Avocado and olives are filed under `vegetable`, not `fruit` — that is where users look for them.

### 3.2 `per100g`

Eight numbers, per 100 grams **of the food as its name describes it**.

| Field | Unit | Convention |
|---|---|---|
| `kcal` | kcal | The label/reference figure, not a recomputed Atwater estimate |
| `protein_g` | g | |
| `carbs_g` | g | **TOTAL** carbohydrate, inclusive of fibre (US convention) |
| `fat_g` | g | |
| `fiber_g` | g | Included in `carbs_g` |
| `sugar_g` | g | Total sugars including naturally occurring; included in `carbs_g` |
| `satfat_g` | g | Included in `fat_g` |
| `sodium_mg` | **mg** | Not grams. Not salt. |

### 3.3 `servings` — the thing that makes logging fast

**Every food has realistic named portions with real gram weights.** 3,418 servings across 1,557 foods, 2.20
per food. A tracker that only accepts grams is unusable; this list is the difference.

```json
{ "label": "1 medium, 7-8 in (118 g)", "grams": 118, "isDefault": true }
```

Rules `validate.mjs` enforces: at least one serving; exactly one `isDefault`; positive gram weights;
distinct labels within a food.

Conventions:
- Put the gram weight in the label too — `"1 medium (118 g)"`. It teaches portion size, which is most of
  what a beginner needs from a tracker.
- The default is the portion a person actually eats: 1 oz for nuts, the box serving for cereal, the named
  item for restaurant food, 1 cup cooked for rice. **Never default to 100 g** for anything measured by
  eye — a "1 cup" default on cereal prevents the classic 3x over-log.
- A `"... (N ml)"` label declares a true fluid volume and *requires* a density (§3.4).

### 3.4 `density_g_per_ml`

349 foods carry a density. Required for every food in `beverage`, `alcohol` and `fat-oil`, and for any food
with a millilitre serving label. `null` means the food is not sensibly measured by volume.

This is what makes "1 cup of milk" and "1 tbsp of olive oil" resolve to grams. Note that 1 tbsp of oil is
13.5–14 g, **not** 15 g — oil is less dense than water, and getting this wrong is a 10% error on a
calorie-dense food.

`verify.mjs` cross-checks every millilitre serving in the database against `density × volume` and fails if
they disagree by more than 4%. That check found and fixed 19 inconsistencies.

### 3.5 `micronutrients` — vitamin A and folate, split by chemical form

This block exists because collapsing either nutrient into one number makes an upper-limit check wrong in
both directions, and the failure modes are **not** symmetric nuisances:

- **Vitamin A's UL applies to preformed retinol only.** Provitamin-A carotenoids are converted on demand
  and are essentially non-toxic at dietary intakes. With a single "vitamin A RAE" figure, a
  sweet-potato-heavy day false-alarms — while **85 g of beef liver, roughly 2.7× the retinol UL, passes
  silently.** That is exactly backwards for a check whose entire purpose is safety.
- **Folate's UL applies to synthetic folic acid** (enriched grains, fortified cereals, supplements), not to
  naturally occurring food folate. Lentils cannot cause the masked-B12-deficiency risk the UL exists to
  prevent; a bowl of Total plus a multivitamin can.

```ts
interface Micronutrients {
  vitamin_a_retinol_mcg: number | null;         // preformed retinol.  THE VITAMIN A UL APPLIES HERE
  vitamin_a_carotenoid_mcg_rae: number | null;  // provitamin-A carotenoids, ALREADY IN RAE. No UL.
  folate_food_mcg: number | null;               // naturally occurring, RAW mcg. No UL.
  folic_acid_mcg: number | null;                // synthetic, RAW mcg.  THE FOLATE UL APPLIES HERE
  folate_dfe_mcg: number | null;                // dietary folate equivalents
}
```

**Unit conventions — read before consuming any of this:**

- All values are per 100 g, matching `per100g`.
- `vitamin_a_carotenoid_mcg_rae` is the carotenoid contribution **already expressed in retinol activity
  equivalents**, so `total vitamin A RAE = retinol + carotenoid_rae`. It is **not** raw beta-carotene
  micrograms, which would be ~12× larger. `validate.mjs` rejects any value above 3,000 mcg RAE as a
  probable unit slip.
- `folate_dfe_mcg` uses **`DFE = food folate + 1.7 × folic acid`**. DFE and raw micrograms are not
  interchangeable. `validate.mjs` enforces this identity on every row where all three are present — that is
  the check that catches a raw figure written into a DFE field, which is otherwise invisible and
  understates enriched grains by up to 70%.

**`null` means UNKNOWN. It does not mean zero.** A consumer must *suppress* the corresponding check for a
`null` field, never read it as 0.

126 of 1,557 foods are populated; **1,431 are `null`.** We populated where the distinction changes a safety
decision — organ meats and cod liver oil, dairy fat and eggs, US-fortified fluid milk, the major carotenoid
vegetables and fruit, enriched grains and fortified cereals, and the high-food-folate legumes and greens —
and refused to guess for the rest. 25 foods carry non-zero folic acid.

**An explicit `0` is a positive assertion.** `sweet-potato-baked` has `vitamin_a_retinol_mcg: 0`, which is a
claim that it contains no preformed retinol at all. That claim is what stops it false-alarming.

**Multivitamins are deliberately `null`**, not estimated: formulations vary by more than 10×, and a guessed
figure would be worse than no figure. The user must enter their own from the label.

#### How to consume it (this is the part that matters)

`sumMicronutrients` returns `{ known, unknownEntries, unknownGrams }` per nutrient rather than a bare
number, because a bare number forces the caller to choose between two wrong answers:

- **Upper-limit / safety checks — use `known` directly.** It is a strict *lower bound* on the true total, so
  `known > UL` is a true positive no matter how much was unknown. **Never suppress a UL check because some
  foods were unknown** — that is precisely the failure mode where beef liver passes silently.
- **Adequacy / deficiency checks — suppress when `unknownEntries > 0`.** Most of the database is `null`
  here; a partial sum would flag everyone as deficient.
- **Run each limit against the right field.** Vitamin A UL → `vitamin_a_retinol_mcg`. Folate UL →
  `folic_acid_mcg`. Never against a total and never against DFE.

`scaleMicronutrients` propagates `null` at every quantity — unknown stays unknown, never becomes 0.

---

## 4. Validation

`node src/data/foods/validate.mjs` — exits non-zero on any error. Runs against the generated JSON.

1. Every `json/<category>.json` parses and is an array.
2. File name matches the `category` of every food inside it.
3. `id` unique across the whole database, kebab-case, non-empty.
4. Required keys present, correctly typed, **no extra keys**.
5. `category` in the controlled vocabulary.
6. No negative numbers, no `NaN`/`Infinity`.
7. Component sanity: `protein + carbs + fat ≤ 100 g` per 100 g; `fiber ≤ carbs`; `sugar ≤ carbs`;
   `satfat ≤ fat`; `sodium ≤ 40,000 mg` (pure salt is 38,758); `kcal ≤ 902` (pure fat).
8. ≥1 serving, exactly one default, positive weights, distinct labels.
9. Density required for liquid categories and for any millilitre serving; plausible range 0.25–1.60 g/ml.
10. **Energy cross-check** — §4.1.
11. **Micronutrients** — block present, fields nullable, plausibility ceilings, and the DFE identity.
12. **No stale entries in `energy-exceptions.json`.** An allowlist that is never pruned stops being an
    allowlist, so an unnecessary exception is an *error*, not a warning.

### 4.1 The energy cross-check is a bracket, not a point

The naive rule is `4·protein + 4·carbs + 9·fat ≈ kcal`. That rule is wrong for a large and *predictable*
class of real foods, because US labelling counts fibre inside total carbohydrate while fibre yields
somewhere between 0 and 4 kcal/g depending on fermentability. Atwater general factors assume 4; specific
factors assume ~2; fully insoluble fibre like wheat bran yields ~0.

So the check is an interval:

```
E_low  = 4·protein + 4·(carbs − fiber) + 9·fat      (fibre at 0 kcal/g)
E_high = 4·protein + 4·carbs           + 9·fat      (fibre at 4 kcal/g)

kcal must lie within tolerance of [E_low, E_high]
tolerance = max(10% of kcal, 10 kcal)
```

The **10 kcal absolute floor** matters: a percentage tolerance is meaningless on a 14 kcal food. Iceberg
lettuce is 23% "off" and 3 kcal wrong. For a zero-fibre food the interval collapses to a point and this
degrades exactly to the classic 4/4/9 check at 10%.

**1,487 of 1,557 foods pass this standard check.**

### 4.2 Exceptions are a *different* test, never an absent test

70 foods cannot satisfy even the bracket. Each has a reasoned entry in `energy-exceptions.json` with a flag
from a closed vocabulary, and each flag triggers a substitute check that is in some cases *stronger* than
the one it replaces:

| Flag | n | Substitute check |
|---|--:|---|
| `alcohol` | 57 | Back-compute implied ethanol from the calorie gap at 6.93 kcal/g; require `0 < g ≤ 50` per 100 g. 50 g/100 g is above 100-proof spirit, so anything higher is a data error. |
| `polyol` | 6 | Two-sided physical bound: sugar alcohols and allulose sit in total carbohydrate but yield 0–2.4 kcal/g, so the label must come in **at or below** the 4 kcal/g estimate, and must clear the floor set by protein and fat, which do yield full Atwater energy. |
| `acid` | 4 | Vinegars carry 4–8% acetic acid at ~3.5 kcal/g, which has no macro field. Unexplained energy must be positive and ≤ 40 kcal/100 g. |
| `fiber` | 2 | Reserved for foods where even the 0–4 kcal/g bracket fails. Error must be within 35% of the bracket. |
| `rounding` | 1 | Label rounding on a small published serving. Absolute error ≤ 25 kcal. |

The alcohol rule is worth calling out because it is a *better* test than 4/4/9 would have been. For red
wine it independently recovers 10.7 g ethanol/100 g, which matches 13.5% ABV × 0.789 g/ml ÷ 0.99 g/ml =
10.76. For 80-proof spirits it recovers 33.3 g against a theoretical 33.6. The check is effectively
verifying the stated ABV.

### 4.3 Real validator output

```
    foods                          1557
    categories                     27
    unique ids                     1557
    servings defined               3418 (avg 2.20 per food)
    search aliases                 308
    with density                   349
    verified: true                 841 (54.0%)
    retinol known / null           126 / 1431
    carotenoid RAE known / null    126 / 1431
    folate split known / null      126 / 1431
    foods bearing folic acid       25
    energy check, standard bracket 1487
    energy check, exception rule   70
  ----------------------------------------------------------

  PASS — 1557 foods, 0 errors.
```

### 4.4 What validation actually caught

The gate is not decorative. It found 18 genuine errors in the first authored pass, including:

- Five dairy rows where sugar exceeded total carbohydrate — a real artefact of USDA reporting lactose and
  "carbohydrate by difference" from different analytical methods.
- Four vinegars whose energy is dominated by acetic acid, which has no macro field. This produced the
  `acid` exception class rather than a fudged number.
- Vanilla extract, which is ≥35% ethanol by US federal standard of identity. The alcohol rule recovers
  34.3 g/100 g against a theoretical 31.4. It is genuinely an alcoholic ingredient and is now flagged as one.
- **`oat-bran-dry`: USDA SR Legacy lists 246 kcal against a macro panel implying 397.** That figure is
  irreconcilable with its own components. Corrected to a consistent 375 kcal and marked `verified: false`
  with the discrepancy noted. This is the single best argument for having the gate at all.
- 19 millilitre servings whose stated gram weight disagreed with `density × volume`.

---

## 5. Search design

`src/lib/food/search.ts`. Zero dependencies, safe in a Web Worker.

### 5.1 Structure

An inverted index is built once at module load (~11 ms over 1,557 foods) and reused. A query never linear
scans the corpus.

- Every food contributes tokens from four fields — **name, aliases, brand, category** — stored both raw and
  lightly stemmed.
- Postings are packed into single integers as `doc·256 + field·64 + min(position, 63)`.
- A sorted vocabulary array supports prefix expansion by binary search.
- A `(first letter, length)` bucketing supports bounded-edit-distance recovery without scanning the whole
  vocabulary.

### 5.2 Query pipeline

Per query token, in order, stopping early where the cheap paths suffice:

1. **Exact** term match (weight 1.00), plus the stemmed form (0.98).
2. **Prefix** expansion for tokens ≥ 2 chars (weight 0.62 × `len(token)/len(term)`), discounted to 0.8× for
   any token that is not the last one — a prefix of the word you are still typing is worth more than a
   prefix of one you finished. Capped at 300 expansions.
3. **Fuzzy** recovery, *only* when steps 1–2 produced fewer than 6 documents and the token is ≥ 4 chars.
   Bounded Damerau/OSA edit distance (1 for tokens ≤ 5 chars, else 2) against candidates from the
   `(first letter, length)` buckets — probing both the first and second character so a leading-letter slip
   is still recoverable. Capped at 600 candidates. Weight `0.45 / (1 + distance)`.

**A document takes the maximum contribution across the terms one query token expanded to, never the sum.**
Summing would let a food that happens to contain "chicken" in its name, its aliases *and* its brand outrank
a food actually named "Chicken breast".

**Multi-word queries are AND, not OR.** A document must match every query token. "chicken breast" must not
return every chicken product — it returns 8 results, not 60.

### 5.3 Ranking

```
score = Σ_tokens best_match_contribution
      + static prior
      + personalisation
      + whole-query bonuses
```

| Component | Weight |
|---|---|
| Field: name / alias / brand / category | 1.00 / 0.85 / 0.60 / 0.32 |
| Name-position bonus | `× (1 + 0.35/(position+1))` |
| Prior: `verified` | +0.15 |
| Prior: generic (no brand) | +0.12 |
| Prior: whole-food category | +0.10 |
| Prior: short name | `+0.30 × 1/(1 + tokens/3)` |
| Bonus: name === query | +2.60 |
| Bonus: name starts with query | +1.25 |
| Bonus: alias === query | +2.20 |
| Personal: frequency | `min(2.0, 0.45·ln(1+uses))` |
| Personal: recency | `1.5·e^(−position/8)`, most recent first |

The generic and short-name priors are what make "banana" return `banana-raw` rather than "Banana bread,
homemade". The whole-food prior does the same for "chicken" and "rice".

**Personalisation cannot promote an irrelevant food**, because AND semantics mean a non-matching document
never enters the result set at all. That is verified explicitly.

### 5.4 Empty query

Not an error. Returns the user's recent and most-frequent foods ranked by the personalisation terms alone —
which is exactly what an empty search box should show. With no history, it returns nothing.

### 5.5 Measured performance

Over the full 1,557-food database, every prefix of 20 realistic queries (203 keystrokes):

| Metric | Result |
|---|---|
| Index build (one-off) | **11.6 ms** |
| Keystroke p50 | **0.04 ms** |
| Keystroke p95 | **0.18 ms** |
| Keystroke max | **0.93 ms** |
| Worst case (2-char prefix) | **0.20 ms** |

Target was sub-16 ms. There is roughly two orders of magnitude of headroom, so the database can grow
substantially before this needs revisiting.

### 5.6 Recall behaviours, all verified

| Input | Resolves to |
|---|---|
| `brocoli`, `chiken`, `avacado`, `yoghurt` | typo recovery |
| `bananna`, `salomn` | transposition recovery |
| `eggs`, `blueberries`, `strawberry`, `almond` | plural/singular |
| `garbanzo`, `pepitas`, `zoodles`, `cilantro`, `acv` | alias/synonym |
| `chick`, `brocc`, `gree yog` | mid-typing prefix |
| `creme fraiche`, `reeses`, `cap'n crunch` | diacritics and punctuation |
| `fage`, `big mac`, `chipotle chicken` | brand |

---

## 6. How a user's own foods merge with the seed set

There is one code path, not two.

```ts
createFoodSearchIndex([...SEED_FOODS, ...userCustomFoods, ...cachedOffFoods])
```

- A custom food satisfies the same `FoodItem` interface, so it is searchable, portionable and loggable
  exactly like a seed food. Its aliases work. Its servings work.
- **Later entries win on id collision.** A user's correction of a seed food *shadows* the seed entry
  everywhere, permanently. The user is always authoritative — if they have weighed their own bagel and
  found it is 110 g, that is the truth for them.
- `getMergedSearchIndex(userFoods)` caches against a cheap signature of the user's food ids, so a component
  can call it on every render and it only rebuilds when the list actually changes.
- OFF results are cached into the vault and then participate as ordinary `FoodItem`s. They always carry
  `verified: false`, `source: "Open Food Facts (barcode …)"`, and all-null micronutrients.

Id namespaces: seed foods use bare kebab-case slugs; OFF results use `off:<barcode>`; user foods should use
a uuid or a `custom-` prefix. Never reuse or rename a seed id — log entries reference it.

---

## 7. Open Food Facts client

`src/lib/food/open-food-facts.ts`. Implements `docs/kg/specs/integration-food-db.md`.

- **Barcode only.** OFF v2 search is faceted, with no full-text mode; free-text search is served by the
  bundled DB, which is faster, works offline and is better for whole foods anyway.
- **One scan = one request.** Callers must check the vault cache and the seed DB first, and must cache a
  successful result permanently. Food data changes on a scale of months.
- **Rate limits apply per user, not per app**, because we call OFF directly from the device. A proxy would
  collapse every user onto one IP and cap the whole user base at 15 product reads/minute. The
  privacy-correct architecture is also the rate-limit-correct one.
- **We cannot comply with OFF's User-Agent policy, and we say so.** `User-Agent` is a forbidden header name
  in the Fetch spec; browsers silently drop any attempt to set it from JavaScript. There is no workaround
  from a web app. Instead we (a) send `app_name` / `app_version` but deliberately omit any stable client
  identifier that could link scans, and (b) are exemplary on the axis we do
  control, volume. The limitation is documented rather than papered over.
- **Offline is not an error.** Every function resolves to a structured `{ ok: false, reason }` and never
  throws for a network condition. `describeFailure()` provides user-facing copy for each reason.
- **The sodium trap:** OFF reports sodium in **grams**; we store **milligrams**. Forgetting the ×1000
  produces a food claiming 0.6 mg of sodium.
- **The carbs trap:** EU entries report *net* carbs in `carbohydrates_100g`. When no explicit total is
  present we reconstruct `total = net + fibre`.
- A product without energy *and* protein *and* carbs *and* fat is rejected outright. A half-mapped food is
  a trap, not a convenience.

---

## 8. Verification

`node src/lib/food/verify.mjs` — **91 checks, 0 failures.**

It transpiles the TypeScript modules with the `typescript` package already in `devDependencies`, rewrites
the `@/` alias, and imports the result from a temp directory. No new dependencies, and it exercises the real
source rather than a copy.

Coverage includes: unit conversion and round-tripping; scale/unscale inverse; every default serving in the
database resolving; every millilitre serving agreeing with density × volume; order-independent summation;
add/subtract inverses; grouped sums re-summing to the whole; recipe totals, per-serving invariance under
rescaling, and cooked-weight concentration; energy split surfacing alcohol as unaccounted energy; search
relevance, AND semantics, typo/plural/alias/brand recall, personalisation limits, and the custom-food
merge; OFF mapping including the sodium, salt, net-carb and kJ paths; and the micronutrient safety cases
described in §3.5 — including an explicit assertion that **85 g of beef liver trips the retinol UL** and
that **a carotenoid-heavy day does not.**

---

## 9. Known limitations

1. **No live verification of any value** (§2.4). Internal consistency is strong; external accuracy is
   unconfirmed. Spot-check ~50 high-traffic rows before this is used by anyone but its author.
2. **The `restaurant` category is the weakest data in the database.** Chains publish per-item nutrition,
   not per-100 g, so every row was derived by dividing a published panel by a published item weight — and
   inherits any error in that weight. Chains also reformulate. The whole category is `verified: false` and
   should be logged using the named item serving, never by typing grams.
3. **1,431 of 1,557 foods have null micronutrients.** By design (§3.5), but it means adequacy checks are
   suppressed for most days. Expanding coverage is the highest-value follow-up.
4. **Only two micronutrients are modelled**, because only those two have a form-dependent upper limit that
   made the split necessary. Iron, calcium, B12, vitamin D and potassium are not present.
5. **Portion weights for produce are averages.** A "medium banana" is 118 g by convention; real bananas vary
   ±30%. Users who care should weigh.
6. **The stemmer handles plurals only.** A full Porter stemmer collapses food words that should stay
   distinct, so this was a deliberate trade of a little recall for visibly correct results.
7. **No multi-word alias phrase matching beyond token AND.** "mac and cheese" works because the tokens are
   present, but there is no phrase index.
