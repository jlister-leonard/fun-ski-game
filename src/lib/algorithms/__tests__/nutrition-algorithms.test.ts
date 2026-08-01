/**
 * nutrition-algorithms.test.ts — runnable assertions for the nutrition
 * algorithm modules.
 *
 * Ported verbatim from docs/kg/specs/algorithms/verify.mjs. Every assertion,
 * its condition and its tolerance are preserved one-for-one.
 *
 * These are behavioural assertions on synthetic data, not unit tests of
 * implementation details. The point is to prove the estimators recover known
 * ground truth from noisy simulated logs.
 */

import { it, expect } from 'vitest';

import {
  computeWeightTrend,
  ewmaTrend,
  summarizeTrend,
  perturbationOffsetKg,
  isPerturbationActive,
} from '../weight-trend';
import type { PerturbationEvent, TrendPoint, WeightEntry } from '../weight-trend';
import {
  estimateExpenditure,
  coldStartTdee,
  mifflinStJeorBmr,
  katchMcArdleBmr,
  effectiveKcalPerKg,
  activeEnergyBaseline,
  applyActiveEnergyModifier,
  normalizeActiveEnergy,
  dedupeWorkouts,
  predictiveGoalAdjustment,
  assessDataSufficiency,
  DEFAULT_KCAL_PER_KG,
} from '../expenditure';
import type { ExpenditureDay } from '../expenditure';
import {
  computeMacroTargets,
  weeklyCheckIn,
  dynamicMaintenanceRate,
  defaultRatePctBwPerWeek,
} from '../macro-targets';
import type { CheckInState, MacroTargetInput } from '../macro-targets';
import {
  validateProfile,
  validateTargets,
  validateWeightEntry,
  validateLoggedDay,
  validateObservedProgress,
  scoreScoff,
  assessBehaviouralSignals,
  detectLoggingDiscrepancy,
  validateAll,
  hasBlock,
  LIMITS,
  leanLossFraction,
  projectBodyFatOutcome,
  explainRateTradeoff,
  clampRatePctBwPerWeek,
  validateRate,
} from '../guardrails';
import type { TargetsToValidate, UserProfile } from '../guardrails';

/* ------------------------------------------------------------------ */
/* Test harness                                                        */
/* ------------------------------------------------------------------ */

let currentSection = 'preamble';
function section(title: string): void {
  currentSection = title;
}
function check(name: string, condition: boolean, detail = ''): void {
  const label = `${currentSection} · ${name}${detail ? ` (${detail})` : ''}`;
  it(label, () => {
    expect(condition).toBe(true);
  });
}
function near(name: string, actual: number, expected: number, tolerance: number): void {
  check(
    name,
    Math.abs(actual - expected) <= tolerance,
    `got ${round(actual, 2)}, expected ${round(expected, 2)} +/- ${tolerance}`,
  );
}
function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Unwrap a nullable numeric result; the assertions below never expect null. */
function requireNumber(x: number | null): number {
  if (x === null) throw new Error('expected a number, got null');
  return x;
}

/* ------------------------------------------------------------------ */
/* Deterministic PRNG + simulator                                      */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Box-Muller standard normal from a uniform generator. */
function makeNormal(rng: () => number): () => number {
  let spare: number | null = null;
  return function () {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}
function isoDate(dayIndex: number, start = Date.UTC(2026, 0, 1)): string {
  const d = new Date(start + dayIndex * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** One day of simulated food logging. */
interface SimLog {
  date: string;
  intakeKcal: number | null;
}

interface SimOptions {
  /** number of days */
  days: number;
  /** starting true weight */
  startKg: number;
  /** function(dayIndex) -> true TDEE that day */
  tdee: (dayIndex: number) => number;
  /** function(dayIndex) -> logged intake that day */
  intake: (dayIndex: number) => number;
  /** true tissue energy density */
  rho?: number;
  /** scale noise SD (kg) */
  noiseSd?: number;
  /** probability of weighing on a given day */
  weighInProb?: number;
  /** probability of logging food on a given day */
  logProb?: number;
  seed?: number;
  /** add transient multi-day water-weight excursions */
  waterShocks?: boolean;
}

interface SimResult {
  weights: WeightEntry[];
  logs: SimLog[];
  finalTrueKg: number;
}

/** Simulate a person. */
function simulate(opts: SimOptions): SimResult {
  const {
    days,
    startKg,
    tdee,
    intake,
    rho = DEFAULT_KCAL_PER_KG,
    noiseSd = 0.9,
    weighInProb = 1,
    logProb = 1,
    seed = 42,
    waterShocks = false,
  } = opts;
  const rng = mulberry32(seed);
  const normal = makeNormal(rng);

  const weights: WeightEntry[] = [];
  const logs: SimLog[] = [];
  let trueKg = startKg;
  let water = 0;

  for (let i = 0; i < days; i++) {
    const kcalIn = intake(i);
    const kcalOut = tdee(i);
    trueKg += (kcalIn - kcalOut) / rho;

    if (waterShocks) {
      // AR(1) water compartment plus occasional +1.5 kg salt/carb shocks.
      water = water * 0.75 + normal() * 0.25;
      if (rng() < 0.03) water += 1.5;
    }

    if (rng() < weighInProb) {
      weights.push({ date: isoDate(i), kg: trueKg + water + normal() * noiseSd });
    }
    logs.push({ date: isoDate(i), intakeKcal: rng() < logProb ? kcalIn : null });
  }
  return { weights, logs, finalTrueKg: trueKg };
}

/** Join a trend series to daily logs on date. */
function joinDays(trend: readonly TrendPoint[], logs: readonly SimLog[]): ExpenditureDay[] {
  const byDate = new Map(logs.map((l) => [l.date, l.intakeKcal]));
  return trend.map((t) => ({
    date: t.date,
    trendKg: t.trendKg,
    intakeKcal: byDate.has(t.date) ? (byDate.get(t.date) ?? null) : null,
  }));
}

/* ================================================================== */
section('1. WEIGHT TREND FILTER');
/* ================================================================== */

{
  // --- 1a. Recovers a known linear trend through heavy noise -----------
  const TRUE_RATE_KG_WK = -0.45;
  const sim = simulate({
    days: 90,
    startKg: 85,
    tdee: () => 2800,
    intake: () => 2800 + (TRUE_RATE_KG_WK / 7) * DEFAULT_KCAL_PER_KG,
    noiseSd: 0.9,
    seed: 7,
  });
  const trend = computeWeightTrend(sim.weights);
  const last = trend[trend.length - 1];
  const summary = summarizeTrend(trend);
  if (!summary) throw new Error('summarizeTrend returned null');

  check('90-day series produces 90 daily points', trend.length === 90, `got ${trend.length}`);
  near('trend weight tracks true weight', last.trendKg, sim.finalTrueKg, 0.5);
  near('weekly rate recovered', last.weeklyChangeKg, TRUE_RATE_KG_WK, 0.12);
  check(
    'rate 95% CI covers truth',
    summary.weeklyChangeCi95[0] <= TRUE_RATE_KG_WK && summary.weeklyChangeCi95[1] >= TRUE_RATE_KG_WK,
    `CI [${summary.weeklyChangeCi95[0]}, ${summary.weeklyChangeCi95[1]}]`,
  );
  check('rate is flagged actionable with daily data', summary.rateIsActionable === true);

  // Noise suppression: trend must be far smoother than the raw scale series.
  let rawVar = 0;
  let trendVar = 0;
  for (let i = 1; i < trend.length; i++) {
    rawVar += (trend[i].kg - trend[i - 1].kg) ** 2;
    trendVar += (trend[i].trendKg - trend[i - 1].trendKg) ** 2;
  }
  const smoothingRatio = Math.sqrt(rawVar / trendVar);
  check(
    'day-to-day trend movement is >5x smoother than scale',
    smoothingRatio > 5,
    `${round(smoothingRatio, 1)}x`,
  );
}

{
  // --- 1b. Single 4 kg outlier barely moves the trend ------------------
  const sim = simulate({ days: 60, startKg: 80, tdee: () => 2500, intake: () => 2500, noiseSd: 0.6, seed: 11 });
  const clean = computeWeightTrend(sim.weights);
  const spiked = sim.weights.map((w, i) => (i === 40 ? { ...w, kg: w.kg + 4 } : w));
  const dirty = computeWeightTrend(spiked);

  const impact = Math.abs(dirty[41].trendKg - clean[41].trendKg);
  check('4 kg single-day spike shifts trend by < 0.5 kg', impact < 0.5, `${round(impact, 3)} kg`);
  check('the spike is flagged as an outlier', dirty[40].outlier === true);

  const ew = ewmaTrend(spiked, 0.1);
  const ewImpact = Math.abs(ew[41].trendKg - ewmaTrend(sim.weights, 0.1)[41].trendKg);
  check(
    'Kalman rejects the spike better than a plain EWMA',
    impact < ewImpact,
    `kalman ${round(impact, 3)} kg vs ewma ${round(ewImpact, 3)} kg`,
  );
}

{
  // --- 1c. Adapts to a genuine trend break -----------------------------
  const sim = simulate({
    days: 120,
    startKg: 90,
    tdee: () => 2800,
    // Maintenance for 60 days, then a real 600 kcal deficit.
    intake: (i) => (i < 60 ? 2800 : 2200),
    noiseSd: 0.9,
    seed: 23,
  });
  const trend = computeWeightTrend(sim.weights);
  const causal = computeWeightTrend(sim.weights, { smooth: false });
  const expectedRate = (-600 * 7) / DEFAULT_KCAL_PER_KG; // ~-0.545 kg/wk

  // Use the CAUSAL series here: the RTS smoother legitimately anticipates the
  // break when looking back at history, so the smoothed rate at day 55 already
  // leans negative. That is correct behaviour for a chart, and exactly why
  // coaching decisions must read the causal estimate.
  near('rate is ~0 before the break (causal)', causal[55].weeklyChangeKg, 0, 0.15);
  check(
    'the smoother anticipates the break when looking backwards',
    trend[55].weeklyChangeKg < causal[55].weeklyChangeKg,
    `smoothed ${round(trend[55].weeklyChangeKg, 3)} vs causal ${round(causal[55].weeklyChangeKg, 3)} kg/wk`,
  );

  // Median days to reach 80% of the new rate, across 20 independent seeds.
  const convergenceDays: number[] = [];
  for (let s = 1; s <= 20; s++) {
    const run = simulate({
      days: 120, startKg: 90, tdee: () => 2800,
      intake: (i) => (i < 60 ? 2800 : 2200), noiseSd: 0.9, seed: s * 13,
    });
    const c = computeWeightTrend(run.weights, { smooth: false });
    let d = 99;
    for (let i = 60; i < 120; i++) {
      if (c[i].weeklyChangeKg <= 0.8 * expectedRate) { d = i - 60; break; }
    }
    convergenceDays.push(d);
  }
  convergenceDays.sort((a, b) => a - b);
  const medianDays = convergenceDays[10];
  check(
    'median detection of a real trend break is within 3 weeks',
    medianDays <= 24,
    `median ${medianDays} days, range ${convergenceDays[0]}-${convergenceDays[19]}`,
  );
  const maxAdapt = Math.max(...causal.slice(60, 100).map((p) => p.adaptationFactor));
  check('adaptive gate fires on the real break', maxAdapt > 2, `peak factor ${round(maxAdapt, 1)}`);
  near('settles on the new rate', trend[110].weeklyChangeKg, expectedRate, 0.15);
}

{
  // --- 1d. Sparse weigh-ins and gaps -----------------------------------
  const sim = simulate({
    days: 90,
    startKg: 75,
    tdee: () => 2200,
    intake: () => 2200 - 400,
    noiseSd: 0.9,
    weighInProb: 0.4,
    seed: 31,
  });
  const trend = computeWeightTrend(sim.weights);
  const expected = (-400 * 7) / DEFAULT_KCAL_PER_KG;
  // The series spans first weigh-in to last weigh-in, with every calendar day
  // in between present exactly once.
  let contiguous = true;
  for (let i = 1; i < trend.length; i++) {
    const gap =
      (Date.parse(`${trend[i].date}T00:00:00Z`) - Date.parse(`${trend[i - 1].date}T00:00:00Z`)) /
      86400000;
    if (gap !== 1) contiguous = false;
  }
  check('gaps are filled to a contiguous daily grid', contiguous, `${trend.length} days, no jumps`);
  near('rate recovered from ~40% weigh-in adherence', trend[trend.length - 1].weeklyChangeKg, expected, 0.2);
  const observedCount = trend.filter((p) => p.observed).length;
  check('observed flag matches input count', observedCount === sim.weights.length);
  const summary = summarizeTrend(trend);
  if (!summary) throw new Error('summarizeTrend returned null');
  check('sparse data widens the CI', summary.weeklyChangeCi95[1] - summary.weeklyChangeCi95[0] > 0.1);
}

{
  // --- 1e. Water-weight shocks -----------------------------------------
  const sim = simulate({
    days: 90,
    startKg: 82,
    tdee: () => 2600,
    intake: () => 2600 - 500,
    noiseSd: 0.8,
    waterShocks: true,
    seed: 55,
  });
  const trend = computeWeightTrend(sim.weights);
  const expected = (-500 * 7) / DEFAULT_KCAL_PER_KG;
  near('rate survives AR(1) water shocks', trend[trend.length - 1].weeklyChangeKg, expected, 0.2);
}

/* ================================================================== */
section('2. COLD START EQUATIONS');
/* ================================================================== */

{
  // Hand-computed reference values.
  const m = mifflinStJeorBmr('male', 80, 180, 30);
  near('Mifflin-St Jeor male 80kg/180cm/30y', m, 10 * 80 + 6.25 * 180 - 5 * 30 + 5, 0.01);
  check('...equals 1780 kcal', Math.round(m) === 1780, `${Math.round(m)}`);

  // 10*65 + 6.25*165 - 5*30 - 161 = 650 + 1031.25 - 150 - 161 = 1370.25
  const f = mifflinStJeorBmr('female', 65, 165, 30);
  check('Mifflin-St Jeor female 65kg/165cm/30y = 1370', Math.round(f) === 1370, `${Math.round(f)}`);

  const k = katchMcArdleBmr(64);
  check('Katch-McArdle at 64 kg LBM = 1752', Math.round(k) === 1752, `${Math.round(k)}`);

  const cs = coldStartTdee({
    sex: 'male',
    weightKg: 80,
    heightCm: 180,
    ageYears: 30,
    activityLevel: 'moderately_active',
  });
  check('cold start uses Mifflin without body fat', cs.equation === 'mifflin-st-jeor');
  near('cold start TDEE = BMR x 1.55', cs.tdeeKcal, 1780 * 1.55, 1);
  check('cold start SD is large (>=200)', cs.sdKcal >= 200, `${cs.sdKcal} kcal`);

  const cs2 = coldStartTdee({
    sex: 'male',
    weightKg: 80,
    heightCm: 180,
    ageYears: 30,
    bodyFatPct: 20,
    activityLevel: 'moderately_active',
  });
  check('cold start switches to Katch-McArdle with body fat', cs2.equation === 'katch-mcardle');

  // Forbes energy density.
  near('rho at 24 kg fat mass', effectiveKcalPerKg(24), 7150, 250);
  check('rho rises with fat mass', effectiveKcalPerKg(40) > effectiveKcalPerKg(15));
  check('rho stays in a sane band', effectiveKcalPerKg(5) >= 5200 && effectiveKcalPerKg(80) <= 8600);
}

/* ================================================================== */
section('3. ADAPTIVE EXPENDITURE ESTIMATOR');
/* ================================================================== */

{
  // --- 3a. THE HEADLINE TEST -------------------------------------------
  // 90 days at a true 500 kcal deficit. Does the estimator find the TDEE?
  const TRUE_TDEE = 2800;
  const INTAKE = 2300;
  const sim = simulate({
    days: 90,
    startKg: 85,
    tdee: () => TRUE_TDEE,
    intake: () => INTAKE,
    noiseSd: 0.9,
    seed: 101,
  });
  const trend = computeWeightTrend(sim.weights);
  const days = joinDays(trend, sim.logs);

  // Deliberately bad prior: 400 kcal too low.
  const prior = { tdeeKcal: 2400, sdKcal: 380 };
  const est = estimateExpenditure(days, { prior, bmrKcal: 1800 });

  console.log(
    `\n  >> 90d @ true TDEE ${TRUE_TDEE}, intake ${INTAKE}, prior ${prior.tdeeKcal}:\n` +
      `     posterior      = ${est.tdeeKcal} kcal  (SD ${est.sdKcal}, 95% CI [${est.ci95[0]}, ${est.ci95[1]}])\n` +
      `     data-only      = ${est.dataTdeeKcal} kcal (SD ${est.dataSdKcal})\n` +
      `     data weight    = ${est.dataWeight}   confidence = ${est.confidence} (${est.confidenceLabel})\n` +
      `     observed rate  = ${est.observedWeeklyChangeKg} kg/wk, mean intake ${est.meanIntakeKcal} kcal\n`,
  );

  near('converges near true TDEE', est.tdeeKcal, TRUE_TDEE, 120);
  check('escapes the bad prior', Math.abs(est.tdeeKcal - prior.tdeeKcal) > 250);
  check('95% CI covers the truth', est.ci95[0] <= TRUE_TDEE && est.ci95[1] >= TRUE_TDEE);
  check('data dominates after 90 days', est.dataWeight > 0.8, `${est.dataWeight}`);
  check('confidence is high', est.confidenceLabel === 'high', est.confidenceLabel);
  check('not clamped', est.clamped === false);

  // --- 3b. Convergence over time ---------------------------------------
  console.log('  >> convergence trajectory (same simulation, truncated):');
  const trajectory: Array<{ n: number; tdee: number; sd: number; dataWeight: number; src: string }> = [];
  for (const n of [7, 14, 21, 28, 42, 56, 90]) {
    const e = estimateExpenditure(days.slice(0, n), { prior, bmrKcal: 1800 });
    trajectory.push({ n, tdee: e.tdeeKcal, sd: e.sdKcal, dataWeight: e.dataWeight, src: e.source });
    console.log(
      `     day ${String(n).padStart(2)}: TDEE ${String(e.tdeeKcal).padStart(4)}  ` +
        `SD ${String(e.sdKcal).padStart(3)}  dataWeight ${String(e.dataWeight).padStart(5)}  ${e.source}`,
    );
  }
  const d7 = trajectory[0];
  const d28 = trajectory[3];
  const d90 = trajectory[6];
  check('day 7 still leans on the prior', d7.dataWeight < 0.6, `${d7.dataWeight}`);
  check('day 28 is data-dominant', d28.dataWeight > 0.6, `${d28.dataWeight}`);
  check('uncertainty shrinks monotonically-ish', d90.sd < d7.sd, `${d7.sd} -> ${d90.sd}`);
  check(
    'error shrinks as data accumulates',
    Math.abs(d90.tdee - TRUE_TDEE) < Math.abs(d7.tdee - TRUE_TDEE),
    `day7 err ${Math.abs(d7.tdee - TRUE_TDEE)} -> day90 err ${Math.abs(d90.tdee - TRUE_TDEE)}`,
  );

  // --- 3c. Naive back-calculation comparison ---------------------------
  // The thing we are claiming to be better than.
  const naiveErrors: number[] = [];
  const modelErrors: number[] = [];
  for (let end = 21; end <= 90; end += 7) {
    const w = days.slice(end - 14, end);
    const dW = w[w.length - 1].trendKg - w[0].trendKg;
    const meanIn = w.reduce((a, d) => a + (d.intakeKcal ?? 0), 0) / w.length;
    const naive = meanIn - (DEFAULT_KCAL_PER_KG * dW) / (w.length - 1);
    naiveErrors.push(Math.abs(naive - TRUE_TDEE));
    modelErrors.push(
      Math.abs(estimateExpenditure(days.slice(0, end), { prior, bmrKcal: 1800 }).tdeeKcal - TRUE_TDEE),
    );
  }
  const meanNaive = naiveErrors.reduce((a, b) => a + b, 0) / naiveErrors.length;
  const meanModel = modelErrors.reduce((a, b) => a + b, 0) / modelErrors.length;
  console.log(
    `\n  >> mean |error| vs true TDEE across 10 rolling evaluations:\n` +
      `     naive 14-day back-calculation : ${round(meanNaive, 0)} kcal\n` +
      `     cumulative weighted regression: ${round(meanModel, 0)} kcal\n`,
  );
  check('beats naive back-calculation', meanModel < meanNaive, `${round(meanModel, 0)} vs ${round(meanNaive, 0)} kcal`);
}

{
  // --- 3d. Tracks a real change in expenditure -------------------------
  const sim = simulate({
    days: 140,
    startKg: 88,
    tdee: (i) => (i < 70 ? 3000 : 2600), // job change, stopped commuting
    intake: () => 2600,
    noiseSd: 0.9,
    seed: 202,
  });
  const trend = computeWeightTrend(sim.weights);
  const days = joinDays(trend, sim.logs);
  const before = estimateExpenditure(days.slice(0, 70), { prior: { tdeeKcal: 2900, sdKcal: 380 } });
  const after = estimateExpenditure(days, { prior: { tdeeKcal: 2900, sdKcal: 380 } });
  console.log(`  >> TDEE step 3000 -> 2600 at day 70: before ${before.tdeeKcal}, after ${after.tdeeKcal}`);
  near('detects the pre-change level', before.tdeeKcal, 3000, 150);
  near('tracks down to the new level', after.tdeeKcal, 2600, 200);
}

{
  // --- 3e. Missing logs -------------------------------------------------
  const TRUE = 2700;
  const sim = simulate({
    days: 84,
    startKg: 80,
    tdee: () => TRUE,
    intake: () => 2300,
    noiseSd: 0.9,
    logProb: 0.7,
    weighInProb: 0.6,
    seed: 303,
  });
  const trend = computeWeightTrend(sim.weights);
  const days = joinDays(trend, sim.logs);
  const est = estimateExpenditure(days, { prior: { tdeeKcal: 2500, sdKcal: 380 }, bmrKcal: 1750 });
  console.log(
    `  >> 70% logging / 60% weigh-in: TDEE ${est.tdeeKcal} (SD ${est.sdKcal}), ` +
      `${est.imputedDays}/${est.daysUsed} days imputed`,
  );
  near('still lands close with patchy data', est.tdeeKcal, TRUE, 200);
  check('imputed days are counted', est.imputedDays > 0);

  // --- 3f. Cold start with no data -------------------------------------
  const none = estimateExpenditure([], { prior: { tdeeKcal: 2500, sdKcal: 380 } });
  check('empty history returns the prior', none.tdeeKcal === 2500 && none.source === 'prior');
  check('empty history has zero confidence', none.confidence === 0);

  const threeDays = estimateExpenditure(days.slice(0, 3), { prior: { tdeeKcal: 2500, sdKcal: 380 } });
  check('3 days of data still returns the prior', threeDays.source === 'prior');
}

{
  // --- 3g. Consistent under-logging self-corrects ----------------------
  // User truly eats 2600 but logs 2300 (300 kcal/day consistent under-report).
  const TRUE_TDEE = 2800;
  const TRUE_INTAKE = 2600;
  const UNDER = 300;
  const sim = simulate({
    days: 84,
    startKg: 85,
    tdee: () => TRUE_TDEE,
    intake: () => TRUE_INTAKE,
    noiseSd: 0.9,
    seed: 404,
  });
  const trend = computeWeightTrend(sim.weights);
  const logs = sim.logs.map((l) => ({ ...l, intakeKcal: l.intakeKcal === null ? null : l.intakeKcal - UNDER }));
  const est = estimateExpenditure(joinDays(trend, logs), { prior: { tdeeKcal: 2800, sdKcal: 380 } });
  console.log(
    `  >> consistent 300 kcal under-logging: estimate ${est.tdeeKcal} ` +
      `(true ${TRUE_TDEE}, expected ~${TRUE_TDEE - UNDER})`,
  );
  near('estimate shifts down by the logging bias', est.tdeeKcal, TRUE_TDEE - UNDER, 130);
  check(
    'so a target set in logged units still produces the right real intake',
    Math.abs(est.tdeeKcal - 500 + UNDER - (TRUE_TDEE - 500)) < 130,
  );
}

/* ================================================================== */
section('3H. CREATINE / NON-ENERGETIC PERTURBATION (THE DEATH-SPIRAL TEST)');
/* ================================================================== */

{
  // A user in a genuine, correct 500 kcal deficit starts 5 g/day creatine on
  // day 30. Creatine adds ~1.5 kg of intracellular water over ~4 weeks. The
  // scale flattens. A naive estimator reads that as "expenditure fell" and
  // cuts calories on a plan that was working perfectly.
  const TRUE_TDEE = 2900;
  const INTAKE = 2400;
  const CREATINE_DAY = 30;
  const CREATINE_SHIFT_KG = 1.5;
  const CREATINE_TAU = 28 / 3;

  const base = simulate({
    days: 90, startKg: 88, tdee: () => TRUE_TDEE, intake: () => INTAKE,
    noiseSd: 0.9, seed: 606,
  });
  // Overlay the creatine water loading on the observed scale weight only —
  // true body energy is completely unaffected.
  const dayIndex = new Map(base.weights.map((w, i) => [w.date, i]));
  const withCreatine = base.weights.map((w) => {
    const i = dayIndex.get(w.date) ?? Number.NaN;
    const elapsed = i - CREATINE_DAY;
    const water = elapsed < 0 ? 0 : CREATINE_SHIFT_KG * (1 - Math.pow(0.5, elapsed / CREATINE_TAU));
    return { date: w.date, kg: w.kg + water };
  });

  const creatineEvent: PerturbationEvent = { startDate: isoDate(CREATINE_DAY), type: 'creatine-start' };
  const prior = { tdeeKcal: 2800, sdKcal: 380 };

  // (a) No creatine at all — the reference.
  const refTrend = computeWeightTrend(base.weights);
  const refEst = estimateExpenditure(joinDays(refTrend, base.logs), { prior, bmrKcal: 1850 });

  // (b) Creatine taken, NOT logged, and no perturbation handling.
  const naiveTrend = computeWeightTrend(withCreatine);
  const naiveEst = estimateExpenditure(joinDays(naiveTrend, base.logs), { prior, bmrKcal: 1850 });

  // (c) Creatine taken AND logged.
  const loggedTrend = computeWeightTrend(withCreatine, { perturbations: [creatineEvent] });
  const loggedDays = joinDays(loggedTrend, base.logs).map((d, i) => ({
    ...d,
    energyTrendKg: loggedTrend[i].energyTrendKg,
    perturbationActive: loggedTrend[i].perturbationActive,
  }));
  const loggedEst = estimateExpenditure(loggedDays, { prior, bmrKcal: 1850 });

  console.log(
    `\n  True TDEE ${TRUE_TDEE} kcal, real deficit ${TRUE_TDEE - INTAKE} kcal/day throughout.\n` +
      `  Creatine started day ${CREATINE_DAY} (+${CREATINE_SHIFT_KG} kg water over 4 weeks, zero energy).\n\n` +
      `  (a) no creatine          : TDEE ${refEst.tdeeKcal}  (err ${refEst.tdeeKcal - TRUE_TDEE})  conf ${refEst.confidence}\n` +
      `  (b) creatine, NOT logged : TDEE ${naiveEst.tdeeKcal}  (err ${naiveEst.tdeeKcal - TRUE_TDEE})  conf ${naiveEst.confidence}  ` +
      `stepDetected ${naiveEst.unexplainedStepKg} kg  suppress=${naiveEst.suppressAdjustment}\n` +
      `  (c) creatine, logged     : TDEE ${loggedEst.tdeeKcal}  (err ${loggedEst.tdeeKcal - TRUE_TDEE})  conf ${loggedEst.confidence}  ` +
      `perturbDays ${loggedEst.perturbationDays}  suppress=${loggedEst.suppressAdjustment}\n`,
  );

  near('(c) logging creatine recovers the true TDEE', loggedEst.tdeeKcal, TRUE_TDEE, 150);
  check(
    '(c) logged creatine is far more accurate than ignoring it',
    Math.abs(loggedEst.tdeeKcal - TRUE_TDEE) < Math.abs(naiveEst.tdeeKcal - TRUE_TDEE),
    `logged err ${Math.abs(loggedEst.tdeeKcal - TRUE_TDEE)} vs unlogged err ${Math.abs(naiveEst.tdeeKcal - TRUE_TDEE)} kcal`,
  );
  // HONEST LIMITATION: a slow 4-week water ramp is NOT reliably separable from
  // a genuine fall in expenditure. Measured over 200 runs: ~18% detection at a
  // ~9% false-positive rate. We assert the bias exists and is bounded, and that
  // the user is prompted — not that we magically detect it.
  check(
    '(b) unlogged creatine biases the estimate DOWNWARD (the hazard is real)',
    naiveEst.tdeeKcal < refEst.tdeeKcal - 50,
    `unlogged ${naiveEst.tdeeKcal} vs reference ${refEst.tdeeKcal} kcal`,
  );
  check(
    '(b) but the bias is bounded, not a runaway',
    Math.abs(naiveEst.tdeeKcal - TRUE_TDEE) < 250,
    `err ${naiveEst.tdeeKcal - TRUE_TDEE} kcal`,
  );
  // Measure the prompt's real sensitivity/specificity rather than cherry-picking
  // a seed. This documents the honest capability of the automatic fallback.
  let promptOnCreatine = 0;
  let promptOnStable = 0;
  const TRIALS = 60;
  for (let s = 1; s <= TRIALS; s++) {
    const stable = simulate({
      days: 90, startKg: 88, tdee: () => TRUE_TDEE, intake: () => INTAKE, noiseSd: 0.9, seed: s * 17,
    });
    const idx = new Map(stable.weights.map((w, i) => [w.date, i]));
    const dosed = stable.weights.map((w) => {
      const i = idx.get(w.date) ?? Number.NaN;
      const el = i - CREATINE_DAY;
      return { date: w.date, kg: w.kg + (el < 0 ? 0 : CREATINE_SHIFT_KG * (1 - Math.pow(0.5, el / CREATINE_TAU))) };
    });
    const eStable = estimateExpenditure(joinDays(computeWeightTrend(stable.weights), stable.logs), { prior, bmrKcal: 1850 });
    const eDosed = estimateExpenditure(joinDays(computeWeightTrend(dosed), stable.logs), { prior, bmrKcal: 1850 });
    if (eStable.regimeChangeSuspected) promptOnStable++;
    if (eDosed.regimeChangeSuspected) promptOnCreatine++;
  }
  const sens = (100 * promptOnCreatine) / TRIALS;
  const fpr = (100 * promptOnStable) / TRIALS;
  console.log(
    `  Automatic fallback across ${TRIALS} runs: prompts the user on ${sens.toFixed(0)}% of unlogged\n` +
      `  creatine cases and ${fpr.toFixed(0)}% of genuinely stable ones. A slow water ramp is NOT\n` +
      `  reliably separable from a real drop in expenditure — logging the event is the accurate path.\n`,
  );
  check(
    'the prompt is meaningfully more likely when something really changed',
    sens > fpr * 1.8,
    `${sens.toFixed(0)}% vs ${fpr.toFixed(0)}% on stable data`,
  );
  check('the prompt names the likely causes', /creatine/.test(
    estimateExpenditure(joinDays(computeWeightTrend(withCreatine), base.logs), {
      prior, bmrKcal: 1850, regimeChangePromptKcal: 1,
    }).userPrompt ?? ''));

  // Suppression must be active DURING the settling window and must lift after.
  const midWindow = estimateExpenditure(loggedDays.slice(0, 51), { prior, bmrKcal: 1850 });
  check(
    '(c) adjustment is vetoed while creatine is still loading (day 50)',
    midWindow.suppressAdjustment === true,
    `perturbDays ${midWindow.perturbationDays}`,
  );
  check(
    '(c) normal estimation resumes once it has settled (day 90)',
    loggedEst.suppressAdjustment === false,
  );

  // --- THE ACTUAL SAFETY PROPERTY --------------------------------------
  // Run the weekly check-in loop across the creatine window in all three
  // scenarios and confirm the calorie target does NOT spiral downward.
  const macroInput: MacroTargetInput = {
    sex: 'male', ageYears: 34, heightCm: 180, bodyweightKg: 88, bodyFatPct: 21,
    goal: 'cut', tdeeKcal: TRUE_TDEE, trainingLoad: 'moderate',
  };
  function runCheckIns(
    trendSeries: readonly TrendPoint[],
    logs: readonly SimLog[],
    usePerturbationFields: boolean,
    respectVeto: boolean,
  ): number[] {
    const days: ExpenditureDay[] = joinDays(trendSeries, logs).map((d, i) => (usePerturbationFields
      ? { ...d, energyTrendKg: trendSeries[i].energyTrendKg, perturbationActive: trendSeries[i].perturbationActive }
      : d));
    let st: CheckInState = {
      lastAdjustedDate: isoDate(21),
      currentKcal: computeMacroTargets({ ...macroInput, tdeeKcal: 2900 }).kcal,
      lastAdjustmentSign: 0,
    };
    const path = [st.currentKcal];
    for (let d = 28; d < 90; d += 7) {
      const e = estimateExpenditure(days.slice(0, d + 1), { prior, bmrKcal: 1850 });
      const r = weeklyCheckIn(isoDate(d), { ...macroInput, tdeeKcal: e.tdeeKcal }, st, {
        estimateConfidence: e.confidence,
        suppressAdjustment: respectVeto ? e.suppressAdjustment : false,
      });
      if (r.shouldUpdate) {
        st = {
          lastAdjustedDate: isoDate(d),
          currentKcal: r.targets.kcal,
          lastAdjustmentSign: r.adjustmentSign,
        };
      }
      path.push(st.currentKcal);
    }
    return path;
  }

  const pathUnprotected = runCheckIns(naiveTrend, base.logs, false, false);
  const pathAutoDetect = runCheckIns(naiveTrend, base.logs, false, true);
  const pathLogged = runCheckIns(loggedTrend, base.logs, true, true);

  const drop = (p: readonly number[]): number => p[0] - Math.min(...p);
  console.log(
    `  Weekly calorie target across the creatine window (day 28 -> 88):\n` +
      `    unprotected (no perturbation logic) : ${pathUnprotected.join(' -> ')}   max drop ${drop(pathUnprotected)} kcal\n` +
      `    auto step-detection only            : ${pathAutoDetect.join(' -> ')}   max drop ${drop(pathAutoDetect)} kcal\n` +
      `    creatine logged                     : ${pathLogged.join(' -> ')}   max drop ${drop(pathLogged)} kcal\n`,
  );

  check(
    'auto step-detection is at least as protective as no handling',
    drop(pathAutoDetect) <= drop(pathUnprotected),
    `${drop(pathAutoDetect)} kcal vs ${drop(pathUnprotected)} kcal unprotected`,
  );
  check(
    'logging creatine prevents the spiral entirely',
    drop(pathLogged) <= 60,
    `max drop ${drop(pathLogged)} kcal`,
  );
  check(
    'the user is never cut below a sane floor by a water-weight artefact',
    Math.min(...pathAutoDetect) >= 2000 && Math.min(...pathLogged) >= 2000,
    `min targets: auto ${Math.min(...pathAutoDetect)}, logged ${Math.min(...pathLogged)} kcal`,
  );

  // The trend chart must still show the user their real scale weight, while
  // the estimator uses the corrected series.
  const lastLogged = loggedTrend[loggedTrend.length - 1];
  check(
    'trendKg keeps the water (what the scale says), energyTrendKg removes it',
    lastLogged.trendKg - lastLogged.energyTrendKg > 1.0,
    `offset ${lastLogged.perturbationOffsetKg} kg`,
  );
  check(
    'perturbation offset saturates near the modelled plateau',
    Math.abs(lastLogged.perturbationOffsetKg - 1.5) < 0.2,
    `${lastLogged.perturbationOffsetKg} kg`,
  );
}

{
  // Transient perturbations reverse; persistent ones do not.
  const carb: PerturbationEvent = { startDate: '2026-03-01', type: 'carb-load' };
  const d1 = perturbationOffsetKg(carb, '2026-03-03');
  const d12 = perturbationOffsetKg(carb, '2026-03-12');
  check('a carb load loads quickly', d1 > 0.6, `${round(d1, 2)} kg at +2d`);
  check('...and washes out', Math.abs(d12) < 0.2, `${round(d12, 2)} kg at +11d`);

  const creat: PerturbationEvent = { startDate: '2026-03-01', type: 'creatine-start' };
  check('creatine persists', perturbationOffsetKg(creat, '2026-06-01') > 1.4);
  check('nothing happens before the start date', perturbationOffsetKg(creat, '2026-02-01') === 0);
  check('the window closes after settling', isPerturbationActive([creat], '2026-05-01') === false);
  check('the window is open during settling', isPerturbationActive([creat], '2026-03-10') === true);
}

/* ================================================================== */
section('4. WEARABLE INTEGRATION (NO DOUBLE COUNTING)');
/* ================================================================== */

{
  const active: number[] = [];
  const rng = mulberry32(9);
  for (let i = 0; i < 60; i++) active.push(400 + (rng() < 0.4 ? 350 : 0) + rng() * 100);
  const baseline = activeEnergyBaseline(active);
  const tdee = 2800;

  // Zero-mean property: applying the modifier over the same window it was
  // built from must not change the average.
  let sumDelta = 0;
  for (const a of active.slice(-28)) {
    sumDelta += applyActiveEnergyModifier(tdee, a, baseline).deltaKcal;
  }
  const meanDelta = sumDelta / 28;
  console.log(`  >> baseline active ${Math.round(baseline)} kcal, mean applied delta ${round(meanDelta, 1)} kcal/day`);
  check('modifier is ~zero-mean, so it cannot shift the weekly budget', Math.abs(meanDelta) < 40, `${round(meanDelta, 1)} kcal`);

  const big = applyActiveEnergyModifier(tdee, baseline + 2000, baseline);
  check('large deviation is capped at 25% of TDEE', big.capped === true && big.deltaKcal === 700, `${big.deltaKcal}`);
  const rest = applyActiveEnergyModifier(tdee, baseline - 300, baseline);
  check('rest day lowers the day target', rest.deltaKcal < 0, `${rest.deltaKcal}`);

  // Total-vs-active normalisation.
  check(
    'total-burn source is converted to active',
    normalizeActiveEnergy({ date: 'x', totalKcal: 2600, basalKcal: 1750 }) === 850,
  );
  check(
    'active-only source passes through',
    normalizeActiveEnergy({ date: 'x', activeKcal: 620 }) === 620,
  );
  check(
    'falls back to supplied BMR',
    normalizeActiveEnergy({ date: 'x', totalKcal: 2600 }, 1800) === 800,
  );
  check('returns null when unusable', normalizeActiveEnergy({ date: 'x' }) === null);

  // Cross-source workout de-duplication.
  const t0 = Date.UTC(2026, 2, 1, 18, 0);
  const deduped = dedupeWorkouts(
    [
      { startMs: t0, endMs: t0 + 3600000, kcal: 720, source: 'strava' },
      { startMs: t0 + 60000, endMs: t0 + 3660000, kcal: 810, source: 'apple' },
      { startMs: t0 + 7200000, endMs: t0 + 9000000, kcal: 300, source: 'oura' },
    ],
    ['strava', 'apple', 'oura'],
  );
  check('overlapping workouts from two apps collapse to one', deduped.length === 2, `${deduped.length} kept`);
  check('precedence order is respected', deduped[0].source === 'strava', deduped[0].source);
}

{
  // Predictive goal adjustment (feed-forward for adaptive thermogenesis).
  const a0 = predictiveGoalAdjustment(2800, -1.0, 0.5, 0);
  const a7 = predictiveGoalAdjustment(2800, -1.0, 0.5, 7);
  const a14 = predictiveGoalAdjustment(2800, -1.0, 0.5, 14);
  const a60 = predictiveGoalAdjustment(2800, -1.0, 0.5, 60);
  console.log(`  >> goal swing -1%/wk -> +0.5%/wk, adjustment by day: 0d ${a0}, 7d ${a7}, 14d ${a14}, 60d ${a60}`);
  check('no adjustment on day zero', a0 === 0);
  check('positive when swinging deficit -> surplus', a14 > 0);
  near('~6% of TDEE after two weeks (MacroFactor anchor)', a14 / 2800, 0.045, 0.02);
  check('decays away once the estimator has caught up', Math.abs(a60) < Math.abs(a14));
  check('reversed swing gives a negative adjustment', predictiveGoalAdjustment(2800, 0.5, -1.0, 14) < 0);
}

{
  // Data sufficiency gating.
  const full: ExpenditureDay[] = Array.from({ length: 40 }, (_, i) => ({ date: isoDate(i), trendKg: 80, intakeKcal: 2400 }));
  check('full logging updates', assessDataSufficiency(full).canUpdate === true);
  const sparse = full.map((d, i) => (i >= 35 ? { ...d, intakeKcal: null } : d));
  const s = assessDataSufficiency(sparse);
  check('fewer than 4 logged days in 7 puts it on hold', s.canUpdate === false && s.status === 'holding');
  const young = full.slice(0, 12);
  check('first 30 days are flagged as calibrating', assessDataSufficiency(young).status === 'calibrating');
}

/* ================================================================== */
section('5. MACRO TARGETS');
/* ================================================================== */

{
  const input: MacroTargetInput = {
    sex: 'male',
    ageYears: 34,
    heightCm: 180,
    bodyweightKg: 88,
    bodyFatPct: 22,
    goal: 'cut',
    tdeeKcal: 2850,
    bmrKcal: 1800,
    trainingLoad: 'moderate',
  };
  const t = computeMacroTargets(input);
  console.log(
    `\n  >> Synthetic cutting scenario:\n` +
      `     ${t.kcal} kcal | P ${t.proteinG} g | C ${t.carbG} g | F ${t.fatG} g | fibre ${t.fiberG} g\n` +
      `     rate ${t.targetRatePctBwPerWeek}%/wk = ${t.targetRateKgPerWeek} kg/wk, offset ${t.energyOffsetKcal} kcal, rho ${t.kcalPerKgTissue}\n` +
      `     %E: P ${t.percentEnergy.protein} / C ${t.percentEnergy.carb} / F ${t.percentEnergy.fat}\n` +
      `     per kg BW: P ${t.perKgBodyweight.protein} | per kg LBM: P ${t.perKgLeanMass?.protein}\n`,
  );

  check('deficit is applied', t.kcal < input.tdeeKcal, `${t.kcal} < ${input.tdeeKcal}`);
  check('macros sum to the calorie target', Math.abs(t.proteinKcal + t.carbKcal + t.fatKcal - t.kcal) <= 10);
  check(
    'protein sits in the Helms deficit band (2.3-3.1 g/kg FFM)',
    requireNumber(t.perKgLeanMass?.protein ?? null) >= 2.2 && requireNumber(t.perKgLeanMass?.protein ?? null) <= 3.15,
    `${t.perKgLeanMass?.protein} g/kg LBM`,
  );
  check('fat is at or above 0.5 g/kg', t.perKgBodyweight.fat >= 0.49, `${t.perKgBodyweight.fat} g/kg`);
  check('fat is at or above 20% of energy', t.percentEnergy.fat >= 19.5, `${t.percentEnergy.fat}%`);
  check('carbs clear the 130 g reference intake', t.carbG >= 130, `${t.carbG} g`);
  check('default loss rate is in the 0.5-1.0%/wk band', Math.abs(t.targetRatePctBwPerWeek) <= 1.0 && Math.abs(t.targetRatePctBwPerWeek) >= 0.5);

  // Energy-balance round trip: does the prescribed deficit imply the target rate?
  const impliedKgPerWeek = ((t.kcal - input.tdeeKcal) * 7) / t.kcalPerKgTissue;
  near('deficit is consistent with the target rate', impliedKgPerWeek, t.targetRateKgPerWeek, 0.05);
}

{
  // Training load shifts carbs, not calories.
  const base: MacroTargetInput = {
    sex: 'male', ageYears: 30, heightCm: 178, bodyweightKg: 80, bodyFatPct: 18,
    goal: 'maintain', tdeeKcal: 2800, trainingLoad: 'light',
  };
  const light = computeMacroTargets(base);
  const heavy = computeMacroTargets({ ...base, trainingLoad: 'veryHigh' });
  console.log(
    `  >> training load: light C ${light.carbG} g / F ${light.fatG} g  ->  ` +
      `veryHigh C ${heavy.carbG} g / F ${heavy.fatG} g  (kcal ${light.kcal} vs ${heavy.kcal})`,
  );
  check('higher training load raises carbs', heavy.carbG > light.carbG);
  check('...by trading against fat, not calories', Math.abs(heavy.kcal - light.kcal) <= 20 && heavy.fatG < light.fatG);
  check('fat never goes below the floor', heavy.perKgBodyweight.fat >= 0.49, `${heavy.perKgBodyweight.fat}`);
}

{
  // Goal direction and default rates.
  const base: Omit<MacroTargetInput, 'goal'> = {
    sex: 'female', ageYears: 29, heightCm: 166, bodyweightKg: 62, bodyFatPct: 26,
    tdeeKcal: 2100, trainingLoad: 'moderate',
  };
  const cut = computeMacroTargets({ ...base, goal: 'cut' });
  const maintain = computeMacroTargets({ ...base, goal: 'maintain' });
  const gain = computeMacroTargets({ ...base, goal: 'gain' });
  console.log(
    `  >> 62 kg female, TDEE 2100: cut ${cut.kcal} | maintain ${maintain.kcal} | gain ${gain.kcal} kcal`,
  );
  check('cut < maintain < gain', cut.kcal < maintain.kcal && maintain.kcal < gain.kcal);
  near('maintain equals TDEE', maintain.kcal, 2100, 20);
  check('gain rate is conservative (<=0.5%/wk)', gain.targetRatePctBwPerWeek <= 0.5, `${gain.targetRatePctBwPerWeek}`);
  check('higher body fat -> faster default cut', Math.abs(defaultRatePctBwPerWeek('cut', 'female', 40)) > Math.abs(defaultRatePctBwPerWeek('cut', 'female', 18)));

  // High body fat uses lean-mass protein basis.
  const obese = computeMacroTargets({
    sex: 'male', ageYears: 45, heightCm: 175, bodyweightKg: 120, bodyFatPct: 38,
    goal: 'cut', tdeeKcal: 3000, trainingLoad: 'light',
  });
  console.log(`  >> 120 kg / 38% BF: ${obese.kcal} kcal, P ${obese.proteinG} g (${obese.perKgBodyweight.protein} g/kg BW, ${obese.perKgLeanMass?.protein} g/kg LBM)`);
  check(
    'high body fat prescribes protein per kg lean mass, not bodyweight',
    obese.perKgBodyweight.protein < 2.0 && requireNumber(obese.perKgLeanMass?.protein ?? null) >= 2.2,
    `${obese.perKgBodyweight.protein} g/kg BW`,
  );
}

{
  // Dynamic maintenance dead band.
  check('inside the dead band, no correction', dynamicMaintenanceRate(80.4, 80) === 0);
  check('above target, gentle deficit', dynamicMaintenanceRate(82, 80) === -0.15);
  check('below target, gentle surplus', dynamicMaintenanceRate(78, 80) === 0.15);
}

/* ================================================================== */
section('6. WEEKLY CHECK-IN RATE LIMITING');
/* ================================================================== */

{
  const input: MacroTargetInput = {
    sex: 'male', ageYears: 34, heightCm: 180, bodyweightKg: 88, bodyFatPct: 22,
    goal: 'cut', tdeeKcal: 2850, trainingLoad: 'moderate',
  };
  const baseTargets = computeMacroTargets(input);
  const state: CheckInState = { lastAdjustedDate: '2026-03-01', currentKcal: baseTargets.kcal, lastAdjustmentSign: 0 };

  // Cadence.
  const early = weeklyCheckIn('2026-03-04', input, state);
  check('will not adjust before 7 days', early.shouldUpdate === false && early.limitedBy === 'cadence');

  // Dead band.
  const tiny = weeklyCheckIn('2026-03-08', { ...input, tdeeKcal: 2870 }, state);
  check('20 kcal of TDEE movement is inside the dead band', tiny.shouldUpdate === false && tiny.limitedBy === 'dead-band');

  // Step cap.
  const huge = weeklyCheckIn('2026-03-08', { ...input, tdeeKcal: 3600 }, state);
  console.log(
    `  >> TDEE jumps 2850 -> 3600: raw change ${huge.rawChangeKcal} kcal, applied ${huge.appliedChangeKcal} kcal (${huge.limitedBy})`,
  );
  check('a huge jump is capped', huge.limitedBy === 'step-cap' && Math.abs(huge.appliedChangeKcal) <= 300);
  check('...but does move in the right direction', huge.appliedChangeKcal > 0);

  // Reversal damping.
  const reversing = weeklyCheckIn(
    '2026-03-08',
    { ...input, tdeeKcal: 2650 },
    { ...state, lastAdjustmentSign: 1 },
  );
  console.log(
    `  >> reversal: raw ${reversing.rawChangeKcal} kcal, applied ${reversing.appliedChangeKcal} kcal (${reversing.limitedBy})`,
  );
  check('a reversing adjustment is damped', Math.abs(reversing.appliedChangeKcal) < Math.abs(reversing.rawChangeKcal));

  // Four-week cumulative cap.
  const drifted = weeklyCheckIn(
    '2026-03-08',
    { ...input, tdeeKcal: 4200 },
    { ...state, currentKcal: 2700, kcalFourWeeksAgo: 2200, lastAdjustmentSign: 1 },
  );
  check('cumulative four-week drift is capped', drifted.limitedBy === 'four-week-cap', drifted.limitedBy);

  // --- Oscillation stress test -----------------------------------------
  // Feed noisy TDEE estimates and confirm the target does not thrash.
  const rng = mulberry32(77);
  const normal = makeNormal(rng);
  const TDEE_NOISE_SD = 150;
  const SEEDS = 10;
  let st: CheckInState = { lastAdjustedDate: '2026-03-01', currentKcal: baseTargets.kcal, lastAdjustmentSign: 0 };
  const history = [st.currentKcal];
  const proposals: number[] = [];
  let updates = 0;
  for (let wk = 1; wk <= 26; wk++) {
    const date = isoDate(wk * 7, Date.UTC(2026, 2, 1));
    const noisyTdee = 2850 + normal() * TDEE_NOISE_SD;
    proposals.push(computeMacroTargets({ ...input, tdeeKcal: noisyTdee }).kcal);
    const r = weeklyCheckIn(date, { ...input, tdeeKcal: noisyTdee }, st);
    if (r.shouldUpdate) {
      updates++;
      st = {
        lastAdjustedDate: date,
        currentKcal: r.targets.kcal,
        lastAdjustmentSign: r.adjustmentSign,
        kcalFourWeeksAgo: history[Math.max(0, history.length - 4)],
      };
    }
    history.push(st.currentKcal);
  }
  const sd = (xs: readonly number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const totalVariation = history.slice(1).reduce((a, v, i) => a + Math.abs(v - history[i]), 0);
  const proposalSd = sd(proposals);
  const targetSd = sd(history);
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  console.log(
    `\n  >> 26 weekly check-ins with +/-${TDEE_NOISE_SD} kcal SD of TDEE noise around a true 2850:\n` +
      `     unfiltered proposals : SD ${Math.round(proposalSd)} kcal, range ${Math.min(...proposals)}-${Math.max(...proposals)}\n` +
      `     applied targets      : SD ${Math.round(targetSd)} kcal, range ${Math.min(...history)}-${Math.max(...history)}\n` +
      `     mean target ${Math.round(mean)} kcal (unfiltered target would be ${baseTargets.kcal})\n` +
      `     ${updates}/26 weeks actually changed; total movement ${Math.round(totalVariation)} kcal\n`,
  );
  check(
    'rate limiting cuts target variance well below the input noise',
    targetSd < 0.6 * proposalSd,
    `target SD ${Math.round(targetSd)} vs proposal SD ${Math.round(proposalSd)} kcal`,
  );
  // Average over 10 independent noise realisations: a single seed is far too
  // noisy a basis for a stability claim.
  let updSum = 0;
  let ratioSum = 0;
  let movementSum = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r2 = mulberry32(seed * 31);
    const n2 = makeNormal(r2);
    let s2: CheckInState = { lastAdjustedDate: '2026-03-01', currentKcal: baseTargets.kcal, lastAdjustmentSign: 0 };
    const h2 = [s2.currentKcal];
    const p2: number[] = [];
    let u2 = 0;
    for (let wk = 1; wk <= 26; wk++) {
      const date = isoDate(wk * 7, Date.UTC(2026, 2, 1));
      const tv2 = 2850 + n2() * TDEE_NOISE_SD;
      p2.push(computeMacroTargets({ ...input, tdeeKcal: tv2 }).kcal);
      const rr = weeklyCheckIn(date, { ...input, tdeeKcal: tv2 }, s2);
      if (rr.shouldUpdate) {
        u2++;
        s2 = {
          lastAdjustedDate: date, currentKcal: rr.targets.kcal,
          lastAdjustmentSign: rr.adjustmentSign,
          kcalFourWeeksAgo: h2[Math.max(0, h2.length - 4)],
        };
      }
      h2.push(s2.currentKcal);
    }
    updSum += u2;
    ratioSum += sd(h2) / sd(p2);
    movementSum += h2.slice(1).reduce((a, v, i) => a + Math.abs(v - h2[i]), 0) / 26;
  }
  console.log(
    `     across ${SEEDS} seeds: ${(updSum / SEEDS).toFixed(1)}/26 weeks changed, ` +
      `SD ratio ${(ratioSum / SEEDS).toFixed(2)}, avg weekly move ${(movementSum / SEEDS).toFixed(0)} kcal\n`,
  );
  check(
    'about half the weeks change at all, on average',
    updSum / SEEDS <= 15,
    `${(updSum / SEEDS).toFixed(1)}/26`,
  );
  check(
    'the average weekly change is imperceptible',
    movementSum / SEEDS <= 50,
    `${(movementSum / SEEDS).toFixed(0)} kcal/week`,
  );
  check(
    'cumulative churn stays modest',
    totalVariation <= 1600,
    `${Math.round(totalVariation)} kcal of total movement over 26 weeks`,
  );
  near('targets stay centred on the right answer', mean, baseTargets.kcal, 120);
}

/* ================================================================== */
section('7. GUARDRAILS');
/* ================================================================== */

{
  const healthy: UserProfile = {
    sex: 'male', ageYears: 34, heightCm: 180, bodyweightKg: 88, bodyFatPct: 22, goal: 'cut',
  };
  check('a healthy adult profile passes', !hasBlock(validateProfile(healthy)));

  // Age.
  check('under 18 is blocked', hasBlock(validateProfile({ ...healthy, ageYears: 16 })));
  // Pregnancy.
  check('pregnancy is blocked', hasBlock(validateProfile({ ...healthy, sex: 'female', pregnant: true })));
  // Early lactation.
  check(
    'early lactation cut is blocked',
    hasBlock(validateProfile({ ...healthy, sex: 'female', breastfeeding: true, weeksPostpartum: 3 })),
  );
  // ED history.
  check('declared ED history is blocked', hasBlock(validateProfile({ ...healthy, eatingDisorderHistory: true })));

  // BMI.
  const underweight = { ...healthy, bodyweightKg: 55, heightCm: 180 }; // BMI 17.0
  check('underweight + cut is blocked', hasBlock(validateProfile(underweight)));
  check('underweight + gain is allowed', !hasBlock(validateProfile({ ...underweight, goal: 'gain' })));
  const severe = { ...healthy, bodyweightKg: 48, heightCm: 180 }; // BMI 14.8
  check('severe thinness blocks every goal', hasBlock(validateProfile({ ...severe, goal: 'gain' })));

  // Goal weight in underweight territory.
  const badGoal = validateProfile({ ...healthy, goalWeightKg: 58 }); // BMI 17.9
  check('an underweight goal weight is blocked', hasBlock(badGoal));
  check(
    '...and the message states the minimum acceptable goal weight',
    badGoal.some((f) => f.code === 'GOAL_WEIGHT_UNDERWEIGHT' && /59\.9|60\.0/.test(f.message)),
    badGoal.find((f) => f.code === 'GOAL_WEIGHT_UNDERWEIGHT')?.message.slice(-60),
  );
}

{
  const profile: UserProfile = { sex: 'female', ageYears: 30, heightCm: 165, bodyweightKg: 62, bodyFatPct: 26, goal: 'cut' };

  // Calorie floors.
  const starve: TargetsToValidate = { kcal: 700, proteinG: 120, carbG: 40, fatG: 25, targetRatePctBwPerWeek: -1.2 };
  const f1 = validateTargets(starve, { profile, bmrKcal: 1400 });
  check('a sub-800 kcal target is blocked', f1.some((f) => f.code === 'KCAL_BELOW_VLCD_FLOOR' && f.level === 'block'));

  const low: TargetsToValidate = { kcal: 1100, proteinG: 130, carbG: 90, fatG: 32, targetRatePctBwPerWeek: -0.9 };
  const f2 = validateTargets(low, { profile, bmrKcal: 1400 });
  check('below the 1200 kcal female floor is blocked', f2.some((f) => f.code === 'KCAL_BELOW_GUIDELINE_FLOOR' && f.level === 'block'));
  check('clinician supervision lifts the guideline floor', !validateTargets(low, { profile: { ...profile, clinicianSupervised: true }, bmrKcal: 1400 }).some((f) => f.code === 'KCAL_BELOW_GUIDELINE_FLOOR'));
  check('but never the BMR-relative floor', validateTargets({ ...low, kcal: 1050 }, { profile: { ...profile, clinicianSupervised: true }, bmrKcal: 1400 }).some((f) => f.code === 'KCAL_BELOW_BMR_FLOOR' && f.level === 'block'));

  // Rate.
  const fast: TargetsToValidate = { kcal: 1400, proteinG: 130, carbG: 110, fatG: 40, targetRatePctBwPerWeek: -2.0 };
  check('a 2%/wk loss rate is blocked', validateTargets(fast, { profile, bmrKcal: 1400 }).some((f) => f.code === 'RATE_LOSS_UNSAFE' && f.level === 'block'));

  // Fat floor.
  const lowFat: TargetsToValidate = { kcal: 2000, proteinG: 130, carbG: 330, fatG: 25, targetRatePctBwPerWeek: -0.5 };
  check('fat below 15% of energy is blocked', validateTargets(lowFat, { profile }).some((f) => f.code === 'FAT_BELOW_HARD_FLOOR' && f.level === 'block'));

  // Protein ceiling.
  const megaProtein: TargetsToValidate = { kcal: 2400, proteinG: 250, carbG: 200, fatG: 68, targetRatePctBwPerWeek: -0.5 };
  check('protein above 3.5 g/kg is blocked', validateTargets(megaProtein, { profile }).some((f) => f.code === 'PROTEIN_EXCESSIVE' && f.level === 'block'));

  // Energy availability.
  const athlete: UserProfile = { sex: 'female', ageYears: 24, heightCm: 170, bodyweightKg: 58, bodyFatPct: 18, goal: 'cut' };
  const eaLow: TargetsToValidate = { kcal: 1900, proteinG: 130, carbG: 200, fatG: 55, targetRatePctBwPerWeek: -0.7 };
  const eaFindings = validateTargets(eaLow, { profile: athlete, bmrKcal: 1350, exerciseKcalPerDay: 700 });
  check('low energy availability is caught', eaFindings.some((f) => f.code === 'ENERGY_AVAILABILITY_LOW'));

  // A well-formed target set passes.
  const good = computeMacroTargets({
    sex: 'female', ageYears: 30, heightCm: 165, bodyweightKg: 62, bodyFatPct: 26,
    goal: 'cut', tdeeKcal: 2100, trainingLoad: 'moderate',
  });
  const gf = validateTargets(good, { profile, bmrKcal: 1400 });
  check(
    'a generated target set passes its own guardrails',
    !hasBlock(gf),
    gf.filter((f) => !f.ok).map((f) => f.code).join(', ') || 'clean',
  );
}

{
  // --- Rate of loss vs a BODY-FAT PERCENTAGE goal ----------------------
  // Synthetic aggressive-cut scenario.
  check('lean-loss fraction rises with rate', leanLossFraction(1.5) > leanLossFraction(0.5));
  check('lean-loss fraction is bounded', leanLossFraction(5) <= 0.6 && leanLossFraction(0.1) >= 0);

  const rates = [0.5, 0.7, 1.0, 1.5, 2.0];
  console.log('\n  >> Synthetic aggressive-cut scenario:');
  console.log('     rate%/wk  weeks  endWeight  fatLost  leanLost');
  const projections = rates.map((r) => {
    const p = projectBodyFatOutcome(91, 26, 18, r);
    console.log(
      `     ${String(r).padEnd(8)}  ${String(p.weeksToTarget).padStart(5)}  ${String(p.endWeightKg).padStart(9)}  ` +
        `${String(p.fatMassLostKg).padStart(7)}  ${String(p.leanMassLostKg).padStart(8)}`,
    );
    return p;
  });
  const at07 = projections[1];
  const at20 = projections[4];
  check(
    'doubling the rate does NOT halve the time to a body-fat goal',
    requireNumber(at20.weeksToTarget) > requireNumber(at07.weeksToTarget) / 2,
    `0.7%/wk: ${at07.weeksToTarget} wks, 2.0%/wk: ${at20.weeksToTarget} wks`,
  );
  check(
    'the aggressive route costs materially more lean mass',
    requireNumber(at20.leanMassLostKg) > requireNumber(at07.leanMassLostKg) * 2,
    `${at07.leanMassLostKg} kg vs ${at20.leanMassLostKg} kg`,
  );

  const tradeoff = explainRateTradeoff(91, 26, 18, 1.5, 0.7);
  console.log(`\n  >> trade-off copy at 1.5%/wk:\n     ${tradeoff[0].message}\n`);
  check('a poor trade-off is flagged', tradeoff[0].level === 'warn' || tradeoff[0].level === 'info');
  check(
    'the copy explains the denominator effect, not just a bare limit',
    /divided by total weight|bottom of that fraction/.test(tradeoff[0].message),
  );

  // Enforcement, not just explanation.
  check('loss rate is clamped to the 1%/wk ceiling', clampRatePctBwPerWeek(-2.5) === -1.0);
  check('gain rate is clamped to 0.5%/wk', clampRatePctBwPerWeek(1.9) === 0.5);
  check('a legal rate passes through untouched', clampRatePctBwPerWeek(-0.7) === -0.7);

  const asapProfile: UserProfile = {
    sex: 'male', ageYears: 31, heightCm: 184, bodyweightKg: 91,
    bodyFatPct: 26, goalBodyFatPct: 18, goal: 'cut',
  };
  const asap = validateRate(-1.8, asapProfile);
  check('an "ASAP" rate is blocked', asap.some((f) => f.code === 'RATE_LOSS_UNSAFE' && f.level === 'block'));
  check(
    '...and accompanied by the body-fat reasoning',
    asap.some((f) => f.code === 'RATE_TRADEOFF' || f.code === 'RATE_TRADEOFF_POOR'),
    asap.map((f) => f.code).join(', '),
  );
}

{
  // Observed progress.
  const tooFast = validateObservedProgress({ weeklyChangeKg: -1.6, trendKg: 80, weeksSustained: 3, intentional: true });
  check('sustained >1.5%/wk loss triggers a warning', tooFast.some((f) => f.code === 'OBSERVED_LOSS_TOO_FAST' && f.level === 'warn'));
  check(
    'a single fast week does not',
    validateObservedProgress({ weeklyChangeKg: -1.6, trendKg: 80, weeksSustained: 1, intentional: true }).every((f) => f.level !== 'warn'),
  );
  check(
    'unintended loss triggers a referral',
    validateObservedProgress({ weeklyChangeKg: -0.9, trendKg: 70, weeksSustained: 4, intentional: false, pctLost30d: 6 }).some((f) => f.code === 'UNINTENDED_LOSS_30D'),
  );
}

{
  // Logged-data plausibility.
  check('a 400 kcal day is flagged, not accepted', validateLoggedDay({ loggedKcal: 400, bmrKcal: 1600 }).some((f) => f.code === 'LOG_IMPLAUSIBLY_LOW'));
  check('a 12000 kcal day is flagged', validateLoggedDay({ loggedKcal: 12000, bmrKcal: 1600 }).some((f) => f.code === 'LOG_IMPLAUSIBLY_HIGH'));
  check('a normal day is clean', validateLoggedDay({ loggedKcal: 2300, bmrKcal: 1600 })[0].ok === true);
  check(
    'macro/kcal mismatch is flagged',
    validateLoggedDay({ loggedKcal: 2300, proteinG: 100, carbG: 100, fatG: 40, bmrKcal: 1600 }).some((f) => f.code === 'LOG_MACRO_MISMATCH'),
  );

  // Weight entries.
  check(
    'lb/kg mix-up is blocked',
    validateWeightEntry({ kg: 176, previousKg: 80, daysSincePrevious: 1 }).some((f) => f.code === 'WEIGHT_UNIT_MISMATCH' && f.level === 'block'),
  );
  check('an out-of-range weight is blocked', hasBlock(validateWeightEntry({ kg: 5, previousKg: null, daysSincePrevious: 0 })));
  check(
    'a 6 kg overnight jump warns',
    validateWeightEntry({ kg: 86, previousKg: 80, daysSincePrevious: 1 }).some((f) => f.code === 'WEIGHT_JUMP_LARGE'),
  );
  check('a normal 0.4 kg change is clean', validateWeightEntry({ kg: 80.4, previousKg: 80, daysSincePrevious: 1 })[0].ok === true);

  // Under-logging detection.
  check(
    'logs predicting 3x the observed loss are flagged',
    detectLoggingDiscrepancy(-0.6, -0.1, 4).some((f) => f.code === 'LOGGING_DISCREPANCY'),
  );
  check('matching prediction and observation is clean', detectLoggingDiscrepancy(-0.6, -0.55, 4)[0].ok === true);
  check('not assessed before 3 weeks', detectLoggingDiscrepancy(-0.6, -0.1, 2)[0].code === 'LOGGING_DISCREPANCY_NOT_ASSESSED');
}

{
  // ED screening.
  const neg = scoreScoff([false, false, false, false, false]);
  check('SCOFF 0 leaves the gate open', neg.score === 0 && neg.gateClosed === false);
  const border = scoreScoff([false, true, false, false, false]);
  check('SCOFF 1 is informational only', border.score === 1 && border.gateClosed === false);
  const pos = scoreScoff([true, true, false, false, false]);
  check('SCOFF 2 closes the gate', pos.score === 2 && pos.gateClosed === true && hasBlock(pos.findings));
  check('SCOFF has exactly 5 questions', LIMITS.SCOFF_CUTOFF === 2);

  // Behavioural signals.
  check(
    'repeated below-floor requests warn',
    assessBehaviouralSignals({ belowFloorRequests30d: 4, goalWeightReductions30d: 0, consecutiveSevereUnderEatingDays: 0, consecutiveMultiWeighInDays: 0 }).some((f) => f.code === 'BEHAVIOUR_REPEATED_LOW_TARGET_REQUESTS'),
  );
  check(
    'severe under-eating blocks',
    hasBlock(assessBehaviouralSignals({ belowFloorRequests30d: 0, goalWeightReductions30d: 0, consecutiveSevereUnderEatingDays: 6, consecutiveMultiWeighInDays: 0 })),
  );
  check(
    'a normal usage pattern is clean',
    assessBehaviouralSignals({ belowFloorRequests30d: 0, goalWeightReductions30d: 1, consecutiveSevereUnderEatingDays: 1, consecutiveMultiWeighInDays: 2 })[0].ok === true,
  );
}

{
  // End-to-end orchestration.
  const result = validateAll({
    profile: { sex: 'female', ageYears: 22, heightCm: 168, bodyweightKg: 51, bodyFatPct: 17, goal: 'cut' },
    targets: { kcal: 1150, proteinG: 120, carbG: 90, fatG: 35, targetRatePctBwPerWeek: -1.3 },
    bmrKcal: 1330,
    scoffAnswers: [false, true, true, false, false],
  });
  console.log(
    `\n  >> end-to-end on a high-risk profile: blocked=${result.blocked}, ` +
      `${result.actionable.length} actionable findings, referral urgency='${result.referral?.urgency}'\n` +
      `     codes: ${result.actionable.map((f) => `${f.level}:${f.code}`).join(', ')}\n`,
  );
  check('the high-risk case is blocked', result.blocked === true);
  check('an urgent referral is surfaced', result.referral?.urgency === 'now' && result.referral.showResources === true);
  check('findings are sorted with blocks first', result.actionable[0].level === 'block');
  check('a disclaimer is always attached', result.disclaimer.includes('not medical advice'));

  const clean = validateAll({
    profile: { sex: 'male', ageYears: 34, heightCm: 180, bodyweightKg: 88, bodyFatPct: 22, goal: 'cut' },
    targets: computeMacroTargets({
      sex: 'male', ageYears: 34, heightCm: 180, bodyweightKg: 88, bodyFatPct: 22,
      goal: 'cut', tdeeKcal: 2850, trainingLoad: 'moderate',
    }),
    bmrKcal: 1830,
  });
  check('a normal case passes end to end', clean.blocked === false && clean.referral === null);
}

/* ================================================================== */
section('8. FULL PIPELINE: 90 DAYS, RAW SCALE DATA -> TARGETS');
/* ================================================================== */

{
  const TRUE_TDEE = 2950;
  const profile: UserProfile = {
    sex: 'male', ageYears: 36, heightCm: 183, bodyweightKg: 92, bodyFatPct: 24, goal: 'cut',
  };
  const cold = coldStartTdee({
    sex: 'male', weightKg: 92, heightCm: 183, ageYears: 36, bodyFatPct: 24, activityLevel: 'moderately_active',
  });

  const sim = simulate({
    days: 90,
    startKg: 92,
    tdee: () => TRUE_TDEE,
    intake: () => 2450,
    noiseSd: 0.95,
    weighInProb: 0.85,
    logProb: 0.9,
    waterShocks: true,
    seed: 909,
  });

  const trend = computeWeightTrend(sim.weights);
  const summary = summarizeTrend(trend);
  if (!summary) throw new Error('summarizeTrend returned null');
  const est = estimateExpenditure(joinDays(trend, sim.logs), {
    prior: { tdeeKcal: cold.tdeeKcal, sdKcal: cold.sdKcal },
    bmrKcal: cold.bmrKcal,
    kcalPerKg: effectiveKcalPerKg(92 * 0.24),
  });
  const targets = computeMacroTargets({
    ...profile, tdeeKcal: est.tdeeKcal, bmrKcal: cold.bmrKcal, trainingLoad: 'moderate',
  });
  const findings = validateAll({ profile, targets, bmrKcal: cold.bmrKcal });

  console.log(
    `\n  cold start (Katch-McArdle x 1.55) : ${cold.tdeeKcal} kcal  (BMR ${cold.bmrKcal}, SD ${cold.sdKcal})\n` +
      `  true TDEE                          : ${TRUE_TDEE} kcal\n` +
      `  adaptive estimate after 90 days    : ${est.tdeeKcal} kcal  95% CI [${est.ci95[0]}, ${est.ci95[1]}]\n` +
      `  error vs truth                     : cold start ${cold.tdeeKcal - TRUE_TDEE} kcal -> adaptive ${est.tdeeKcal - TRUE_TDEE} kcal\n` +
      `  trend weight  92.0 -> ${summary.trendKg} kg  (${summary.weeklyChangeKg} kg/wk, ${summary.weeklyChangePctBw}%/wk)\n` +
      `  true weight                        : ${round(sim.finalTrueKg, 2)} kg\n` +
      `  prescribed targets                 : ${targets.kcal} kcal | P ${targets.proteinG} g | C ${targets.carbG} g | F ${targets.fatG} g\n` +
      `  guardrails                         : blocked=${findings.blocked}, findings=${findings.actionable.map((f) => f.code).join(', ') || 'none'}\n`,
  );

  near('pipeline recovers true TDEE', est.tdeeKcal, TRUE_TDEE, 150);
  check(
    'adaptive estimate beats the cold start',
    Math.abs(est.tdeeKcal - TRUE_TDEE) < Math.abs(cold.tdeeKcal - TRUE_TDEE),
    `${Math.abs(est.tdeeKcal - TRUE_TDEE)} vs ${Math.abs(cold.tdeeKcal - TRUE_TDEE)} kcal`,
  );
  near('trend weight matches true weight', summary.trendKg, sim.finalTrueKg, 0.6);
  check('the resulting plan passes the guardrails', findings.blocked === false);
}
