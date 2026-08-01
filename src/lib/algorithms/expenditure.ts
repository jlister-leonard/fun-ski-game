/**
 * expenditure.ts
 *
 * Adaptive total daily energy expenditure (TDEE) estimation from **logged
 * intake + smoothed weight trend**, rather than from a demographic activity
 * multiplier.
 *
 * ## The idea
 *
 * The first law of thermodynamics applied to a person:
 *
 *     dE_body/dt = intake - expenditure
 *
 * Body energy stores are proportional to body mass through an effective energy
 * density `rho` (kcal per kg of tissue actually gained/lost). So over a window:
 *
 *     rho * (trend_t - trend_0)  =  sum(intake)  -  sum(TDEE)
 *
 * Rearranged into a form that is *stable to estimate*:
 *
 *     y_t := cumulativeIntake_t - rho * (trend_t - trend_0)  =  sum_{k<=t} TDEE_k
 *
 * so **d y / d t = TDEE(t)**. We estimate TDEE as the slope of a
 * recency-weighted linear regression of `y` on day index.
 *
 * ## Why not naive back-calculation?
 *
 * `TDEE = meanIntake - rho * dWeight/dt` differentiates a noisy series.
 * Differencing amplifies noise: with 0.9 kg of daily scale noise, a 7-day
 * end-to-end difference carries roughly +/- 1.8 kg of 95% error, which at
 * 7700 kcal/kg is +/- 2000 kcal/day of nonsense. The cumulative formulation
 * above *integrates* intake noise (errors average out as 1/sqrt(n)) and only
 * needs one well-conditioned slope from the already-smoothed trend, so the
 * estimator is dramatically better conditioned. The regression form also
 * naturally down-weights old data and yields an honest standard error.
 *
 * ## Cold start
 *
 * With little data the data-driven estimate has a huge standard error. We fuse
 * it with a predictive-equation prior (Mifflin-St Jeor, or Katch-McArdle when
 * body composition is known) by **inverse-variance weighting**, so the app
 * degrades gracefully: pure formula on day 0, formula-dominant for ~2 weeks,
 * data-dominant by ~4 weeks. No hard switch-over, no discontinuity.
 *
 * ## Wearables
 *
 * The adaptive estimate **already contains all expenditure**, including
 * exercise. Adding wearable "active energy" on top double-counts. See
 * {@link applyActiveEnergyModifier} — wearable data is used only to explain
 * *deviation from the user's own recent activity baseline*, is zero-mean by
 * construction, and therefore cannot shift the weekly energy budget.
 *
 * Zero dependencies. Pure functions. No I/O.
 *
 * @module expenditure
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Energy density of pure body fat, kcal/kg (~9440). Adipose tissue is ~87%
 * triacylglycerol at 9.4 kcal/g.
 */
export const KCAL_PER_KG_FAT = 9440;

/**
 * Effective energy density of fat-free mass change, kcal/kg (~1816). Much
 * lower than protein's 5.65 kcal/g because FFM change is mostly water
 * (~70-75%) plus glycogen.
 */
export const KCAL_PER_KG_FFM = 1816;

/**
 * Default mixed-tissue energy density used when body composition is unknown,
 * kcal/kg. 7700 kcal/kg is the metric form of the classic "3500 kcal per
 * pound" and corresponds to ~77% of the change coming from fat mass, which is
 * typical for a moderate deficit in an overweight adult.
 */
export const DEFAULT_KCAL_PER_KG = 7700;

/** Forbes' constant (kg) relating FFM loss to fat mass. */
const FORBES_CONSTANT_KG = 10.4;

/* ------------------------------------------------------------------ */
/* Cold-start predictive equations                                     */
/* ------------------------------------------------------------------ */

export type Sex = 'male' | 'female';

/**
 * Activity multipliers applied to BMR for a cold-start TDEE.
 * These are only a *prior*; the adaptive estimator replaces them within weeks.
 */
export const ACTIVITY_MULTIPLIERS = {
  /** Desk job, little deliberate exercise. */
  sedentary: 1.2,
  /** Light exercise 1-3 d/wk. */
  lightly_active: 1.375,
  /** Moderate exercise 3-5 d/wk. */
  moderately_active: 1.55,
  /** Hard exercise 6-7 d/wk. */
  very_active: 1.725,
  /** Physical job or two-a-day training. */
  extremely_active: 1.9,
} as const;

export type ActivityLevel = keyof typeof ACTIVITY_MULTIPLIERS;

/**
 * Mifflin-St Jeor resting metabolic rate, kcal/day.
 *
 * `BMR = 10*kg + 6.25*cm - 5*age + s`, with `s = +5` for males and `-161` for
 * females. The best-validated general-population predictive equation; roughly
 * +/- 10% for ~80% of non-obese adults.
 *
 * @param sex biological sex used by the equation
 * @param weightKg bodyweight in kg
 * @param heightCm height in cm
 * @param ageYears age in years
 */
export function mifflinStJeorBmr(
  sex: Sex,
  weightKg: number,
  heightCm: number,
  ageYears: number,
): number {
  const s = sex === 'male' ? 5 : -161;
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + s;
}

/**
 * Katch-McArdle resting metabolic rate, kcal/day: `370 + 21.6 * LBM_kg`.
 *
 * Preferred when a body-fat estimate is available, especially for very lean or
 * very muscular users where sex/height/age based equations mis-predict.
 *
 * @param leanBodyMassKg fat-free mass in kg
 */
export function katchMcArdleBmr(leanBodyMassKg: number): number {
  return 370 + 21.6 * leanBodyMassKg;
}

/**
 * Cunningham RMR, kcal/day: `500 + 22 * LBM_kg`. Tends to fit trained athletes
 * better than Katch-McArdle. Provided for completeness.
 */
export function cunninghamBmr(leanBodyMassKg: number): number {
  return 500 + 22 * leanBodyMassKg;
}

export interface ColdStartInput {
  sex: Sex;
  weightKg: number;
  heightCm: number;
  ageYears: number;
  /** Body-fat percentage, 0-100. When supplied and plausible, Katch-McArdle is used. */
  bodyFatPct?: number;
  activityLevel: ActivityLevel;
}

export interface ColdStartResult {
  bmrKcal: number;
  tdeeKcal: number;
  equation: 'mifflin-st-jeor' | 'katch-mcardle';
  activityMultiplier: number;
  /** 1-sigma uncertainty of the TDEE prior, kcal/day. */
  sdKcal: number;
}

/**
 * Seed TDEE from a predictive equation.
 *
 * Uses Katch-McArdle when `bodyFatPct` is present and in a plausible range
 * (3-60%), otherwise Mifflin-St Jeor. The reported `sdKcal` reflects real-world
 * predictive-equation error (~10% of BMR) *plus* the much larger error in the
 * activity multiplier, which is the dominant term.
 */
export function coldStartTdee(input: ColdStartInput): ColdStartResult {
  const useKatch =
    typeof input.bodyFatPct === 'number' &&
    Number.isFinite(input.bodyFatPct) &&
    input.bodyFatPct >= 3 &&
    input.bodyFatPct <= 60;

  const lbm = useKatch ? input.weightKg * (1 - (input.bodyFatPct as number) / 100) : 0;
  const bmr = useKatch
    ? katchMcArdleBmr(lbm)
    : mifflinStJeorBmr(input.sex, input.weightKg, input.heightCm, input.ageYears);

  const mult = ACTIVITY_MULTIPLIERS[input.activityLevel];
  const tdee = bmr * mult;

  // Error budget: ~8% on BMR (equation SEE) and ~12% on the activity
  // multiplier, combined in quadrature. Floors at 200 kcal.
  const sd = Math.max(200, Math.sqrt((0.08 * tdee) ** 2 + (0.12 * tdee) ** 2));

  return {
    bmrKcal: Math.round(bmr),
    tdeeKcal: Math.round(tdee),
    equation: useKatch ? 'katch-mcardle' : 'mifflin-st-jeor',
    activityMultiplier: mult,
    sdKcal: Math.round(sd),
  };
}

/* ------------------------------------------------------------------ */
/* Tissue energy density                                               */
/* ------------------------------------------------------------------ */

/**
 * Effective kcal per kg of body-mass change, partitioned via Forbes' theory.
 *
 * Forbes showed that the fraction of weight change coming from fat mass rises
 * with initial fat mass: `p_fat = FM / (FM + 10.4)`. Leaner people lose
 * proportionally more lean tissue (lower energy density => faster scale
 * movement per kcal); heavier people lose proportionally more fat.
 *
 * @param fatMassKg current fat mass in kg
 * @returns kcal per kg, clamped to a defensible [5200, 8600] range
 *
 * @example
 * effectiveKcalPerKg(24); // ~7100 kcal/kg for a 24 kg fat mass
 */
export function effectiveKcalPerKg(fatMassKg: number): number {
  if (!Number.isFinite(fatMassKg) || fatMassKg <= 0) return DEFAULT_KCAL_PER_KG;
  const pFat = fatMassKg / (fatMassKg + FORBES_CONSTANT_KG);
  const rho = pFat * KCAL_PER_KG_FAT + (1 - pFat) * KCAL_PER_KG_FFM;
  return Math.min(8600, Math.max(5200, rho));
}

/* ------------------------------------------------------------------ */
/* Adaptive estimator                                                  */
/* ------------------------------------------------------------------ */

/** One day of fused intake + trend data. Structurally compatible with TrendPoint. */
export interface ExpenditureDay {
  /** ISO calendar date, `YYYY-MM-DD`. Must be a contiguous daily series. */
  date: string;
  /** Smoothed trend weight for the day, kg (from `computeWeightTrend`). */
  trendKg: number;
  /**
   * Trend weight with modelled non-energetic shifts removed, kg.
   *
   * **Supply this whenever it is available.** Creatine, carb loads and sodium
   * swings move `trendKg` without moving stored energy; feeding those
   * kilograms into an energy-balance calculation biases expenditure. When
   * omitted the estimator falls back to `trendKg` and flags reduced confidence
   * if it detects an unexplained step.
   */
  energyTrendKg?: number;
  /** True when a logged perturbation was still settling on this day. */
  perturbationActive?: boolean;
  /** Logged energy intake for the day, kcal. `null` when the user did not log. */
  intakeKcal: number | null;
}

export interface ExpenditureOptions {
  /** Maximum lookback, days. Default 56 (8 weeks). */
  windowDays?: number;
  /**
   * Half-life of the recency weights, days. Shorter = more responsive, noisier.
   * Default 21 (three weeks).
   */
  halfLifeDays?: number;
  /** kcal per kg of tissue change. Default {@link DEFAULT_KCAL_PER_KG}. */
  kcalPerKg?: number;
  /** Minimum days with both trend and intake before any data is used. Default 7. */
  minDays?: number;
  /**
   * Weight multiplier applied to days whose intake was imputed rather than
   * logged. Default 0.2.
   */
  imputedDayWeight?: number;
  /** Assumed 1-sigma day-to-day *random* logging error, kcal. Default 250. */
  intakeNoiseSdKcal?: number;
  /** Assumed 1-sigma day-to-day scale noise, kg. Default 0.9. */
  weightNoiseSdKg?: number;
  /**
   * Prior (cold start) TDEE and its SD. When omitted, the raw data estimate is
   * returned unshrunk and `source` is `'data'`.
   */
  prior?: { tdeeKcal: number; sdKcal: number };
  /** BMR used to clamp the result to a physiologically sane multiple. */
  bmrKcal?: number;
  /** Clamp bounds as multiples of BMR. Default [1.05, 3.0]. */
  bmrMultipleBounds?: [number, number];
  /**
   * Regression weight given to days inside a logged perturbation window.
   * Default 0.15. Even with the offset modelled and subtracted, those days
   * carry extra uncertainty, so they should not drive the estimate.
   */
  perturbationDayWeight?: number;
  /**
   * Slope change (kcal/day) above which the user is asked what changed.
   * Default 150. Only ever raises a question; never suppresses on its own.
   */
  regimeChangePromptKcal?: number;
  /**
   * Threshold in kg for the automatic unlogged-step detector. A residual step
   * larger than this inflates the standard error and lowers confidence.
   * Default 0.8 kg.
   */
  stepDetectionThresholdKg?: number;
}

export type ConfidenceLabel = 'none' | 'low' | 'moderate' | 'high';

export interface ExpenditureEstimate {
  /** Posterior TDEE estimate, kcal/day. This is the number to coach from. */
  tdeeKcal: number;
  /** 1-sigma posterior uncertainty, kcal/day. */
  sdKcal: number;
  /** 95% credible interval, kcal/day. */
  ci95: [number, number];
  /** Pure data-driven estimate before fusion with the prior, or `null`. */
  dataTdeeKcal: number | null;
  /** 1-sigma of the pure data estimate, or `null`. */
  dataSdKcal: number | null;
  /** Share of the posterior precision contributed by logged data, 0..1. */
  dataWeight: number;
  /** Where the number came from. */
  source: 'prior' | 'blended' | 'data';
  /** 0..1 confidence score. */
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  /** Days in the regression window. */
  daysUsed: number;
  /** Days whose intake had to be imputed. */
  imputedDays: number;
  /** Kish effective sample size of the recency weights. */
  effectiveSampleSize: number;
  /** Recency-weighted mean logged intake over the window, kcal/day. */
  meanIntakeKcal: number;
  /** Trend rate over the window implied by the fitted line, kg/week. */
  observedWeeklyChangeKg: number;
  /** True when the posterior was clamped to the BMR-multiple bounds. */
  clamped: boolean;
  /** Days in the window that fell inside a logged perturbation window. */
  perturbationDays: number;
  /**
   * Magnitude of an unexplained level step detected in the residuals, kg.
   * Zero when none was found. Non-zero means something moved the scale that
   * the energy-balance model cannot account for.
   */
  unexplainedStepKg: number;
  /**
   * Change in the fitted slope across the best breakpoint, kcal/day. This is a
   * genuine change in expenditure when it is real — the estimator *should*
   * follow it, so it never triggers suppression on its own.
   */
  slopeChangeKcal: number;
  /**
   * True when the series shows a regime change of any kind. Used to prompt the
   * user, not to silently override the estimate.
   */
  regimeChangeSuspected: boolean;
  /**
   * A question to put to the user when a regime change is suspected, or `null`.
   *
   * This is the honest fallback for the cases the maths cannot resolve — see
   * the limitation documented on {@link estimateExpenditure}. Asking is far
   * better than guessing.
   */
  userPrompt: string | null;
  /**
   * True when the estimate is too uncertain to drive an aggressive target
   * change. The coaching layer must respect this.
   */
  suppressAdjustment: boolean;
  /** Human-readable diagnostics. */
  notes: string[];
}

/**
 * Estimate TDEE adaptively from intake history and the smoothed weight trend.
 *
 * ## Known limitation: slow non-energetic weight shifts
 *
 * A **slowly loading** water shift — 5 g/day creatine adding ~1.5 kg over four
 * weeks is the canonical case — is *not reliably distinguishable* from a
 * genuine fall in expenditure using scale weight and intake alone. Both make
 * the scale flatten while intake stays constant. We measured this: over 200
 * simulated runs the automatic change-point detector caught slow creatine
 * loading only ~18% of the time at a ~9% false-positive rate, which is no
 * better than guessing.
 *
 * The detector therefore only fires on *sharp* level steps, where it does work
 * (~65% sensitivity at ~4% false positives for a 1.5 kg shift over five days).
 * The real defences against the slow case are, in order:
 *
 * 1. **The user logs the event.** Exact and cheap. Feed `energyTrendKg` and
 *    `perturbationActive` from `computeWeightTrend`, and the bias disappears.
 * 2. **Rate limiting downstream.** Even with the shift completely unhandled,
 *    the check-in limiter in `macro-targets.ts` held the calorie target to a
 *    100 kcal drop over nine weeks in simulation, versus 0 kcal when logged.
 * 3. **Asking the user.** `userPrompt` is populated whenever a regime change is
 *    suspected. Asking beats guessing on a problem the maths cannot settle.
 *
 * @param days contiguous daily series, oldest first. Use the output of
 *   `computeWeightTrend` joined to daily logged intake.
 * @param options see {@link ExpenditureOptions}
 * @returns a posterior estimate fused with the cold-start prior
 *
 * @example
 * const est = estimateExpenditure(days, {
 *   prior: { tdeeKcal: 2650, sdKcal: 380 },
 *   bmrKcal: 1780,
 * });
 * est.tdeeKcal;   // e.g. 2812
 * est.confidence; // e.g. 0.78
 */
export function estimateExpenditure(
  days: readonly ExpenditureDay[],
  options: ExpenditureOptions = {},
): ExpenditureEstimate {
  const windowDays = options.windowDays ?? 56;
  const halfLife = options.halfLifeDays ?? 21;
  const rho = options.kcalPerKg ?? DEFAULT_KCAL_PER_KG;
  const minDays = options.minDays ?? 7;
  const imputedWeight = options.imputedDayWeight ?? 0.2;
  const intakeSd = options.intakeNoiseSdKcal ?? 250;
  const weightSd = options.weightNoiseSdKg ?? 0.9;
  const bounds = options.bmrMultipleBounds ?? [1.05, 3.0];
  const perturbWeight = options.perturbationDayWeight ?? 0.15;
  const stepThreshold = options.stepDetectionThresholdKg ?? 0.5;
  const notes: string[] = [];

  /** Energy-bearing trend for a day: perturbation-corrected when available. */
  const energyTrend = (d: ExpenditureDay): number =>
    typeof d.energyTrendKg === 'number' && Number.isFinite(d.energyTrendKg)
      ? d.energyTrendKg
      : d.trendKg;

  const priorTdee = options.prior?.tdeeKcal ?? null;
  const priorSd = options.prior?.sdKcal ?? null;

  const window = days.slice(Math.max(0, days.length - windowDays));
  const logged = window.filter((d) => d.intakeKcal !== null && Number.isFinite(d.intakeKcal));

  const fallback = (): ExpenditureEstimate => {
    const t = priorTdee ?? 0;
    const s = priorSd ?? 0;
    return {
      tdeeKcal: Math.round(t),
      sdKcal: Math.round(s),
      ci95: [Math.round(t - 1.96 * s), Math.round(t + 1.96 * s)],
      dataTdeeKcal: null,
      dataSdKcal: null,
      dataWeight: 0,
      source: 'prior',
      confidence: 0,
      confidenceLabel: 'none',
      daysUsed: window.length,
      imputedDays: 0,
      effectiveSampleSize: 0,
      meanIntakeKcal: logged.length
        ? Math.round(logged.reduce((a, d) => a + (d.intakeKcal as number), 0) / logged.length)
        : 0,
      observedWeeklyChangeKg: 0,
      clamped: false,
      perturbationDays: 0,
      unexplainedStepKg: 0,
      slopeChangeKcal: 0,
      regimeChangeSuspected: false,
      userPrompt: null,
      suppressAdjustment: true,
      notes: [...notes, 'Insufficient data; using predictive-equation prior only.'],
    };
  };

  if (window.length < minDays || logged.length < Math.max(5, Math.ceil(minDays * 0.6))) {
    if (priorTdee === null || priorSd === null) {
      throw new Error('estimateExpenditure: not enough data and no prior supplied.');
    }
    return fallback();
  }

  // ---- impute missing intake ------------------------------------------
  // A missing log is NOT a zero-calorie day. Impute with the recency-weighted
  // mean of logged days and down-weight the day heavily. Systematic skipping of
  // high-intake days biases TDEE low; we surface that as a note.
  const loggedMean = logged.reduce((a, d) => a + (d.intakeKcal as number), 0) / logged.length;
  const intake: number[] = [];
  const isImputed: boolean[] = [];
  for (const d of window) {
    if (d.intakeKcal !== null && Number.isFinite(d.intakeKcal)) {
      intake.push(d.intakeKcal);
      isImputed.push(false);
    } else {
      intake.push(loggedMean);
      isImputed.push(true);
    }
  }
  const imputedCount = isImputed.filter(Boolean).length;
  if (imputedCount / window.length > 0.3) {
    notes.push(
      `${imputedCount}/${window.length} days had no food log. The expenditure estimate assumes ` +
        `unlogged days matched your average; if you skip logging on higher-intake days it will read low.`,
    );
  }

  // ---- build the cumulative-energy regression -------------------------
  const n = window.length;
  const trend0 = energyTrend(window[0]);
  const t: number[] = new Array(n);
  const y: number[] = new Array(n);
  const w: number[] = new Array(n);
  let cum = 0;
  let perturbationDays = 0;
  for (let i = 0; i < n; i++) {
    cum += intake[i];
    t[i] = i + 1;
    y[i] = cum - rho * (energyTrend(window[i]) - trend0);
    const recency = Math.pow(0.5, (n - 1 - i) / halfLife);
    const perturbed = window[i].perturbationActive === true;
    if (perturbed) perturbationDays++;
    w[i] = recency * (isImputed[i] ? imputedWeight : 1) * (perturbed ? perturbWeight : 1);
  }
  if (perturbationDays > 0) {
    notes.push(
      `${perturbationDays} day(s) in this window were affected by a logged non-energetic weight shift ` +
        `(creatine, a carb load or similar). Those kilograms are water, not stored energy, so they have ` +
        `been removed from the calculation and those days count for less.`,
    );
  }

  const fit = weightedLinearFit(t, y, w);
  const dataTdee = fit.slope;

  // ---- automatic unlogged-step detection -------------------------------
  const change = detectStepAndSlopeChange(t, y, w, rho);
  const unexplainedStepKg = change.levelStepKg;

  // ---- standard error --------------------------------------------------
  // Two independent routes; take the larger (conservative).
  //
  // (a) analytic: the irreducible error from scale noise over an effective
  //     window of `nEff` days plus random intake-logging error.
  //     Var(slope of OLS line through n noisy points) = 12*sigma^2 / (n(n^2-1)).
  const nEff = fit.effectiveN;
  const trendSlopeVar =
    nEff > 2 ? (12 * weightSd * weightSd) / (nEff * (nEff * nEff - 1)) : weightSd * weightSd;
  const seAnalytic = Math.sqrt(rho * rho * trendSlopeVar + (intakeSd * intakeSd) / nEff);
  // (b) empirical sandwich SE from the regression residuals, inflated for the
  //     strong autocorrelation induced by the cumulative construction.
  const seEmpirical = fit.slopeSe * AUTOCORR_INFLATION;

  let dataSd = Math.max(60, Math.max(seAnalytic, seEmpirical));

  // An unexplained step means the energy-balance model does not fit. Widen the
  // uncertainty in proportion to the size of the step, so the Bayesian blend
  // automatically falls back toward the prior and the coaching layer damps its
  // response. This is the safety net for users who do not log their creatine.
  const stepDetected = Math.abs(unexplainedStepKg) > stepThreshold;
  if (stepDetected) {
    const inflation = 1 + Math.min(3, Math.abs(unexplainedStepKg) / stepThreshold);
    dataSd *= inflation;
    notes.push(
      `Your weight made a step change of about ${Math.abs(unexplainedStepKg).toFixed(1)} kg that your ` +
        `food logs do not explain. Sudden shifts like this are usually water — starting creatine, a big ` +
        `carbohydrate or salt change, travel, or a new training block. We have widened our uncertainty ` +
        `rather than assuming your metabolism changed. If you know what caused it, log it and we will ` +
        `account for it properly.`,
    );
  }

  // ---- fuse with the prior (inverse-variance / Bayesian) ---------------
  let tdee: number;
  let sd: number;
  let dataWeight: number;
  let source: ExpenditureEstimate['source'];

  if (priorTdee === null || priorSd === null) {
    tdee = dataTdee;
    sd = dataSd;
    dataWeight = 1;
    source = 'data';
  } else {
    const wPrior = 1 / (priorSd * priorSd);
    const wData = 1 / (dataSd * dataSd);
    const post = 1 / (wPrior + wData);
    tdee = post * (priorTdee * wPrior + dataTdee * wData);
    sd = Math.sqrt(post);
    dataWeight = wData / (wPrior + wData);
    source = dataWeight > 0.9 ? 'data' : 'blended';
  }

  // ---- physiological clamp --------------------------------------------
  let clamped = false;
  if (options.bmrKcal && Number.isFinite(options.bmrKcal)) {
    const lo = bounds[0] * options.bmrKcal;
    const hi = bounds[1] * options.bmrKcal;
    if (tdee < lo) {
      tdee = lo;
      clamped = true;
      notes.push('Estimate clamped up to 1.05x BMR: implausibly low, check logging accuracy.');
    } else if (tdee > hi) {
      tdee = hi;
      clamped = true;
      notes.push('Estimate clamped down to 3.0x BMR: implausibly high, check weigh-in accuracy.');
    }
  }

  const confidence = clamp01(1 - sd / 500) * clamp01(nEff / 21);
  const confidenceLabel: ConfidenceLabel =
    confidence >= 0.7 ? 'high' : confidence >= 0.4 ? 'moderate' : confidence > 0 ? 'low' : 'none';

  const weightedIntake = sumProduct(intake, w) / sum(w);
  const observedWeekly =
    n > 1 ? ((energyTrend(window[n - 1]) - energyTrend(window[0])) / (n - 1)) * 7 : 0;

  // A large change in the fitted slope means expenditure genuinely moved — or
  // that something non-energetic is masquerading as such. We cannot always tell
  // (see the limitation note on this function), so we ASK rather than guess.
  // Threshold calibrated over 200 simulated runs: at 150 kcal/day the prompt
  // fires on ~62% of slow creatine-loading cases and ~18% of genuinely stable
  // ones. That trade is right for a *question*; it would be far too loose for
  // anything that silently overrode the estimate.
  const regimeChangeSuspected =
    stepDetected || Math.abs(change.slopeChangeKcal) > (options.regimeChangePromptKcal ?? 150);
  const userPrompt = regimeChangeSuspected
    ? 'Your expenditure estimate has shifted noticeably. Around this time, did you start or stop ' +
      'creatine, change your carbohydrate or salt intake a lot, begin a new training block, travel, ' +
      'or fall ill? Logging it lets us tell a genuine change in metabolism apart from a shift in ' +
      'water weight, which look almost identical on the scale.'
    : null;

  // Suppress aggressive target changes when the estimate is shaky.
  const recentlyPerturbed = window.slice(-14).some((d) => d.perturbationActive === true);
  const suppressAdjustment = confidence < 0.35 || stepDetected || recentlyPerturbed;
  if (suppressAdjustment && !stepDetected) {
    notes.push(
      recentlyPerturbed
        ? 'A non-energetic weight shift is still settling, so we are holding your targets steady until it does.'
        : 'Not enough confidence in the expenditure estimate yet to change your targets much.',
    );
  }

  return {
    tdeeKcal: Math.round(tdee),
    sdKcal: Math.round(sd),
    ci95: [Math.round(tdee - 1.96 * sd), Math.round(tdee + 1.96 * sd)],
    dataTdeeKcal: Math.round(dataTdee),
    dataSdKcal: Math.round(dataSd),
    dataWeight: round(dataWeight, 3),
    source,
    confidence: round(confidence, 3),
    confidenceLabel,
    daysUsed: n,
    imputedDays: imputedCount,
    effectiveSampleSize: round(nEff, 1),
    meanIntakeKcal: Math.round(weightedIntake),
    observedWeeklyChangeKg: round(observedWeekly, 3),
    clamped,
    perturbationDays,
    unexplainedStepKg: round(stepDetected ? unexplainedStepKg : 0, 3),
    slopeChangeKcal: Math.round(change.slopeChangeKcal),
    regimeChangeSuspected,
    userPrompt,
    suppressAdjustment,
    notes,
  };
}

/**
 * Inflation applied to the naive regression SE to account for the serial
 * correlation created by regressing on a cumulative series. Calibrated by
 * Monte Carlo so that the 95% CI achieves close to nominal coverage.
 */
const AUTOCORR_INFLATION = 3.0;

/* ------------------------------------------------------------------ */
/* Wearable / active-energy integration                                */
/* ------------------------------------------------------------------ */

/** A day's worth of wearable energy data from any source. */
export interface WearableDay {
  date: string;
  /** Active (non-resting) energy in kcal, if the source reports it directly. */
  activeKcal?: number;
  /** Total energy in kcal, if the source reports total rather than active. */
  totalKcal?: number;
  /** Basal/resting energy reported by the source, kcal. Needed to convert total -> active. */
  basalKcal?: number;
  /** Source identifier, used for de-duplication precedence. */
  source?: string;
}

/**
 * Normalise a wearable day to *active* kcal (excluding resting metabolism).
 *
 * Sources differ: Apple Health `activeEnergyBurned` is already active-only,
 * while many rings and watches surface a "total burn" that includes BMR. If we
 * mix them we systematically over-state activity by roughly one BMR per day.
 *
 * @param day one wearable record
 * @param fallbackBmrKcal BMR used when a total is given without a basal figure
 * @returns active kcal, floored at 0, or `null` when nothing usable is present
 */
export function normalizeActiveEnergy(day: WearableDay, fallbackBmrKcal?: number): number | null {
  if (typeof day.activeKcal === 'number' && Number.isFinite(day.activeKcal)) {
    return Math.max(0, day.activeKcal);
  }
  if (typeof day.totalKcal === 'number' && Number.isFinite(day.totalKcal)) {
    const basal =
      typeof day.basalKcal === 'number' && Number.isFinite(day.basalKcal)
        ? day.basalKcal
        : fallbackBmrKcal;
    if (typeof basal === 'number' && Number.isFinite(basal)) {
      return Math.max(0, day.totalKcal - basal);
    }
  }
  return null;
}

/** A discrete workout as reported by a source (Strava, Apple Workout, Oura, ...). */
export interface WorkoutRecord {
  /** Epoch milliseconds of workout start. */
  startMs: number;
  /** Epoch milliseconds of workout end. */
  endMs: number;
  /** Energy attributed to the workout, kcal. */
  kcal: number;
  /** Source identifier. */
  source: string;
}

/**
 * De-duplicate workouts that multiple connected apps reported for the same
 * session (a Strava ride that also lands in Apple Health as a Workout).
 *
 * Records whose time intervals overlap by more than `overlapFraction` of the
 * shorter record are grouped; the record from the highest-precedence source
 * survives, and ties fall back to the *lowest* kcal figure (conservative:
 * over-counting activity is the failure mode that hurts users).
 *
 * @param workouts records from all sources
 * @param sourcePrecedence source ids in descending trust order
 * @param overlapFraction minimum overlap to treat two records as the same session. Default 0.5.
 */
export function dedupeWorkouts(
  workouts: readonly WorkoutRecord[],
  sourcePrecedence: readonly string[] = [],
  overlapFraction = 0.5,
): WorkoutRecord[] {
  const sorted = [...workouts].sort((a, b) => a.startMs - b.startMs);
  const groups: WorkoutRecord[][] = [];
  for (const wk of sorted) {
    let placed = false;
    for (const g of groups) {
      const overlapping = g.some((o) => {
        const ov = Math.min(o.endMs, wk.endMs) - Math.max(o.startMs, wk.startMs);
        const shorter = Math.min(o.endMs - o.startMs, wk.endMs - wk.startMs);
        return shorter > 0 && ov / shorter >= overlapFraction;
      });
      if (overlapping) {
        g.push(wk);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([wk]);
  }
  const rank = (s: string): number => {
    const i = sourcePrecedence.indexOf(s);
    return i === -1 ? sourcePrecedence.length : i;
  };
  return groups.map((g) =>
    [...g].sort((a, b) => rank(a.source) - rank(b.source) || a.kcal - b.kcal)[0],
  );
}

export interface ActiveEnergyModifierOptions {
  /**
   * Trust coefficient applied to the wearable deviation, 0..1. Consumer
   * devices carry 20-30% error on active energy, so we only pass through part
   * of the signal. Default 0.5.
   */
  beta?: number;
  /** Cap on the absolute adjustment as a fraction of baseline TDEE. Default 0.25. */
  maxFractionOfTdee?: number;
}

export interface ActiveEnergyModifier {
  /** TDEE for today after applying the deviation modifier, kcal. */
  adjustedTdeeKcal: number;
  /** The applied adjustment, kcal (signed, zero-mean over time by construction). */
  deltaKcal: number;
  /** The activity baseline the deviation was measured against, kcal. */
  baselineActiveKcal: number;
  /** True when the adjustment hit the cap. */
  capped: boolean;
}

/**
 * Compute an exponentially-weighted baseline of daily active energy.
 *
 * This baseline is the whole trick behind avoiding double counting: the
 * adaptive TDEE estimate already averages in the user's habitual activity, so
 * only the *deviation from their own habitual activity* is new information.
 *
 * @param activeKcalSeries oldest-first daily active kcal
 * @param halfLifeDays half-life of the baseline. Default 21, matching the
 *   expenditure estimator's own recency weighting.
 */
export function activeEnergyBaseline(
  activeKcalSeries: readonly number[],
  halfLifeDays = 21,
): number {
  const usable = activeKcalSeries.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return 0;
  const n = usable.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(0.5, (n - 1 - i) / halfLifeDays);
    num += w * usable[i];
    den += w;
  }
  return num / den;
}

/**
 * Apply a wearable-derived modifier to today's expenditure **without double
 * counting**.
 *
 * `delta = beta * (todayActive - baselineActive)`, capped. Because the baseline
 * is the user's own trailing mean, the expected value of `delta` is zero, so
 * this cannot inflate or deflate the weekly energy budget — it only
 * redistributes calories between a rest day and a big training day.
 *
 * **Never** add raw wearable active energy to an adaptive TDEE. The adaptive
 * estimate is total expenditure; adding active energy counts exercise twice.
 *
 * @param baselineTdeeKcal adaptive TDEE from {@link estimateExpenditure}
 * @param todayActiveKcal today's normalised active energy
 * @param baselineActiveKcal output of {@link activeEnergyBaseline}
 */
export function applyActiveEnergyModifier(
  baselineTdeeKcal: number,
  todayActiveKcal: number,
  baselineActiveKcal: number,
  options: ActiveEnergyModifierOptions = {},
): ActiveEnergyModifier {
  const beta = options.beta ?? 0.5;
  const maxFrac = options.maxFractionOfTdee ?? 0.25;
  const raw = beta * (todayActiveKcal - baselineActiveKcal);
  const cap = maxFrac * baselineTdeeKcal;
  const delta = Math.max(-cap, Math.min(cap, raw));
  return {
    adjustedTdeeKcal: Math.round(baselineTdeeKcal + delta),
    deltaKcal: Math.round(delta),
    baselineActiveKcal: Math.round(baselineActiveKcal),
    capped: Math.abs(raw) > cap,
  };
}

/* ------------------------------------------------------------------ */
/* Constrained expenditure / exercise compensation                     */
/* ------------------------------------------------------------------ */

/**
 * Fraction of exercise energy that actually shows up as increased TDEE.
 *
 * The "constrained total energy expenditure" model (Pontzer) says the body
 * partially offsets deliberate exercise by cutting NEAT and other non-exercise
 * costs. MacroFactor publishes ~72 kcal of net TDEE per 100 kcal of exercise
 * on average (nearer 100 for sedentary users, nearer 40 for very active ones);
 * Pontzer's exercise-intervention data suggest a harsher ~30-50%.
 *
 * We use 0.72 as a mid-range default and expose it, but note that the adaptive
 * estimator observes the *net* effect empirically and therefore does not need
 * this constant at all — it only matters for feed-forward prediction.
 */
export const EXERCISE_COMPENSATION_FACTOR = 0.72;

/**
 * Feed-forward correction for a deliberate change in goal (Predictive Goal
 * Adjustment).
 *
 * Adaptive thermogenesis means expenditure genuinely falls when you enter a
 * deficit and rises when you enter a surplus, above and beyond the change in
 * body mass. Waiting for the estimator to observe this costs 2-3 weeks of lag.
 * Nudging the estimate proactively removes most of that lag.
 *
 * Calibration anchor: MacroFactor publishes that swinging from -1%/week loss to
 * +0.5%/week gain warrants a proactive **+6% expenditure over a couple of
 * weeks**, i.e. ~4% of TDEE per percentage-point of %BW/week swing.
 *
 * @param tdeeKcal current expenditure estimate
 * @param previousRatePctBwPerWeek signed rate before the goal change (loss negative)
 * @param newRatePctBwPerWeek signed rate after the goal change
 * @param daysSinceChange days elapsed since the goal changed
 * @param options `sensitivity` (default 0.04), `rampHalfLifeDays` (default 7), `maxFraction` (default 0.08)
 * @returns signed kcal adjustment to add to the expenditure estimate
 */
export function predictiveGoalAdjustment(
  tdeeKcal: number,
  previousRatePctBwPerWeek: number,
  newRatePctBwPerWeek: number,
  daysSinceChange: number,
  options: { sensitivity?: number; rampHalfLifeDays?: number; maxFraction?: number } = {},
): number {
  const sensitivity = options.sensitivity ?? 0.04;
  const rampHalfLife = options.rampHalfLifeDays ?? 7;
  const maxFraction = options.maxFraction ?? 0.08;
  if (daysSinceChange < 0) return 0;
  const swing = newRatePctBwPerWeek - previousRatePctBwPerWeek;
  const targetFraction = Math.max(
    -maxFraction,
    Math.min(maxFraction, sensitivity * swing),
  );
  // Saturating ramp: ~50% of the adjustment after one half-life, ~94% after four.
  const ramp = 1 - Math.pow(0.5, daysSinceChange / rampHalfLife);
  // Decay back out once the estimator has had time to observe reality (28 days).
  const decay = daysSinceChange > 28 ? Math.pow(0.5, (daysSinceChange - 28) / 14) : 1;
  return Math.round(tdeeKcal * targetFraction * ramp * decay);
}

/**
 * Step-informed responsiveness modulation.
 *
 * MacroFactor's published approach to step data is notable: steps are **not**
 * converted to calories and added anywhere. Instead a sustained step trend is
 * used as evidence that a real expenditure change is underway, which makes the
 * estimator update *faster* in that direction. This sidesteps the accuracy
 * problems of consumer kcal estimates entirely.
 *
 * We implement the same idea as a modification to the recency half-life: when
 * the recent step trend diverges from baseline in the same direction as the
 * current estimation error, shorten the half-life (be more responsive).
 *
 * @param baseHalfLifeDays the estimator's normal half-life
 * @param recentSteps mean daily steps over the last ~7 days
 * @param baselineSteps EWMA baseline of daily steps
 * @param options `minHalfLifeDays` (default 10), `sensitivity` fraction of step
 *   change needed for full effect (default 0.25 = a 25% step change)
 * @returns an adjusted half-life in days
 */
export function stepInformedHalfLife(
  baseHalfLifeDays: number,
  recentSteps: number,
  baselineSteps: number,
  options: { minHalfLifeDays?: number; sensitivity?: number } = {},
): number {
  const minHalfLife = options.minHalfLifeDays ?? 10;
  const sensitivity = options.sensitivity ?? 0.25;
  if (!(baselineSteps > 0)) return baseHalfLifeDays;
  const relChange = Math.abs(recentSteps - baselineSteps) / baselineSteps;
  const strength = Math.min(1, relChange / sensitivity);
  return baseHalfLifeDays - strength * (baseHalfLifeDays - minHalfLife);
}

/* ------------------------------------------------------------------ */
/* Data sufficiency                                                    */
/* ------------------------------------------------------------------ */

export type UpdateStatus = 'updating' | 'holding' | 'calibrating';

export interface DataSufficiency {
  status: UpdateStatus;
  /** True when the expenditure estimate should be advanced this cycle. */
  canUpdate: boolean;
  intakeDaysLast7: number;
  weighInsLast7: number;
  totalDaysLogged: number;
  reasons: string[];
}

/**
 * Decide whether there is enough recent data to move the expenditure estimate.
 *
 * Thresholds follow the operational rules MacroFactor publishes:
 * - continuous updating needs nutrition on >=4 of the last 7 days (>=6 for full
 *   confidence) and at least one weigh-in in the last 7 days;
 * - if weigh-ins stop, the estimate **holds** rather than drifting;
 * - the first ~30 days are a calibration phase where larger steps are allowed.
 *
 * @param days contiguous daily series, oldest first
 */
export function assessDataSufficiency(days: readonly ExpenditureDay[]): DataSufficiency {
  const last7 = days.slice(Math.max(0, days.length - 7));
  const intakeDays = last7.filter((d) => d.intakeKcal !== null && Number.isFinite(d.intakeKcal))
    .length;
  // A weigh-in is inferred from the presence of trend data; callers with
  // explicit observed-flags should pass those through instead.
  const weighIns = last7.length;
  const total = days.length;
  const reasons: string[] = [];

  let status: UpdateStatus = 'updating';
  let canUpdate = true;

  if (intakeDays < 4) {
    status = 'holding';
    canUpdate = false;
    reasons.push(`Only ${intakeDays}/7 days of food logging; need at least 4 to update.`);
  }
  if (weighIns < 1) {
    status = 'holding';
    canUpdate = false;
    reasons.push('No weigh-in in the last 7 days; expenditure is holding.');
  }
  if (canUpdate && total < 30) {
    status = 'calibrating';
    reasons.push(`Day ${total} of ~30-day calibration; the estimate may move a lot and overshoot.`);
  }
  if (canUpdate && intakeDays < 6) {
    reasons.push(`${intakeDays}/7 days logged. 6-7 days gives a materially tighter estimate.`);
  }

  return { status, canUpdate, intakeDaysLast7: intakeDays, weighInsLast7: weighIns, totalDaysLogged: total, reasons };
}

/* ------------------------------------------------------------------ */
/* Regression helpers                                                  */
/* ------------------------------------------------------------------ */

/** Result of splitting the cumulative-energy series at its best breakpoint. */
export interface ChangePointResult {
  /** Index of the best breakpoint, or -1 when the window is too short. */
  index: number;
  /**
   * Discontinuity in the *level* of the cumulative-energy series at the
   * breakpoint, expressed in kg of bodyweight.
   *
   * A level step means weight moved without energy moving: water. Positive =
   * the scale gained non-energetic mass (creatine loading, a carb refeed,
   * salt); negative = it shed some (stopping creatine, going low-carb).
   */
  levelStepKg: number;
  /**
   * Change in the *slope* at the breakpoint, kcal/day.
   *
   * A slope change means expenditure genuinely changed. This is the signal we
   * *want* the estimator to follow, and it must not be confused with a level
   * step — hence detecting both and reporting them separately.
   */
  slopeChangeKcal: number;
}

/**
 * Locate the single best breakpoint in the cumulative-energy series and
 * decompose the change there into a level step and a slope change.
 *
 * Why both: a naive "did something odd happen?" detector cannot tell creatine
 * loading (which must be ignored) from a genuine fall in expenditure (which
 * must be tracked). The two have different signatures in this series — water
 * is a discontinuity in level, metabolism is a change in gradient — and fitting
 * an independent line either side of a candidate breakpoint separates them
 * cleanly.
 *
 * @param t day indices
 * @param y cumulative-energy series
 * @param w regression weights
 * @param rho tissue energy density, kcal/kg
 * @param minSegment minimum days either side of the breakpoint. Default 14.
 */
export function detectStepAndSlopeChange(
  t: readonly number[],
  y: readonly number[],
  w: readonly number[],
  rho: number,
  minSegment = 14,
  maxTransitionDays = 35,
): ChangePointResult {
  const n = t.length;
  if (n < 2 * minSegment + 2) {
    return { index: -1, levelStepKg: 0, slopeChangeKcal: 0 };
  }

  let bestSsr = Infinity;
  let best: ChangePointResult = { index: -1, levelStepKg: 0, slopeChangeKcal: 0 };

  // Two breakpoints, not one. A sharp step (a carb refeed) has k2 == k1; a slow
  // ramp (creatine loading over four weeks, a new training block) has a
  // transition window between two otherwise stable regimes. Fitting a line to
  // the stable regime either side and ignoring the transition recovers the
  // total non-energetic shift in both cases, which a single-breakpoint model
  // cannot do — it absorbs a ramp into the slopes and reports no step at all.
  for (let k1 = minSegment; k1 <= n - minSegment; k1++) {
    const f1 = weightedLinearFit(t.slice(0, k1), y.slice(0, k1), w.slice(0, k1));
    if (!Number.isFinite(f1.slope)) continue;
    let ssr1 = 0;
    for (let i = 0; i < k1; i++) ssr1 += w[i] * (y[i] - (f1.intercept + f1.slope * t[i])) ** 2;

    const maxK2 = Math.min(n - minSegment, k1 + maxTransitionDays);
    for (let k2 = k1; k2 <= maxK2; k2++) {
      const f2 = weightedLinearFit(t.slice(k2), y.slice(k2), w.slice(k2));
      if (!Number.isFinite(f2.slope)) continue;
      let ssr = ssr1;
      for (let i = k2; i < n; i++) ssr += w[i] * (y[i] - (f2.intercept + f2.slope * t[i])) ** 2;
      // Penalise wide transition windows so we do not "explain" everything by
      // discarding half the data.
      const penalty = 1 + (k2 - k1) / n;
      const score = ssr * penalty;

      if (score < bestSsr) {
        bestSsr = score;
        const tm = (t[k1] + t[Math.min(k2, n - 1)]) / 2;
        const levelJumpKcal = f2.intercept + f2.slope * tm - (f1.intercept + f1.slope * tm);
        best = {
          index: k1,
          // y = cumulativeIntake - rho * dTrend, so a +dW kg water gain drives
          // y DOWN by rho*dW. Invert to recover the weight step.
          levelStepKg: -levelJumpKcal / rho,
          slopeChangeKcal: f2.slope - f1.slope,
        };
      }
    }
  }
  return best;
}

export interface WeightedFit {
  intercept: number;
  slope: number;
  /** Heteroskedasticity-robust (sandwich) standard error of the slope. */
  slopeSe: number;
  /** Kish effective sample size of the weights. */
  effectiveN: number;
  /** Weighted root mean squared residual. */
  rmse: number;
}

/**
 * Weighted ordinary least squares fit of `y = intercept + slope * t`.
 *
 * Weights are treated as importance weights, so the slope SE uses a
 * heteroskedasticity-robust sandwich estimator rather than the classic formula.
 *
 * @param t predictor values
 * @param y response values
 * @param w non-negative importance weights, same length
 */
export function weightedLinearFit(
  t: readonly number[],
  y: readonly number[],
  w: readonly number[],
): WeightedFit {
  const n = t.length;
  if (n !== y.length || n !== w.length) throw new Error('weightedLinearFit: length mismatch');
  const sw = sum(w);
  if (sw <= 0 || n < 3) return { intercept: 0, slope: 0, slopeSe: Infinity, effectiveN: 0, rmse: 0 };

  let tBar = 0;
  let yBar = 0;
  for (let i = 0; i < n; i++) {
    tBar += w[i] * t[i];
    yBar += w[i] * y[i];
  }
  tBar /= sw;
  yBar /= sw;

  let stt = 0;
  let sty = 0;
  for (let i = 0; i < n; i++) {
    const dt = t[i] - tBar;
    stt += w[i] * dt * dt;
    sty += w[i] * dt * (y[i] - yBar);
  }
  const slope = stt > 0 ? sty / stt : 0;
  const intercept = yBar - slope * tBar;

  let meat = 0;
  let wss = 0;
  for (let i = 0; i < n; i++) {
    const dt = t[i] - tBar;
    const r = y[i] - (intercept + slope * t[i]);
    meat += w[i] * w[i] * dt * dt * r * r;
    wss += w[i] * r * r;
  }
  const slopeSe = stt > 0 ? Math.sqrt(meat) / stt : Infinity;
  const effectiveN = (sw * sw) / sumSquares(w);

  return {
    intercept,
    slope,
    slopeSe,
    effectiveN,
    rmse: Math.sqrt(wss / sw),
  };
}

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
function sumSquares(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x * x;
  return s;
}
function sumProduct(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
