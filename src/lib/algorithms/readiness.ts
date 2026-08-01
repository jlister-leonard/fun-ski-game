/**
 * readiness.ts — Galpin-style readiness scoring and bounded load modulation.
 *
 * Implements `docs/kg/specs/training-methodology.md` §8.3–§8.5. §8.5 is
 * **normative**: those ten rules are requirements, not suggestions, and every
 * one of them is expressed here as code and pinned by a test in
 * `__tests__/readiness.test.ts`.
 *
 * ## What this module is for
 *
 * It answers one question — *should today's session be trimmed?* — and it is
 * built so that the answer can only ever be "no" or "yes, by this much, for
 * these named reasons". It cannot answer "yes, do more".
 *
 * ## The three things that are easy to get catastrophically wrong
 *
 * 1. **Treating one night as a signal.** HRV is noisy, individual, and only
 *    interpretable against your own baseline. Galpin's most emphatic point is
 *    that a single day's reading means nothing. So {@link hrvScore} returns
 *    **−0.5** for a one-off dip and reserves the full −2 for a dip that has
 *    persisted three days or more. A single bad night cannot, on its own, push
 *    a user out of the `normal` band.
 * 2. **Scoring a baseline that does not exist yet.** HRV and RHR contribute
 *    *zero* until 21 days of readings exist. Not a shrunken contribution, not a
 *    population prior — zero, excluded from the denominator, with the user told
 *    "building your baseline — N/21 days".
 * 3. **Letting the dial turn both ways.** Readiness may trim a session. It may
 *    never add load to one. A good night's sleep is not evidence that you got
 *    stronger.
 *
 * ## Contract
 *
 * Guardrail output uses the existing {@link Finding} type from
 * `algorithms/guardrails.ts` — same `{ ok, level, code, message }` shape, same
 * `hasBlock()` semantics. There is no parallel readiness-only finding type.
 * The generator proposes and the guardrail disposes: {@link assessReadiness}
 * proposes an adjustment, and its own findings can pause or suppress it.
 *
 * Pure, zero-dependency, no I/O. The only import is a type.
 *
 * **Not medical advice.** This module does not diagnose, screen for, or detect
 * anything. An HRV drop is described as "below your usual range" and never as a
 * health finding. Where §8.5 rule 7 fires, the app steps back and points at a
 * clinician rather than attempting an explanation.
 *
 * @module readiness
 */

import type { Finding } from './guardrails';

/* ------------------------------------------------------------------ */
/* Limits (single source of truth)                                     */
/* ------------------------------------------------------------------ */

/**
 * Every numeric bound §8.5 imposes, in one place.
 *
 * Exported so the tests, the UI copy and any future caller read the same
 * constants rather than re-typing them. Changing a number here changes it
 * everywhere, which is the point.
 */
export const READINESS_LIMITS = {
  /** Days of readings before HRV/RHR may influence anything at all (rule 3). */
  baselineDays: 21,
  /** Consecutive suppressed days before a HRV dip counts as a real signal. */
  sustainedSuppressionDays: 3,
  /** bpm above baseline that counts as a moderate RHR elevation. */
  rhrModerateBpm: 7,
  /** bpm above baseline that counts as a marked RHR elevation. */
  rhrMarkedBpm: 10,

  /** Volume adjustment as a fraction of prescribed volume (rule 1). */
  volume: { min: -0.5, max: 0.1 },
  /** RIR adjustment. Negative means "go closer to failure" (rule 1). */
  rir: { min: -1, max: 2 },
  /**
   * Load adjustment as a fraction. **The maximum is exactly zero** — readiness
   * may never increase a prescribed load (rule 1).
   */
  load: { min: -0.2, max: 0 },

  /** Never prescribe below this RIR while readiness is `low` or `poor`. */
  minRirWhenSuppressed: 3,
  /** Never cut an exercise below this many working sets. */
  minSetsPerExercise: 2,
  /** Consecutive readiness-driven cuts after which the app stops cutting (rule 2). */
  maxConsecutiveReductions: 3,

  /** The `low` band's total volume cut, per §8.4. */
  lowVolumeCut: -0.25,
  /** The `poor` band's total volume cut, per §8.4. */
  poorVolumeCut: -0.45,
  /** The `low` band's load trim, per §8.4. */
  lowLoadCut: -0.05,
  /** The `poor` band's load trim, per §8.4. */
  poorLoadCut: -0.15,

  /** Physician-first triggers (rule 7). */
  referral: {
    /** RHR this many bpm above baseline… */
    rhrAboveBaselineBpm: 10,
    /** …for this many consecutive days. */
    rhrDays: 3,
    /** HRV this many SD below baseline… */
    hrvSdBelow: 2,
    /** …for this many consecutive days. */
    hrvDays: 7,
  },
} as const;

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/**
 * Fixed user-facing strings.
 *
 * They live here rather than in the components because §8.5 constrains the
 * *wording*, not just the logic: rule 6 forbids medical claims, and rule 4
 * requires that a substitution is never presented as a fix. Copy that a rule
 * governs belongs next to the rule, where a test can read it.
 */
export const RECOVERY_COPY = {
  /** Required by rule 4. Pain is not soreness. */
  pain:
    "Pain isn't soreness. If it's sharp, radiating, swelling, or lasts more than " +
    'a couple of weeks, see a qualified clinician — we can’t assess that.',
  /** Rule 4(b). Note what this deliberately does not say. */
  substitution:
    'There are gentler variants of these movements. They are alternatives that may ' +
    'feel better on the day — not a fix for whatever is causing the discomfort.',
  /** Rule 5. No neck-check, no triage, no heuristics. */
  illness:
    'You have marked yourself as unwell, so there is no session today — rest and ' +
    'fluids, and see a clinician if you are worried or it is not settling. We do ' +
    'not try to work out what is going on, and we will not program around it.',
  /** Rule 7. Deliberately offers no explanation. */
  referral:
    'Some of your numbers have been outside your usual range for a while. We are ' +
    'not able to say why, and we are not going to guess — please book an ' +
    'appointment with a doctor and take these readings with you. Readiness-based ' +
    'programming is paused until then.',
  /** Rule 2. The nudge that has to come with the pause. */
  chronicReduction:
    'This is the third session running that we have trimmed. Something is not ' +
    'recovering, and quietly shaving a bit off every session hides that rather ' +
    'than fixing it. Take a deload week or a rest day, and have a look at sleep, ' +
    'food, life stress, and whether you are coming down with something.',
  /** Rule 3. `{n}` is replaced with the count of days collected. */
  baseline:
    'Building your baseline — {n}/{required} days. HRV and resting heart rate ' +
    'stay out of your readiness score until then, because a reading only means ' +
    'something against your own normal range.',
  /** Rule 8. */
  override:
    'This is a suggestion. Accept it, edit it, or ignore it — the plan is yours.',
  /** The house phrasing for a suppressed metric. Never a health finding. */
  belowUsualRange: 'below your usual range',
} as const;

/** §8.4's band copy, verbatim. */
export const BAND_COPY: Record<ReadinessBand, string> = {
  high: "You're primed. Green light on the planned session.",
  normal: 'Normal day. Run the plan.',
  low: 'Recovery looks a bit down. Trimmed a set and left a rep in the tank.',
  poor: "Low readiness. Today's a technique-and-blood-flow day, not a PR day.",
};

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** Readiness bands, §8.4. */
export type ReadinessBand = 'high' | 'normal' | 'low' | 'poor';

/** A 1–5 subjective rating. */
export type SubjectiveScale = 1 | 2 | 3 | 4 | 5;

/** How the last session went, relative to the one before it. */
export type SessionPerformance = 'up' | 'flat' | 'down';

/** What to do with the day's conditioning, §9.3. */
export type ConditioningGuidance =
  /** Run it as planned. */
  | 'as_programmed'
  /** Swap the hard interval session for Zone 2. */
  | 'downgrade_intervals'
  /** Zone 1–2 only. */
  | 'easy_only'
  /** Nothing today. */
  | 'rest';

/** Which input a contribution came from. */
export type ReadinessInputId =
  | 'hrv'
  | 'rhr'
  | 'sleep'
  | 'sleep_quality'
  | 'soreness'
  | 'energy'
  | 'performance';

/**
 * Everything the model reads. §8.2, plus the counters the guardrails need.
 *
 * **Subjective inputs are first-class, not fallbacks.** Only `subjectiveSoreness`
 * and `subjectiveEnergy` are required: the app works fully with no wearable at
 * all, and a wearable is an enhancement. Every optional field that is absent
 * contributes nothing and is excluded from the denominator — never imputed,
 * never defaulted to a population value.
 *
 * All units are SI-adjacent and explicit: HRV in milliseconds (RMSSD, morning,
 * consistent conditions), RHR in bpm, sleep in hours.
 *
 * @remarks HRV is **not comparable across devices**. A chest strap, a ring and
 * a wrist optical sensor produce different RMSSD, so `hrvBaseline`, `hrvSD` and
 * `hrvBaselineDays` must all come from the same device as `hrvToday`, and
 * switching devices resets the count to zero. This module cannot check that; it
 * trusts the caller.
 */
export interface ReadinessInput {
  /** This morning's RMSSD, ms. */
  hrvToday?: number | null;
  /** 30–60 day rolling mean, ms. */
  hrvBaseline?: number | null;
  /** Rolling SD of the baseline window, ms. */
  hrvSD?: number | null;
  /** Readings collected in the baseline window. Below 21, HRV scores nothing. */
  hrvBaselineDays?: number;
  /** Consecutive days HRV has sat below `hrvBaseline − hrvSD`. */
  hrvSuppressedDays?: number;
  /** Consecutive days HRV has sat more than 2 SD below baseline (rule 7). */
  hrvBelow2SdDays?: number;

  /** This morning's resting heart rate, bpm. */
  rhrToday?: number | null;
  /** Rolling mean resting heart rate, bpm. */
  rhrBaseline?: number | null;
  /** Readings collected in the baseline window. Below 21, RHR scores nothing. */
  rhrBaselineDays?: number;
  /** Consecutive days RHR has sat more than 10 bpm above baseline (rule 7). */
  rhrElevatedDays?: number;
  /**
   * Consecutive days RHR has sat at or above
   * {@link READINESS_LIMITS.rhrModerateBpm} above baseline.
   *
   * Distinct from {@link rhrElevatedDays}, which counts against the much higher
   * physician-referral threshold. Without its own counter, a sustained moderate
   * elevation — the pattern that actually signals accumulating fatigue or an
   * illness coming on — could never outweigh a single day's blip.
   */
  rhrModeratelyElevatedDays?: number;

  /** Hours asleep last night. */
  sleepHours?: number | null;
  /** Hours below the user's own target across the last 7 days. */
  sleepDebt7d?: number | null;
  /**
   * Subjective sleep quality, 1 = terrible, 5 = excellent.
   *
   * An addition to §8.3's six components, not a replacement for any of them —
   * "how did you actually sleep" is the cheapest recovery signal there is and
   * the only one available to a user with no wearable. Omit it and the score is
   * bit-for-bit what §8.3 specifies.
   */
  sleepQuality?: SubjectiveScale | null;

  /** 1 = none, 5 = severe. Required. */
  subjectiveSoreness: SubjectiveScale;
  /** 1 = wrecked, 5 = great. Required. */
  subjectiveEnergy: SubjectiveScale;
  /** How the last session compared with the one before it. */
  sessionPerfLastTime?: SessionPerformance | null;

  /** The user has reported joint or muscle pain. */
  painFlag: boolean;
  /** The user has reported being unwell. */
  illnessFlag: boolean;

  /**
   * How many consecutive sessions readiness has already trimmed. At
   * {@link READINESS_LIMITS.maxConsecutiveReductions} the app stops trimming
   * and prompts a deload instead (rule 2).
   */
  consecutiveReductions?: number;

  /** Red-flag symptoms the user has reported. Any one suppresses programming (rule 7). */
  symptoms?: {
    /** Chest pain at any intensity. */
    chestPain?: boolean;
    /** Dizziness or fainting at any intensity. */
    dizzinessOrFainting?: boolean;
    /** Shortness of breath at any intensity. */
    shortnessOfBreath?: boolean;
    /** Weight change the user cannot account for. */
    unexplainedWeightChange?: boolean;
    /** Pain that is present at rest, not just under load. */
    painAtRest?: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

/**
 * One input's contribution to the score, with the sentence that explains it.
 *
 * Rule 10 requires every adjustment to display which inputs drove it, so the
 * reasoning is a returned value rather than something the UI reconstructs. A
 * screen that renders `contributions` has satisfied rule 10 by construction.
 */
export interface ReadinessContribution {
  id: ReadinessInputId;
  /** Short human label, e.g. "Sleep". */
  label: string;
  /** The sub-score, in [−2, +1]. */
  score: number;
  /** Plain language, quoting the actual numbers. Never a health claim. */
  detail: string;
}

/** An input that was asked for but did not count, and why not. */
export interface ReadinessExclusion {
  id: ReadinessInputId;
  reason: string;
}

/** Progress toward a usable HRV/RHR baseline (rule 3). */
export interface BaselineStatus {
  /** Days of HRV readings collected. */
  hrvDays: number;
  /** Days of RHR readings collected. */
  rhrDays: number;
  /** Days required before either counts. */
  requiredDays: number;
  /** True once HRV may contribute. */
  hrvReady: boolean;
  /** True once RHR may contribute. */
  rhrReady: boolean;
  /** True when the user has supplied no HRV or RHR at all. */
  noWearableData: boolean;
  /** "Building your baseline — 12/21 days…", or `null` when nothing is pending. */
  message: string | null;
}

/**
 * What readiness proposes doing to the session.
 *
 * Every field is already clamped into the §8.5 bounds — there is no
 * "unclamped" variant, because the only way to be sure a bound holds is for the
 * out-of-range value never to exist.
 */
export interface ReadinessAdjustment {
  /** Total volume change as a fraction, ∈ [−0.5, +0.1]. */
  volumeDelta: number;
  /** Sets to add or remove per exercise. Negative trims. */
  setsPerExerciseDelta: number;
  /** Floor on sets per exercise after trimming. */
  minSetsPerExercise: number;
  /** RIR change, ∈ [−1, +2]. Positive leaves more in the tank. */
  rirDelta: number;
  /** Absolute RIR floor, or `null` when none applies. */
  minRir: number | null;
  /** Load change as a fraction, ∈ [−0.2, **0**]. Never positive. */
  loadDelta: number;
  /** §8.4's "+0 to +1 set on the last exercise only", for the `high` band. */
  extraSetOnLastExercise: boolean;
  /** What to do with conditioning, §9.3. */
  conditioning: ConditioningGuidance;
  /**
   * One sentence per adjustment, each naming the inputs behind it (rule 10).
   * Empty only when nothing was adjusted.
   */
  reasons: string[];
  /**
   * False when the app has deliberately declined to adjust — illness, a
   * referral trigger, or three consecutive reductions. A `false` here is not
   * "nothing was wrong"; read `findings`.
   */
  applied: boolean;
}

/** The whole assessment. */
export interface ReadinessAssessment {
  /** Mean of the contributing sub-scores, ≈[−2, +1]. */
  score: number;
  band: ReadinessBand;
  /** §8.4's copy for the band. */
  bandCopy: string;
  /** What counted, and by how much. */
  contributions: ReadinessContribution[];
  /** What did not count, and why. */
  excluded: ReadinessExclusion[];
  baseline: BaselineStatus;
  adjustment: ReadinessAdjustment;
  /** Guardrail output. `hasBlock()` means: do not present a prescribed session. */
  findings: Finding[];
  /** True when no automated programming may be shown at all (rules 5 and 7). */
  programmingSuppressed: boolean;
  /** True when rule 2 has stopped the adjusting. */
  adjustmentPaused: boolean;
  /** True when a deload or rest day is being prompted instead of an adjustment. */
  deloadPrompted: boolean;
  /** True when a clinician referral is being surfaced (rule 7). */
  referral: boolean;
}

/* ------------------------------------------------------------------ */
/* Finding helpers                                                     */
/* ------------------------------------------------------------------ */

function finding(level: Finding['level'], code: string, message: string): Finding {
  return { ok: false, level, code, message };
}

/* ------------------------------------------------------------------ */
/* Sub-scores (§8.3)                                                   */
/* ------------------------------------------------------------------ */

/**
 * HRV's contribution, in [−2, +1], or `null` when it must not contribute.
 *
 * Two guardrails live in these six lines:
 *
 * - **No baseline, no signal.** Fewer than 21 days of readings returns `null`,
 *   which excludes HRV from the score *and* from the denominator. A partial
 *   baseline is not a weak signal; it is not a signal.
 * - **A one-day dip scores −0.5, not −2.** The full penalty needs three
 *   consecutive days below `baseline − SD`. This asymmetry is the whole point:
 *   with the other five components typically near zero, −0.5 spread across the
 *   denominator cannot on its own move a user out of the `normal` band, while
 *   −2 can.
 *
 * @param i the day's inputs
 * @returns the sub-score, or `null` to exclude HRV entirely
 */
export function hrvScore(i: ReadinessInput): number | null {
  const { hrvToday, hrvBaseline, hrvSD } = i;
  if (hrvToday == null || hrvBaseline == null || hrvSD == null) return null;
  if ((i.hrvBaselineDays ?? 0) < READINESS_LIMITS.baselineDays) return null;

  const z = (hrvToday - hrvBaseline) / Math.max(hrvSD, 1);
  const suppressedDays = i.hrvSuppressedDays ?? 0;

  if (z < -1 && suppressedDays >= READINESS_LIMITS.sustainedSuppressionDays) return -2;
  if (z < -1) return -0.5;
  if (z > 1) return 1;
  return 0;
}

/**
 * Resting heart rate's contribution, in [−2, **0**], or `null`.
 *
 * Galpin's position is that RHR is not sensitive enough to detect the stress of
 * a single hard session — it is useful for spotting illness and long-horizon
 * fitness change, and poor as a day-to-day dial. So this function is
 * deliberately **one-directional**: a low RHR earns nothing. A metric too blunt
 * to detect a hard session is too blunt to hand out a green light on the
 * strength of one morning.
 *
 * Like {@link hrvScore} it returns `null` without 21 days of baseline, and it
 * damps a one-off elevation to −0.5 for exactly the same reason.
 *
 * @param i the day's inputs
 * @returns the sub-score, or `null` to exclude RHR entirely
 */
export function rhrScore(i: ReadinessInput): number | null {
  const { rhrToday, rhrBaseline } = i;
  if (rhrToday == null || rhrBaseline == null) return null;
  if ((i.rhrBaselineDays ?? 0) < READINESS_LIMITS.baselineDays) return null;

  const delta = rhrToday - rhrBaseline;
  const sustained = READINESS_LIMITS.sustainedSuppressionDays;
  const markedDays = i.rhrElevatedDays ?? 0;
  // Falls back to the marked counter so a caller that only supplies the old
  // field still gets the -1 branch at >=10 bpm rather than silently losing it.
  const moderateDays = i.rhrModeratelyElevatedDays ?? markedDays;

  if (delta >= READINESS_LIMITS.rhrMarkedBpm && markedDays >= sustained) return -2;
  if (delta >= READINESS_LIMITS.rhrModerateBpm && moderateDays >= sustained) return -1;
  if (delta >= 5) return -0.5;
  return 0;
}

/**
 * Sleep duration's contribution, in [−2, +1], or `null` when unknown.
 *
 * The +1 requires both a full night *and* a 7-day debt under 3 hours: one good
 * night on the back of a bad week is a recovery, not a surplus.
 *
 * @param i the day's inputs
 */
export function sleepScore(i: ReadinessInput): number | null {
  const h = i.sleepHours;
  if (h == null) return null;
  if (h < 5) return -2;
  if (h < 6.5) return -1;
  if (h >= 7 && (i.sleepDebt7d ?? 0) < 3) return 1;
  return 0;
}

/**
 * Subjective sleep quality's contribution, in [−2, +1], or `null`.
 *
 * Not in §8.3. Added because duration alone misses the night spent awake at
 * 3 a.m. in bed for eight hours, and because it is the one sleep signal a user
 * with no wearable can always give. Omitting the field reproduces §8.3 exactly.
 *
 * @param i the day's inputs
 */
export function sleepQualityScore(i: ReadinessInput): number | null {
  const q = i.sleepQuality;
  if (q == null) return null;
  return ({ 1: -2, 2: -1, 3: 0, 4: 0, 5: 1 } as const)[q];
}

/**
 * Soreness's contribution, in [−2, +1]. Always present.
 *
 * @param i the day's inputs
 */
export function sorenessScore(i: ReadinessInput): number {
  return ({ 1: 1, 2: 0, 3: 0, 4: -1, 5: -2 } as const)[i.subjectiveSoreness];
}

/**
 * Energy's contribution, in [−2, +1]. Always present.
 *
 * @param i the day's inputs
 */
export function energyScore(i: ReadinessInput): number {
  return ({ 1: -2, 2: -1, 3: 0, 4: 0, 5: 1 } as const)[i.subjectiveEnergy];
}

/**
 * Last session's performance, in [−1, +1], or `null` when unknown.
 *
 * @param i the day's inputs
 */
export function performanceScore(i: ReadinessInput): number | null {
  const p = i.sessionPerfLastTime;
  if (p == null) return null;
  return p === 'up' ? 1 : p === 'down' ? -1 : 0;
}

/**
 * Map a score to its band, §8.3.
 *
 * @param score the mean sub-score
 */
export function bandForScore(score: number): ReadinessBand {
  if (score <= -1.0) return 'poor';
  if (score < -0.3) return 'low';
  if (score <= 0.4) return 'normal';
  return 'high';
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

/**
 * Clamp a proposed adjustment into the §8.5 rule 1 bounds.
 *
 * Every number that reaches a {@link ReadinessAdjustment} passes through here,
 * so an out-of-range adjustment is not merely rejected — it never exists.
 *
 * @param kind which axis is being adjusted
 * @param proposed the proposed change (a fraction for volume and load)
 * @returns the value the app will actually use
 */
export function clampReadinessAdjustment(
  kind: 'volume' | 'rir' | 'load',
  proposed: number,
): number {
  const { min, max } = READINESS_LIMITS[kind];
  if (!Number.isFinite(proposed)) return 0;
  return Math.min(max, Math.max(min, proposed));
}

/* ------------------------------------------------------------------ */
/* Baseline (rule 3)                                                   */
/* ------------------------------------------------------------------ */

/**
 * How far along the 21-day HRV/RHR baseline is.
 *
 * @param i the day's inputs
 * @returns the status, including the copy to show while it is building
 */
export function baselineStatus(i: ReadinessInput): BaselineStatus {
  const required = READINESS_LIMITS.baselineDays;
  const hrvDays = i.hrvBaselineDays ?? 0;
  const rhrDays = i.rhrBaselineDays ?? 0;
  const hasHrv = i.hrvToday != null || hrvDays > 0;
  const hasRhr = i.rhrToday != null || rhrDays > 0;
  const hrvReady = hrvDays >= required;
  const rhrReady = rhrDays >= required;

  const pending: number[] = [];
  if (hasHrv && !hrvReady) pending.push(hrvDays);
  if (hasRhr && !rhrReady) pending.push(rhrDays);

  return {
    hrvDays,
    rhrDays,
    requiredDays: required,
    hrvReady,
    rhrReady,
    noWearableData: !hasHrv && !hasRhr,
    message:
      pending.length > 0
        ? RECOVERY_COPY.baseline
            .replace('{n}', String(Math.min(...pending)))
            .replace('{required}', String(required))
        : null,
  };
}

/* ------------------------------------------------------------------ */
/* Turning a timeseries into baseline inputs                           */
/* ------------------------------------------------------------------ */

/** One day's value of one metric, ascending by date at the call site. */
export interface DailyReading {
  /** `YYYY-MM-DD`. */
  date: string;
  value: number;
}

/** A rolling baseline and how much data stands behind it. */
export interface MetricBaseline {
  /** Rolling mean over the window, or `null` when the window is empty. */
  mean: number | null;
  /** Rolling sample SD, or `null` with fewer than two readings. */
  sd: number | null;
  /** Readings in the window. This is the number rule 3 gates on. */
  days: number;
  /** The most recent reading overall, window or not. */
  latest: DailyReading | null;
}

/**
 * Summarise a metric series into the mean, SD and day-count the scorer wants.
 *
 * The most recent reading is **excluded from its own baseline** by default.
 * "Today against your usual" is only a meaningful comparison if today is not
 * one of the things being averaged — including it pulls the baseline toward the
 * value being tested and shrinks every deviation slightly, which is precisely
 * the wrong direction for a guardrail that exists to avoid over-reacting.
 *
 * @param series one reading per day, ascending by date
 * @param options.windowDays how many prior readings to average. Default 60.
 * @param options.excludeLatest whether to hold the newest reading out. Default `true`.
 * @returns the baseline summary
 */
export function summarizeMetricBaseline(
  series: readonly DailyReading[],
  options: { windowDays?: number; excludeLatest?: boolean } = {},
): MetricBaseline {
  const { windowDays = 60, excludeLatest = true } = options;
  const latest = series.length > 0 ? series[series.length - 1] : null;
  const pool = excludeLatest ? series.slice(0, -1) : series.slice();
  const window = pool.slice(Math.max(0, pool.length - windowDays));

  if (window.length === 0) return { mean: null, sd: null, days: 0, latest };

  const mean = window.reduce((s, p) => s + p.value, 0) / window.length;
  const sd =
    window.length < 2
      ? null
      : Math.sqrt(
          window.reduce((s, p) => s + (p.value - mean) ** 2, 0) / (window.length - 1),
        );

  return { mean, sd, days: window.length, latest };
}

/**
 * How many of the most recent consecutive readings sit strictly below a value.
 *
 * Counts backwards from the newest reading and stops at the first that does
 * not. Gaps are not filled: a missing day simply is not a reading, so a run is
 * a run of *readings*, not of calendar days. That is the conservative reading —
 * it cannot manufacture a three-day run out of one reading and two blanks.
 *
 * @param series one reading per day, ascending by date
 * @param threshold the value to compare against
 * @returns the run length, 0 when the newest reading is at or above it
 */
export function consecutiveDaysBelow(
  series: readonly DailyReading[],
  threshold: number,
): number {
  let n = 0;
  for (let k = series.length - 1; k >= 0; k--) {
    if (series[k].value < threshold) n++;
    else break;
  }
  return n;
}

/**
 * How many of the most recent consecutive readings sit strictly above a value.
 *
 * @param series one reading per day, ascending by date
 * @param threshold the value to compare against
 * @returns the run length
 */
export function consecutiveDaysAbove(
  series: readonly DailyReading[],
  threshold: number,
): number {
  let n = 0;
  for (let k = series.length - 1; k >= 0; k--) {
    if (series[k].value > threshold) n++;
    else break;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Physician-first triggers (rule 7)                                   */
/* ------------------------------------------------------------------ */

/**
 * The §8.5 rule 7 triggers.
 *
 * When any fires, the app surfaces a clinician referral, suppresses
 * readiness-based programming, and **does not attempt an explanation**. That
 * last clause is why this returns a single fixed message rather than one
 * tailored to which trigger fired: naming the pattern is a hair's breadth from
 * interpreting it, and interpreting it is not something an app gets to do.
 *
 * @param i the day's inputs
 * @returns findings — a `block` when a referral is warranted, otherwise empty
 */
export function physicianReferralFindings(i: ReadinessInput): Finding[] {
  const r = READINESS_LIMITS.referral;
  const s = i.symptoms ?? {};

  const rhrTrigger =
    i.rhrToday != null &&
    i.rhrBaseline != null &&
    i.rhrToday - i.rhrBaseline > r.rhrAboveBaselineBpm &&
    (i.rhrElevatedDays ?? 0) >= r.rhrDays;

  const hrvTrigger = (i.hrvBelow2SdDays ?? 0) >= r.hrvDays;

  const symptomTrigger = Boolean(
    s.chestPain ||
      s.dizzinessOrFainting ||
      s.shortnessOfBreath ||
      s.unexplainedWeightChange ||
      s.painAtRest,
  );

  if (!rhrTrigger && !hrvTrigger && !symptomTrigger) return [];
  return [finding('block', 'readiness.clinician_referral', RECOVERY_COPY.referral)];
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

const LABELS: Record<ReadinessInputId, string> = {
  hrv: 'HRV',
  rhr: 'Resting heart rate',
  sleep: 'Sleep',
  sleep_quality: 'Sleep quality',
  soreness: 'Soreness',
  energy: 'Energy',
  performance: 'Last session',
};

const SORENESS_WORDS: Record<SubjectiveScale, string> = {
  1: 'no soreness',
  2: 'a little soreness',
  3: 'moderate soreness',
  4: 'a lot of soreness',
  5: 'severe soreness',
};

const ENERGY_WORDS: Record<SubjectiveScale, string> = {
  1: 'wrecked',
  2: 'flat',
  3: 'okay',
  4: 'good',
  5: 'great',
};

const QUALITY_WORDS: Record<SubjectiveScale, string> = {
  1: 'a bad night',
  2: 'a broken night',
  3: 'an average night',
  4: 'a decent night',
  5: 'a good night',
};

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function hrvDetail(i: ReadinessInput, score: number): string {
  const today = i.hrvToday as number;
  const base = i.hrvBaseline as number;
  const sd = Math.max(i.hrvSD as number, 1);
  const z = (today - base) / sd;
  const days = i.hrvSuppressedDays ?? 0;

  if (score === -2) {
    return `HRV ${round(today, 1)} ms against a ${round(base, 1)} ms average — ${RECOVERY_COPY.belowUsualRange}, and it has stayed there ${days} days running. A run like that is what the score reacts to.`;
  }
  if (score === -0.5) {
    return `HRV ${round(today, 1)} ms against a ${round(base, 1)} ms average — ${RECOVERY_COPY.belowUsualRange} this morning. One morning is mostly noise, so it is counted at a quarter weight.`;
  }
  if (score === 1) {
    return `HRV ${round(today, 1)} ms is above your ${round(base, 1)} ms average.`;
  }
  return `HRV ${round(today, 1)} ms is within your usual range (average ${round(base, 1)} ms, ${round(z, 1)} SD).`;
}

function rhrDetail(i: ReadinessInput, score: number): string {
  const today = i.rhrToday as number;
  const base = i.rhrBaseline as number;
  const delta = round(today - base, 1);
  const days = i.rhrElevatedDays ?? 0;

  if (score <= -1) {
    return `Resting heart rate ${round(today, 1)} bpm, ${delta} above your ${round(base, 1)} bpm average, for ${days} days running — ${RECOVERY_COPY.belowUsualRange.replace('below', 'outside')}.`;
  }
  if (score === -0.5) {
    return `Resting heart rate ${round(today, 1)} bpm is ${delta} above your ${round(base, 1)} bpm average this morning. One morning counts lightly.`;
  }
  return `Resting heart rate ${round(today, 1)} bpm is in line with your ${round(base, 1)} bpm average.`;
}

function sleepDetail(i: ReadinessInput, score: number): string {
  const h = round(i.sleepHours as number, 1);
  const debt = i.sleepDebt7d;
  const debtText = debt == null ? '' : ` Sleep debt over the week is ${round(debt, 1)} h.`;
  if (score === -2) return `${h} h asleep — well under the 7–9 h range.${debtText}`;
  if (score === -1) return `${h} h asleep — under the 7–9 h range.${debtText}`;
  if (score === 1) return `${h} h asleep, with little debt behind it.${debtText}`;
  return `${h} h asleep.${debtText}`;
}

/**
 * Build the scored contributions and the exclusions, in display order.
 *
 * @param i the day's inputs
 */
function collect(i: ReadinessInput): {
  contributions: ReadinessContribution[];
  excluded: ReadinessExclusion[];
} {
  const contributions: ReadinessContribution[] = [];
  const excluded: ReadinessExclusion[] = [];
  const baseline = baselineStatus(i);

  // ---- HRV ----------------------------------------------------------
  const hrv = hrvScore(i);
  if (hrv !== null) {
    contributions.push({ id: 'hrv', label: LABELS.hrv, score: hrv, detail: hrvDetail(i, hrv) });
  } else if (i.hrvToday == null || i.hrvBaseline == null || i.hrvSD == null) {
    excluded.push({
      id: 'hrv',
      reason: 'No HRV reading with a baseline to compare it against.',
    });
  } else {
    excluded.push({
      id: 'hrv',
      reason: `Baseline is ${baseline.hrvDays} of ${baseline.requiredDays} days. Until it is complete, HRV counts for nothing.`,
    });
  }

  // ---- RHR ----------------------------------------------------------
  const rhr = rhrScore(i);
  if (rhr !== null) {
    contributions.push({ id: 'rhr', label: LABELS.rhr, score: rhr, detail: rhrDetail(i, rhr) });
  } else if (i.rhrToday == null || i.rhrBaseline == null) {
    excluded.push({
      id: 'rhr',
      reason: 'No resting heart rate with a baseline to compare it against.',
    });
  } else {
    excluded.push({
      id: 'rhr',
      reason: `Baseline is ${baseline.rhrDays} of ${baseline.requiredDays} days. Until it is complete, resting heart rate counts for nothing.`,
    });
  }

  // ---- Sleep --------------------------------------------------------
  const sleep = sleepScore(i);
  if (sleep !== null) {
    contributions.push({
      id: 'sleep',
      label: LABELS.sleep,
      score: sleep,
      detail: sleepDetail(i, sleep),
    });
  } else {
    excluded.push({ id: 'sleep', reason: 'No sleep duration recorded for last night.' });
  }

  const quality = sleepQualityScore(i);
  if (quality !== null) {
    contributions.push({
      id: 'sleep_quality',
      label: LABELS.sleep_quality,
      score: quality,
      detail: `You called it ${QUALITY_WORDS[i.sleepQuality as SubjectiveScale]}.`,
    });
  }

  // ---- Subjective ---------------------------------------------------
  contributions.push({
    id: 'soreness',
    label: LABELS.soreness,
    score: sorenessScore(i),
    detail: `You reported ${SORENESS_WORDS[i.subjectiveSoreness]} (${i.subjectiveSoreness}/5).`,
  });
  contributions.push({
    id: 'energy',
    label: LABELS.energy,
    score: energyScore(i),
    detail: `You reported feeling ${ENERGY_WORDS[i.subjectiveEnergy]} (${i.subjectiveEnergy}/5).`,
  });

  // ---- Last session -------------------------------------------------
  const perf = performanceScore(i);
  if (perf !== null) {
    contributions.push({
      id: 'performance',
      label: LABELS.performance,
      score: perf,
      detail:
        i.sessionPerfLastTime === 'up'
          ? 'Your last session went better than the one before it.'
          : i.sessionPerfLastTime === 'down'
            ? 'Your last session went worse than the one before it.'
            : 'Your last session was in line with the one before it.',
    });
  } else {
    excluded.push({ id: 'performance', reason: 'No previous session to compare against.' });
  }

  return { contributions, excluded };
}

/** The do-nothing adjustment. */
function neutralAdjustment(
  conditioning: ConditioningGuidance,
  reasons: string[],
  applied: boolean,
): ReadinessAdjustment {
  return {
    volumeDelta: 0,
    setsPerExerciseDelta: 0,
    minSetsPerExercise: READINESS_LIMITS.minSetsPerExercise,
    rirDelta: 0,
    minRir: null,
    loadDelta: 0,
    extraSetOnLastExercise: false,
    conditioning,
    reasons,
    applied,
  };
}

/**
 * The band's prescribed adjustment, §8.4, already clamped to §8.5 rule 1.
 *
 * The `high` row is worth reading closely: it adds an optional set to the last
 * exercise and **nothing else**. `volumeDelta` stays at zero and `loadDelta`
 * cannot be positive, so the best possible readiness day buys one extra set of
 * accessory work — not a heavier bar. That is the difference between an
 * autoregulator and a hype man.
 *
 * @param band the day's band
 * @param drivers the contributions that pushed the score, for the reason copy
 * @returns the adjustment
 */
export function adjustmentForBand(
  band: ReadinessBand,
  drivers: readonly ReadinessContribution[] = [],
): ReadinessAdjustment {
  const names = drivers.map((d) => d.label.toLowerCase());
  const because =
    names.length > 0 ? ` Driven by ${joinList(names)}.` : '';

  switch (band) {
    case 'high':
      return {
        ...neutralAdjustment('as_programmed', [], true),
        extraSetOnLastExercise: true,
        reasons: [
          `Recovery is in good shape, so the plan runs as written with the option of one extra set on the last exercise.${because} Readiness never raises a prescribed load — a good night's sleep is not evidence that you got stronger.`,
        ],
      };

    case 'normal':
      return neutralAdjustment('as_programmed', ['Nothing stands out today. Run the plan as written.'], true);

    case 'low':
      return {
        volumeDelta: clampReadinessAdjustment('volume', READINESS_LIMITS.lowVolumeCut),
        setsPerExerciseDelta: -1,
        minSetsPerExercise: READINESS_LIMITS.minSetsPerExercise,
        rirDelta: clampReadinessAdjustment('rir', 1),
        minRir: READINESS_LIMITS.minRirWhenSuppressed,
        loadDelta: clampReadinessAdjustment('load', READINESS_LIMITS.lowLoadCut),
        extraSetOnLastExercise: false,
        conditioning: 'downgrade_intervals',
        reasons: [
          `One set off each exercise (floor of ${READINESS_LIMITS.minSetsPerExercise}), one more rep left in the tank, and about 5% off the bar.${because}`,
          'A hard interval day becomes Zone 2. Easy aerobic work is the last thing to cut, not the first.',
        ],
        applied: true,
      };

    case 'poor':
      return {
        volumeDelta: clampReadinessAdjustment('volume', READINESS_LIMITS.poorVolumeCut),
        setsPerExerciseDelta: -2,
        minSetsPerExercise: READINESS_LIMITS.minSetsPerExercise,
        rirDelta: clampReadinessAdjustment('rir', 2),
        minRir: READINESS_LIMITS.minRirWhenSuppressed,
        loadDelta: clampReadinessAdjustment('load', READINESS_LIMITS.poorLoadCut),
        extraSetOnLastExercise: false,
        conditioning: 'easy_only',
        reasons: [
          `Volume down about 45%, two more reps in reserve (never below ${READINESS_LIMITS.minRirWhenSuppressed} RIR), and 15% off the bar.${because}`,
          'Conditioning is Zone 1–2 only today.',
        ],
        applied: true,
      };
  }
}

function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Score the day, band it, and propose a bounded adjustment with its reasoning.
 *
 * The single entry point. Everything §8.5 requires happens here, in this order,
 * because the order is itself a guardrail — the suppressions run **after** the
 * adjustment is built, so there is no path where a suppression is computed and
 * then quietly overwritten by a band's prescription.
 *
 * 1. Score the available inputs (§8.3), excluding anything without a baseline.
 * 2. Take the band's adjustment (§8.4), clamped to the bounds (rule 1).
 * 3. `painFlag` — clamp volume and load so neither can rise (rule 4).
 * 4. Three consecutive reductions — stop adjusting, prompt a deload (rule 2).
 * 5. A rule 7 trigger — suppress programming, surface a referral.
 * 6. `illnessFlag` — suppress programming entirely (rule 5).
 *
 * @param i the day's inputs
 * @returns the score, the band, what drove it, the adjustment and the findings
 *
 * @example
 * const a = assessReadiness({
 *   sleepHours: 5.5, subjectiveSoreness: 4, subjectiveEnergy: 2,
 *   painFlag: false, illnessFlag: false,
 * });
 * a.band;                       // 'low'
 * a.adjustment.loadDelta;       // -0.05, and never above 0
 * a.contributions.map(c => c.detail);  // rule 10: the reasoning, ready to render
 */
export function assessReadiness(i: ReadinessInput): ReadinessAssessment {
  const { contributions, excluded } = collect(i);
  const baseline = baselineStatus(i);

  const score =
    contributions.length > 0
      ? contributions.reduce((sum, c) => sum + c.score, 0) / contributions.length
      : 0;
  const band = bandForScore(score);

  const findings: Finding[] = [];
  let programmingSuppressed = false;
  let adjustmentPaused = false;
  let deloadPrompted = false;

  // The negatives, strongest first — these are what the reason copy names.
  const drivers = contributions
    .filter((c) => c.score < 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  let adjustment = adjustmentForBand(band, band === 'low' || band === 'poor' ? drivers : []);

  // ---- rule 3: tell the user the baseline is still building ----------
  if (baseline.message !== null) {
    findings.push(finding('info', 'readiness.baseline_building', baseline.message));
  }

  // ---- rule 4: pain -------------------------------------------------
  if (i.painFlag) {
    adjustment = {
      ...adjustment,
      volumeDelta: Math.min(0, adjustment.volumeDelta),
      loadDelta: Math.min(0, adjustment.loadDelta),
      setsPerExerciseDelta: Math.min(0, adjustment.setsPerExerciseDelta),
      extraSetOnLastExercise: false,
      reasons: [
        ...adjustment.reasons,
        'You have flagged pain, so nothing goes up today — not the load, not the sets.',
      ],
    };
    findings.push(finding('warn', 'readiness.pain_flagged', RECOVERY_COPY.pain));
    findings.push(finding('info', 'readiness.substitution_offered', RECOVERY_COPY.substitution));
  }

  // ---- rule 2: chronic auto-reduction -------------------------------
  const reductions = i.consecutiveReductions ?? 0;
  const wouldReduce = band === 'low' || band === 'poor';
  if (wouldReduce && reductions >= READINESS_LIMITS.maxConsecutiveReductions) {
    adjustmentPaused = true;
    deloadPrompted = true;
    adjustment = neutralAdjustment(
      'easy_only',
      [
        `Readiness has trimmed ${reductions} sessions in a row, so it is standing down rather than trimming a fourth.`,
      ],
      false,
    );
    findings.push(finding('warn', 'readiness.chronic_reduction', RECOVERY_COPY.chronicReduction));
  }

  // ---- rule 7: physician-first triggers ------------------------------
  const referralFindings = physicianReferralFindings(i);
  if (referralFindings.length > 0) {
    programmingSuppressed = true;
    adjustment = neutralAdjustment(
      'rest',
      ['Readiness-based programming is paused while this is looked at properly.'],
      false,
    );
    findings.push(...referralFindings);
  }

  // ---- rule 5: illness ------------------------------------------------
  if (i.illnessFlag) {
    programmingSuppressed = true;
    adjustment = neutralAdjustment('rest', ['No session is being programmed today.'], false);
    findings.push(finding('block', 'readiness.illness', RECOVERY_COPY.illness));
  }

  // ---- rule 8: the override is always available ----------------------
  if (adjustment.applied && (band === 'low' || band === 'poor')) {
    findings.push(finding('info', 'readiness.override_available', RECOVERY_COPY.override));
  }

  return {
    score: round(score, 3),
    band,
    bandCopy: BAND_COPY[band],
    contributions,
    excluded,
    baseline,
    adjustment,
    findings,
    programmingSuppressed,
    adjustmentPaused,
    deloadPrompted,
    referral: referralFindings.length > 0,
  };
}

/**
 * Map a readiness score to the 0–100 scale `ReadinessRecord.score` stores.
 *
 * The raw score lives in roughly [−2, +1], which is the right shape for the
 * arithmetic and the wrong shape for a person. This is a presentation mapping
 * and nothing more — banding is always done on the raw score by
 * {@link bandForScore}, never by re-thresholding the percentage, so the two can
 * never disagree.
 *
 * @param score the raw score from {@link assessReadiness}
 * @returns an integer 0–100
 */
export function readinessPercent(score: number): number {
  const clamped = Math.min(1, Math.max(-2, score));
  return Math.round(((clamped + 2) / 3) * 100);
}
