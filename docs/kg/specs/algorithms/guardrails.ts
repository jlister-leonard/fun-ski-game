/**
 * guardrails.ts
 *
 * Safety validation for nutrition targets, user profiles and logged data.
 *
 * **This module is the only place safety limits live.** `macro-targets.ts`
 * *proposes*; this module *disposes*. Keeping the two separate means a change
 * to the target generator can never silently loosen a limit, and it makes the
 * limits independently testable and auditable.
 *
 * Every check returns a {@link Finding}. The caller must treat any finding with
 * `level: 'block'` as fatal: do not show the target, do not let the user
 * proceed. `warn` findings must be surfaced prominently and acknowledged.
 * `info` findings are educational.
 *
 * Design rules baked in here:
 * - **Never respond to a suspiciously low food log by lowering the target.**
 * - **Never congratulate rapid loss.** Fast loss branches to "check your scale",
 *   then to "check in with a clinician".
 * - **A gate must be a real gate.** Eating-disorder screening results must lock
 *   the session, not show a dismissible dialog the user can re-answer.
 * - **A disclaimer does not cure a bad claim** (FTC Health Products Compliance
 *   Guidance). Fix the claim first; the disclaimer is additional, not a shield.
 *
 * Zero dependencies. Pure functions. No I/O.
 *
 * @module guardrails
 */

/* ------------------------------------------------------------------ */
/* Result type                                                         */
/* ------------------------------------------------------------------ */

export type FindingLevel = 'info' | 'warn' | 'block';

/** A single validation result. */
export interface Finding {
  /** `true` when nothing is wrong. Findings with level `warn`/`block` are always `false`. */
  ok: boolean;
  level: FindingLevel;
  /** Stable machine-readable code. Never reuse a code for a different meaning. */
  code: string;
  /** User-facing message. Plain language, no jargon, no blame. */
  message: string;
}

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

/** True when any finding is a hard block. */
export function hasBlock(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.level === 'block');
}
/** All findings that are not `ok`, sorted block > warn > info. */
export function actionable(findings: readonly Finding[]): Finding[] {
  const rank: Record<FindingLevel, number> = { block: 0, warn: 1, info: 2 };
  return findings.filter((f) => !f.ok).sort((a, b) => rank[a.level] - rank[b.level]);
}

/* ------------------------------------------------------------------ */
/* Limits (single source of truth)                                     */
/* ------------------------------------------------------------------ */

/**
 * Numeric safety limits. Exported so tests, UI copy and server-side validation
 * all read the same constants.
 */
export const LIMITS = {
  /** Absolute energy floor below which nothing is ever prescribed, kcal/day. */
  ABSOLUTE_KCAL_FLOOR: 800,
  /** Guideline floors from the 2013 AHA/ACC/TOS obesity guideline, kcal/day. */
  KCAL_FLOOR_BY_SEX: { female: 1200, male: 1500 } as const,
  /** Prescribed energy below this multiple of BMR is blocked. */
  MIN_KCAL_AS_BMR_MULTIPLE: 0.8,
  /** Prescribed energy below this multiple of BMR is warned about. */
  WARN_KCAL_AS_BMR_MULTIPLE: 1.0,
  /** Energy-availability reference and conservative app caution line, kcal/kg fat-free mass/day. */
  ENERGY_AVAILABILITY: { reference: 45, caution: 30 } as const,
  /** Maximum prescribable loss rate, % bodyweight/week. */
  MAX_LOSS_PCT_BW_PER_WEEK: 1.0,
  /** Loss rate above which we hard-block, % bodyweight/week. */
  BLOCK_LOSS_PCT_BW_PER_WEEK: 1.5,
  /** Maximum prescribable gain rate, % bodyweight/week. */
  MAX_GAIN_PCT_BW_PER_WEEK: 0.5,
  /** BMI thresholds (WHO). */
  BMI: { severeThinness: 16, underweight: 18.5, cautionCeiling: 20, overweight: 25 } as const,
  /** Protein warning and hard-cap thresholds, g/kg bodyweight/day. */
  PROTEIN_G_PER_KG: { warn: 2.5, block: 3.5 } as const,
  /** Protein as a share of energy: AMDR upper bound. */
  PROTEIN_PCT_ENERGY_WARN: 40,
  /** Fat floors. */
  FAT: { minGPerKg: 0.5, hardMinGPerKg: 0.3, minPctEnergy: 20, hardMinPctEnergy: 15 } as const,
  /** Carbohydrate floors, g/day (IOM EAR 100, RDA 130). */
  CARB_G: { info: 130, warn: 100 } as const,
  /** Minimum age for automated weight-loss coaching. */
  MIN_AGE_YEARS: 18,
  /** Goldberg-style EI:BMR ratio below which a weight-stable log is implausible. */
  GOLDBERG_EI_BMR_RATIO: 1.35,
  /** Single-day weight change beyond this is treated as noise, not signal, kg. */
  DAILY_WEIGHT_NOISE_KG: 2.0,
  /** Single-day weight change beyond this is treated as a data error, kg. */
  DAILY_WEIGHT_ERROR_KG: 5.0,
  /** Unintended-loss clinical referral thresholds. */
  UNINTENDED_LOSS: { pct30d: 5, pct180d: 10 } as const,
  /** SCOFF score at or above which the ED gate closes. */
  SCOFF_CUTOFF: 2,
} as const;

/* ------------------------------------------------------------------ */
/* Profile eligibility                                                 */
/* ------------------------------------------------------------------ */

export type Sex = 'male' | 'female';
export type Goal = 'cut' | 'maintain' | 'gain';

export interface UserProfile {
  sex: Sex;
  ageYears: number;
  heightCm: number;
  /** Current trend bodyweight, kg. */
  bodyweightKg: number;
  bodyFatPct?: number;
  goal: Goal;
  /** Target bodyweight, kg. Optional. */
  goalWeightKg?: number;
  /** Target body-fat percentage. Unlocks the rate trade-off explanation. */
  goalBodyFatPct?: number;
  pregnant?: boolean;
  breastfeeding?: boolean;
  /** Weeks postpartum, when breastfeeding. */
  weeksPostpartum?: number;
  /** Self-reported current or past-year eating-disorder diagnosis or treatment. */
  eatingDisorderHistory?: boolean;
  /** Attestation that a clinician is supervising an aggressive plan. */
  clinicianSupervised?: boolean;
}

/** BMI in kg/m². */
export function bmi(bodyweightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return bodyweightKg / (m * m);
}

/**
 * Validate whether a user should be given a weight-change prescription at
 * all. Run this **before** computing any targets.
 *
 * @param p the user profile
 * @returns findings; a `block` means do not prescribe
 */
export function validateProfile(p: UserProfile): Finding[] {
  const out: Finding[] = [];
  const b = bmi(p.bodyweightKg, p.heightCm);

  if (!Number.isFinite(b) || b < 10 || b > 100) {
    out.push(
      block(
        'PROFILE_IMPLAUSIBLE',
        'The height and weight entered give an impossible BMI. Please check the numbers and units.',
      ),
    );
    return out;
  }

  if (p.ageYears < LIMITS.MIN_AGE_YEARS) {
    out.push(
      block(
        'AGE_UNDER_18',
        'This app is built for adults. Nutrition and weight goals for people under 18 need to be set with a paediatrician or a registered dietitian, because energy needs during growth are different and dieting in adolescence carries real risks.',
      ),
    );
  }

  if (p.pregnant) {
    out.push(
      block(
        'PREGNANCY',
        'We do not set weight-loss targets during pregnancy. Your energy and nutrient needs are best managed with your midwife, obstetrician or a registered dietitian.',
      ),
    );
  }

  if (p.breastfeeding && p.goal === 'cut') {
    const weeks = p.weeksPostpartum ?? 0;
    if (weeks < 8) {
      out.push(
        block(
          'LACTATION_EARLY',
          'Deliberate weight loss in the first two months of breastfeeding can affect milk supply. We will hold you at maintenance for now; please talk to your health visitor, midwife or doctor before starting a deficit.',
        ),
      );
    } else {
      out.push(
        warn(
          'LACTATION',
          'While breastfeeding we keep the floor at 1,800 kcal and cap loss at about 0.45 kg per week to protect milk supply. Please check in with a clinician too.',
        ),
      );
    }
  }

  if (p.eatingDisorderHistory) {
    out.push(
      block(
        'ED_HISTORY',
        'You told us you have been diagnosed with or treated for an eating disorder. Calorie and weight tracking can make recovery harder, so we will not set numeric targets. Please see the support options below, and consider working with a clinician who knows your history.',
      ),
    );
  }

  if (b < LIMITS.BMI.severeThinness) {
    out.push(
      block(
        'BMI_SEVERE_THINNESS',
        'Your BMI is in the severely underweight range. We will not set any targets. Please speak to a doctor soon — this warrants a proper assessment rather than an app.',
      ),
    );
  } else if (b < LIMITS.BMI.underweight) {
    if (p.goal === 'cut') {
      out.push(
        block(
          'BMI_UNDERWEIGHT_CUT',
          'Your BMI is below the healthy range, so we will not set a weight-loss target. We can help you maintain or gain instead. If you want to lose weight anyway, that is a conversation to have with a doctor or dietitian.',
        ),
      );
    } else {
      out.push(
        info(
          'BMI_UNDERWEIGHT',
          'Your BMI is below the healthy range. A gradual gain is a reasonable goal; a clinician can help rule out anything underlying.',
        ),
      );
    }
  } else if (b < LIMITS.BMI.cautionCeiling && p.goal === 'cut') {
    out.push(
      warn(
        'BMI_LOW_NORMAL_CUT',
        'Your BMI is at the low end of the healthy range. Losing more weight has little health upside from here. If you are cutting for a sport or a physique goal, keep it slow and time-limited.',
      ),
    );
  }

  if (typeof p.goalWeightKg === 'number' && Number.isFinite(p.goalWeightKg)) {
    const goalBmi = bmi(p.goalWeightKg, p.heightCm);
    if (goalBmi < LIMITS.BMI.underweight) {
      out.push(
        block(
          'GOAL_WEIGHT_UNDERWEIGHT',
          `A goal weight of ${p.goalWeightKg.toFixed(1)} kg would put your BMI at ${goalBmi.toFixed(1)}, below the healthy range of 18.5. We cannot set that as a target. The lowest goal weight we will accept for your height is ${(LIMITS.BMI.underweight * (p.heightCm / 100) ** 2).toFixed(1)} kg.`,
        ),
      );
    }
  }

  if (out.length === 0) out.push(ok('PROFILE_OK'));
  return out;
}

/* ------------------------------------------------------------------ */
/* Rate of change                                                      */
/* ------------------------------------------------------------------ */

/**
 * Validate a *requested* rate of weight change.
 *
 * @param ratePctBwPerWeek signed rate, negative for loss
 * @param p the user profile
 */
export function validateRate(ratePctBwPerWeek: number, p: UserProfile): Finding[] {
  const out: Finding[] = [];
  const magnitude = Math.abs(ratePctBwPerWeek);

  if (ratePctBwPerWeek < 0) {
    if (magnitude > LIMITS.BLOCK_LOSS_PCT_BW_PER_WEEK) {
      out.push(
        block(
          'RATE_LOSS_UNSAFE',
          `Losing ${magnitude.toFixed(2)}% of your bodyweight per week is faster than we will support, and we have capped it at ${LIMITS.MAX_LOSS_PCT_BW_PER_WEEK}%. Past about 1% per week a large and rising share of what you lose is muscle rather than fat, so you end up smaller but not much leaner.`,
        ),
      );
    } else if (magnitude > LIMITS.MAX_LOSS_PCT_BW_PER_WEEK) {
      out.push(
        warn(
          'RATE_LOSS_FAST',
          `${magnitude.toFixed(2)}% per week is above the 1% ceiling we recommend. At this rate roughly ${Math.round(leanLossFraction(magnitude) * 100)}% of what you lose is projected to be lean tissue, against about 5% at 0.5% per week. 0.5-0.75% per week is the sweet spot.`,
        ),
      );
    } else if (magnitude > 0.85 && typeof p.bodyFatPct === 'number' && p.bodyFatPct < 15) {
      out.push(
        info(
          'RATE_LOSS_FAST_FOR_LEAN',
          'At your body-fat level, slower loss (around 0.5-0.7% per week) protects lean mass better.',
        ),
      );
    }
    if (p.breastfeeding) {
      const maxKgPerWeek = 0.45;
      const kgPerWeek = (magnitude / 100) * p.bodyweightKg;
      if (kgPerWeek > maxKgPerWeek) {
        out.push(
          warn(
            'RATE_LOSS_LACTATION',
            `While breastfeeding we cap loss at about 0.45 kg per week. Your requested rate works out at ${kgPerWeek.toFixed(2)} kg per week.`,
          ),
        );
      }
    }
  } else if (ratePctBwPerWeek > 0) {
    if (magnitude > LIMITS.MAX_GAIN_PCT_BW_PER_WEEK) {
      out.push(
        warn(
          'RATE_GAIN_FAST',
          `Gaining faster than about 0.5% of bodyweight per week mostly adds fat. In a trial of elite athletes, a much larger surplus produced five times the fat gain for no extra lean mass.`,
        ),
      );
    }
  }

  // When the user's goal is a body-fat percentage, show them the actual trade.
  if (
    ratePctBwPerWeek < 0 &&
    magnitude > LIMITS.MAX_LOSS_PCT_BW_PER_WEEK * 0.9 &&
    typeof p.bodyFatPct === 'number' &&
    typeof p.goalBodyFatPct === 'number' &&
    p.goalBodyFatPct < p.bodyFatPct
  ) {
    out.push(
      ...explainRateTradeoff(
        p.bodyweightKg,
        p.bodyFatPct,
        p.goalBodyFatPct,
        magnitude,
      ).filter((f) => !f.ok),
    );
  }

  if (out.length === 0) out.push(ok('RATE_OK'));
  return out;
}

/**
 * Clamp a requested rate to the enforceable limits. Call this before
 * generating targets; `validateRate` explains *why*, this makes it so.
 *
 * @param ratePctBwPerWeek the requested signed rate
 * @returns the rate the app will actually use
 */
export function clampRatePctBwPerWeek(ratePctBwPerWeek: number): number {
  if (!Number.isFinite(ratePctBwPerWeek)) return 0;
  if (ratePctBwPerWeek < 0) {
    return -Math.min(Math.abs(ratePctBwPerWeek), LIMITS.MAX_LOSS_PCT_BW_PER_WEEK);
  }
  return Math.min(ratePctBwPerWeek, LIMITS.MAX_GAIN_PCT_BW_PER_WEEK);
}

/* ------------------------------------------------------------------ */
/* Body-fat goal projection                                            */
/* ------------------------------------------------------------------ */

/**
 * Fraction of weight lost that comes from lean tissue, as a function of the
 * rate of loss.
 *
 * Anchors: Garthe et al. 2011 found athletes losing 0.7%/week *gained* 2.1%
 * lean mass over the phase, while those losing 1.4%/week lost a little. Helms
 * et al. 2014 put the practical ceiling at 1%/week. Beyond that the lean-mass
 * cost climbs steeply.
 *
 * Confidence: [reasonable-inference]. The direction and rough magnitude are
 * well supported; the exact curve is a modelling choice, and it assumes
 * resistance training plus adequate protein.
 *
 * @param ratePctBwPerWeek magnitude of loss as % bodyweight per week
 * @returns fraction of the loss that is lean tissue, 0..1
 */
export function leanLossFraction(ratePctBwPerWeek: number): number {
  const r = Math.abs(ratePctBwPerWeek);
  // Piecewise linear through (0.5, 0.05), (1.0, 0.20), (1.5, 0.38), (2.0, 0.50).
  if (r <= 0.5) return 0.05;
  if (r <= 1.0) return 0.05 + ((r - 0.5) / 0.5) * 0.15;
  if (r <= 1.5) return 0.2 + ((r - 1.0) / 0.5) * 0.18;
  return Math.min(0.6, 0.38 + ((r - 1.5) / 0.5) * 0.12);
}

export interface BodyFatProjection {
  /** Weeks to reach the target body-fat percentage, or `null` if unreachable. */
  weeksToTarget: number | null;
  /** Bodyweight at the point the target is reached, kg. */
  endWeightKg: number | null;
  /** Lean mass lost along the way, kg. */
  leanMassLostKg: number | null;
  /** Fat mass lost along the way, kg. */
  fatMassLostKg: number | null;
  ratePctBwPerWeek: number;
}

/**
 * Project how long a given rate of loss takes to reach a target body-fat
 * percentage, accounting for the lean mass sacrificed on the way.
 *
 * This exists to make the rate guardrail *persuasive* rather than arbitrary.
 * Body-fat percentage is `fat / (fat + lean)`. Losing lean mass shrinks the
 * denominator, which partly cancels the numerator you worked to reduce — so
 * past a point, dieting harder reaches a body-fat *percentage* goal barely any
 * sooner, and sometimes later, while costing muscle that took years to build.
 *
 * @example
 * // a body-fat reduction goal: compare a moderate and an aggressive cut.
 * projectBodyFatOutcome(88, 21, 14, 0.7);
 * projectBodyFatOutcome(88, 21, 14, 1.5);
 */
export function projectBodyFatOutcome(
  bodyweightKg: number,
  bodyFatPct: number,
  targetBodyFatPct: number,
  ratePctBwPerWeek: number,
  maxWeeks = 104,
): BodyFatProjection {
  const rate = Math.abs(ratePctBwPerWeek);
  const leanFrac = leanLossFraction(rate);
  let fat = bodyweightKg * (bodyFatPct / 100);
  let lean = bodyweightKg - fat;
  const fat0 = fat;
  const lean0 = lean;

  if (rate <= 0) {
    return {
      weeksToTarget: null, endWeightKg: null, leanMassLostKg: null,
      fatMassLostKg: null, ratePctBwPerWeek: ratePctBwPerWeek,
    };
  }

  for (let wk = 1; wk <= maxWeeks; wk++) {
    const bw = fat + lean;
    const loss = bw * (rate / 100);
    const leanLoss = loss * leanFrac;
    const fatLoss = loss - leanLoss;
    fat = Math.max(0, fat - fatLoss);
    lean = Math.max(0, lean - leanLoss);
    const bfPct = (fat / (fat + lean)) * 100;
    if (bfPct <= targetBodyFatPct) {
      return {
        weeksToTarget: wk,
        endWeightKg: round2(fat + lean),
        leanMassLostKg: round2(lean0 - lean),
        fatMassLostKg: round2(fat0 - fat),
        ratePctBwPerWeek,
      };
    }
  }
  return {
    weeksToTarget: null, endWeightKg: null, leanMassLostKg: null,
    fatMassLostKg: null, ratePctBwPerWeek,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Explain, in the user's own numbers, why a faster cut is a bad trade when the
 * goal is a body-fat *percentage*.
 *
 * @param bodyweightKg current trend bodyweight
 * @param bodyFatPct current body-fat estimate
 * @param targetBodyFatPct the goal
 * @param requestedRatePctBwPerWeek what the user asked for (magnitude)
 * @param recommendedRatePctBwPerWeek what we would rather they did. Default 0.7.
 */
export function explainRateTradeoff(
  bodyweightKg: number,
  bodyFatPct: number,
  targetBodyFatPct: number,
  requestedRatePctBwPerWeek: number,
  recommendedRatePctBwPerWeek = 0.7,
): Finding[] {
  const fast = projectBodyFatOutcome(bodyweightKg, bodyFatPct, targetBodyFatPct, requestedRatePctBwPerWeek);
  const slow = projectBodyFatOutcome(bodyweightKg, bodyFatPct, targetBodyFatPct, recommendedRatePctBwPerWeek);
  if (fast.weeksToTarget === null || slow.weeksToTarget === null) {
    return [ok('RATE_TRADEOFF_NOT_PROJECTABLE')];
  }
  const weeksSaved = slow.weeksToTarget - fast.weeksToTarget;
  const extraLeanLost = (fast.leanMassLostKg ?? 0) - (slow.leanMassLostKg ?? 0);

  const body =
    `Going at ${Math.abs(requestedRatePctBwPerWeek).toFixed(2)}% per week gets you to ${targetBodyFatPct}% body fat in about ` +
    `${fast.weeksToTarget} weeks, and costs roughly ${(fast.leanMassLostKg ?? 0).toFixed(1)} kg of lean mass. ` +
    `At ${recommendedRatePctBwPerWeek.toFixed(2)}% per week it takes about ${slow.weeksToTarget} weeks and costs ` +
    `roughly ${(slow.leanMassLostKg ?? 0).toFixed(1)} kg. ` +
    `So you would save about ${Math.max(0, weeksSaved)} week(s) and give up about ${Math.max(0, extraLeanLost).toFixed(1)} kg of muscle. ` +
    `Body-fat percentage is fat divided by total weight — burning off lean mass shrinks the bottom of that fraction ` +
    `as well as the top, which is why crash dieting moves the percentage far less than it moves the scale.`;

  if (weeksSaved <= 2 && extraLeanLost > 0.5) {
    return [
      warn(
        'RATE_TRADEOFF_POOR',
        `${body} That is a bad trade. We would strongly suggest the slower rate.`,
      ),
    ];
  }
  return [info('RATE_TRADEOFF', body)];
}

/* ------------------------------------------------------------------ */
/* Target validation                                                   */
/* ------------------------------------------------------------------ */

/** The subset of a target set this module needs. Structurally compatible with `MacroTargets`. */
export interface TargetsToValidate {
  kcal: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  targetRatePctBwPerWeek: number;
}

export interface TargetValidationContext {
  profile: UserProfile;
  /** Estimated BMR, kcal/day. Strongly recommended — it makes the floors personal. */
  bmrKcal?: number;
  /** Estimated daily exercise energy expenditure, kcal. Used for energy availability. */
  exerciseKcalPerDay?: number;
}

/**
 * Validate a generated target set against the hard limits.
 *
 * @param t the proposed targets
 * @param ctx profile plus optional BMR and exercise energy
 * @returns findings; the caller must not display targets when any is a `block`
 *
 * @example
 * const findings = validateTargets(targets, { profile, bmrKcal: 1720 });
 * if (hasBlock(findings)) { showBlockingScreen(actionable(findings)); }
 */
export function validateTargets(
  t: TargetsToValidate,
  ctx: TargetValidationContext,
): Finding[] {
  const out: Finding[] = [];
  const p = ctx.profile;

  // ---- Energy floors ---------------------------------------------------
  if (t.kcal < LIMITS.ABSOLUTE_KCAL_FLOOR) {
    out.push(
      block(
        'KCAL_BELOW_VLCD_FLOOR',
        `A target of ${Math.round(t.kcal)} kcal is a very-low-energy diet. These are only used inside a specialist weight-management service with clinical supervision, never from an app. We will not set this.`,
      ),
    );
  }

  const sexFloor = LIMITS.KCAL_FLOOR_BY_SEX[p.sex];
  const lactationFloor = p.breastfeeding ? 1800 : 0;
  const guidelineFloor = Math.max(sexFloor, lactationFloor);
  if (t.kcal < guidelineFloor && !p.clinicianSupervised) {
    out.push(
      block(
        'KCAL_BELOW_GUIDELINE_FLOOR',
        `${Math.round(t.kcal)} kcal is below the ${guidelineFloor} kcal floor we use${p.breastfeeding ? ' while breastfeeding' : ` for ${p.sex === 'female' ? 'women' : 'men'}`}. Getting enough vitamins and minerals from food alone below this level is very difficult. Reduce your target rate, or work with a clinician who can supervise a lower intake.`,
      ),
    );
  }

  if (typeof ctx.bmrKcal === 'number' && ctx.bmrKcal > 0) {
    const ratio = t.kcal / ctx.bmrKcal;
    if (ratio < LIMITS.MIN_KCAL_AS_BMR_MULTIPLE) {
      out.push(
        block(
          'KCAL_BELOW_BMR_FLOOR',
          `This target is below 80% of your estimated resting metabolism (${Math.round(ctx.bmrKcal)} kcal). That is too aggressive to run unsupervised. Please pick a slower rate of loss.`,
        ),
      );
    } else if (ratio < LIMITS.WARN_KCAL_AS_BMR_MULTIPLE) {
      out.push(
        warn(
          'KCAL_BELOW_BMR',
          `This target is below your estimated resting metabolism of ${Math.round(ctx.bmrKcal)} kcal. It is workable short-term but expect low energy, and do not run it for months.`,
        ),
      );
    }
  }

  // ---- Energy availability (REDs) --------------------------------------
  const lbm = leanMassKg(p);
  if (lbm !== null && typeof ctx.exerciseKcalPerDay === 'number') {
    const ea = (t.kcal - ctx.exerciseKcalPerDay) / lbm;
    if (ea < LIMITS.ENERGY_AVAILABILITY.caution) {
      out.push(
        warn(
          'ENERGY_AVAILABILITY_LOW',
          `After training you would have about ${ea.toFixed(0)} kcal per kg of lean mass left for everything else. We use 30 as a conservative app caution line, not a diagnostic cutoff: energy availability and Relative Energy Deficiency in Sport (REDs) sit on a continuum. This app cannot diagnose REDs. Eat more, train less, or both; if under-fuelling persists or you have symptoms, speak with a sports-medicine clinician or sports dietitian.`,
        ),
      );
    } else if (ea < LIMITS.ENERGY_AVAILABILITY.reference) {
      out.push(
        info(
          'ENERGY_AVAILABILITY_REDUCED',
          `Energy availability is around ${ea.toFixed(0)} kcal/kg lean mass. About 45 is a commonly used reference point, not a universal optimum or diagnostic boundary. Watch recovery, performance and health symptoms rather than treating one estimate as a diagnosis.`,
        ),
      );
    }
  }

  // ---- Rate ------------------------------------------------------------
  out.push(...validateRate(t.targetRatePctBwPerWeek, p).filter((f) => !f.ok));

  // ---- Protein ---------------------------------------------------------
  const proteinPerKg = t.proteinG / p.bodyweightKg;
  const proteinPct = ((t.proteinG * 4) / t.kcal) * 100;
  if (proteinPerKg > LIMITS.PROTEIN_G_PER_KG.block) {
    out.push(
      block(
        'PROTEIN_EXCESSIVE',
        `${t.proteinG} g of protein is ${proteinPerKg.toFixed(1)} g per kg of bodyweight. There is no evidence of benefit at this level and it starts to crowd out other nutrients. We have capped it.`,
      ),
    );
  } else if (proteinPerKg > LIMITS.PROTEIN_G_PER_KG.warn) {
    out.push(
      warn(
        'PROTEIN_HIGH',
        `${proteinPerKg.toFixed(1)} g/kg is above the point where more protein stops helping (roughly 1.6-2.2 g/kg for muscle gain, up to ~3.1 g/kg of lean mass in a deep cut). It appears safe in healthy people but it is not buying you anything.`,
      ),
    );
  }
  if (proteinPct > LIMITS.PROTEIN_PCT_ENERGY_WARN) {
    out.push(
      info(
        'PROTEIN_PCT_HIGH',
        `Protein is ${proteinPct.toFixed(0)}% of your energy, above the 10-35% reference range. This is common and generally fine in a deep cut, but it leaves little room for carbohydrate and fat.`,
      ),
    );
  }
  if (proteinPerKg > 1.6 && p.bodyweightKg > 0) {
    // Renal caveat is only meaningful if the user has flagged kidney disease;
    // we cannot know that here, so this is intentionally not a finding.
  }

  // ---- Fat -------------------------------------------------------------
  const fatPerKg = t.fatG / p.bodyweightKg;
  const fatPct = ((t.fatG * 9) / t.kcal) * 100;
  if (fatPerKg < LIMITS.FAT.hardMinGPerKg || fatPct < LIMITS.FAT.hardMinPctEnergy) {
    out.push(
      block(
        'FAT_BELOW_HARD_FLOOR',
        `${t.fatG} g of fat is below what we will prescribe. Fat below about 15% of energy is linked to lower testosterone and risks falling short on essential fatty acids and fat-soluble vitamins.`,
      ),
    );
  } else if (fatPerKg < LIMITS.FAT.minGPerKg || fatPct < LIMITS.FAT.minPctEnergy) {
    out.push(
      warn(
        'FAT_LOW',
        `Fat is ${t.fatG} g (${fatPct.toFixed(0)}% of energy). We normally keep it at or above 20% of energy, or 0.5 g per kg of bodyweight, for hormonal health.`,
      ),
    );
  }

  // ---- Carbohydrate ----------------------------------------------------
  if (t.carbG < LIMITS.CARB_G.warn) {
    out.push(
      warn(
        'CARB_VERY_LOW',
        `${t.carbG} g of carbohydrate is below the ~100 g/day your brain uses. This is a deliberate choice on a ketogenic diet, but if it is not, raise your calories or shift some fat to carbohydrate.`,
      ),
    );
  } else if (t.carbG < LIMITS.CARB_G.info) {
    out.push(
      info(
        'CARB_LOW',
        `${t.carbG} g of carbohydrate is below the 130 g/day reference intake. Fine for many people, but watch your training performance.`,
      ),
    );
  }

  // ---- Internal consistency -------------------------------------------
  const macroKcal = t.proteinG * 4 + t.carbG * 4 + t.fatG * 9;
  if (Math.abs(macroKcal - t.kcal) > Math.max(50, 0.05 * t.kcal)) {
    out.push(
      warn(
        'MACROS_INCONSISTENT',
        `The macro targets add up to ${Math.round(macroKcal)} kcal but the calorie target says ${Math.round(t.kcal)}. This is a bug; please report it.`,
      ),
    );
  }

  if (out.length === 0) out.push(ok('TARGETS_OK'));
  return out;
}

function leanMassKg(p: UserProfile): number | null {
  if (typeof p.bodyFatPct !== 'number' || !Number.isFinite(p.bodyFatPct)) return null;
  if (p.bodyFatPct < 3 || p.bodyFatPct > 60) return null;
  return p.bodyweightKg * (1 - p.bodyFatPct / 100);
}

/* ------------------------------------------------------------------ */
/* Observed progress                                                   */
/* ------------------------------------------------------------------ */

export interface ObservedProgress {
  /** Smoothed rate of change, kg/week (negative = losing). */
  weeklyChangeKg: number;
  /** Current trend bodyweight, kg. */
  trendKg: number;
  /** Number of consecutive weeks this rate has held. */
  weeksSustained: number;
  /** Percentage of bodyweight lost over the last 30 days (positive number = loss). */
  pctLost30d?: number;
  /** Percentage of bodyweight lost over the last 180 days (positive number = loss). */
  pctLost180d?: number;
  /** Whether the loss is intentional (a cut) or not. */
  intentional: boolean;
}

/**
 * Validate what is actually happening, as opposed to what was prescribed.
 *
 * This is the check that catches a user who is losing far faster than their
 * plan calls for — usually because they are under-eating, under-logging, or
 * ill. It deliberately never produces a congratulatory message.
 */
export function validateObservedProgress(o: ObservedProgress): Finding[] {
  const out: Finding[] = [];
  const pctPerWeek = o.trendKg > 0 ? (Math.abs(o.weeklyChangeKg) / o.trendKg) * 100 : 0;

  if (o.weeklyChangeKg < 0 && pctPerWeek > LIMITS.BLOCK_LOSS_PCT_BW_PER_WEEK) {
    if (o.weeksSustained >= 2) {
      out.push(
        warn(
          'OBSERVED_LOSS_TOO_FAST',
          `You have been losing about ${pctPerWeek.toFixed(1)}% of your bodyweight per week for ${o.weeksSustained} weeks. That is faster than is healthy to sustain. We are raising your calorie target. If this continues, please check in with a doctor.`,
        ),
      );
    } else {
      out.push(
        info(
          'OBSERVED_LOSS_FAST_SHORT',
          'This week is showing very fast loss. That is often water rather than fat, so we will not change anything yet. Keep weighing in.',
        ),
      );
    }
  }

  if (!o.intentional) {
    if ((o.pctLost30d ?? 0) >= LIMITS.UNINTENDED_LOSS.pct30d) {
      out.push(
        warn(
          'UNINTENDED_LOSS_30D',
          `You have lost about ${(o.pctLost30d ?? 0).toFixed(0)}% of your bodyweight in the last month without trying to. Unintentional weight loss at that rate is worth a doctor's appointment.`,
        ),
      );
    } else if ((o.pctLost180d ?? 0) >= LIMITS.UNINTENDED_LOSS.pct180d) {
      out.push(
        warn(
          'UNINTENDED_LOSS_180D',
          `You have lost about ${(o.pctLost180d ?? 0).toFixed(0)}% of your bodyweight over six months without intending to. Please mention this to a doctor.`,
        ),
      );
    }
  }

  if (out.length === 0) out.push(ok('PROGRESS_OK'));
  return out;
}

/* ------------------------------------------------------------------ */
/* Logged data plausibility                                            */
/* ------------------------------------------------------------------ */

export interface LoggedDayCheckInput {
  loggedKcal: number;
  /** Logged macro grams, if available, for a cross-check against kcal. */
  proteinG?: number;
  carbG?: number;
  fatG?: number;
  bmrKcal: number;
}

/**
 * Assess whether a single logged day is physiologically plausible.
 *
 * **Implausible days must be excluded from the expenditure regression, not
 * used to lower the user's target.** A 400 kcal log means the user forgot to
 * log dinner, not that they need less food.
 */
export function validateLoggedDay(d: LoggedDayCheckInput): Finding[] {
  const out: Finding[] = [];
  const ratio = d.bmrKcal > 0 ? d.loggedKcal / d.bmrKcal : Infinity;

  if (!Number.isFinite(d.loggedKcal) || d.loggedKcal < 0) {
    out.push(block('LOG_INVALID', 'That calorie value is not a number we can use.'));
    return out;
  }
  if (d.loggedKcal > 0 && d.loggedKcal < 0.9 * d.bmrKcal) {
    out.push(
      warn(
        'LOG_IMPLAUSIBLY_LOW',
        `${Math.round(d.loggedKcal)} kcal is below your resting metabolism. We will leave this day out of your expenditure calculation rather than assume you ate that little.`,
      ),
    );
  } else if (ratio < LIMITS.GOLDBERG_EI_BMR_RATIO) {
    out.push(
      info(
        'LOG_LOW_VS_BMR',
        'This day looks light relative to your resting needs. If it was a partial log, finishing it will make your expenditure estimate more accurate.',
      ),
    );
  }
  if (d.loggedKcal > 3 * d.bmrKcal || d.loggedKcal > 10000) {
    out.push(
      warn(
        'LOG_IMPLAUSIBLY_HIGH',
        `${Math.round(d.loggedKcal)} kcal is higher than we can treat as real. Check for a portion-size or unit mistake; we will leave this day out of your expenditure calculation.`,
      ),
    );
  }

  if (
    typeof d.proteinG === 'number' &&
    typeof d.carbG === 'number' &&
    typeof d.fatG === 'number'
  ) {
    const fromMacros = d.proteinG * 4 + d.carbG * 4 + d.fatG * 9;
    if (d.loggedKcal > 0 && Math.abs(fromMacros - d.loggedKcal) > 0.2 * d.loggedKcal) {
      out.push(
        info(
          'LOG_MACRO_MISMATCH',
          `Your macros add up to ${Math.round(fromMacros)} kcal but the day is logged as ${Math.round(d.loggedKcal)}. One of the entries probably has incomplete macro data.`,
        ),
      );
    }
  }

  if (out.length === 0) out.push(ok('LOG_OK'));
  return out;
}

export interface WeightEntryCheckInput {
  /** The new reading, kg. */
  kg: number;
  /** The previous reading, kg. `null` for the first ever entry. */
  previousKg: number | null;
  /** Days since the previous reading. */
  daysSincePrevious: number;
}

/**
 * Assess whether a new scale reading is usable.
 *
 * @returns findings. A `block` means reject the entry and ask the user to
 *   confirm; a `warn` means accept it but expect the trend filter to
 *   down-weight it.
 */
export function validateWeightEntry(e: WeightEntryCheckInput): Finding[] {
  const out: Finding[] = [];
  if (!Number.isFinite(e.kg) || e.kg <= 20 || e.kg > 400) {
    out.push(
      block(
        'WEIGHT_OUT_OF_RANGE',
        'That weight is outside the range we can work with. Check whether your scale is set to kilograms or pounds.',
      ),
    );
    return out;
  }
  if (e.previousKg !== null && e.daysSincePrevious > 0) {
    const delta = e.kg - e.previousKg;
    const ratio = e.kg / e.previousKg;
    // ~2.2 is the lb/kg factor; catch unit mix-ups explicitly.
    if (ratio > 2.0 || ratio < 0.5) {
      out.push(
        block(
          'WEIGHT_UNIT_MISMATCH',
          'That is more than double or less than half your last weigh-in. This is almost always a pounds/kilograms mix-up. Please check your units.',
        ),
      );
      return out;
    }
    if (Math.abs(delta) > LIMITS.DAILY_WEIGHT_ERROR_KG && e.daysSincePrevious <= 2) {
      out.push(
        warn(
          'WEIGHT_JUMP_LARGE',
          `That is a ${Math.abs(delta).toFixed(1)} kg change in ${e.daysSincePrevious} day(s). We will record it but give it very little weight in your trend until it is confirmed by later weigh-ins.`,
        ),
      );
    } else if (Math.abs(delta) > LIMITS.DAILY_WEIGHT_NOISE_KG && e.daysSincePrevious <= 1) {
      out.push(
        info(
          'WEIGHT_DAILY_NOISE',
          'Day-to-day swings of a kilo or two are normal — mostly water, food in transit and sodium. Your trend line is what matters.',
        ),
      );
    }
  }
  if (out.length === 0) out.push(ok('WEIGHT_OK'));
  return out;
}

/**
 * Detect systematic under-logging by comparing what the logs *imply* should be
 * happening to what the scale actually shows.
 *
 * Consistent under-reporting is largely self-correcting: the expenditure
 * estimate absorbs it and the target lands in the user's own logging units.
 * **Inconsistent** under-reporting is not, and this is what catches it.
 *
 * @param predictedWeeklyChangeKg what the logged intake and estimated
 *   expenditure predict for the week
 * @param observedWeeklyChangeKg what the trend actually did
 * @param weeksObserved how long the discrepancy has persisted
 */
export function detectLoggingDiscrepancy(
  predictedWeeklyChangeKg: number,
  observedWeeklyChangeKg: number,
  weeksObserved: number,
): Finding[] {
  if (weeksObserved < 3) return [ok('LOGGING_DISCREPANCY_NOT_ASSESSED')];
  const predicted = Math.abs(predictedWeeklyChangeKg);
  if (predicted < 0.1) return [ok('LOGGING_DISCREPANCY_NOT_ASSESSED')];
  const realised = observedWeeklyChangeKg / predictedWeeklyChangeKg;
  if (realised < 0.3) {
    return [
      warn(
        'LOGGING_DISCREPANCY',
        'Your logs predict faster progress than the scale is showing. The most likely explanation is that some food is not making it into the log — that is extremely common and not a character flaw. We will not lower your calorie target on the strength of the logs alone. Logging a few days as completely as you can will fix the estimate.',
      ),
    ];
  }
  return [ok('LOGGING_DISCREPANCY_OK')];
}

/* ------------------------------------------------------------------ */
/* Eating-disorder screening                                           */
/* ------------------------------------------------------------------ */

/**
 * The five SCOFF questions (Morgan, Reid & Lacey, BMJ 1999), verbatim.
 * Answered yes/no; each "yes" scores 1.
 */
export const SCOFF_QUESTIONS: readonly string[] = [
  'Do you make yourself Sick because you feel uncomfortably full?',
  'Do you worry you have lost Control over how much you eat?',
  'Have you recently lost more than One stone (6.35 kg) in a three-month period?',
  'Do you believe yourself to be Fat when others say you are too thin?',
  'Would you say that Food dominates your life?',
];

export interface ScoffResult {
  score: number;
  findings: Finding[];
  /** When true, the app must not display calorie or weight targets. */
  gateClosed: boolean;
}

/**
 * Score the SCOFF screener and decide whether the numeric-targets gate closes.
 *
 * **NICE NG69 is explicit that a screening tool must not be the sole method of
 * determining whether someone has an eating disorder.** We therefore use SCOFF
 * only to decide whether *this app* is appropriate — never to tell a user they
 * have a diagnosis. The copy below is worded accordingly.
 *
 * The gate must be enforced server-side and must persist. Do not implement it
 * as a dismissible dialog that a user can bypass by re-answering, which is the
 * failure mode of several shipped products.
 *
 * @param answers five booleans, in the order of {@link SCOFF_QUESTIONS}
 */
export function scoreScoff(answers: readonly boolean[]): ScoffResult {
  if (answers.length !== SCOFF_QUESTIONS.length) {
    throw new Error(`scoreScoff expects ${SCOFF_QUESTIONS.length} answers`);
  }
  const score = answers.reduce((a, b) => a + (b ? 1 : 0), 0);
  const findings: Finding[] = [];
  if (score >= LIMITS.SCOFF_CUTOFF) {
    findings.push(
      block(
        'ED_SCREEN_POSITIVE',
        'Some of your answers suggest that tracking calories and weight could do you more harm than good right now. This is not a diagnosis and it is not a judgement — it just means an app is the wrong tool. We have turned off calorie and weight targets. Please consider talking to a doctor or a therapist who works with eating and body image.',
      ),
    );
  } else if (score === 1) {
    findings.push(
      info(
        'ED_SCREEN_BORDERLINE',
        'If tracking ever starts to feel compulsive or distressing, you can switch to a no-numbers mode in Settings at any time.',
      ),
    );
  } else {
    findings.push(ok('ED_SCREEN_NEGATIVE'));
  }
  return { score, findings, gateClosed: score >= LIMITS.SCOFF_CUTOFF };
}

export interface BehaviouralSignals {
  /** Times in the last 30 days the user asked for a target below the floor. */
  belowFloorRequests30d: number;
  /** Times in the last 30 days the user lowered their goal weight. */
  goalWeightReductions30d: number;
  /** Consecutive days logged under 60% of the calorie target. */
  consecutiveSevereUnderEatingDays: number;
  /** Consecutive days with more than one weigh-in. */
  consecutiveMultiWeighInDays: number;
}

/**
 * Passive behavioural screening.
 *
 * A screener answered once at signup catches very little. These signals come
 * from how the product is actually being used, and are the more reliable
 * trigger in practice. They escalate to the same gate as a positive SCOFF.
 */
export function assessBehaviouralSignals(s: BehaviouralSignals): Finding[] {
  const out: Finding[] = [];

  if (s.belowFloorRequests30d >= 3) {
    out.push(
      warn(
        'BEHAVIOUR_REPEATED_LOW_TARGET_REQUESTS',
        'You have tried several times to set a calorie target below what we consider safe. We are not going to allow it, and we would gently suggest that wanting to go lower is itself worth talking to someone about.',
      ),
    );
  }
  if (s.goalWeightReductions30d >= 3) {
    out.push(
      warn(
        'BEHAVIOUR_MOVING_GOAL_POST',
        'Your goal weight has moved down several times this month. When the target keeps receding, reaching it rarely feels like enough. It might be worth talking this through with someone.',
      ),
    );
  }
  if (s.consecutiveSevereUnderEatingDays >= 5) {
    out.push(
      block(
        'BEHAVIOUR_SEVERE_UNDEREATING',
        'You have logged well under your target for several days running. We have paused your targets. Please eat something today, and if this is a pattern rather than a busy week, please talk to a doctor.',
      ),
    );
  }
  if (s.consecutiveMultiWeighInDays >= 7) {
    out.push(
      info(
        'BEHAVIOUR_FREQUENT_WEIGHING',
        'Weighing more than once a day adds noise, not information — your trend line already handles the fluctuations. One weigh-in, same time each day, is plenty.',
      ),
    );
  }

  if (out.length === 0) out.push(ok('BEHAVIOUR_OK'));
  return out;
}

/* ------------------------------------------------------------------ */
/* User-facing copy                                                    */
/* ------------------------------------------------------------------ */

/**
 * Canonical disclaimer copy.
 *
 * Placement matters more than wording: this must appear at the point of goal
 * setting and on the targets screen, not buried in the terms of service. The
 * FTC's Health Products Compliance Guidance is explicit that a disclaimer does
 * not cure an otherwise misleading claim — so the rest of the product must also
 * avoid disease claims (do not say the app treats or prevents obesity, diabetes
 * or anything else). Staying inside FDA's General Wellness policy means making
 * no diagnosis/treatment/cure/mitigation/prevention claims and not positioning
 * the app as a substitute for clinical care.
 */
export const DISCLAIMERS = {
  /** Short form, for the targets screen footer. */
  short:
    'General wellness information, not medical advice. These targets are estimates.',

  /** Full form, shown at goal setting and in onboarding. */
  full:
    'This app provides general wellness and educational information only. It is not medical advice, and it is not intended to diagnose, treat, cure, mitigate or prevent any disease. The calorie and macronutrient targets it shows are estimates based on the data you enter, and they can be wrong. ' +
    'Please talk to a doctor or a registered dietitian before starting any weight-change plan — particularly if you are under 18, pregnant or breastfeeding, have a history of an eating disorder, have a medical condition such as diabetes, kidney disease or heart disease, or take any medication whose effect depends on what you eat.',

  /** Shown alongside the adaptive expenditure number. */
  estimateUncertainty:
    'Your expenditure figure is an estimate calculated from the food you log and the way your weight trends. It gets better with more data. It is not a measurement, and it will move around.',

  /** Shown when the app declines to set a target. */
  refusal:
    'We are not able to set targets in this situation. This is a limit we apply deliberately, not a bug, and there is no setting that overrides it.',
} as const;

/**
 * Support resources to surface whenever the eating-disorder gate closes, or on
 * request.
 *
 * **Verify these before shipping and re-verify periodically.** This landscape
 * changes: NEDA closed its human-staffed helpline in 2023 and its chatbot
 * replacement was withdrawn after giving weight-loss advice to users with
 * eating disorders. Never route a user in distress to an automated agent.
 */
export const SUPPORT_RESOURCES: readonly {
  region: string;
  name: string;
  contact: string;
  note: string;
}[] = [
  {
    region: 'US',
    name: 'Crisis Text Line',
    contact: 'Text "NEDA" to 741741',
    note: '24/7, staffed by trained human volunteers.',
  },
  {
    region: 'US',
    name: 'ANAD Helpline',
    contact: '888-375-7767',
    note: 'National Association of Anorexia Nervosa and Associated Disorders.',
  },
  {
    region: 'US',
    name: '988 Suicide & Crisis Lifeline',
    contact: 'Call or text 988',
    note: 'For acute risk of any kind.',
  },
  {
    region: 'UK',
    name: 'Beat',
    contact: '0808 801 0677',
    note: "The UK's eating disorder charity helpline.",
  },
];

/**
 * Decide whether to surface a "talk to a professional" prompt, and with what
 * urgency.
 *
 * @param findings all findings gathered this session
 * @returns `null` when no prompt is warranted
 */
export function professionalReferralPrompt(
  findings: readonly Finding[],
): { urgency: 'now' | 'soon' | 'consider'; message: string; showResources: boolean } | null {
  const codes = new Set(findings.filter((f) => !f.ok).map((f) => f.code));

  const urgent = [
    'ED_SCREEN_POSITIVE',
    'ED_HISTORY',
    'BMI_SEVERE_THINNESS',
    'BEHAVIOUR_SEVERE_UNDEREATING',
  ];
  if (urgent.some((c) => codes.has(c))) {
    return {
      urgency: 'now',
      message:
        'Please talk to a doctor, therapist or registered dietitian about this. You do not have to have a diagnosis, or be sure anything is wrong, to be worth talking to someone about it.',
      showResources: true,
    };
  }

  const soon = [
    'UNINTENDED_LOSS_30D',
    'UNINTENDED_LOSS_180D',
    'OBSERVED_LOSS_TOO_FAST',
    'BMI_UNDERWEIGHT_CUT',
    'GOAL_WEIGHT_UNDERWEIGHT',
    'ENERGY_AVAILABILITY_LOW',
  ];
  if (soon.some((c) => codes.has(c))) {
    return {
      urgency: 'soon',
      message:
        'This is worth raising with a doctor or a registered dietitian in the next week or two. Bring your weight trend and a few days of food logs — it makes the conversation much more useful.',
      showResources: false,
    };
  }

  const consider = [
    'BEHAVIOUR_REPEATED_LOW_TARGET_REQUESTS',
    'BEHAVIOUR_MOVING_GOAL_POST',
    'KCAL_BELOW_BMR',
    'LACTATION',
  ];
  if (consider.some((c) => codes.has(c))) {
    return {
      urgency: 'consider',
      message:
        'A registered dietitian could help you get more out of this than an algorithm can. Worth considering if you have access to one.',
      showResources: false,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Convenience: run everything                                         */
/* ------------------------------------------------------------------ */

export interface FullValidationInput {
  profile: UserProfile;
  targets?: TargetsToValidate;
  bmrKcal?: number;
  exerciseKcalPerDay?: number;
  observed?: ObservedProgress;
  behaviour?: BehaviouralSignals;
  scoffAnswers?: readonly boolean[];
}

export interface FullValidationResult {
  findings: Finding[];
  blocked: boolean;
  /** Highest-severity findings first. */
  actionable: Finding[];
  referral: ReturnType<typeof professionalReferralPrompt>;
  disclaimer: string;
}

/**
 * Run every applicable check and collate the result. This is the function the
 * application layer should call; the individual validators are exported for
 * targeted use and testing.
 */
export function validateAll(input: FullValidationInput): FullValidationResult {
  const findings: Finding[] = [];
  if (input.scoffAnswers) findings.push(...scoreScoff(input.scoffAnswers).findings);
  findings.push(...validateProfile(input.profile));
  if (input.targets) {
    findings.push(
      ...validateTargets(input.targets, {
        profile: input.profile,
        bmrKcal: input.bmrKcal,
        exerciseKcalPerDay: input.exerciseKcalPerDay,
      }),
    );
  }
  if (input.observed) findings.push(...validateObservedProgress(input.observed));
  if (input.behaviour) findings.push(...assessBehaviouralSignals(input.behaviour));

  return {
    findings,
    blocked: hasBlock(findings),
    actionable: actionable(findings),
    referral: professionalReferralPrompt(findings),
    disclaimer: DISCLAIMERS.full,
  };
}
