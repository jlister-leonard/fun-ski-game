import type { NutrientDefinition } from '@/lib/algorithms';

/**
 * @file The nutrient reference values the diary needs, extracted from the spec.
 *
 * ## Why this is an extract rather than an import
 *
 * The authoritative table is `docs/kg/specs/micronutrients.json`, owned by the
 * nutrition-personalization agent. The obvious implementation imports that file
 * directly, and the first version of this module did.
 *
 * It has to be an extract for one concrete reason: every nutrient in that file
 * carries a `sources` array of citation URLs — `ods.od.nih.gov`,
 * `www.ncbi.nlm.nih.gov`, `www.efsa.europa.eu` and others. Importing the file
 * puts those hostnames in the shipped bundle, and `scripts/privacy-audit.mjs`
 * fails the build on any unrecognised outbound host. The audit is right to: a
 * host string in the bundle is indistinguishable, to a scanner, from a host the
 * app might call. The architecture's central promise is that health data never
 * leaves the device, and the check that enforces it is worth more than the
 * convenience of a wildcard import. (It would also have shipped ~65 KB of prose
 * to render two progress bars.)
 *
 * ## What stops this drifting from the spec
 *
 * A test. `__tests__/nutrition-diary.test.ts` reads
 * `docs/kg/specs/micronutrients.json` from disk — at test time, so nothing is
 * bundled — and asserts that every field below matches the spec's value
 * exactly. Change a DRI or an upper limit in the spec and this file fails until
 * it is updated. That is the same arrangement the algorithms test uses, and it
 * is the reason no number here is "remembered": each was copied under a check.
 *
 * The fields dropped are the ones the diary does not read: prose notes, the
 * `primaryFoodSources` tables, and the citations. The test asserts the retained
 * set is complete with respect to what `assessNutrient()` consumes.
 *
 * ## What is actually assessable from a food log
 *
 * Two of the spec's 28 nutrients, because those are the only two the bundled
 * food database carries: vitamin A and folate — each split by chemical form,
 * because each has an upper limit that applies to only one of its forms. Fibre
 * is here for its DRI, which gives the adequacy panel a floor even when there
 * is no energy target to scale it against.
 *
 * The diary says so rather than rendering 26 nutrients at "0% of reference",
 * which would be both wrong and, for this user, harmful.
 */

/** The keys copied from the spec. The test asserts this list is exhaustive. */
export const EXTRACTED_FIELDS = [
  'id',
  'name',
  'category',
  'unit',
  'referenceType',
  'reference',
  'referenceBasis',
  'upperLimit',
  'upperLimitBasis',
  'riskWithoutVegetables',
  'supplementCloseability',
  'trackingPriority',
] as const;

/**
 * Vitamin A.
 *
 * Reference is total retinol activity equivalents; the upper limit is
 * **preformed retinol only**. That asymmetry is the whole reason this nutrient
 * is modelled with a form discriminator: a single "vitamin A RAE" number makes
 * a sweet-potato-heavy day false-alarm while 85 g of beef liver — roughly twice
 * the limit on its own — passes silently. That is the wrong way round for a
 * check whose entire purpose is safety.
 */
export const VITAMIN_A: NutrientDefinition = {
  id: 'vitamin_a',
  name: 'Vitamin A',
  category: 'fat-soluble-vitamin',
  unit: 'mcg RAE',
  referenceType: 'RDA',
  reference: {
    male: [{ minAge: 19, maxAge: 200, value: 900 }],
    female: [{ minAge: 19, maxAge: 200, value: 700 }],
  },
  upperLimit: {
    male: [{ minAge: 19, maxAge: 200, value: 3000 }],
    female: [{ minAge: 19, maxAge: 200, value: 3000 }],
  },
  upperLimitBasis: 'preformed-retinol-only',
  riskWithoutVegetables: 'moderate',
  supplementCloseability: 'good',
  trackingPriority: 'primary',
};

/**
 * Folate.
 *
 * Reference is dietary folate equivalents (`food + 1.7 × folic acid`); the
 * upper limit is **synthetic folic acid, in raw micrograms**. Lentils cannot
 * breach it; a bowl of fortified cereal plus a multivitamin can. Mixing DFE and
 * raw micrograms inflates supplement contributions by 70%, which is why
 * `assessMicronutrients()` builds the two totals separately.
 */
export const FOLATE: NutrientDefinition = {
  id: 'folate',
  name: 'Folate',
  category: 'water-soluble-vitamin',
  unit: 'mcg DFE',
  referenceType: 'RDA',
  reference: {
    male: [{ minAge: 19, maxAge: 200, value: 400 }],
    female: [{ minAge: 19, maxAge: 200, value: 400 }],
  },
  upperLimit: {
    male: [{ minAge: 19, maxAge: 200, value: 1000 }],
    female: [{ minAge: 19, maxAge: 200, value: 1000 }],
  },
  upperLimitBasis: 'synthetic-folic-acid-only',
  riskWithoutVegetables: 'high',
  supplementCloseability: 'equivalent',
  trackingPriority: 'primary',
};

/**
 * Fibre.
 *
 * An Adequate Intake rather than an RDA, tabulated by sex and age band and
 * energy-scaled at 14 g per 1,000 kcal by `energyScaledFiberTarget()`. There is
 * no upper limit — high intakes cause discomfort, not toxicity — so the
 * adequacy panel shows a floor and never a ceiling.
 */
export const FIBER: NutrientDefinition = {
  id: 'fiber',
  name: 'Fiber',
  category: 'macronutrient-component',
  unit: 'g',
  referenceType: 'AI',
  reference: {
    male: [
      { minAge: 19, maxAge: 50, value: 38 },
      { minAge: 51, maxAge: 200, value: 30 },
    ],
    female: [
      { minAge: 19, maxAge: 50, value: 25 },
      { minAge: 51, maxAge: 200, value: 21 },
    ],
  },
  referenceBasis:
    '14 g per 1,000 kcal. The app should prefer the energy-scaled form for anyone eating well above or below 2,700 kcal, and does so in `energyScaledTarget()`.',
  upperLimit: null,
  riskWithoutVegetables: 'high',
  supplementCloseability: 'partial',
  trackingPriority: 'primary',
};

/**
 * The nutrients the diary can say anything about from a food log alone.
 *
 * Deliberately short. Adding to it requires the **food database** to carry the
 * nutrient, not merely the reference table to define it. Fibre is absent
 * because it is a macronutrient the diary already tracks in grams, and
 * rendering it twice would double-count its prominence.
 */
export const ASSESSABLE_FROM_FOOD_LOG: readonly NutrientDefinition[] = [VITAMIN_A, FOLATE];

/** Every definition this module extracts, for the drift test. */
export const EXTRACTED_NUTRIENTS: readonly NutrientDefinition[] = [VITAMIN_A, FOLATE, FIBER];
