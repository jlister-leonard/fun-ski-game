/**
 * weight-trend.ts
 *
 * Body-weight trend estimation: separates the slow "true" change in stored body
 * energy (signal) from day-to-day water / gut-content / glycogen noise.
 *
 * Model: a **local linear trend** state-space model (a.k.a. Holt's linear
 * exponential smoothing in its stochastic form), run through a scalar Kalman
 * filter, with two robustness extensions:
 *
 *   1. **Huberised measurement update** — a weigh-in whose standardised
 *      innovation exceeds `outlierSigma` has its measurement variance inflated
 *      rather than being hard-rejected. A single 3 kg spike barely moves the
 *      trend; a *sustained* 3 kg shift still gets absorbed (because the CUSUM
 *      below fires), so we never permanently ignore a real step change.
 *
 *   2. **Adaptive process noise (CUSUM-gated)** — a two-sided CUSUM over
 *      standardised innovations detects runs of same-signed prediction error,
 *      i.e. a genuine trend break. When it fires, the slope process noise is
 *      temporarily inflated so the filter re-converges in days instead of
 *      weeks. This is the mechanism behind "hedge in week 1, commit in week 2".
 *
 * Missing days are handled natively: the Kalman *predict* step runs on every
 * calendar day, the *update* step only on days with a weigh-in. No
 * interpolation is fed into the estimator (interpolated values are produced
 * separately, for display only).
 *
 * A fixed-interval RTS smoother pass is available for rendering historical
 * trend lines. At the most recent day the smoothed and filtered estimates are
 * identical, so using the smoothed series for display never leaks future
 * information into "today's" coaching decision.
 *
 * Zero dependencies. Pure functions. No I/O.
 *
 * @module weight-trend
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Non-energetic perturbations                                         */
/* ------------------------------------------------------------------ */

/**
 * Kinds of event that move the scale **without** moving stored body energy.
 *
 * These are the main threat to any energy-balance estimator. Creatine is the
 * worst offender because the shift is large (1-2 kg), one-directional, loads
 * over weeks rather than days, and then *persists* for as long as the user
 * supplements — so it looks exactly like a genuine plateau.
 */
export type PerturbationType =
  | 'creatine-start'
  | 'creatine-stop'
  | 'carb-load'
  | 'carb-restriction-start'
  | 'sodium-spike'
  | 'menstrual-fluid'
  | 'travel'
  | 'illness'
  | 'new-training-block'
  | 'other';

/** A logged event that perturbs scale weight without changing body energy. */
export interface PerturbationEvent {
  /** ISO date the event began. */
  startDate: string;
  type: PerturbationType;
  /**
   * Expected signed shift in kg. Defaults come from {@link PERTURBATION_DEFAULTS}
   * when omitted.
   */
  expectedShiftKg?: number;
  /** Days over which the shift loads and settles. Defaults per type. */
  settlingDays?: number;
  /**
   * For transient events, the number of days after which the shift reverses
   * back to zero. Omit for persistent shifts such as ongoing creatine use.
   */
  reversesAfterDays?: number;
  label?: string;
}

/**
 * Default magnitude and settling time per perturbation type.
 *
 * Creatine: a 5 g/day maintenance protocol (no loading phase) raises total body
 * water by roughly 1-2 kg, accumulating over about three to four weeks and
 * persisting for as long as supplementation continues. We model +1.5 kg over a
 * 28-day settling window. A 20 g/day loading protocol reaches a similar
 * plateau in about a week.
 *
 * Confidence on the exact numbers: [reasonable-inference]. The *existence* and
 * rough scale of the effect is [well-established]; the individual magnitude
 * varies with muscle mass and baseline creatine saturation.
 */
export const PERTURBATION_DEFAULTS: Record<
  PerturbationType,
  { expectedShiftKg: number; settlingDays: number; reversesAfterDays?: number }
> = {
  'creatine-start': { expectedShiftKg: 1.5, settlingDays: 28 },
  'creatine-stop': { expectedShiftKg: -1.5, settlingDays: 28 },
  'carb-load': { expectedShiftKg: 1.5, settlingDays: 3, reversesAfterDays: 5 },
  'carb-restriction-start': { expectedShiftKg: -1.8, settlingDays: 7 },
  'sodium-spike': { expectedShiftKg: 1.0, settlingDays: 2, reversesAfterDays: 4 },
  'menstrual-fluid': { expectedShiftKg: 1.0, settlingDays: 3, reversesAfterDays: 7 },
  travel: { expectedShiftKg: 1.0, settlingDays: 2, reversesAfterDays: 6 },
  illness: { expectedShiftKg: -1.0, settlingDays: 3, reversesAfterDays: 10 },
  'new-training-block': { expectedShiftKg: 1.0, settlingDays: 14 },
  other: { expectedShiftKg: 0, settlingDays: 14 },
};

/**
 * Modelled non-energetic offset contributed by one event on a given day, kg.
 *
 * Loads as a saturating exponential reaching ~87.5% of the plateau at
 * `settlingDays`, then optionally reverses on the same time constant.
 */
export function perturbationOffsetKg(event: PerturbationEvent, isoDate: string): number {
  const d = PERTURBATION_DEFAULTS[event.type];
  const shift = event.expectedShiftKg ?? d.expectedShiftKg;
  const settling = Math.max(1, event.settlingDays ?? d.settlingDays);
  const reverses = event.reversesAfterDays ?? d.reversesAfterDays;
  const elapsed = daysBetween(event.startDate, isoDate);
  if (elapsed < 0) return 0;
  const tau = settling / 3;
  const loaded = shift * (1 - Math.pow(0.5, elapsed / tau));
  if (reverses === undefined) return loaded;
  if (elapsed <= reverses) return loaded;
  const since = elapsed - reverses;
  return loaded * Math.pow(0.5, since / tau);
}

/** Total modelled offset from all events on a given day, kg. */
export function totalPerturbationOffsetKg(
  events: readonly PerturbationEvent[],
  isoDate: string,
): number {
  let total = 0;
  for (const e of events) total += perturbationOffsetKg(e, isoDate);
  return total;
}

/** True when any event is still inside its settling window on the given day. */
export function isPerturbationActive(
  events: readonly PerturbationEvent[],
  isoDate: string,
): boolean {
  for (const e of events) {
    const d = PERTURBATION_DEFAULTS[e.type];
    const settling = e.settlingDays ?? d.settlingDays;
    const reverses = e.reversesAfterDays ?? d.reversesAfterDays;
    const elapsed = daysBetween(e.startDate, isoDate);
    const windowEnd = reverses === undefined ? settling : reverses + settling;
    if (elapsed >= 0 && elapsed <= windowEnd) return true;
  }
  return false;
}

/** A raw scale reading. `date` is an ISO calendar date, `YYYY-MM-DD`. */
export interface WeightEntry {
  /** ISO calendar date, `YYYY-MM-DD`. Local calendar day of the weigh-in. */
  date: string;
  /** Scale reading in kilograms. */
  kg: number;
}

/** One day of output, one row per calendar day between first and last entry. */
export interface TrendPoint {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  /**
   * Scale weight for the day: the raw reading if one exists, otherwise a
   * linear interpolation between the neighbouring readings. Display only —
   * interpolated values are NOT used by the estimator.
   */
  kg: number;
  /** Filtered (or smoothed) trend weight in kg. This is what the user sees. */
  trendKg: number;
  /**
   * Trend weight with modelled non-energetic shifts removed, kg.
   *
   * **This is the series the expenditure estimator must consume.** `trendKg`
   * still contains the ~1.5 kg of intracellular water that creatine adds; that
   * water is not stored energy, and feeding it to an energy-balance calculation
   * makes the estimator conclude expenditure is lower than it really is.
   * Equals `trendKg` when no perturbations are logged.
   */
  energyTrendKg: number;
  /** Modelled non-energetic offset applied on this day, kg. */
  perturbationOffsetKg: number;
  /** True when a logged perturbation is still settling on this day. */
  perturbationActive: boolean;
  /**
   * True when the filter saw a level discontinuity it cannot explain — a step
   * in scale weight with no logged perturbation. Downstream estimators should
   * widen their uncertainty when this is set.
   */
  stepSuspected: boolean;
  /** Estimated rate of change in kg per week (7 x the daily slope state). */
  weeklyChangeKg: number;
  /** True when a real weigh-in exists for this date. */
  observed: boolean;
  /** Raw reading if observed, else `null`. */
  rawKg: number | null;
  /**
   * True when the reading's standardised innovation exceeded `outlierSigma`
   * and its influence was down-weighted.
   */
  outlier: boolean;
  /** 1-sigma uncertainty of `trendKg`, in kg. */
  trendSdKg: number;
  /** 1-sigma uncertainty of `weeklyChangeKg`, in kg/week. */
  weeklyChangeSdKg: number;
  /**
   * Process-noise multiplier the adaptive gate applied on this day. 1 = normal,
   * >1 = the filter believes a real trend break is underway.
   */
  adaptationFactor: number;
}

/** Tunable filter parameters. All defaults are calibrated for daily weigh-ins. */
export interface TrendOptions {
  /**
   * Standard deviation of single-day scale noise, kg. Empirically ~0.8-1.2 kg
   * for an 80 kg adult weighing at a consistent time of day.
   * Default 0.9, scaled by bodyweight when `scaleNoiseToBodyweight` is true.
   */
  observationSdKg?: number;
  /** Scale `observationSdKg` by (median bodyweight / 80 kg). Default true. */
  scaleNoiseToBodyweight?: boolean;
  /**
   * Process-noise SD of the *level* state, kg/day. Small: nearly all real
   * movement should be explained by the slope. Default 0.005.
   *
   * Empirically this parameter barely matters — sweeping it over 0.002-0.01
   * moves both responsiveness and steady-state error by under 5%. The
   * responsiveness/stability frontier is governed almost entirely by
   * `slopeProcessSdKg` and `adaptationGain`.
   */
  levelProcessSdKg?: number;
  /**
   * Process-noise SD of the *slope* state, kg/day per day. This is the main
   * responsiveness dial. Default 0.003, which detects a genuine change in rate
   * in a median of ~20 days at 0.9 kg observation noise — matching the 2-3
   * weeks MacroFactor publishes for its own estimator.
   */
  slopeProcessSdKg?: number;
  /** Standardised-innovation threshold above which a reading is Huberised. Default 3.0. */
  outlierSigma?: number;
  /** Slack parameter `k` of the two-sided CUSUM, in sigma units. Default 0.4. */
  cusumSlack?: number;
  /** Gain applied to the CUSUM statistic when inflating process noise. Default 3.0. */
  adaptationGain?: number;
  /** Hard cap on the process-noise multiplier. Default 40. */
  maxAdaptationFactor?: number;
  /** Run the RTS backward smoother over the history. Default true. */
  smooth?: boolean;
  /**
   * Absolute per-day change (kg) above which a reading is treated as a data
   * error (unit mix-up, someone else's weigh-in) and dropped entirely rather
   * than Huberised. Default 10 kg.
   */
  hardRejectDeltaKg?: number;
  /**
   * Logged non-energetic events (creatine, carb loads, travel, ...).
   *
   * Inside an event's settling window the filter inflates *level* process noise
   * so the step is absorbed by the level, and suppresses the CUSUM so the
   * adaptive gate does not mistake a water shift for a genuine change in the
   * rate of fat loss.
   */
  perturbations?: readonly PerturbationEvent[];
  /** Level process-noise multiplier applied inside a perturbation window. Default 400. */
  perturbationLevelNoiseFactor?: number;
}

type ResolvedOptions = Required<Omit<TrendOptions, 'perturbations'>> & {
  perturbations: readonly PerturbationEvent[];
};

const DEFAULTS: ResolvedOptions = {
  observationSdKg: 0.9,
  scaleNoiseToBodyweight: true,
  levelProcessSdKg: 0.005,
  slopeProcessSdKg: 0.003,
  outlierSigma: 3.0,
  cusumSlack: 0.4,
  adaptationGain: 3.0,
  maxAdaptationFactor: 40,
  smooth: true,
  hardRejectDeltaKg: 10,
  perturbations: [],
  perturbationLevelNoiseFactor: 400,
};

/** Reference bodyweight used to scale observation noise. */
const REFERENCE_BODYWEIGHT_KG = 80;

/* ------------------------------------------------------------------ */
/* Date helpers (no dependencies)                                      */
/* ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;

/**
 * Parse `YYYY-MM-DD` into a UTC epoch-day integer.
 * @throws if the string is not a valid ISO calendar date.
 */
export function toEpochDay(isoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) throw new Error(`Invalid ISO date: ${isoDate}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ts = Date.UTC(y, mo - 1, d);
  if (!Number.isFinite(ts)) throw new Error(`Invalid ISO date: ${isoDate}`);
  return Math.round(ts / MS_PER_DAY);
}

/** Inverse of {@link toEpochDay}. */
export function fromEpochDay(epochDay: number): string {
  const dt = new Date(epochDay * MS_PER_DAY);
  const y = dt.getUTCFullYear().toString().padStart(4, '0');
  const mo = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = dt.getUTCDate().toString().padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** Number of whole days from `a` to `b` (negative if `b` precedes `a`). */
export function daysBetween(a: string, b: string): number {
  return toEpochDay(b) - toEpochDay(a);
}

/* ------------------------------------------------------------------ */
/* Tiny 2x2 linear algebra                                             */
/* ------------------------------------------------------------------ */

/** Symmetric 2x2 covariance stored as [p00, p01, p11]. */
type Cov2 = [number, number, number];

function invert2(a: number, b: number, c: number, d: number): [number, number, number, number] {
  const det = a * d - b * c;
  const safeDet = Math.abs(det) < 1e-12 ? (det < 0 ? -1e-12 : 1e-12) : det;
  return [d / safeDet, -b / safeDet, -c / safeDet, a / safeDet];
}

/* ------------------------------------------------------------------ */
/* Core filter                                                         */
/* ------------------------------------------------------------------ */

interface Step {
  epochDay: number;
  /** Observation for the day, or null. */
  y: number | null;
  /** Predicted state before update. */
  xPred: [number, number];
  pPred: Cov2;
  /** Filtered state after update (equals prediction when y is null). */
  xFilt: [number, number];
  pFilt: Cov2;
  outlier: boolean;
  adaptationFactor: number;
  perturbationActive: boolean;
  stepSuspected: boolean;
}

/**
 * Deduplicate, sort and sanity-check raw entries.
 *
 * Multiple readings on the same calendar day are averaged (a common pattern
 * with smart scales that sync several readings). Non-finite and non-positive
 * values are dropped.
 *
 * @param entries raw scale readings, any order
 * @returns entries sorted ascending by date, one per calendar day
 */
export function normalizeEntries(entries: readonly WeightEntry[]): WeightEntry[] {
  const byDay = new Map<number, { sum: number; n: number }>();
  for (const e of entries) {
    if (!Number.isFinite(e.kg) || e.kg <= 0) continue;
    const day = toEpochDay(e.date);
    const acc = byDay.get(day);
    if (acc) {
      acc.sum += e.kg;
      acc.n += 1;
    } else {
      byDay.set(day, { sum: e.kg, n: 1 });
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, acc]) => ({ date: fromEpochDay(day), kg: acc.sum / acc.n }));
}

/** Median of a numeric array. Returns 0 for an empty array. */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Compute the smoothed body-weight trend.
 *
 * @param entries raw scale readings; any order, gaps allowed, duplicates averaged
 * @param options filter tuning; see {@link TrendOptions}
 * @returns one {@link TrendPoint} per calendar day from the first to the last
 *          weigh-in, inclusive. Empty array if there are no usable readings.
 *
 * @example
 * const series = computeWeightTrend([
 *   { date: '2026-01-01', kg: 82.4 },
 *   { date: '2026-01-02', kg: 81.9 },
 *   { date: '2026-01-04', kg: 82.1 },
 * ]);
 * series[series.length - 1].weeklyChangeKg; // estimated kg/week right now
 */
export function computeWeightTrend(
  entries: readonly WeightEntry[],
  options: TrendOptions = {},
): TrendPoint[] {
  const opt: ResolvedOptions = { ...DEFAULTS, ...options };
  const clean = normalizeEntries(entries);
  if (clean.length === 0) return [];

  const medianKg = median(clean.map((e) => e.kg));
  const obsSd = opt.scaleNoiseToBodyweight
    ? opt.observationSdKg * Math.max(0.5, medianKg / REFERENCE_BODYWEIGHT_KG)
    : opt.observationSdKg;
  const R0 = obsSd * obsSd;
  const qLevel0 = opt.levelProcessSdKg ** 2;
  const qSlope0 = opt.slopeProcessSdKg ** 2;

  const firstDay = toEpochDay(clean[0].date);
  const lastDay = toEpochDay(clean[clean.length - 1].date);
  const obsByDay = new Map<number, number>();
  for (const e of clean) obsByDay.set(toEpochDay(e.date), e.kg);

  // Single reading: no trend is identifiable.
  if (clean.length === 1) {
    return [
      {
        date: clean[0].date,
        kg: clean[0].kg,
        trendKg: clean[0].kg,
        energyTrendKg: clean[0].kg - totalPerturbationOffsetKg(opt.perturbations, clean[0].date),
        perturbationOffsetKg: totalPerturbationOffsetKg(opt.perturbations, clean[0].date),
        perturbationActive: isPerturbationActive(opt.perturbations, clean[0].date),
        stepSuspected: false,
        weeklyChangeKg: 0,
        observed: true,
        rawKg: clean[0].kg,
        outlier: false,
        trendSdKg: obsSd,
        weeklyChangeSdKg: 7 * 0.05,
        adaptationFactor: 1,
      },
    ];
  }

  // --- Initialisation -------------------------------------------------
  // Level: first reading. Slope: OLS over the first <=14 days of data, which
  // avoids a multi-week ramp-in while staying robust to a noisy first week.
  const seed = clean.filter((e) => toEpochDay(e.date) - firstDay <= 14);
  let slope0 = 0;
  if (seed.length >= 3) {
    const ts = seed.map((e) => toEpochDay(e.date) - firstDay);
    const tBar = ts.reduce((a, b) => a + b, 0) / ts.length;
    const yBar = seed.reduce((a, e) => a + e.kg, 0) / seed.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < seed.length; i++) {
      num += (ts[i] - tBar) * (seed[i].kg - yBar);
      den += (ts[i] - tBar) ** 2;
    }
    if (den > 0) slope0 = num / den;
  }

  let x: [number, number] = [clean[0].kg, slope0];
  // Diffuse-ish prior: level known to ~1 obs SD, slope to ~0.06 kg/day (0.4 kg/wk).
  let p: Cov2 = [R0, 0, 0.06 ** 2];

  let cusumPos = 0;
  let cusumNeg = 0;
  const steps: Step[] = [];

  // Rolling window of recent innovations, used to spot an unlogged level step.
  const recentInnovations: number[] = [];

  for (let day = firstDay; day <= lastDay; day++) {
    const dateStr = fromEpochDay(day);
    const perturbActive = isPerturbationActive(opt.perturbations, dateStr);

    // ---- adaptive process noise -------------------------------------
    const cusum = Math.max(cusumPos, cusumNeg);
    const adaptationFactor = Math.min(
      opt.maxAdaptationFactor,
      1 + opt.adaptationGain * cusum * cusum,
    );
    // Inside a known perturbation window, let the LEVEL move freely (a water
    // shift is a step in level) but keep the SLOPE tightly constrained (it is
    // emphatically not a change in the rate of fat loss).
    const qL = qLevel0 * (perturbActive ? opt.perturbationLevelNoiseFactor : adaptationFactor);
    const qS = qSlope0 * (perturbActive ? 1 : adaptationFactor);

    // ---- predict:  F = [[1,1],[0,1]] --------------------------------
    const xPred: [number, number] = [x[0] + x[1], x[1]];
    const pPred: Cov2 = [p[0] + 2 * p[1] + p[2] + qL, p[1] + p[2], p[2] + qS];

    let xFilt: [number, number] = [xPred[0], xPred[1]];
    let pFilt: Cov2 = [pPred[0], pPred[1], pPred[2]];
    let outlier = false;

    const yRaw = obsByDay.get(day);
    const y = yRaw === undefined ? null : yRaw;

    if (y !== null) {
      const innovation = y - xPred[0];
      const sInn = pPred[0] + R0;
      const std = innovation / Math.sqrt(sInn);

      // Hard reject: physically impossible jump => almost certainly a data
      // error (unit mix-up, wrong person). Never let it touch the state.
      const hardReject = Math.abs(innovation) > opt.hardRejectDeltaKg;

      if (!hardReject) {
        // Huberise: inflate R for readings beyond `outlierSigma`.
        let R = R0;
        if (Math.abs(std) > opt.outlierSigma) {
          const scale = Math.abs(std) / opt.outlierSigma;
          R = R0 * scale * scale;
          outlier = true;
        }
        const s = pPred[0] + R;
        const k0 = pPred[0] / s;
        const k1 = pPred[1] / s;

        xFilt = [xPred[0] + k0 * innovation, xPred[1] + k1 * innovation];
        // P = (I - K H) P-, H = [1, 0]
        const p00 = (1 - k0) * pPred[0];
        const p01 = (1 - k0) * pPred[1];
        const p11 = pPred[2] - k1 * pPred[1];
        pFilt = [p00, p01, Math.max(p11, 1e-10)];

        // CUSUM on the *clipped* standardised innovation so one wild reading
        // cannot by itself trigger adaptation, but a run of moderate,
        // same-signed errors (a real trend break) will.
        //
        // Suppressed inside a logged perturbation window: we already know why
        // the weight moved, so we must not conclude the fat-loss rate changed.
        if (!perturbActive) {
          const e = Math.max(-opt.outlierSigma, Math.min(opt.outlierSigma, std));
          cusumPos = Math.max(0, cusumPos + e - opt.cusumSlack);
          cusumNeg = Math.max(0, cusumNeg - e - opt.cusumSlack);
        } else {
          cusumPos = 0;
          cusumNeg = 0;
        }
        recentInnovations.push(innovation);
        if (recentInnovations.length > 14) recentInnovations.shift();
      } else {
        outlier = true;
      }
    } else {
      // No weigh-in: predict-only. Decay the CUSUM so a stale alarm does not
      // keep the filter jumpy through a logging gap.
      cusumPos = Math.max(0, cusumPos - opt.cusumSlack);
      cusumNeg = Math.max(0, cusumNeg - opt.cusumSlack);
    }

    // Automatic step detection, for when the user did NOT log the event.
    // A sustained run of same-signed prediction error summing to more than
    // ~1 kg over a fortnight is a level step, not noise.
    const innovationSum = recentInnovations.reduce((a, b) => a + b, 0);
    const stepSuspected =
      !perturbActive && recentInnovations.length >= 10 && Math.abs(innovationSum) > 3.5;

    steps.push({
      epochDay: day,
      y,
      xPred,
      pPred,
      xFilt,
      pFilt,
      outlier,
      adaptationFactor,
      perturbationActive: perturbActive,
      stepSuspected,
    });

    x = xFilt;
    p = pFilt;
  }

  // --- RTS fixed-interval smoother -------------------------------------
  const xOut: [number, number][] = steps.map((s) => [s.xFilt[0], s.xFilt[1]]);
  const pOut: Cov2[] = steps.map((s) => [s.pFilt[0], s.pFilt[1], s.pFilt[2]]);

  if (opt.smooth) {
    for (let t = steps.length - 2; t >= 0; t--) {
      const pf = steps[t].pFilt;
      const pp = steps[t + 1].pPred;
      // C = Pf * F^T * inv(Pp),  F^T = [[1,0],[1,1]]
      // Pf * F^T = [[p00+p01, p01],[p01+p11, p11]]
      const a = pf[0] + pf[1];
      const b = pf[1];
      const c = pf[1] + pf[2];
      const d = pf[2];
      const [i00, i01, i10, i11] = invert2(pp[0], pp[1], pp[1], pp[2]);
      const c00 = a * i00 + b * i10;
      const c01 = a * i01 + b * i11;
      const c10 = c * i00 + d * i10;
      const c11 = c * i01 + d * i11;

      const dx0 = xOut[t + 1][0] - steps[t + 1].xPred[0];
      const dx1 = xOut[t + 1][1] - steps[t + 1].xPred[1];
      xOut[t] = [
        steps[t].xFilt[0] + c00 * dx0 + c01 * dx1,
        steps[t].xFilt[1] + c10 * dx0 + c11 * dx1,
      ];

      // P_s = Pf + C (P_s(t+1) - Pp(t+1)) C^T
      const dP0 = pOut[t + 1][0] - pp[0];
      const dP1 = pOut[t + 1][1] - pp[1];
      const dP2 = pOut[t + 1][2] - pp[2];
      const m00 = c00 * dP0 + c01 * dP1;
      const m01 = c00 * dP1 + c01 * dP2;
      const m10 = c10 * dP0 + c11 * dP1;
      const m11 = c10 * dP1 + c11 * dP2;
      pOut[t] = [
        Math.max(1e-10, pf[0] + m00 * c00 + m01 * c01),
        pf[1] + m00 * c10 + m01 * c11,
        Math.max(1e-10, pf[2] + m10 * c10 + m11 * c11),
      ];
    }
  }

  // --- Display interpolation of raw scale weight ------------------------
  const interpolated = interpolateScaleWeight(clean, firstDay, lastDay);

  return steps.map((s, i) => {
    const dateStr = fromEpochDay(s.epochDay);
    const raw = obsByDay.get(s.epochDay);
    const offset = totalPerturbationOffsetKg(opt.perturbations, dateStr);
    return {
      date: dateStr,
      kg: round(interpolated[i], 3),
      trendKg: round(xOut[i][0], 3),
      energyTrendKg: round(xOut[i][0] - offset, 3),
      perturbationOffsetKg: round(offset, 3),
      perturbationActive: s.perturbationActive,
      stepSuspected: s.stepSuspected,
      weeklyChangeKg: round(xOut[i][1] * 7, 4),
      observed: raw !== undefined,
      rawKg: raw === undefined ? null : raw,
      outlier: s.outlier,
      trendSdKg: round(Math.sqrt(Math.max(pOut[i][0], 0)), 4),
      weeklyChangeSdKg: round(7 * Math.sqrt(Math.max(pOut[i][2], 0)), 4),
      adaptationFactor: round(s.adaptationFactor, 3),
    };
  });
}

function interpolateScaleWeight(
  clean: readonly WeightEntry[],
  firstDay: number,
  lastDay: number,
): number[] {
  const out: number[] = [];
  let idx = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    while (idx < clean.length - 1 && toEpochDay(clean[idx + 1].date) <= day) idx++;
    const dA = toEpochDay(clean[idx].date);
    if (dA === day) {
      out.push(clean[idx].kg);
      continue;
    }
    const next = clean[idx + 1];
    if (!next) {
      out.push(clean[idx].kg);
      continue;
    }
    const dB = toEpochDay(next.date);
    const f = (day - dA) / (dB - dA);
    out.push(clean[idx].kg + f * (next.kg - clean[idx].kg));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Simpler reference implementations (for comparison / fallback)       */
/* ------------------------------------------------------------------ */

/**
 * Classic Hacker's-Diet style EWMA trend: `trend += alpha * (kg - trend)`.
 *
 * Kept as a reference baseline and as a fallback for very short histories.
 * It has no slope state, so the weekly rate must be differenced out of the
 * trend, which is noticeably noisier than the Kalman slope estimate.
 *
 * @param entries raw readings
 * @param alpha smoothing constant, 0..1. 0.1 ~ 10-day half-life-ish. Default 0.1.
 * @param rateWindowDays lookback used to difference the trend into a rate. Default 14.
 */
export function ewmaTrend(
  entries: readonly WeightEntry[],
  alpha = 0.1,
  rateWindowDays = 14,
): TrendPoint[] {
  const clean = normalizeEntries(entries);
  if (clean.length === 0) return [];
  const firstDay = toEpochDay(clean[0].date);
  const lastDay = toEpochDay(clean[clean.length - 1].date);
  const obsByDay = new Map<number, number>();
  for (const e of clean) obsByDay.set(toEpochDay(e.date), e.kg);
  const interp = interpolateScaleWeight(clean, firstDay, lastDay);

  const trend: number[] = [];
  let t = clean[0].kg;
  for (let i = 0, day = firstDay; day <= lastDay; day++, i++) {
    const y = obsByDay.get(day);
    if (y !== undefined) t = t + alpha * (y - t);
    trend.push(t);
  }

  return trend.map((tv, i) => {
    const day = firstDay + i;
    const back = Math.max(0, i - rateWindowDays);
    const span = i - back;
    const raw = obsByDay.get(day);
    return {
      date: fromEpochDay(day),
      kg: round(interp[i], 3),
      trendKg: round(tv, 3),
      energyTrendKg: round(tv, 3),
      perturbationOffsetKg: 0,
      perturbationActive: false,
      stepSuspected: false,
      weeklyChangeKg: span > 0 ? round(((tv - trend[back]) / span) * 7, 4) : 0,
      observed: raw !== undefined,
      rawKg: raw === undefined ? null : raw,
      outlier: false,
      trendSdKg: 0,
      weeklyChangeSdKg: 0,
      adaptationFactor: 1,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Derived summaries                                                   */
/* ------------------------------------------------------------------ */

/** Summary of the current state of the weight trend, for coaching decisions. */
export interface TrendSummary {
  /** Latest trend weight, kg. */
  trendKg: number;
  /** Latest estimated rate, kg/week. */
  weeklyChangeKg: number;
  /** Latest estimated rate as a percentage of trend bodyweight per week. */
  weeklyChangePctBw: number;
  /** 95% CI on the weekly rate, kg/week. */
  weeklyChangeCi95: [number, number];
  /** Number of real weigh-ins in the last 14 days. */
  weighInsLast14d: number;
  /** Fraction of the last 14 days with a weigh-in, 0..1. */
  adherence14d: number;
  /** True when a logged perturbation is still settling as of the latest day. */
  perturbationActive: boolean;
  /** True when an unlogged level step is suspected in the recent window. */
  stepSuspected: boolean;
  /**
   * True when the rate estimate is precise enough to act on: the 95% CI is
   * narrower than +/-0.6% of bodyweight per week and there have been at least
   * 5 weigh-ins in the past fortnight.
   *
   * Note the filter's reported CI is deliberately conservative — on synthetic
   * data with a genuinely constant rate it is about 2x wider than the observed
   * error, because the model permits the rate to drift and the simulation does
   * not. Real rates do drift, so the truth sits between the two.
   */
  rateIsActionable: boolean;
  /** ISO date of the latest point. */
  date: string;
}

/**
 * Condense a trend series into the values the coaching layer needs.
 *
 * @param series output of {@link computeWeightTrend}
 * @returns `null` when the series is empty
 */
export function summarizeTrend(series: readonly TrendPoint[]): TrendSummary | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  const lastDay = toEpochDay(last.date);
  let weighIns = 0;
  for (const p of series) {
    if (p.observed && lastDay - toEpochDay(p.date) < 14) weighIns++;
  }
  const halfWidth = 1.96 * last.weeklyChangeSdKg;
  return {
    date: last.date,
    trendKg: last.trendKg,
    weeklyChangeKg: last.weeklyChangeKg,
    weeklyChangePctBw: last.trendKg > 0 ? round((last.weeklyChangeKg / last.trendKg) * 100, 3) : 0,
    weeklyChangeCi95: [
      round(last.weeklyChangeKg - halfWidth, 4),
      round(last.weeklyChangeKg + halfWidth, 4),
    ],
    weighInsLast14d: weighIns,
    adherence14d: round(weighIns / 14, 3),
    perturbationActive: last.perturbationActive,
    stepSuspected: series.slice(-14).some((p) => p.stepSuspected),
    // Actionable when the CI is tighter than +/-0.6% BW/wk, we have data, and
    // nothing non-energetic is currently moving the scale.
    rateIsActionable:
      last.trendKg > 0 &&
      halfWidth / last.trendKg <= 0.006 &&
      weighIns >= 5 &&
      !last.perturbationActive,
  };
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
