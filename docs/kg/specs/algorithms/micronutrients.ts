/**
 * micronutrients.ts
 *
 * Micronutrient adequacy: turn logged foods plus a supplement stack into
 * structured findings about what is short and what is over the limit.
 *
 * This module exists because the user this app is being built for eats no
 * vegetables and is running an aggressive deficit. That combination is
 * precisely where deficiencies show up, so adequacy is a first-class surface
 * here rather than a nice-to-have. See `docs/kg/specs/nutrition-personalization.md`.
 *
 * Three design decisions are load-bearing and easy to get wrong:
 *
 * 1. **Food and supplements are one world, not two.** Every calculation sums
 *    both. The product question a user actually has is "what am I still short
 *    of, given what I already take", and you cannot answer it from two separate
 *    screens.
 *
 * 2. **Upper limits are provenance-sensitive.** The magnesium UL is
 *    supplemental-only. The folate UL is synthetic-folic-acid-only. The vitamin
 *    A UL is preformed-retinol-only. Summing food into any of those comparisons
 *    produces false alarms that train users to ignore the real ones. Every
 *    intake contribution therefore carries a `source` and an optional `form`,
 *    and {@link countsTowardUpperLimit} is the single place that logic lives.
 *
 * 3. **Below the RDA is not a deficiency.** The RDA covers ~97.5% of the
 *    population; an individual below it has an elevated *probability* of
 *    inadequacy and nothing more. No function here returns the word
 *    "deficient", and the copy in {@link ADEQUACY_COPY} is written to keep the
 *    distinction visible. This matters more than usual in a restrictive-eating
 *    context, where alarming language about food is itself a harm.
 *
 * Reference data lives in `docs/kg/specs/micronutrients.json`. This module is
 * data-agnostic: pass it whatever database you loaded.
 *
 * Zero runtime dependencies. Pure functions. No I/O. The only import is a
 * type-only import of `Finding` from guardrails.ts, which erases at compile
 * time.
 *
 * @module micronutrients
 */

import type { Finding, FindingLevel } from './guardrails.js';

export type { Finding, FindingLevel };

/* ------------------------------------------------------------------ */
/* Finding constructors (local — guardrails.ts keeps its own private)   */
/* ------------------------------------------------------------------ */

function ok(code: string, message = ''): Finding {
  return { ok: true, level: 'info', code, message };
}
function info(code: string, message: string): Finding {
  return { ok: false, level: 'info', code, message };
}
function warn(code: string, message: string): Finding {
  return { ok: false, level: 'warn', code, message };
}

/* ------------------------------------------------------------------ */
/* Reference-data types (mirror micronutrients.json)                   */
/* ------------------------------------------------------------------ */

export type Sex = 'male' | 'female';

/** How the reference intake was derived. `none` means the DRI system declined to set one. */
export type ReferenceType = 'RDA' | 'AI' | 'none';

/**
 * Which intake contributions count against the Tolerable Upper Intake Level.
 *
 * Getting this wrong is the most common defect in nutrition software. The DRI
 * committees set several ULs against a *specific chemical form from a specific
 * source*, not against total intake, because the adverse effect only occurs
 * with that form.
 */
export type UpperLimitBasis =
  /** Everything counts: food, fortified food and supplements. */
  | 'total'
  /** Supplements and medications only. Magnesium, vitamin E. */
  | 'supplemental-only'
  /** Supplements plus fortified food. Niacin. */
  | 'supplemental-and-fortified-only'
  /** Synthetic folic acid only. Natural food folate is unlimited. */
  | 'synthetic-folic-acid-only'
  /** Preformed retinol only. Provitamin-A carotenoids are unlimited. */
  | 'preformed-retinol-only';

export type RiskWithoutVegetables = 'none' | 'low' | 'moderate' | 'high' | 'severe';

export type SupplementCloseability = 'equivalent' | 'good' | 'partial' | 'poor';

export type TrackingPriority = 'primary' | 'secondary' | 'tertiary';

export interface AgeBandValue {
  minAge: number;
  maxAge: number;
  value: number;
}

export interface SexedBands {
  male: readonly AgeBandValue[];
  female: readonly AgeBandValue[];
}

export interface AlternativeReference extends SexedBands {
  /** Why this anchor exists and where it came from. Always shown in the UI. */
  basis: string;
  confidence: 'well-established' | 'reasonable-inference' | 'uncertain';
}

export interface ReferenceModifier {
  condition: string;
  add: number;
  note?: string;
}

export interface SupplementCap {
  value: number;
  unit: string;
  note: string;
}

export interface NutrientDefinition {
  id: string;
  name: string;
  category: string;
  unit: string;
  referenceType: ReferenceType;
  reference: SexedBands | null;
  referenceBasis?: string;
  /** Present when `referenceType === 'none'` but a non-DRI tracking anchor exists. */
  alternativeReference?: AlternativeReference | null;
  referenceModifiers?: readonly ReferenceModifier[];
  upperLimit: SexedBands | null;
  upperLimitBasis?: UpperLimitBasis;
  upperLimitNote?: string;
  /** Regulatory ceiling on a single supplement unit. Potassium's 99 mg. */
  supplementCap?: SupplementCap | null;
  riskWithoutVegetables: RiskWithoutVegetables;
  riskNote?: string;
  supplementCloseability: SupplementCloseability;
  supplementNote?: string;
  trackingPriority: TrackingPriority;
  displayNote?: string;
  athleteNote?: string;
  sources?: readonly string[];
}

export interface MicronutrientDatabase {
  version: string;
  nutrients: readonly NutrientDefinition[];
}

/* ------------------------------------------------------------------ */
/* Intake types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Where a nutrient contribution came from. Drives upper-limit arithmetic.
 *
 * - `food` — naturally present in the food.
 * - `fortified` — added during manufacture. Enriched flour, fortified cereal,
 *   fortified milk.
 * - `supplement` — a pill, powder, gummy or drink taken as a supplement.
 */
export type IntakeSource = 'food' | 'fortified' | 'supplement';

/**
 * A single nutrient contribution from a single item.
 *
 * `form` is the vitamer/chemical-form discriminator. It only matters for
 * nutrients whose UL is form-specific. Known values used by this module:
 * `'preformed'` and `'carotenoid'` for vitamin A; `'folic-acid'` and
 * `'food-folate'` for folate. Anything else is passed through untouched.
 */
export interface NutrientContribution {
  nutrientId: string;
  amount: number;
  source: IntakeSource;
  form?: string;
}

export interface LoggedItem {
  /** Stable id of the food or supplement, for attribution in the UI. */
  id: string;
  label: string;
  contributions: readonly NutrientContribution[];
}

/* ------------------------------------------------------------------ */
/* Supplement stack model                                              */
/* ------------------------------------------------------------------ */

export type SupplementTiming =
  | 'morning'
  | 'with-breakfast'
  | 'midday'
  | 'pre-workout'
  | 'post-workout'
  | 'with-dinner'
  | 'evening'
  | 'any';

/**
 * One product in the user's stack.
 *
 * Modelled as a product rather than as a nutrient because that is how upper
 * limits get breached in real life: two products each individually sane, taken
 * together. Attribution back to the product is what makes the finding
 * actionable — "your multivitamin and your ZMA both have zinc" is useful,
 * "you are over the zinc UL" is not.
 */
export interface SupplementProduct {
  id: string;
  /** What the user calls it. */
  label: string;
  /** Doses per day. A 2-capsule serving taken once daily is `dosesPerDay: 1`. */
  dosesPerDay: number;
  timing: SupplementTiming;
  /** Nutrient content of ONE dose. `source` is normally `'supplement'`. */
  perDose: readonly NutrientContribution[];
  /** Free-text, e.g. "prescribed by GP for documented deficiency". */
  note?: string;
  /**
   * Set when a clinician directed a dose above the UL. Downgrades the UL
   * finding from `warn` to `info` — it does not suppress it, because the user
   * should still be able to see the number.
   */
  clinicianDirected?: boolean;
}

export interface SupplementStack {
  products: readonly SupplementProduct[];
}

/** Expand a stack into a day's worth of nutrient contributions. */
export function expandStack(stack: SupplementStack): LoggedItem[] {
  return stack.products.map((p) => ({
    id: p.id,
    label: p.label,
    contributions: p.perDose.map((c) => ({
      ...c,
      source: c.source ?? 'supplement',
      amount: c.amount * p.dosesPerDay,
    })),
  }));
}

/* ------------------------------------------------------------------ */
/* Reference lookup                                                    */
/* ------------------------------------------------------------------ */

export interface PersonContext {
  sex: Sex;
  ageYears: number;
  /** Applies `referenceModifiers` whose `condition` appears here. e.g. `['smoker']`. */
  conditions?: readonly string[];
  /** Used to energy-scale fiber. */
  energyKcal?: number;
}

function bandValue(bands: readonly AgeBandValue[] | undefined, ageYears: number): number | null {
  if (!bands) return null;
  for (const b of bands) {
    if (ageYears >= b.minAge && ageYears <= b.maxAge) return b.value;
  }
  return null;
}

/**
 * The reference intake for this person, plus how much to trust it.
 *
 * `isAnchor` is true when the value came from `alternativeReference` rather
 * than from a real DRI. The UI must render anchors differently — an anchored
 * nutrient can be "below the anchor" without that meaning anything is wrong,
 * which is emphatically not true of an RDA.
 */
export interface ResolvedReference {
  value: number | null;
  type: ReferenceType;
  isAnchor: boolean;
  basis?: string;
  confidence?: string;
}

export function resolveReference(
  def: NutrientDefinition,
  person: PersonContext,
): ResolvedReference {
  const direct = def.reference ? bandValue(def.reference[person.sex], person.ageYears) : null;

  if (direct !== null) {
    let value = direct;
    for (const m of def.referenceModifiers ?? []) {
      if (person.conditions?.includes(m.condition)) value += m.add;
    }
    return { value, type: def.referenceType, isAnchor: false, basis: def.referenceBasis };
  }

  const alt = def.alternativeReference;
  if (alt) {
    const v = bandValue(alt[person.sex], person.ageYears);
    if (v !== null) {
      return {
        value: v,
        type: 'none',
        isAnchor: true,
        basis: alt.basis,
        confidence: alt.confidence,
      };
    }
  }

  return { value: null, type: def.referenceType, isAnchor: false };
}

/**
 * Fiber's AI is defined as 14 g per 1,000 kcal. The tabulated 38 g figure is
 * that rule evaluated at a reference energy intake, so for anyone eating well
 * away from ~2,700 kcal the tabulated number is the wrong target.
 *
 * This matters here specifically: a man in an aggressive deficit eating 2,000
 * kcal has an energy-scaled fiber target of 28 g, not 38 g. Holding him to 38 g
 * manufactures a shortfall that is an artefact of the reference table.
 *
 * @returns the scaled target, or the tabulated value when energy is unknown
 */
export function energyScaledFiberTarget(tabulated: number, energyKcal?: number): number {
  if (!energyKcal || !Number.isFinite(energyKcal) || energyKcal <= 0) return tabulated;
  return Math.round((14 * energyKcal) / 1000);
}

export function resolveUpperLimit(
  def: NutrientDefinition,
  person: PersonContext,
): number | null {
  if (!def.upperLimit) return null;
  return bandValue(def.upperLimit[person.sex], person.ageYears);
}

/* ------------------------------------------------------------------ */
/* Upper-limit provenance logic — the single source of truth            */
/* ------------------------------------------------------------------ */

/**
 * Does this contribution count against the UL?
 *
 * Read the {@link UpperLimitBasis} docs before changing anything here. Each
 * branch encodes a specific DRI committee decision, not a convention.
 */
export function countsTowardUpperLimit(
  basis: UpperLimitBasis | undefined,
  c: NutrientContribution,
): boolean {
  switch (basis ?? 'total') {
    case 'total':
      return true;

    case 'supplemental-only':
      return c.source === 'supplement';

    case 'supplemental-and-fortified-only':
      return c.source === 'supplement' || c.source === 'fortified';

    case 'synthetic-folic-acid-only':
      // Explicit form wins. Otherwise: anything added to food or taken as a
      // supplement is folic acid unless it says otherwise; natural food folate
      // never counts.
      if (c.form === 'folic-acid') return true;
      if (c.form === 'food-folate') return false;
      return c.source === 'supplement' || c.source === 'fortified';

    case 'preformed-retinol-only':
      // Carotenoids never count, from any source. Preformed retinol always
      // does, including from liver — which is the case that matters.
      if (c.form === 'carotenoid') return false;
      if (c.form === 'preformed') return true;
      return c.source === 'supplement' || c.source === 'fortified';

    default:
      return true;
  }
}

/* ------------------------------------------------------------------ */
/* Intake aggregation                                                  */
/* ------------------------------------------------------------------ */

export interface NutrientIntake {
  nutrientId: string;
  /** Everything, regardless of source. What the user "got". */
  total: number;
  fromFood: number;
  fromFortified: number;
  fromSupplement: number;
  /** Only the portion that counts against the UL for this nutrient. */
  countingTowardUpperLimit: number;
  /** Product/food ids contributing, largest first. Drives attribution copy. */
  contributors: readonly { id: string; label: string; amount: number }[];
}

/**
 * Sum a day of logged foods and an expanded supplement stack into per-nutrient
 * intakes.
 *
 * @param items every logged food AND every expanded supplement dose
 * @param db the nutrient database, used only for UL provenance rules
 */
export function computeIntake(
  items: readonly LoggedItem[],
  db: MicronutrientDatabase,
): Map<string, NutrientIntake> {
  const byId = new Map<string, NutrientDefinition>();
  for (const d of db.nutrients) byId.set(d.id, d);

  const out = new Map<string, NutrientIntake>();
  const contributorAccum = new Map<string, Map<string, { label: string; amount: number }>>();

  for (const item of items) {
    for (const c of item.contributions) {
      if (!Number.isFinite(c.amount) || c.amount === 0) continue;

      let acc = out.get(c.nutrientId);
      if (!acc) {
        acc = {
          nutrientId: c.nutrientId,
          total: 0,
          fromFood: 0,
          fromFortified: 0,
          fromSupplement: 0,
          countingTowardUpperLimit: 0,
          contributors: [],
        };
        out.set(c.nutrientId, acc);
        contributorAccum.set(c.nutrientId, new Map());
      }

      acc.total += c.amount;
      if (c.source === 'food') acc.fromFood += c.amount;
      else if (c.source === 'fortified') acc.fromFortified += c.amount;
      else acc.fromSupplement += c.amount;

      const def = byId.get(c.nutrientId);
      if (countsTowardUpperLimit(def?.upperLimitBasis, c)) {
        acc.countingTowardUpperLimit += c.amount;
      }

      const contribs = contributorAccum.get(c.nutrientId)!;
      const prev = contribs.get(item.id);
      if (prev) prev.amount += c.amount;
      else contribs.set(item.id, { label: item.label, amount: c.amount });
    }
  }

  for (const [nutrientId, contribs] of contributorAccum) {
    const list = [...contribs.entries()]
      .map(([id, v]) => ({ id, label: v.label, amount: v.amount }))
      .sort((a, b) => b.amount - a.amount);
    out.get(nutrientId)!.contributors = list;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Adequacy assessment                                                 */
/* ------------------------------------------------------------------ */

/**
 * Adequacy bands.
 *
 * Deliberately *not* a binary. A binary pass/fail on an RDA implies a precision
 * the underlying science does not have, and in a restrictive-eating context a
 * red FAIL badge on a food-related number is exactly the kind of thing that
 * does harm.
 */
export type AdequacyStatus =
  /** At or above the reference. */
  | 'met'
  /** 70–99%. Common, usually unremarkable, worth knowing. */
  | 'slightly-short'
  /** 50–69%. Worth acting on. */
  | 'short'
  /** Under 50%. Sustained, this is the one to take seriously. */
  | 'well-short'
  /** No reference and no anchor exists. Intake is reported, not judged. */
  | 'not-assessed';

export type UpperLimitStatus = 'ok' | 'approaching' | 'exceeded' | 'no-limit';

export interface AdequacyAssessment {
  nutrientId: string;
  name: string;
  unit: string;
  intake: number;
  fromFood: number;
  fromSupplement: number;
  reference: number | null;
  referenceType: ReferenceType;
  referenceIsAnchor: boolean;
  pctOfReference: number | null;
  status: AdequacyStatus;
  /** How much more would reach the reference. `0` when met, `null` when unassessed. */
  remainingGap: number | null;
  upperLimit: number | null;
  upperLimitBasis: UpperLimitBasis;
  /** Intake measured against the UL, i.e. only the counting portion. */
  intakeAgainstUpperLimit: number;
  upperLimitStatus: UpperLimitStatus;
  riskWithoutVegetables: RiskWithoutVegetables;
  supplementCloseability: SupplementCloseability;
  trackingPriority: TrackingPriority;
  contributors: readonly { id: string; label: string; amount: number }[];
}

/** Thresholds, exported so UI copy and tests read the same numbers. */
export const ADEQUACY_THRESHOLDS = {
  MET_PCT: 100,
  SLIGHTLY_SHORT_PCT: 70,
  SHORT_PCT: 50,
  /** Fraction of the UL at which we say "approaching". */
  APPROACHING_UL_FRACTION: 0.8,
  /** Consecutive days a nutrient must be short before it is worth a finding. */
  SUSTAINED_DAYS: 7,
} as const;

function classify(pct: number | null): AdequacyStatus {
  if (pct === null) return 'not-assessed';
  if (pct >= ADEQUACY_THRESHOLDS.MET_PCT) return 'met';
  if (pct >= ADEQUACY_THRESHOLDS.SLIGHTLY_SHORT_PCT) return 'slightly-short';
  if (pct >= ADEQUACY_THRESHOLDS.SHORT_PCT) return 'short';
  return 'well-short';
}

/**
 * Assess one nutrient.
 *
 * @param def nutrient definition from micronutrients.json
 * @param intake aggregated intake, or `undefined` when nothing was logged
 * @param person sex, age, conditions, energy intake
 */
export function assessNutrient(
  def: NutrientDefinition,
  intake: NutrientIntake | undefined,
  person: PersonContext,
): AdequacyAssessment {
  const ref = resolveReference(def, person);

  let referenceValue = ref.value;
  if (def.id === 'fiber' && referenceValue !== null) {
    referenceValue = energyScaledFiberTarget(referenceValue, person.energyKcal);
  }

  const total = intake?.total ?? 0;
  const counting = intake?.countingTowardUpperLimit ?? 0;
  const ul = resolveUpperLimit(def, person);

  const pct =
    referenceValue !== null && referenceValue > 0
      ? Math.round((total / referenceValue) * 1000) / 10
      : null;

  let ulStatus: UpperLimitStatus = 'no-limit';
  if (ul !== null) {
    if (counting > ul) ulStatus = 'exceeded';
    else if (counting >= ul * ADEQUACY_THRESHOLDS.APPROACHING_UL_FRACTION) ulStatus = 'approaching';
    else ulStatus = 'ok';
  }

  return {
    nutrientId: def.id,
    name: def.name,
    unit: def.unit,
    intake: total,
    fromFood: (intake?.fromFood ?? 0) + (intake?.fromFortified ?? 0),
    fromSupplement: intake?.fromSupplement ?? 0,
    reference: referenceValue,
    referenceType: ref.type,
    referenceIsAnchor: ref.isAnchor,
    pctOfReference: pct,
    status: classify(pct),
    remainingGap:
      referenceValue === null ? null : Math.max(0, Math.round((referenceValue - total) * 100) / 100),
    upperLimit: ul,
    upperLimitBasis: def.upperLimitBasis ?? 'total',
    intakeAgainstUpperLimit: counting,
    upperLimitStatus: ulStatus,
    riskWithoutVegetables: def.riskWithoutVegetables,
    supplementCloseability: def.supplementCloseability,
    trackingPriority: def.trackingPriority,
    contributors: intake?.contributors ?? [],
  };
}

/** Assess every nutrient in the database. */
export function assessAll(
  items: readonly LoggedItem[],
  db: MicronutrientDatabase,
  person: PersonContext,
): AdequacyAssessment[] {
  const intake = computeIntake(items, db);
  return db.nutrients.map((def) => assessNutrient(def, intake.get(def.id), person));
}

/* ------------------------------------------------------------------ */
/* Gap ranking                                                         */
/* ------------------------------------------------------------------ */

const CLOSEABILITY_RANK: Record<SupplementCloseability, number> = {
  equivalent: 0,
  good: 1,
  partial: 2,
  poor: 3,
};

const STATUS_SEVERITY: Record<AdequacyStatus, number> = {
  'well-short': 0,
  short: 1,
  'slightly-short': 2,
  met: 3,
  'not-assessed': 4,
};

const PRIORITY_RANK: Record<TrackingPriority, number> = {
  primary: 0,
  secondary: 1,
  tertiary: 2,
};

/**
 * Gaps worth acting on, ordered so the top of the list is the most useful thing
 * to do next.
 *
 * Ordering is severity, then tracking priority, then *how easy the gap is to
 * close*. That last term is deliberate: a large gap in something a pill fixes
 * outright (vitamin K1) should surface above a small gap in something a pill
 * fixes badly (fiber diversity), because the first is one decision and the
 * second is a lifestyle argument.
 *
 * Anchored nutrients (nitrate, lutein, K2) are excluded — being "below" a
 * performance anchor is not a gap and must not be listed as one.
 */
export function rankGaps(assessments: readonly AdequacyAssessment[]): AdequacyAssessment[] {
  return assessments
    .filter((a) => !a.referenceIsAnchor)
    .filter((a) => a.status === 'well-short' || a.status === 'short' || a.status === 'slightly-short')
    .sort((a, b) => {
      const s = STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status];
      if (s !== 0) return s;
      const p = PRIORITY_RANK[a.trackingPriority] - PRIORITY_RANK[b.trackingPriority];
      if (p !== 0) return p;
      const c = CLOSEABILITY_RANK[a.supplementCloseability] - CLOSEABILITY_RANK[b.supplementCloseability];
      if (c !== 0) return c;
      return (a.pctOfReference ?? 100) - (b.pctOfReference ?? 100);
    });
}

/**
 * Gaps that a supplement cannot reasonably fix — the honest list.
 *
 * Surfacing this separately is the point. Telling someone "take a pill" for
 * potassium is wrong (99 mg cap against a 3,400 mg AI) and telling them a
 * psyllium scoop replaces dietary fiber diversity is overclaiming. These need
 * different copy from the closeable gaps, so they get a different function.
 */
export function gapsSupplementsCannotClose(
  assessments: readonly AdequacyAssessment[],
): AdequacyAssessment[] {
  return rankGaps(assessments).filter(
    (a) => a.supplementCloseability === 'poor' || a.supplementCloseability === 'partial',
  );
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/**
 * User-facing copy. Matter-of-fact, no moralising, no alarm.
 *
 * Two rules the wording follows and future edits must keep:
 * - Never call a food good or bad. Foods supply nutrients; that is all.
 * - Never say "deficient" from a food log. A log measures intake, not status.
 *   Only a blood test measures status, and the copy says so where it matters.
 */
export const ADEQUACY_COPY = {
  belowReference: (name: string, pct: number, unit: string, gap: number) =>
    `${name} came in around ${Math.round(pct)}% of the daily reference — about ${formatAmount(gap)} ${unit} short.`,

  sustainedShort: (name: string, days: number) =>
    `${name} has been short most days for the last ${days}. One low day is nothing; a run of them is worth a look.`,

  intakeNotStatus:
    'This is what you ate, not what is in your blood. A food log can point at a likely gap; only a blood test can confirm one.',

  anchoredNutrient: (name: string) =>
    `${name} has no official daily requirement. The number shown is a reference point for comparison, not a target you are failing to hit.`,

  upperLimitExceeded: (name: string, intake: number, ul: number, unit: string, basis: string) =>
    `${name} is at ${formatAmount(intake)} ${unit} against an upper limit of ${formatAmount(ul)} ${unit}${basis}. Worth checking whether two products are both supplying it.`,

  approachingUpperLimit: (name: string, unit: string, ul: number) =>
    `${name} is close to its upper limit of ${formatAmount(ul)} ${unit}. Not a problem today; worth knowing before you add anything else that contains it.`,

  supplementEquivalent: (name: string) =>
    `${name} is one of the gaps a supplement closes completely — the supplemental form is the same molecule, absorbed at least as well as the food version. Nothing is lost by covering it that way.`,

  supplementPoor: (name: string) =>
    `${name} is not really a supplement problem. Covering it means changing what is on the plate.`,

  disclaimer:
    'Nutrient reference intakes are population figures, not personal requirements. Being under one does not mean something is wrong. If you want to know your actual status, ask a doctor about a blood test.',
} as const;

function formatAmount(n: number): string {
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 100) / 100);
}

/**
 * Turn assessments into findings.
 *
 * Levels are deliberately restrained. Nothing here is ever a `block`: a
 * micronutrient shortfall in a food log is not grounds for locking the app,
 * and treating it that way would be both clinically wrong and — in a
 * restrictive-eating context — actively harmful.
 *
 * @param assessments output of {@link assessAll}
 * @param opts `sustainedDays` promotes a shortfall from info to warn when it
 *   has persisted; pass the count of days this nutrient has been short.
 */
export function adequacyFindings(
  assessments: readonly AdequacyAssessment[],
  opts: { sustainedShortDays?: Readonly<Record<string, number>> } = {},
): Finding[] {
  const out: Finding[] = [];
  const sustained = opts.sustainedShortDays ?? {};

  for (const a of assessments) {
    // --- Upper limits ------------------------------------------------
    if (a.upperLimitStatus === 'exceeded' && a.upperLimit !== null) {
      const basis = upperLimitBasisPhrase(a.upperLimitBasis);
      out.push(
        warn(
          `MICRO_UL_EXCEEDED_${a.nutrientId.toUpperCase()}`,
          ADEQUACY_COPY.upperLimitExceeded(a.name, a.intakeAgainstUpperLimit, a.upperLimit, a.unit, basis),
        ),
      );
    } else if (a.upperLimitStatus === 'approaching' && a.upperLimit !== null) {
      out.push(
        info(
          `MICRO_UL_APPROACHING_${a.nutrientId.toUpperCase()}`,
          ADEQUACY_COPY.approachingUpperLimit(a.name, a.unit, a.upperLimit),
        ),
      );
    }

    // --- Shortfalls --------------------------------------------------
    if (a.referenceIsAnchor || a.status === 'met' || a.status === 'not-assessed') continue;
    if (a.trackingPriority === 'tertiary' && a.status !== 'well-short') continue;

    const days = sustained[a.nutrientId] ?? 0;
    const isSustained = days >= ADEQUACY_THRESHOLDS.SUSTAINED_DAYS;
    const code = `MICRO_SHORT_${a.nutrientId.toUpperCase()}`;
    const message = isSustained
      ? ADEQUACY_COPY.sustainedShort(a.name, days)
      : ADEQUACY_COPY.belowReference(a.name, a.pctOfReference ?? 0, a.unit, a.remainingGap ?? 0);

    // Only a sustained, substantial shortfall earns a warn. A single short day
    // is information, not a problem, and must not be dressed up as one.
    if (isSustained && (a.status === 'well-short' || a.status === 'short')) {
      out.push(warn(code, message));
    } else {
      out.push(info(code, message));
    }
  }

  if (out.length === 0) out.push(ok('MICRO_OK'));
  return out;
}

function upperLimitBasisPhrase(basis: UpperLimitBasis): string {
  switch (basis) {
    case 'supplemental-only':
      return ' (the limit applies to supplements only, not to food)';
    case 'supplemental-and-fortified-only':
      return ' (the limit applies to supplements and fortified food, not to natural food)';
    case 'synthetic-folic-acid-only':
      return ' (the limit applies to folic acid from supplements and fortified food, not to folate from food)';
    case 'preformed-retinol-only':
      return ' (the limit applies to preformed vitamin A, not to carotenoids)';
    case 'total':
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ */
/* Supplement-stack analysis                                           */
/* ------------------------------------------------------------------ */

export interface StackOverlap {
  nutrientId: string;
  name: string;
  unit: string;
  total: number;
  upperLimit: number | null;
  /** Products supplying it, largest first. */
  products: readonly { id: string; label: string; amount: number }[];
}

/**
 * Find nutrients supplied by more than one product in the stack.
 *
 * This is the check that catches the real-world failure mode — a multivitamin
 * plus a ZMA plus a "immune support" zinc lozenge, none of them unreasonable
 * alone. It runs on the stack only, ignoring food, because that is the
 * actionable surface: you can change which pills you take far more easily than
 * you can change what is in beef.
 */
export function findStackOverlaps(
  stack: SupplementStack,
  db: MicronutrientDatabase,
  person: PersonContext,
): StackOverlap[] {
  const byId = new Map<string, NutrientDefinition>();
  for (const d of db.nutrients) byId.set(d.id, d);

  const acc = new Map<string, Map<string, { label: string; amount: number }>>();
  for (const p of stack.products) {
    for (const c of p.perDose) {
      const amount = c.amount * p.dosesPerDay;
      if (!Number.isFinite(amount) || amount === 0) continue;
      let m = acc.get(c.nutrientId);
      if (!m) {
        m = new Map();
        acc.set(c.nutrientId, m);
      }
      const prev = m.get(p.id);
      if (prev) prev.amount += amount;
      else m.set(p.id, { label: p.label, amount });
    }
  }

  const out: StackOverlap[] = [];
  for (const [nutrientId, m] of acc) {
    if (m.size < 2) continue;
    const def = byId.get(nutrientId);
    const products = [...m.entries()]
      .map(([id, v]) => ({ id, label: v.label, amount: v.amount }))
      .sort((a, b) => b.amount - a.amount);
    out.push({
      nutrientId,
      name: def?.name ?? nutrientId,
      unit: def?.unit ?? '',
      total: products.reduce((s, p) => s + p.amount, 0),
      upperLimit: def ? resolveUpperLimit(def, person) : null,
      products,
    });
  }

  return out.sort((a, b) => {
    const aOver = a.upperLimit !== null && a.total > a.upperLimit ? 0 : 1;
    const bOver = b.upperLimit !== null && b.total > b.upperLimit ? 0 : 1;
    return aOver - bOver || b.products.length - a.products.length;
  });
}

/**
 * Which gaps does the stack actually close, and what is left?
 *
 * Answers the question the user has, which is not "what do I eat" and not
 * "what do I take" but "given both, what is still missing".
 */
export interface StackCoverage {
  /** Reference met only because of the supplement. */
  closedBySupplement: readonly string[];
  /** Still short after food AND supplements. */
  stillShort: readonly AdequacyAssessment[];
  /** Still short, and a supplement will not fix it. */
  stillShortAndNotSupplementable: readonly AdequacyAssessment[];
  /** Nutrients over the UL. */
  overUpperLimit: readonly AdequacyAssessment[];
  overlaps: readonly StackOverlap[];
}

export function analyseStackCoverage(
  foods: readonly LoggedItem[],
  stack: SupplementStack,
  db: MicronutrientDatabase,
  person: PersonContext,
): StackCoverage {
  const withStack = assessAll([...foods, ...expandStack(stack)], db, person);
  const foodOnly = assessAll(foods, db, person);

  const foodOnlyById = new Map(foodOnly.map((a) => [a.nutrientId, a]));
  const closedBySupplement: string[] = [];
  for (const a of withStack) {
    const f = foodOnlyById.get(a.nutrientId);
    if (a.status === 'met' && f && f.status !== 'met' && f.status !== 'not-assessed') {
      closedBySupplement.push(a.nutrientId);
    }
  }

  return {
    closedBySupplement,
    stillShort: rankGaps(withStack),
    stillShortAndNotSupplementable: gapsSupplementsCannotClose(withStack),
    overUpperLimit: withStack.filter((a) => a.upperLimitStatus === 'exceeded'),
    overlaps: findStackOverlaps(stack, db, person),
  };
}

/* ------------------------------------------------------------------ */
/* No-vegetable gap profile                                            */
/* ------------------------------------------------------------------ */

/**
 * Nutrients this database says are hard to cover without vegetables, ordered
 * by risk and then by how badly a supplement substitutes.
 *
 * Used to seed the adequacy screen for a user who has told the app they do not
 * eat vegetables, BEFORE they have logged enough to compute anything. Showing
 * a useful answer on day one is worth a lot, and the answer is knowable from
 * the restriction alone.
 */
const RISK_RANK: Record<RiskWithoutVegetables, number> = {
  severe: 0,
  high: 1,
  moderate: 2,
  low: 3,
  none: 4,
};

export function noVegetableRiskProfile(
  db: MicronutrientDatabase,
  minRisk: RiskWithoutVegetables = 'moderate',
): NutrientDefinition[] {
  const threshold = RISK_RANK[minRisk];
  return db.nutrients
    .filter((d) => RISK_RANK[d.riskWithoutVegetables] <= threshold)
    .sort(
      (a, b) =>
        RISK_RANK[a.riskWithoutVegetables] - RISK_RANK[b.riskWithoutVegetables] ||
        CLOSEABILITY_RANK[b.supplementCloseability] - CLOSEABILITY_RANK[a.supplementCloseability] ||
        PRIORITY_RANK[a.trackingPriority] - PRIORITY_RANK[b.trackingPriority],
    );
}

/* ------------------------------------------------------------------ */
/* Gap-closing protocol — concrete recommendations                     */
/* ------------------------------------------------------------------ */

/**
 * A named, dosed recommendation for closing a specific gap.
 *
 * Per `docs/kg/specs/advice-policy.md`, supplementing an identified gap is Tier
 * 1: name the compound, give a dose range and timing, say what it closes, and
 * tag the confidence. "Consider supplementation" is not a recommendation and
 * this product does not ship it.
 *
 * Form is specified because form is not cosmetic. Magnesium oxide and magnesium
 * glycinate are not interchangeable; K1 and K2 MK-7 do different jobs; psyllium
 * and inulin have opposite GI tolerability profiles. Naming "magnesium" without
 * naming the salt is advice that reliably sends people to the worst option on
 * the shelf, because the worst option is the cheapest.
 *
 * Every recommendation must pass {@link recommendationExceedsUpperLimit} against
 * the user's existing stack before it is shown. That check is not optional.
 */
export interface SupplementRecommendation {
  id: string;
  /** Nutrient ids this closes. Empty for non-nutrient ergogenics (creatine). */
  nutrientIds: readonly string[];
  /** The compound to buy, including the salt/ester where it matters. */
  compound: string;
  /** Why this form rather than the alternatives. */
  formRationale: string;
  doseLow: number;
  doseHigh: number;
  unit: string;
  /** Set when label dose and elemental dose differ, which trips people up. */
  elementalNote?: string;
  timing: SupplementTiming;
  timingRationale: string;
  /** Plain-English statement of what gap this closes. */
  closes: string;
  confidence: 'well-established' | 'reasonable-inference' | 'uncertain';
  /** Tier 2 caveat: the specific uncertainty, not a generic disclaimer. */
  caveat?: string;
  tier: 1 | 2;
}

/**
 * The protocol for a person eating no vegetables, training hard, in a deficit.
 *
 * Ordered roughly by value. The first four are the ones that actually matter
 * for this profile; the rest are conditional on what the log shows.
 *
 * Doses are deliberately given as ranges, and every range sits below the
 * relevant UL with headroom, so that a user already taking a multivitamin does
 * not get pushed over by following this. The UL check still runs.
 */
export const GAP_CLOSING_PROTOCOL: readonly SupplementRecommendation[] = [
  {
    id: 'k1',
    nutrientIds: ['vitamin_k1'],
    compound: 'Vitamin K1 (phylloquinone)',
    formRationale:
      'K1 specifically, not a "vitamin K" blend and not K2 MK-7. Leafy greens are a K1 source; K2 comes from animal and fermented foods and you are not short of it. A K2-only product closes none of this gap, and a great many products marketed as "vitamin K" are K2-only.',
    doseLow: 100,
    doseHigh: 120,
    unit: 'mcg',
    timing: 'with-dinner',
    timingRationale: 'Fat-soluble — take it with the meal that has the most fat in it.',
    closes:
      'The single clearest gap a no-greens diet creates. Without leafy vegetables, plausible K1 intake is around 30–60 mcg against a 120 mcg AI, and no non-vegetable food closes that. Supplemental K1 is absorbed better than the K1 in spinach, which sits bound in chloroplast membranes at roughly 10–20% absorption — so this is one of the few cases where the pill is strictly better than the food.',
    confidence: 'well-established',
    caveat:
      'If you take warfarin or another vitamin-K-antagonist anticoagulant, do not start this without telling the clinician who manages your INR. What matters there is keeping intake steady, and a new supplement is a change.',
    tier: 2,
  },
  {
    id: 'magnesium',
    nutrientIds: ['magnesium'],
    compound: 'Magnesium glycinate (or malate)',
    formRationale:
      'Glycinate and malate are well absorbed and well tolerated. Magnesium oxide is the one to avoid: it is the cheapest and most common, its fractional absorption is poor, and most of what you swallow acts as a laxative rather than as magnesium.',
    doseLow: 200,
    doseHigh: 300,
    unit: 'mg',
    elementalNote:
      'Read the elemental magnesium figure, not the compound weight. A "1,000 mg magnesium glycinate" capsule typically contains around 100–140 mg of elemental magnesium, and the label often leads with the larger number.',
    timing: 'evening',
    timingRationale:
      'Timing is not critical for status. Evening is suggested because the mild relaxant effect is more welcome then, and because it keeps it away from a morning zinc or iron dose.',
    closes:
      'Tops up a nutrient most people are short of regardless of vegetables, and training in a deficit does not help. Nuts, seeds, oats and cocoa carry most of the food load here.',
    confidence: 'well-established',
    caveat:
      'The 350 mg upper limit is for supplemental magnesium only — food is unrestricted. Staying at 200–300 mg leaves headroom for whatever is in your multivitamin. Loose stools mean the dose is too high or the form is wrong.',
    tier: 1,
  },
  {
    id: 'epa_dha',
    nutrientIds: ['omega3_epa_dha'],
    compound: 'Fish oil, or algal oil if you avoid fish',
    formRationale:
      'Triglyceride-form fish oil is somewhat better absorbed than ethyl ester, though both work. Algal oil is genuinely equivalent for DHA and is the option if fish is off the list for texture or taste reasons.',
    doseLow: 1000,
    doseHigh: 2000,
    unit: 'mg EPA+DHA',
    elementalNote:
      'Dose the EPA+DHA number on the back of the bottle, not the "1,000 mg fish oil" on the front. A standard 1 g capsule contains roughly 300 mg of actual EPA+DHA, so 1,000 mg EPA+DHA is about three capsules, not one. This is the most common dosing error in the category.',
    timing: 'with-dinner',
    timingRationale: 'With a fat-containing meal. Also reduces fishy reflux.',
    closes:
      'Not a vegetable gap — a fish gap. Relevant here because fish is a high-sensory-load food and is frequently avoided alongside vegetables.',
    confidence: 'well-established',
    caveat:
      'Above about 3 g/day, several large trials have found more atrial fibrillation. 1–2 g is well inside that. If you are on an anticoagulant, mention it.',
    tier: 1,
  },
  {
    id: 'nitrate',
    nutrientIds: ['dietary_nitrate'],
    compound: 'Concentrated beetroot juice shot (standardised for nitrate)',
    formRationale:
      'Buy on the nitrate figure, not the volume — a shot should state ~400 mg (6.4 mmol) nitrate. "Beetroot extract" capsules usually do not state nitrate content and frequently contain very little; they are not a substitute. Nitrate-depleted beetroot juice is what the trials used as placebo, which tells you the nitrate is doing the work.',
    doseLow: 400,
    doseHigh: 520,
    unit: 'mg nitrate',
    elementalNote:
      '520 mg is 8.4 mmol, which is where the dose-response curve flattens. Wylie 2013 tested 4.2, 8.4 and 16.8 mmol: 4.2 did nothing, 8.4 worked, and 16.8 improved oxygen cost slightly further but did not extend exercise tolerance any further at all. Doubling the dose doubles the sugar and the GI load and buys no extra performance.',
    timing: 'pre-workout',
    timingRationale:
      'Plasma nitrite peaks 2–3 hours after you drink it, so take it 2.5–3 hours before the session, not on the way to the gym. This is one of the few supplement timing windows that genuinely matters. For a target event, load 6.4–8.4 mmol daily for 3–6 days beforehand with the last dose 2–3 h out — the intermittent and team-sport benefits show up with multi-day loading rather than a single shot.',
    closes:
      'The one thing a no-greens diet genuinely costs you for endurance. Beetroot and leafy greens are the only meaningful dietary nitrate sources. Read §6.5 before you buy it, though — what it does is not what the marketing says, and specifically it is not a VO2 max supplement.',
    confidence: 'well-established',
    caveat:
      'Do not use antibacterial mouthwash on days you use this, and this is not a minor footnote. Converting nitrate to nitrite depends entirely on bacteria on the back of your tongue — humans have no enzyme for it — and chlorhexidine mouthwash cuts oral nitrite production by about 90% and abolishes the blood-pressure effect outright. Swallow your saliva rather than spitting for the 2–3 h after the dose, for the same reason: in one study, volunteers who spat for three hours got no rise in plasma nitrite whatsoever. Also: buy on the stated mg of nitrate, not "beetroot extract 500 mg" — analyses of commercial products have found wide variation and some contain very little. Expect pink urine and possibly pink stool; harmless.',
    tier: 1,
  },
  {
    id: 'psyllium',
    nutrientIds: ['fiber'],
    compound: 'Psyllium husk',
    formRationale:
      'Psyllium is gel-forming AND minimally fermented, and that combination is why it is the pick: viscosity is what does the work for satiety, stool form and lipids, and not being fermented is why it causes so little gas. Inulin/FOS/chicory root is the exact opposite — no viscosity, highly fermentable — which is why it reliably produces flatulence and bloating: about 5 g/day is the conservative ceiling, 10 g is tolerated by most, and a chicory-heavy "high fibre" bar can deliver 8–12 g in one sitting. If psyllium is texturally intolerable, methylcellulose is the better substitute, because it is also gel-forming and non-fermented. Partially hydrolysed guar gum dissolves invisibly and is pleasant to take, but partial hydrolysis exists precisely to destroy guar viscosity, so it is a fermentable non-viscous fibre and not a psyllium equivalent — its low-gas reputation rests on thinner evidence than the marketing implies.',
    doseLow: 5,
    doseHigh: 10,
    unit: 'g',
    timing: 'any',
    timingRationale:
      'Before the meal you find hardest to stop eating, if satiety is the goal. Start at 3–5 g and build over two weeks; going straight to 10 g is how people decide fibre supplements do not agree with them.',
    closes:
      'Partially closes the fibre gap, and in a deficit fibre is mostly a hunger tool. Worth being straight about the size of the effect: viscous fibre reliably increases how full you feel, but the meta-analytic effect on actual body weight is about a third of a kilogram over ten weeks. It is an adherence aid, not a weight-loss mechanism, and anyone selling it as the latter is overselling.',
    confidence: 'well-established',
    caveat:
      'Take it with a full glass of water and not immediately before lying down. Ramp by about 5 g a week rather than jumping straight to 10 — going too fast is why most people conclude fibre supplements disagree with them. And it is a partial fix: isolated psyllium does not reproduce the fermentable-substrate diversity of mixed whole-food fibre, and nobody should tell you it does.',
    tier: 1,
  },
  {
    id: 'potassium_salt',
    nutrientIds: ['potassium'],
    compound: 'Potassium-chloride salt substitute (used as table salt)',
    formRationale:
      'Not a pill. US supplements are capped at 99 mg per unit against a 3,400 mg AI, so closing this with capsules would take more than thirty of them. A quarter-teaspoon of KCl salt substitute delivers roughly 800 mg — about eight capsules in one shake of a shaker.',
    doseLow: 700,
    doseHigh: 1600,
    unit: 'mg potassium',
    elementalNote:
      'A quarter-teaspoon of a 100% KCl substitute is roughly 690–795 mg depending on brand (Morton Salt Substitute ~690, Nu-Salt ~795). A 50/50 blend such as Morton Lite Salt is about half that, ~350 mg, and still carries sodium.',
    timing: 'any',
    timingRationale: 'Used on food, in place of some of your table salt.',
    closes:
      'The hardest gap on the list, and the only one that has to be solved outside the supplement aisle. Dairy, fish, meat, potatoes and fruit do most of the work; the salt substitute closes what is left.',
    confidence: 'well-established',
    caveat:
      'Do not do this if you have chronic kidney disease, or take an ACE inhibitor, an ARB, or a potassium-sparing diuretic such as spironolactone — those combinations can raise blood potassium dangerously. If you take any regular medication, check first. Also note most KCl salt substitutes are not iodised, so if you replace all your table salt you have quietly removed your main iodine source.',
    tier: 2,
  },
  {
    id: 'vitamin_d',
    nutrientIds: ['vitamin_d'],
    compound: 'Vitamin D3 (cholecalciferol)',
    formRationale: 'D3 raises serum 25(OH)D more effectively than D2.',
    doseLow: 25,
    doseHigh: 50,
    unit: 'mcg',
    elementalNote: '25–50 mcg is 1,000–2,000 IU. Labels are almost always in IU; 1 mcg = 40 IU.',
    timing: 'with-dinner',
    timingRationale: 'Fat-soluble — absorption is meaningfully better with a fat-containing meal.',
    closes:
      'Not a vegetable gap at all — a sunlight one. Included because it is among the most commonly inadequate nutrients in absolute terms, and among the most commonly over-taken.',
    confidence: 'well-established',
    caveat:
      'The 4,000 IU (100 mcg) upper limit is easy to blow past: 5,000 IU softgels are a standard retail size and exceed it on their own. 1,000–2,000 IU is the sensible unmeasured dose. If you want to go higher, get a 25(OH)D test first rather than guessing.',
    tier: 2,
  },
  {
    id: 'lutein',
    nutrientIds: ['lutein_zeaxanthin'],
    compound: 'Lutein + zeaxanthin (marigold extract)',
    formRationale: 'The AREDS2 ratio, 10 mg lutein to 2 mg zeaxanthin, is the studied combination.',
    doseLow: 10,
    doseHigh: 12,
    unit: 'mg',
    timing: 'with-dinner',
    timingRationale: 'Carotenoids need dietary fat to absorb.',
    closes:
      'Dark leafy greens supply about ten times more of these per serving than any non-vegetable food. Egg yolk is the honourable exception and is unusually well absorbed, but you cannot eat enough eggs to match a serving of kale.',
    confidence: 'reasonable-inference',
    caveat:
      'Honest position: the outcome evidence is for slowing progression of existing intermediate macular degeneration in older adults. There is no established benefit for a healthy adult in his thirties. This is a real dietary gap with no demonstrated consequence at your age — worth closing cheaply if you want to, not worth worrying about.',
    tier: 2,
  },
  {
    id: 'creatine',
    nutrientIds: [],
    compound: 'Creatine monohydrate',
    formRationale:
      'Monohydrate. Every other form is more expensive and none has beaten it. Micronised only affects how well it stays suspended in water.',
    doseLow: 3,
    doseHigh: 5,
    unit: 'g',
    timing: 'any',
    timingRationale:
      'Timing is irrelevant — what matters is total muscle saturation, which is a function of taking it every day. Take it whenever you will actually remember.',
    closes:
      'Not a gap — an ergogenic. Already in the stack at 5 g/day, which is correct. No loading phase needed; loading only reaches saturation faster, not higher.',
    confidence: 'well-established',
    caveat:
      'Well-supported for strength and repeated high-intensity work. The evidence for endurance and VO2 max specifically is weak-to-absent, so do not count it toward that goal. The expected 1–2 kg of scale weight in the first weeks is intracellular water, not fat — the app will treat it as a perturbation rather than letting it corrupt the trend.',
    tier: 1,
  },
];

/**
 * Would adding this recommendation push the user over an upper limit, given
 * what they already take?
 *
 * @returns `null` when safe, otherwise the nutrient id and the projected total
 */
export function recommendationExceedsUpperLimit(
  rec: SupplementRecommendation,
  currentStack: SupplementStack,
  db: MicronutrientDatabase,
  person: PersonContext,
): { nutrientId: string; projected: number; upperLimit: number; unit: string } | null {
  const byNutrient = new Map<string, NutrientDefinition>();
  for (const d of db.nutrients) byNutrient.set(d.id, d);

  for (const nutrientId of rec.nutrientIds) {
    const def = byNutrient.get(nutrientId);
    if (!def) continue;
    const ul = resolveUpperLimit(def, person);
    if (ul === null) continue;

    let existing = 0;
    for (const p of currentStack.products) {
      for (const c of p.perDose) {
        if (c.nutrientId !== nutrientId) continue;
        if (countsTowardUpperLimit(def.upperLimitBasis, { ...c, source: c.source ?? 'supplement' })) {
          existing += c.amount * p.dosesPerDay;
        }
      }
    }

    // Check the top of the recommended range — the worst case the user might take.
    const projected = existing + rec.doseHigh;
    if (projected > ul) {
      return { nutrientId, projected, upperLimit: ul, unit: def.unit };
    }
  }
  return null;
}

/**
 * Pick the recommendations that address the user's actual gaps, filtering out
 * any that would breach a UL on top of the existing stack.
 *
 * Non-nutrient entries (creatine) are never auto-suggested by gap analysis —
 * they have no gap to match — and are surfaced separately.
 */
export function recommendationsForGaps(
  gaps: readonly AdequacyAssessment[],
  currentStack: SupplementStack,
  db: MicronutrientDatabase,
  person: PersonContext,
  protocol: readonly SupplementRecommendation[] = GAP_CLOSING_PROTOCOL,
): { safe: SupplementRecommendation[]; wouldExceedUpperLimit: SupplementRecommendation[] } {
  const gapIds = new Set(gaps.map((g) => g.nutrientId));
  const matching = protocol.filter(
    (r) => r.nutrientIds.length > 0 && r.nutrientIds.some((n) => gapIds.has(n)),
  );

  const safe: SupplementRecommendation[] = [];
  const wouldExceed: SupplementRecommendation[] = [];
  for (const r of matching) {
    if (recommendationExceedsUpperLimit(r, currentStack, db, person)) wouldExceed.push(r);
    else safe.push(r);
  }
  return { safe, wouldExceedUpperLimit: wouldExceed };
}
