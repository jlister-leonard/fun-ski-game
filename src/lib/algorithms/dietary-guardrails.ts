/**
 * dietary-guardrails.ts
 *
 * Safety validators for the personalization layer: ARFID-aware tracking
 * safety, dietary-restriction plausibility, and micronutrient upper-limit
 * checking.
 *
 * `guardrails.ts` handles the population-level nutrition safety case — energy
 * floors, loss rates, eating-disorder screening, clinical referral. This module
 * handles the cases that only arise once the app knows something about *this*
 * person's food restrictions, and it defers to `guardrails.ts` wherever the two
 * overlap. Nothing here loosens anything there.
 *
 * The organising principle, stated plainly because it drives every design
 * choice below:
 *
 * > A calorie tracker is a piece of equipment that can hurt someone with a
 * > restrictive eating disorder. The mitigation is not a disclaimer. It is
 * > that the product refuses to reward eating less, refuses to make the
 * > deficit the score, and can be operated usefully with the calorie numbers
 * > switched off entirely.
 *
 * Concretely, that means this module will:
 * - detect sustained under-eating and respond supportively, never by lowering a
 *   target (see `guardrails.ts`: "Never respond to a suspiciously low food log
 *   by lowering the target")
 * - refuse to emit any positive finding for a large deficit day
 * - treat adequacy floors as first-class findings, at least as prominent as
 *   deficit progress
 * - flag when a requested rate of loss combined with a restricted food list
 *   makes nutritional adequacy implausible
 *
 * And it will never:
 * - tell a user a food is safe for them to eat (see {@link OAS_COPY})
 * - suggest, schedule, or prompt a food challenge
 * - produce streak, badge, or any other reward tied to intake being low
 *
 * Zero runtime dependencies. Pure functions. No I/O.
 *
 * @module dietary-guardrails
 */

import type { Finding } from './guardrails';
import type {
  AdequacyAssessment,
  MicronutrientDatabase,
  PersonContext,
  StackOverlap,
  SupplementStack,
} from './micronutrients';
import { findStackOverlaps, resolveUpperLimit } from './micronutrients';

/* ------------------------------------------------------------------ */
/* Finding constructors                                                */
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
function block(code: string, message: string): Finding {
  return { ok: false, level: 'block', code, message };
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Personalization-layer limits. Distinct from `guardrails.LIMITS`, which owns
 * the population floors. Where both apply, the stricter wins.
 */
export const DIET_LIMITS = {
  /** Fraction of target below which a day counts as under-eaten. */
  UNDEREAT_DAY_FRACTION: 0.8,
  /** Fraction of target below which a day counts as severely under-eaten. */
  SEVERE_UNDEREAT_DAY_FRACTION: 0.6,
  /** Under-eaten days within the window that trigger a `warn`. */
  UNDEREAT_DAYS_WARN: 4,
  /** Under-eaten days within the window that escalate. */
  UNDEREAT_DAYS_ESCALATE: 7,
  /** Rolling window, days. */
  UNDEREAT_WINDOW_DAYS: 14,

  /**
   * Protein floor for someone training in a deficit, g/kg bodyweight/day.
   * Below this, the deficit costs more lean mass than it needs to. This is a
   * floor for *adequacy*, not a ceiling — `guardrails.LIMITS.PROTEIN_G_PER_KG`
   * owns the upper bound.
   */
  PROTEIN_FLOOR_G_PER_KG: 1.6,
  /** Hard floor. Below this, flag regardless of goal. */
  PROTEIN_HARD_FLOOR_G_PER_KG: 1.2,

  /** Fat floor, g/kg bodyweight/day. Mirrors `guardrails.LIMITS.FAT.minGPerKg`. */
  FAT_FLOOR_G_PER_KG: 0.5,

  /** Fiber floor as a fraction of the energy-scaled AI (14 g/1000 kcal). */
  FIBER_FLOOR_FRACTION: 0.6,

  /**
   * Distinct accepted foods below which variety is narrow enough that adequacy
   * needs checking rather than assuming. Not a diagnostic threshold and must
   * never be presented as one.
   */
  NARROW_VARIETY_FOOD_COUNT: 20,
  /** Food groups (of 6) below which coverage is thin. */
  THIN_GROUP_COVERAGE: 4,

  /** Loss rate above which a restricted food list makes adequacy implausible, %bw/wk. */
  RESTRICTED_DIET_RATE_CEILING_PCT: 0.75,

  /** Deficit size above which the app must not produce any positive framing, kcal. */
  LARGE_DEFICIT_KCAL: 750,
} as const;

/* ------------------------------------------------------------------ */
/* 1. Sustained under-eating                                           */
/* ------------------------------------------------------------------ */

export interface DayIntake {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Energy logged that day, kcal. `null` when the user did not log. */
  kcal: number | null;
  /** Target for that day, kcal. */
  targetKcal: number;
}

export interface UnderEatingAssessment {
  windowDays: number;
  daysLogged: number;
  underEatenDays: number;
  severelyUnderEatenDays: number;
  meanShortfallKcal: number;
  findings: Finding[];
}

/**
 * Detect sustained under-eating relative to target.
 *
 * Two things this deliberately does *not* do.
 *
 * It does not lower the target. A run of low logged days is at least as likely
 * to be under-logging as under-eating, and the one response that is wrong in
 * both cases is to prescribe less food. `guardrails.validateLoggedDay` handles
 * the plausibility question separately.
 *
 * It does not escalate on tone. The copy is flat and practical. Alarming
 * someone about their eating is a reliable way to make them log less rather
 * than eat more, which destroys the signal and helps nobody.
 *
 * Unlogged days are excluded from the ratio rather than counted as zero — a
 * missing log is missing data, not a fast — but a low logging rate is reported
 * separately, because it is itself worth knowing.
 *
 * @param days most recent days first or last, order does not matter
 */
export function detectSustainedUnderEating(days: readonly DayIntake[]): UnderEatingAssessment {
  const window = days.slice(-DIET_LIMITS.UNDEREAT_WINDOW_DAYS);
  const logged = window.filter((d) => d.kcal !== null && Number.isFinite(d.kcal));

  let under = 0;
  let severe = 0;
  let shortfallSum = 0;

  for (const d of logged) {
    const kcal = d.kcal as number;
    if (d.targetKcal <= 0) continue;
    const ratio = kcal / d.targetKcal;
    if (ratio < DIET_LIMITS.UNDEREAT_DAY_FRACTION) {
      under++;
      shortfallSum += d.targetKcal - kcal;
    }
    if (ratio < DIET_LIMITS.SEVERE_UNDEREAT_DAY_FRACTION) severe++;
  }

  const findings: Finding[] = [];
  const meanShortfall = under > 0 ? Math.round(shortfallSum / under) : 0;

  if (logged.length === 0) {
    findings.push(ok('UNDEREAT_NO_DATA'));
  } else if (severe >= DIET_LIMITS.UNDEREAT_DAYS_WARN) {
    findings.push(
      warn(
        'BEHAVIOUR_SEVERE_UNDEREATING',
        `Intake has been well under target on ${severe} of the last ${logged.length} logged days — averaging about ${meanShortfall} kcal short. If that is under-logging, no action needed. If it is not, eating closer to target will get you better training and better body composition than the extra deficit will. This is worth talking to someone about.`,
      ),
    );
  } else if (under >= DIET_LIMITS.UNDEREAT_DAYS_ESCALATE) {
    findings.push(
      warn(
        'BEHAVIOUR_SUSTAINED_UNDEREATING',
        `You have come in under target on ${under} of the last ${logged.length} logged days, by about ${meanShortfall} kcal on average. Worth a look — either the target is set too high for how you actually eat, or the deficit is bigger than the one you signed up for.`,
      ),
    );
  } else if (under >= DIET_LIMITS.UNDEREAT_DAYS_WARN) {
    findings.push(
      info(
        'BEHAVIOUR_UNDEREATING_PATTERN',
        `${under} of your last ${logged.length} logged days came in under target. Nothing alarming; just noting the pattern.`,
      ),
    );
  } else {
    findings.push(ok('UNDEREAT_OK'));
  }

  // Threshold is 60% rather than 50% so that "logged every other day" — the
  // single most common sparse pattern — actually trips it.
  if (window.length >= 7 && logged.length < window.length * 0.6) {
    findings.push(
      info(
        'LOGGING_SPARSE',
        `About half the last ${window.length} days have no food log. That is fine — the estimates just get less confident, and the app will say so rather than pretend otherwise.`,
      ),
    );
  }

  return {
    windowDays: window.length,
    daysLogged: logged.length,
    underEatenDays: under,
    severelyUnderEatenDays: severe,
    meanShortfallKcal: meanShortfall,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Macro and fiber floors                                           */
/* ------------------------------------------------------------------ */

export interface MacroFloorInput {
  bodyweightKg: number;
  proteinG: number;
  fatG: number;
  fiberG: number;
  energyKcal: number;
  /** `true` when the user is in a deliberate deficit. Tightens the protein floor. */
  inDeficit: boolean;
}

/**
 * Check the adequacy floors.
 *
 * These are surfaced with at least the prominence of deficit progress. That is
 * a UI requirement stated here because it is a safety property, not a design
 * preference: if the only number with visual weight is "calories remaining",
 * the product is teaching that eating less is the goal.
 */
export function checkMacroFloors(input: MacroFloorInput): Finding[] {
  const out: Finding[] = [];
  const { bodyweightKg, proteinG, fatG, fiberG, energyKcal, inDeficit } = input;

  if (!(bodyweightKg > 0)) {
    return [block('FLOOR_NO_BODYWEIGHT', 'Bodyweight is needed before adequacy floors can be checked.')];
  }

  // --- Protein ------------------------------------------------------
  const proteinPerKg = proteinG / bodyweightKg;
  if (proteinPerKg < DIET_LIMITS.PROTEIN_HARD_FLOOR_G_PER_KG) {
    out.push(
      warn(
        'PROTEIN_BELOW_HARD_FLOOR',
        `Protein is at ${proteinPerKg.toFixed(1)} g/kg. In a deficit with hard training, under ${DIET_LIMITS.PROTEIN_HARD_FLOOR_G_PER_KG} g/kg means you lose more muscle than you need to for the same fat loss. Worth fixing before anything else on this list.`,
      ),
    );
  } else if (inDeficit && proteinPerKg < DIET_LIMITS.PROTEIN_FLOOR_G_PER_KG) {
    out.push(
      info(
        'PROTEIN_BELOW_FLOOR',
        `Protein is at ${proteinPerKg.toFixed(1)} g/kg. ${DIET_LIMITS.PROTEIN_FLOOR_G_PER_KG} g/kg or above holds onto more lean mass while you are cutting.`,
      ),
    );
  } else {
    out.push(ok('PROTEIN_FLOOR_OK'));
  }

  // --- Fat ----------------------------------------------------------
  const fatPerKg = fatG / bodyweightKg;
  const fatPctEnergy = energyKcal > 0 ? ((fatG * 9) / energyKcal) * 100 : 0;
  if (fatPerKg < DIET_LIMITS.FAT_FLOOR_G_PER_KG) {
    out.push(
      warn(
        'FAT_BELOW_FLOOR',
        `Fat is at ${fatPerKg.toFixed(2)} g/kg (${Math.round(fatPctEnergy)}% of energy). Below about ${DIET_LIMITS.FAT_FLOOR_G_PER_KG} g/kg you start compromising fat-soluble vitamin absorption and hormone production. Vitamins A, D, E and K all need fat in the same meal to be absorbed, so this one has knock-on effects across the adequacy screen.`,
      ),
    );
  } else {
    out.push(ok('FAT_FLOOR_OK'));
  }

  // --- Fiber --------------------------------------------------------
  const fiberTarget = Math.round((14 * energyKcal) / 1000);
  if (fiberTarget > 0 && fiberG < fiberTarget * DIET_LIMITS.FIBER_FLOOR_FRACTION) {
    out.push(
      info(
        'FIBER_BELOW_FLOOR',
        `Fiber is at ${Math.round(fiberG)} g against about ${fiberTarget} g for your intake. In a deficit this is mostly a hunger problem — fiber is one of the cheapest ways to make a smaller number of calories feel like more food.`,
      ),
    );
  } else {
    out.push(ok('FIBER_FLOOR_OK'));
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 3. Upper-limit exceedance                                           */
/* ------------------------------------------------------------------ */

export interface UpperLimitCheckInput {
  assessments: readonly AdequacyAssessment[];
  stack?: SupplementStack;
  db?: MicronutrientDatabase;
  person?: PersonContext;
  /** Product ids the user has attested a clinician directed. Downgrades to info. */
  clinicianDirectedProductIds?: readonly string[];
}

/**
 * Upper-limit checking, with attribution back to the products responsible.
 *
 * The three highest-value cases, and why:
 *
 * - **Vitamin B6.** Sensory peripheral neuropathy, sometimes irreversible.
 *   B-complex and "energy" products routinely carry 50–100 mg of pyridoxine,
 *   so two products clears the 100 mg UL. EFSA set a far lower UL (12 mg) on
 *   the same evidence base — a genuine disagreement between authorities that
 *   the copy acknowledges rather than papers over.
 * - **Zinc.** The UL endpoint *is* copper depletion, so the finding names the
 *   consequence rather than just the number.
 * - **Preformed vitamin A.** Liver plus a retinol-containing multivitamin.
 *
 * Nothing here blocks. Exceeding a UL is a reason to look at a label, not a
 * reason to lock someone out of their food diary.
 */
export function checkUpperLimits(input: UpperLimitCheckInput): Finding[] {
  const out: Finding[] = [];
  const directed = new Set(input.clinicianDirectedProductIds ?? []);

  const overlaps: StackOverlap[] =
    input.stack && input.db && input.person
      ? findStackOverlaps(input.stack, input.db, input.person)
      : [];
  const overlapByNutrient = new Map(overlaps.map((o) => [o.nutrientId, o]));

  for (const a of input.assessments) {
    if (a.upperLimitStatus !== 'exceeded' || a.upperLimit === null) continue;

    const overlap = overlapByNutrient.get(a.nutrientId);
    const allSources = overlap?.products ?? a.contributors;
    const culprits = allSources.slice(0, 3);

    // Downgrade to `info` when the clinician-directed products are what pushed
    // this over — i.e. without them the intake would be within the limit.
    // Requiring *every* contributor to be directed would be wrong: a 5,000 IU
    // prescribed D3 plus 1,000 IU incidentally in a multivitamin is still a
    // prescribed-dose situation, not a mistake the user made.
    const undirectedTotal = allSources
      .filter((c) => !directed.has(c.id))
      .reduce((s, c) => s + c.amount, 0);
    const explainedByDirected =
      directed.size > 0 &&
      allSources.some((c) => directed.has(c.id)) &&
      undirectedTotal <= a.upperLimit;

    const attribution =
      culprits.length > 1
        ? ` It is coming from more than one place: ${culprits.map((c) => c.label).join(', ')}.`
        : culprits.length === 1
          ? ` Mostly from ${culprits[0]!.label}.`
          : '';

    const consequence = UL_CONSEQUENCE[a.nutrientId] ?? '';
    const code = `UL_EXCEEDED_${a.nutrientId.toUpperCase()}`;
    const msg =
      `${a.name}: ${round(a.intakeAgainstUpperLimit)} ${a.unit} against an upper limit of ${round(a.upperLimit)} ${a.unit}.` +
      attribution +
      (consequence ? ` ${consequence}` : '');

    out.push(
      explainedByDirected ? info(code, `${msg} Noted as clinician-directed.`) : warn(code, msg),
    );
  }

  // Overlaps that are not yet over the limit are still worth surfacing once.
  for (const o of overlaps) {
    if (o.upperLimit === null) continue;
    if (o.total > o.upperLimit) continue; // already reported above
    if (o.total < o.upperLimit * 0.8) continue;
    out.push(
      info(
        `UL_STACK_OVERLAP_${o.nutrientId.toUpperCase()}`,
        `${o.products.length} of your supplements contain ${o.name}, totalling ${round(o.total)} ${o.unit} against an upper limit of ${round(o.upperLimit)} ${o.unit}. Not over it, but there is no headroom left if you add anything else.`,
      ),
    );
  }

  if (out.length === 0) out.push(ok('UL_OK'));
  return out;
}

/** Why the UL exists, in one sentence, for the nutrients where it is useful to say. */
const UL_CONSEQUENCE: Readonly<Record<string, string>> = {
  vitamin_b6:
    'The reason for the limit is nerve damage in the hands and feet, which does not always fully reverse. Note that European and US authorities disagree here — EFSA sets the limit far lower, at 12 mg.',
  zinc: 'Sustained high zinc causes copper deficiency, which shows up as anaemia and nerve symptoms and is easy to miss.',
  vitamin_a:
    'This limit is about preformed vitamin A only — carotenoids from food do not count towards it. Chronic excess is linked to bone and liver problems.',
  vitamin_d: 'Many retail softgels are 5,000 IU, which is above the limit on its own. If a doctor told you to take that, mark it and this will stop flagging.',
  selenium: 'Brazil nuts vary enormously by origin; a daily handful can approach this limit by itself.',
  iron: 'The limit is about gut irritation. Iron is also one to get a blood test for rather than guess at.',
  folate:
    'This limit is about folic acid specifically, not folate from food. High folic acid can hide a B12 deficiency while nerve damage continues.',
  magnesium: 'This limit is about supplements only — magnesium from food is not restricted. The effect at high doses is diarrhoea, not toxicity.',
  iodine: 'Both too little and too much affect the thyroid. Kelp supplements are the usual cause of too much.',
};

function round(n: number): number {
  return n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
}

/**
 * Standalone check: does the stack contain enough zinc, relative to copper, to
 * be worth mentioning even when the zinc UL is not breached?
 *
 * The zinc:copper antagonism bites below the UL on long timescales, and copper
 * deficiency is under-diagnosed. Worth one `info`, not a campaign.
 */
export function checkZincCopperBalance(
  stack: SupplementStack,
  db: MicronutrientDatabase,
  person: PersonContext,
): Finding[] {
  let zinc = 0;
  let copper = 0;
  for (const p of stack.products) {
    for (const c of p.perDose) {
      if (c.nutrientId === 'zinc') zinc += c.amount * p.dosesPerDay;
      if (c.nutrientId === 'copper') copper += c.amount * p.dosesPerDay;
    }
  }
  if (zinc <= 0) return [ok('ZINC_COPPER_OK')];

  const zincDef = db.nutrients.find((d) => d.id === 'zinc');
  const zincUl = zincDef ? resolveUpperLimit(zincDef, person) : null;
  const highZinc = zincUl !== null ? zinc >= zincUl * 0.6 : zinc >= 25;

  if (highZinc && copper === 0) {
    return [
      info(
        'ZINC_WITHOUT_COPPER',
        `Your stack has ${round(zinc)} mg of supplemental zinc and no copper. Zinc blocks copper absorption, and taken at this level for months that can tip into copper deficiency. Most well-formulated zinc products include a little copper for exactly this reason — worth checking the label.`,
      ),
    ];
  }
  return [ok('ZINC_COPPER_OK')];
}

/**
 * High-dose biotin interferes with common laboratory immunoassays — troponin,
 * thyroid panels — producing clinically misleading results. The FDA has issued
 * safety communications about this. Almost no app surfaces it and it is
 * genuinely worth knowing before a blood test.
 */
export function checkBiotinAssayInterference(stack: SupplementStack): Finding[] {
  let biotin = 0;
  for (const p of stack.products) {
    for (const c of p.perDose) {
      if (c.nutrientId === 'biotin') biotin += c.amount * p.dosesPerDay;
    }
  }
  // 30 mcg is the AI. Interference is described at the 5,000–10,000 mcg doses
  // sold for hair and nails; 1,000 mcg is a conservative trigger.
  if (biotin >= 1000) {
    return [
      info(
        'BIOTIN_ASSAY_INTERFERENCE',
        `Your stack has ${Math.round(biotin)} mcg of biotin — that is well above a dietary amount, which is normal for hair-and-nail products. Worth knowing: biotin at these doses interferes with several common blood tests, including thyroid panels and the troponin test used to diagnose heart attacks. Mention it to whoever takes your blood, and it is generally suggested to pause it beforehand.`,
      ),
    ];
  }
  return [ok('BIOTIN_OK')];
}

/* ------------------------------------------------------------------ */
/* 4. Restricted diet + aggressive rate = implausible adequacy         */
/* ------------------------------------------------------------------ */

/** The six groups used for coverage. Matches the CBT-AR variety framing. */
export type FoodGroup = 'grains' | 'protein' | 'dairy' | 'fruit' | 'vegetables' | 'fats';

export const FOOD_GROUPS: readonly FoodGroup[] = [
  'grains',
  'protein',
  'dairy',
  'fruit',
  'vegetables',
  'fats',
];

export interface RestrictedDietPlausibilityInput {
  /** Distinct foods on the user's accepted-foods list. */
  acceptedFoodCount: number;
  /** Which of the six groups the accepted list covers. */
  coveredGroups: readonly FoodGroup[];
  /** Requested rate of loss, %bw/week. Negative for loss. */
  ratePctBwPerWeek: number;
  /** Prescribed energy, kcal/day. */
  targetKcal: number;
  /** Estimated maintenance, kcal/day. */
  maintenanceKcal: number;
  /** Whether the user has a supplement stack configured at all. */
  hasSupplementStack: boolean;
  /** Count of nutrients currently short after food + supplements. */
  shortNutrientCount?: number;
}

/**
 * The check that ties the two halves of this spec together.
 *
 * A narrow accepted-foods list and an aggressive deficit are each survivable.
 * Together they are the specific combination that produces the deficiency case
 * reports: fewer foods means fewer nutrient sources, and less food means less
 * of each. The published ARFID case literature is dominated by vitamin C and
 * vitamin A deficiency in people whose weight was often unremarkable — which
 * is the point. You cannot infer adequacy from the scale.
 *
 * The response is to constrain the *rate*, not the food list. Telling someone
 * with sensory food avoidance to eat more foods is not a setting the app gets
 * to change; slowing the cut is.
 */
export function checkRestrictedDietPlausibility(
  input: RestrictedDietPlausibilityInput,
): Finding[] {
  const out: Finding[] = [];
  const {
    acceptedFoodCount,
    coveredGroups,
    ratePctBwPerWeek,
    targetKcal,
    maintenanceKcal,
    hasSupplementStack,
    shortNutrientCount = 0,
  } = input;

  const lossRate = ratePctBwPerWeek < 0 ? Math.abs(ratePctBwPerWeek) : 0;
  const deficitKcal = Math.max(0, maintenanceKcal - targetKcal);
  const narrow = acceptedFoodCount > 0 && acceptedFoodCount < DIET_LIMITS.NARROW_VARIETY_FOOD_COUNT;
  const thinCoverage = coveredGroups.length < DIET_LIMITS.THIN_GROUP_COVERAGE;
  const aggressive = lossRate > DIET_LIMITS.RESTRICTED_DIET_RATE_CEILING_PCT;

  if ((narrow || thinCoverage) && aggressive) {
    out.push(
      warn(
        'RESTRICTED_DIET_RATE_IMPLAUSIBLE',
        `You are working from ${acceptedFoodCount} foods across ${coveredGroups.length} of six food groups, and asking for ${lossRate.toFixed(2)}% of bodyweight a week. Those two do not go together well: fewer foods means fewer sources of each nutrient, and a big deficit means less of all of them. Slowing to about ${DIET_LIMITS.RESTRICTED_DIET_RATE_CEILING_PCT}% a week gives you room to cover the nutrition without changing what you eat. The fat loss arrives a few weeks later and you keep more muscle.`,
      ),
    );
  } else if (narrow && !hasSupplementStack) {
    out.push(
      info(
        'RESTRICTED_DIET_NO_STACK',
        `A shorter food list is workable — it just means a few nutrients need covering deliberately rather than by accident. Setting up your supplements in the app lets it show you what is actually still missing instead of guessing.`,
      ),
    );
  }

  if (thinCoverage && coveredGroups.length > 0) {
    const missing = FOOD_GROUPS.filter((g) => !coveredGroups.includes(g));
    out.push(
      info(
        'FOOD_GROUP_COVERAGE_THIN',
        `Your accepted foods cover ${coveredGroups.length} of six groups. The ones not represented are ${missing.join(', ')}. That is information, not a problem — it tells the app where to look for gaps rather than telling you what to eat.`,
      ),
    );
  }

  if (deficitKcal >= DIET_LIMITS.LARGE_DEFICIT_KCAL && (narrow || thinCoverage)) {
    out.push(
      info(
        'LARGE_DEFICIT_RESTRICTED_DIET',
        `A ${Math.round(deficitKcal)} kcal deficit on a shorter food list makes the micronutrient side matter more than it usually would. The adequacy screen is the one to watch here, more than the calorie number.`,
      ),
    );
  }

  if (shortNutrientCount >= 5 && aggressive) {
    out.push(
      warn(
        'ADEQUACY_IMPLAUSIBLE_AT_RATE',
        `${shortNutrientCount} nutrients are currently short, and the deficit you are running makes that harder rather than easier to fix. Either the rate comes down or the gaps get covered deliberately — those are the two levers.`,
      ),
    );
  }

  if (out.length === 0) out.push(ok('RESTRICTED_DIET_OK'));
  return out;
}

/* ------------------------------------------------------------------ */
/* 5. ARFID-aware tracking safety                                      */
/* ------------------------------------------------------------------ */

/**
 * Product configuration that the safety layer can read and enforce.
 *
 * These are not user preferences in the ordinary sense. `hideCalories` in
 * particular is a safety affordance: the ability to use the whole product —
 * adequacy, protein, training — with the energy numbers switched off is what
 * makes it usable by someone for whom calorie numbers are the hazard.
 */
export interface TrackingSafetyConfig {
  /** Energy numbers hidden everywhere. Adequacy and protein remain visible. */
  hideCalories: boolean;
  /** Show adequacy at least as prominently as deficit progress. Not toggleable to `false`. */
  adequacyProminence: 'equal-or-greater';
  /** Must always be `false`. Present so the invariant is checkable, not configurable. */
  gamification: false;
  /** Must always be `false`. */
  streaks: false;
  /** Must always be `false`. Under-budget days are never framed as achievement. */
  celebrateUnderBudget: false;
  /** Must always be `false`. "You'd weigh X in 5 weeks" projections. */
  weightProjections: boolean;
}

/**
 * The configuration this product ships with, and the invariants it must hold.
 *
 * Exported so a test can assert them. A regression here is a safety regression,
 * not a cosmetic one — the whole point of encoding it as data is that "we
 * decided not to have streaks" survives the person who decided it leaving.
 */
export const REQUIRED_TRACKING_SAFETY: TrackingSafetyConfig = {
  hideCalories: false,
  adequacyProminence: 'equal-or-greater',
  gamification: false,
  streaks: false,
  celebrateUnderBudget: false,
  weightProjections: false,
};

/**
 * Validate a runtime tracking configuration against the invariants.
 *
 * Returns `block` findings, because a build that ships streaks tied to intake
 * is not a build that should run. This is intended to be called from a test and
 * from app bootstrap.
 */
export function validateTrackingSafety(config: TrackingSafetyConfig): Finding[] {
  const out: Finding[] = [];

  if (config.gamification !== false) {
    out.push(
      block(
        'SAFETY_GAMIFICATION_ENABLED',
        'Gamification tied to food intake is not permitted in this product. Rewarding a user for eating less is the specific mechanism by which tracking apps make restrictive eating worse.',
      ),
    );
  }
  if (config.streaks !== false) {
    out.push(
      block(
        'SAFETY_STREAKS_ENABLED',
        'Logging streaks are not permitted. A streak converts a missed day into a loss, which is a coercion mechanism, and streaks on intake reward restriction directly.',
      ),
    );
  }
  if (config.celebrateUnderBudget !== false) {
    out.push(
      block(
        'SAFETY_CELEBRATES_UNDER_BUDGET',
        'Coming in under target is not an achievement and must never be presented as one.',
      ),
    );
  }
  if (config.weightProjections) {
    out.push(
      warn(
        'SAFETY_WEIGHT_PROJECTION_ENABLED',
        'Forward weight projections from a single day of logging ("if every day were like today, you would weigh X") are disabled by default. They are inaccurate, and they make a single day feel consequential in a way that drives restriction.',
      ),
    );
  }
  if (config.adequacyProminence !== 'equal-or-greater') {
    out.push(
      block(
        'SAFETY_ADEQUACY_DEPRIORITISED',
        'Adequacy must be at least as prominent as deficit progress. A screen whose only weighted number is calories remaining teaches that less is the goal.',
      ),
    );
  }

  if (out.length === 0) out.push(ok('SAFETY_CONFIG_OK'));
  return out;
}

/**
 * Guard on a day-summary string before it is shown.
 *
 * Cheap, and it catches the class of copy that creeps in during polish work:
 * "great job staying under!", "you saved 600 calories". Returns a `block`
 * finding when the copy congratulates a deficit.
 *
 * Intended for a lint-style test over the app's copy constants, not for
 * runtime filtering of dynamic text.
 */
export function checkDaySummaryCopy(copy: string): Finding[] {
  const lowered = copy.toLowerCase();
  const congratulatory = [
    'great job',
    'well done',
    'nice work',
    'crushed it',
    'smashed it',
    'on fire',
    'keep the streak',
    'you saved',
    'under budget',
    'calories left over',
    'good day',
  ];
  const hit = congratulatory.find((p) => lowered.includes(p));
  if (hit) {
    return [
      block(
        'COPY_CELEBRATES_DEFICIT',
        `Day-summary copy contains "${hit}". Praise attached to intake being low is the pattern this product does not ship. State the number; do not score it.`,
      ),
    ];
  }
  return [ok('COPY_OK')];
}

/* ------------------------------------------------------------------ */
/* 6. Professional-support prompt — once, dismissible                  */
/* ------------------------------------------------------------------ */

export interface SupportPromptState {
  /** Has this prompt been shown before? */
  shown: boolean;
  /** Did the user dismiss it? */
  dismissed: boolean;
  /** ISO date it was last shown. */
  lastShownDate?: string;
}

export interface SupportPrompt {
  code: string;
  title: string;
  body: string;
  /** Always true. The prompt is never modal, never blocking, never repeated. */
  dismissible: true;
  showResources: boolean;
}

/**
 * Decide whether to surface a "this might be worth talking to someone about"
 * prompt.
 *
 * Design constraint, stated because it is easy to get wrong in the direction of
 * "more care": this appears **once**, is dismissible, and does not come back
 * once dismissed. A prompt that reappears is a prompt that gets learned as
 * noise, and repeatedly telling someone their eating looks concerning is itself
 * a harm — particularly for a user whose restriction is sensory rather than
 * weight-motivated, for whom the framing may be simply wrong.
 *
 * The eating-disorder *gate* in `guardrails.scoreScoff` is a different
 * mechanism with different rules, and it is a real gate. This is not that.
 *
 * @param findings all findings gathered this session
 * @param state persisted prompt state
 * @returns `null` when nothing should be shown
 */
export function supportPrompt(
  findings: readonly Finding[],
  state: SupportPromptState,
): SupportPrompt | null {
  if (state.dismissed) return null;
  if (state.shown) return null;

  const codes = new Set(findings.filter((f) => !f.ok).map((f) => f.code));

  const strong = ['BEHAVIOUR_SEVERE_UNDEREATING', 'ADEQUACY_IMPLAUSIBLE_AT_RATE'];
  if (strong.some((c) => codes.has(c))) {
    return {
      code: 'SUPPORT_PROMPT_DIETITIAN',
      title: 'Worth a conversation',
      body:
        'A registered dietitian who works with restricted eating can do things this app cannot — check your bloods, work out which gaps actually matter for you, and help you widen what you eat at a pace you choose. You do not need a diagnosis or a crisis to be worth an hour of someone\'s time. This will not come up again.',
      dismissible: true,
      showResources: true,
    };
  }

  const moderate = ['BEHAVIOUR_SUSTAINED_UNDEREATING', 'RESTRICTED_DIET_RATE_IMPLAUSIBLE'];
  if (moderate.some((c) => codes.has(c))) {
    return {
      code: 'SUPPORT_PROMPT_CONSIDER',
      title: 'One thing worth knowing',
      body:
        'If you ever want a second opinion on the nutrition side, a dietitian with experience in restricted eating is the person for it — specifically one who works with ARFID rather than general weight management, because the approach is different. Mentioning it once and then leaving it alone.',
      dismissible: true,
      showResources: false,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 7. Oral allergy syndrome — the safety boundary                      */
/* ------------------------------------------------------------------ */

/**
 * What the app may and may not say about oral allergy syndrome.
 *
 * The boundary is absolute and is enforced here rather than left to copywriting
 * discipline:
 *
 * **May**: explain the general mechanism; describe which protein families are
 * heat-labile in general terms; name the recognised pollen-food clusters as
 * background information; note that an allergist can test for specific
 * components; record what the user tells it.
 *
 * **May not**: tell a user any specific food is safe for them; predict that a
 * food will be tolerated cooked; suggest, schedule, or prompt trying a food;
 * present cluster membership as a reason to avoid or to try anything;
 * characterise any reaction as mild.
 *
 * The reason for the hard line, in one sentence: OAS is usually confined to the
 * mouth, but LTP-mediated reactions to the same foods are not, they are not
 * abolished by cooking, and an app cannot distinguish the two from a food log.
 */
export const OAS_COPY = {
  whatItIs:
    'Oral allergy syndrome happens when your immune system confuses a protein in a raw plant food with a pollen protein it already reacts to. The antibodies were made for the pollen; the food just looks similar enough to trigger them. That is why it usually shows up as itching or tingling in the mouth and lips rather than anything further in — the proteins involved are often fragile, and stomach acid breaks most of them down before they get far.',

  cookingGeneral:
    'The proteins behind the common birch-related pattern are heat-sensitive, which is why many people who react to a raw fruit have no trouble with it cooked, canned, or baked. That is a general fact about the proteins, not a prediction about you. A different family of proteins — lipid transfer proteins — survives cooking, survives digestion, and is the one associated with reactions that are not confined to the mouth. Nothing in a food log can tell the two apart.',

  theBoundary:
    'This app will not tell you a food is safe for you, and it will not suggest you try one. That is not caution for its own sake: the tests that distinguish the mild pattern from the one that needs an adrenaline pen are blood tests for specific proteins, and an allergist can order them. If you want to know where you actually stand, that is the conversation to have.',

  neverChallenge:
    'Do not use this app, or anything you read here, as a reason to try a food you react to. Food challenges are done under supervision, with treatment on hand, because that is what makes them safe.',

  recordingOnly:
    'You can record which foods you react to and how. The app uses that to keep them out of suggestions and to work out your nutrition around them. It does not interpret them.',

  seekUrgentCare:
    'Symptoms beyond the mouth — throat tightness, trouble breathing, hives away from the face, vomiting, feeling faint — are not oral allergy syndrome and need urgent medical attention, not a note in an app.',
} as const;

export interface OasDisclosure {
  /** Foods the user has told the app they react to. Free text, never interpreted. */
  reactedFoods: readonly string[];
  /** Whether the user has ever seen an allergist about it. */
  seenAllergist: boolean;
  /** Whether the user reports any reaction beyond the mouth, ever. */
  reportedSystemicSymptoms: boolean;
  /** Whether the user has been prescribed an adrenaline auto-injector. */
  hasEpinephrine?: boolean;
}

/**
 * Findings from what the user has disclosed about food reactions.
 *
 * Note what this does not do. It does not classify their reactions, name a
 * likely pollen, or predict tolerance. It routes.
 */
export function assessOasDisclosure(d: OasDisclosure): Finding[] {
  const out: Finding[] = [];

  if (d.reportedSystemicSymptoms) {
    out.push(
      warn(
        'OAS_SYSTEMIC_REPORTED',
        `${OAS_COPY.seekUrgentCare} You have recorded a reaction that went beyond your mouth. That belongs with an allergist, and the app will keep saying so rather than working around it.`,
      ),
    );
    if (!d.hasEpinephrine) {
      out.push(
        warn(
          'OAS_SYSTEMIC_NO_EPINEPHRINE',
          'You have recorded a reaction beyond the mouth and no adrenaline auto-injector. Whether you need one is a question for a doctor, and it is worth asking soon.',
        ),
      );
    }
  }

  if (d.reactedFoods.length > 0 && !d.seenAllergist) {
    out.push(
      info(
        'OAS_NO_ALLERGIST',
        `${OAS_COPY.theBoundary}`,
      ),
    );
  }

  if (d.reactedFoods.length > 0) {
    out.push(
      info(
        'OAS_FOODS_EXCLUDED',
        `${d.reactedFoods.length} food${d.reactedFoods.length === 1 ? '' : 's'} recorded as causing a reaction. They are excluded from anything the app suggests, and the nutrition targets are worked out around them.`,
      ),
    );
  }

  if (out.length === 0) out.push(ok('OAS_OK'));
  return out;
}

/**
 * Hard assertion: no suggestion list may contain a food the user reacts to,
 * and no suggestion may be generated for a food on the reaction list in any
 * preparation.
 *
 * Matching is deliberately loose — substring, case-insensitive, both
 * directions — because "apple" must exclude "apple sauce" and "green apple",
 * and a false exclusion costs nothing while a false inclusion is the failure
 * this exists to prevent.
 */
export function filterReactedFoods<T extends { label: string }>(
  candidates: readonly T[],
  reactedFoods: readonly string[],
): T[] {
  const reacted = reactedFoods.map((f) => f.trim().toLowerCase()).filter((f) => f.length > 0);
  if (reacted.length === 0) return [...candidates];
  return candidates.filter((c) => {
    const label = c.label.toLowerCase();
    return !reacted.some((r) => label.includes(r) || r.includes(label));
  });
}

/* ------------------------------------------------------------------ */
/* 8. Run everything                                                   */
/* ------------------------------------------------------------------ */

export interface DietaryValidationInput {
  days?: readonly DayIntake[];
  macros?: MacroFloorInput;
  assessments?: readonly AdequacyAssessment[];
  stack?: SupplementStack;
  db?: MicronutrientDatabase;
  person?: PersonContext;
  restriction?: RestrictedDietPlausibilityInput;
  oas?: OasDisclosure;
  trackingConfig?: TrackingSafetyConfig;
  clinicianDirectedProductIds?: readonly string[];
  supportPromptState?: SupportPromptState;
}

export interface DietaryValidationResult {
  findings: Finding[];
  blocked: boolean;
  actionable: Finding[];
  supportPrompt: SupportPrompt | null;
}

/** All findings that are not `ok`, sorted block > warn > info. */
function actionableOf(findings: readonly Finding[]): Finding[] {
  const rank = { block: 0, warn: 1, info: 2 } as const;
  return findings.filter((f) => !f.ok).sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * The function the application layer calls. Individual validators are exported
 * for targeted use and testing.
 */
export function validateDietary(input: DietaryValidationInput): DietaryValidationResult {
  const findings: Finding[] = [];

  if (input.trackingConfig) findings.push(...validateTrackingSafety(input.trackingConfig));
  if (input.days) findings.push(...detectSustainedUnderEating(input.days).findings);
  if (input.macros) findings.push(...checkMacroFloors(input.macros));
  if (input.assessments) {
    findings.push(
      ...checkUpperLimits({
        assessments: input.assessments,
        stack: input.stack,
        db: input.db,
        person: input.person,
        clinicianDirectedProductIds: input.clinicianDirectedProductIds,
      }),
    );
  }
  if (input.stack && input.db && input.person) {
    findings.push(...checkZincCopperBalance(input.stack, input.db, input.person));
    findings.push(...checkBiotinAssayInterference(input.stack));
  }
  if (input.restriction) findings.push(...checkRestrictedDietPlausibility(input.restriction));
  if (input.oas) findings.push(...assessOasDisclosure(input.oas));

  return {
    findings,
    blocked: findings.some((f) => f.level === 'block'),
    actionable: actionableOf(findings),
    supportPrompt: input.supportPromptState
      ? supportPrompt(findings, input.supportPromptState)
      : null,
  };
}
