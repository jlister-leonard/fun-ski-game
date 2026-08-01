/**
 * coach.ts — the weekly rules engine (task-graph node **A7**).
 *
 * This is the module that makes the app a coach rather than a tracker. It takes
 * one week of everything the vault knows — trend weight, the adaptive
 * expenditure estimate *and its confidence*, logged intake, training volume by
 * muscle, the trainer's three uncontrolled sessions, readiness history,
 * micronutrient adequacy, the supplement stack, medications, and labs when they
 * exist — and returns a ranked list of {@link CoachInsight}, each one carrying
 * its reasoning, the specific inputs that produced it, a confidence tag, a tier
 * from `advice-policy.md`, and whatever {@link Finding}s came with it.
 *
 * ## Four properties this module is built around
 *
 * **1. It composes; it does not re-derive.** Every number quoted here is
 * produced by the module that already owns it — `guardrails.projectBodyFatOutcome`
 * for the timeline, `dietary-guardrails.checkMacroFloors` for the adequacy
 * floors, `micronutrients.recommendationsForGaps` for the doses,
 * `medication-interactions.LAB_EFFECTS` for the creatine/creatinine story. A
 * second implementation of a safety limit is a second thing that can drift, so
 * there is not one here. What this module adds is *ranking, tiering, evidence
 * and copy*.
 *
 * **2. Ranking is structural.** Insights sort by {@link DOMAIN_RANK} band first
 * and severity second, and `adequacy` is a lower-numbered band than
 * `body-composition`. That makes `nutrition-personalization.md` §3.4
 * requirement 1 — *adequacy floors are surfaced at least as prominently as
 * deficit progress* — a property of the sort order rather than of a tuning
 * constant somebody can nudge. It is asserted in the tests.
 *
 * **3. Suppressing a false alarm is a first-class insight.** Creatine putting
 * a kilo of water on the scale, creatine raising measured creatinine and
 * dropping eGFR with it, a heavy lifting week raising AST and ALT, topical
 * minoxidil and fluid — each of these produces a `suppressesAlarm: true`
 * insight that *states the alarm and why it is probably not one*, along with
 * the test that would settle it. Filtering these out silently would be worse
 * than useless: the alarm still exists, and the user would go and meet it
 * somewhere with less context.
 *
 * **4. Nothing is returned that has not passed the guardrails.** Every draft
 * goes through {@link guardInsight}, which runs the medication-directive copy
 * lint (advice-policy Tier 3 rule 1), the celebratory-copy lint from
 * `dietary-guardrails`, a local lint against celebrating weight loss or framing
 * a bigger deficit as a better outcome, and `hasBlock()` over the insight's own
 * findings. Blocked drafts are not dropped on the floor — they land in
 * {@link CoachReview.suppressed} with the finding that killed them, so a
 * regression shows up as data rather than as an absence.
 *
 * ## Units
 *
 * Signatures and stored values are SI, per `AGENTS.md`. The copy generated here
 * is written in quantities that are the same in both systems — percent of
 * bodyweight, kcal, grams, weeks, months, sets, minutes — so that flipping the
 * display preference cannot change a sentence. Masses are exposed as
 * {@link CoachEvidence} with `unit: 'kg'` for `/review` to convert at the
 * display boundary. The only kg that appear in prose come from findings
 * produced by `guardrails.ts`, which already owned that copy.
 *
 * Pure, zero-dependency, no I/O. Sibling algorithm modules only.
 *
 * @module coach
 */

import {
  DISCLAIMERS,
  LIMITS,
  actionable,
  explainRateTradeoff,
  hasBlock,
  leanLossFraction,
  professionalReferralPrompt,
  projectBodyFatOutcome,
  validateObservedProgress,
  validateProfile,
  type Finding,
  type FindingLevel,
  type ObservedProgress,
  type UserProfile,
} from './guardrails';
import {
  DIET_LIMITS,
  checkDaySummaryCopy,
  checkMacroFloors,
  detectSustainedUnderEating,
  type DayIntake,
  type UnderEatingAssessment,
} from './dietary-guardrails';
import {
  gapsSupplementsCannotClose,
  rankGaps,
  recommendationsForGaps,
  type AdequacyAssessment,
  type MicronutrientDatabase,
  type PersonContext,
  type SupplementRecommendation,
  type SupplementStack,
} from './micronutrients';
import {
  LAB_EFFECTS,
  activeConfounders,
  assertNoMedicationDirective,
  isActiveOn,
  type Confidence,
  type Confounder,
  type MedicationEntry,
} from './medication-interactions';
import { PERTURBATION_DEFAULTS, daysBetween, type TrendSummary } from './weight-trend';
import type { DataSufficiency, ExpenditureEstimate } from './expenditure';
import type { ReadinessBand } from './readiness';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which part of the week an insight is about.
 *
 * The order of the union is not the ranking — {@link DOMAIN_RANK} is. They are
 * separate so that adding a domain does not silently reorder the review.
 */
export type InsightDomain =
  /** Something that needs a person, not an app. Always first. */
  | 'safety'
  /** Protein, fat, fibre and energy floors. Ranked above deficit progress. */
  | 'adequacy'
  /** An alarm that is probably not an alarm, and what would settle it. */
  | 'confounder'
  /** Rate of loss, projected timeline, lean-mass cost. */
  | 'body-composition'
  /** Targets, expenditure confidence, fuelling. */
  | 'nutrition'
  /** Weekly sets against landmarks, and where the budget went. */
  | 'training'
  /** Zone 2 dose, interval dose, the VO2max goal. */
  | 'conditioning'
  /** Micronutrient gaps and what closes them. */
  | 'micronutrients'
  /** Lab context. */
  | 'labs'
  /** What was asked for versus what is being programmed. */
  | 'goal-conflict'
  /** Readiness across the week. */
  | 'recovery'
  /** What was logged, framed without judgement. */
  | 'adherence';

/**
 * Band ordering. Lower sorts earlier.
 *
 * `adequacy` (1) sitting above `body-composition` (3) is the machine-checked
 * form of `nutrition-personalization.md` §3.4 requirement 1. Do not reorder
 * these two without reading that section; the test will fail if you do.
 */
export const DOMAIN_RANK: Record<InsightDomain, number> = {
  safety: 0,
  adequacy: 1,
  confounder: 2,
  'body-composition': 3,
  nutrition: 4,
  training: 5,
  conditioning: 6,
  micronutrients: 7,
  labs: 8,
  'goal-conflict': 9,
  recovery: 10,
  adherence: 11,
};

/** Urgency within a band. Mirrors the vault's `InsightSeverity`. */
export type InsightSeverity = 'info' | 'suggestion' | 'warning' | 'critical';

const SEVERITY_WEIGHT: Record<InsightSeverity, number> = {
  critical: 4,
  warning: 3,
  suggestion: 2,
  info: 1,
};

/** The advice-policy tier this insight is issued under. */
export type CoachTier = 1 | 2 | 3;

/**
 * One input that produced an insight.
 *
 * This exists because "show the reasoning" is a requirement in two separate
 * specs (`training-methodology.md` §8.5 rule 10 and `advice-policy.md` Tier 1),
 * and because an opaque recommendation is one the user is right to ignore.
 *
 * `unit` is the SI unit of `value` when it is numeric. `/review` converts to the
 * user's display system; nothing here does.
 */
export interface CoachEvidence {
  label: string;
  value: string | number;
  /** SI unit, or `null` for unitless / already-formatted values. */
  unit: 'kg' | 'kcal' | 'g' | '%' | '%bw/wk' | 'weeks' | 'days' | 'sets' | 'min' | null;
}

/** A single ranked coaching output. */
export interface CoachInsight {
  /** Stable rule id. Same rule, same id, forever — it is how the UI dedupes. */
  id: string;
  domain: InsightDomain;
  severity: InsightSeverity;
  /** Short. Reads on a phone without wrapping three times. */
  headline: string;
  /** The reasoning. Matter-of-fact, no disclaimer stapled on. */
  detail: string;
  /** What to actually do, or `null` when the honest answer is "nothing yet". */
  action: string | null;
  /** Tier 2's one specific sentence of uncertainty. `null` at Tier 1. */
  caveat: string | null;
  /** The specific inputs that produced this. */
  inputs: CoachEvidence[];
  confidence: Confidence;
  tier: CoachTier;
  /** Findings carried along. `hasBlock()` here means the insight is not shown. */
  findings: Finding[];
  /**
   * True when the insight exists to stand *down* an alarm rather than raise
   * one. These are as valuable as the alarms and are counted separately.
   */
  suppressesAlarm: boolean;
  /** 0..1, derived from band and severity. Sort key, and useful to persist. */
  score: number;
}

/** An insight the guardrails refused to show, and what refused it. */
export interface SuppressedInsight {
  id: string;
  domain: InsightDomain;
  /** The `block` finding that stopped it. */
  blockedBy: Finding;
}

/** The whole weekly review. */
export interface CoachReview {
  /** ISO date of the last day of the week under review. */
  weekEndingDate: string;
  /** One line the screen can lead with. Never a verdict on the person. */
  headline: string;
  /** Ranked, guardrailed. */
  insights: CoachInsight[];
  /** Drafts the guardrails blocked, retained so a regression is visible. */
  suppressed: SuppressedInsight[];
  /** Everything the engine could not say, and why. Rendered as-is. */
  dataGaps: string[];
  /** Every finding gathered this run, for `professionalReferralPrompt`. */
  findings: Finding[];
  referral: ReturnType<typeof professionalReferralPrompt>;
  /**
   * True when the eating-disorder rules have closed the numeric-target gate.
   * The screen must show no calorie or weight numbers at all in this state.
   */
  numericTargetsSuppressed: boolean;
  /** Shown once, at the foot of the screen. Not stapled to every insight. */
  disclaimer: string;
}

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

/** What the athlete asked for, and what the engine is actually programming. */
export interface CoachGoals {
  /** Body-fat percentage the cut started from. */
  startBodyFatPct?: number;
  /** Body-fat percentage being chased. */
  targetBodyFatPct?: number;
  /** Prescribed rate, signed, % bodyweight per week. Negative for a cut. */
  targetRatePctBwPerWeek: number;
  /** Weeks into the block. Used for the revised timeline, not for judgement. */
  weeksElapsed?: number;
  /**
   * Pairs of `statedAs` (the athlete's own words) and `intent` (what the engine
   * is doing). `athlete-profile.md` §3.3 requires the gap to be surfaced rather
   * than quietly resolved.
   */
  tradeoffs?: readonly {
    id: string;
    statedAs: string;
    intent: 'improve' | 'maintain' | 'monitor';
    /** Why the engine is not doing what was asked, and what it costs. */
    because: string;
  }[];
  /** VO2max goal, when one is set. */
  vo2max?: {
    targetImprovementPct: number;
    horizonWeeks: number;
  };
}

/** A week of logged intake, already aggregated. */
export interface CoachIntake {
  /** Per-day energy against target, for {@link detectSustainedUnderEating}. */
  days: readonly DayIntake[];
  /** Mean over *logged* days only. Unlogged days are missing data, not zeroes. */
  meanKcal: number;
  meanProteinG: number;
  meanFatG: number;
  meanCarbG: number;
  meanFiberG: number;
  /** Current prescribed daily energy target, kcal. */
  targetKcal: number;
}

/** One muscle's week, with the trainer's share already bounded above. */
export interface MuscleWeek {
  /** Free-form label, e.g. `'quads'`. Deliberately a string — see the module note. */
  muscle: string;
  /** Hard sets the app programmed. */
  appSets: number;
  /**
   * Upper credible bound on the trainer's contribution, per
   * `program-personalized.md` §3.4. **The bound, not the mean** — under-
   * estimating pushes the athlete past MRV three days a week, indefinitely.
   */
  trainerSetsUpperBound: number;
  /** Rank-0 prehab work, charged off the top of both ledgers. */
  prehabSets: number;
  /** Weekly hard-set landmarks for this muscle. */
  landmarks: { mev: number; mavLow: number; mavHigh: number; mrv: number };
  /** Consecutive weeks this muscle has been over its ceiling. */
  weeksOverCeiling?: number;
  /** Confirmed trainer sessions backing the estimate. Drives escalation. */
  confirmations?: number;
}

/** The week's training, as the budget engine sees it. */
export interface CoachTraining {
  volume: readonly MuscleWeek[];
  /** Trainer sessions in the week, and how many the athlete confirmed. */
  trainerSessions: number;
  trainerSessionsConfirmed: number;
  /** Sets the engine declined to program because the budget was gone. */
  indicatorLiftsDropped?: readonly string[];
}

/** The week's conditioning, against the Galpin dose. */
export interface CoachConditioning {
  zone2Minutes: number;
  zone2Sessions: number;
  /** Sessions at Z4/Z5. The VO2max dose. */
  hardIntervalSessions: number;
  /** Minutes spent in the Z3 grey zone. Polarization's failure mode. */
  zone3Minutes?: number;
  /**
   * Mean 4×4 output this week as a percentage of the block's best, when the
   * athlete has done enough of them to have a best. Drives §4.3's backstop.
   */
  intervalOutputPctOfBest?: number | null;
}

/** One readiness day, reduced to what the weekly view needs. */
export interface CoachReadinessDay {
  date: string;
  band: ReadinessBand;
  score: number;
  /** True when the engine declined to adjust — illness, referral, or rule 2. */
  programmingSuppressed?: boolean;
}

/** A lab value, already normalized by `labs.ts`. */
export interface CoachLabValue {
  /** Matches {@link LAB_EFFECTS} ids: `'creatinine'`, `'egfr-creatinine'`, `'alt-ast'`. */
  analyteId: string;
  displayName: string;
  value: number;
  unit: string;
  /** The lab's own interpretation. `critical_*` short-circuits everything. */
  interpretation: 'normal' | 'high' | 'low' | 'critical_high' | 'critical_low' | 'abnormal';
  /** ISO date drawn. */
  drawnOn: string;
}

/** Everything the engine needs for one week. Every field but the first is optional. */
export interface CoachInput {
  /** ISO date of the last day of the week under review. */
  weekEndingDate: string;
  profile: UserProfile;
  goals: CoachGoals;

  trend?: TrendSummary | null;
  expenditure?: ExpenditureEstimate | null;
  dataSufficiency?: DataSufficiency | null;
  intake?: CoachIntake | null;
  training?: CoachTraining | null;
  conditioning?: CoachConditioning | null;
  readiness?: readonly CoachReadinessDay[];

  micronutrients?: {
    assessments: readonly AdequacyAssessment[];
    database: MicronutrientDatabase;
    person: PersonContext;
  } | null;
  supplementStack?: SupplementStack | null;
  medications?: readonly MedicationEntry[];
  labs?: readonly CoachLabValue[];

  /**
   * Hard training sessions in the seven days before the most recent lab draw.
   * Muscle contains AST and ALT; this is what makes a training-driven rise the
   * likelier explanation than anything hepatic.
   */
  hardSessionsBeforeLastDraw?: number;

  /** Weigh-ins in the last 14 days, when no trend summary is available. */
  weighInsLast14d?: number;

  /**
   * Findings gathered elsewhere this session — the ED screener, behavioural
   * signals, profile validation done at goal-setting. Folded into the referral
   * decision and into the numeric-targets gate.
   */
  externalFindings?: readonly Finding[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Coaching thresholds that are this module's own. Everything with a safety
 * meaning lives in `guardrails.LIMITS` or `dietary-guardrails.DIET_LIMITS`;
 * these are the softer editorial ones, exported so tests and UI read the same
 * numbers.
 */
export const COACH_LIMITS = {
  /** Fraction of prescribed rate below which the cut is called "behind". */
  RATE_BEHIND_FRACTION: 0.6,
  /** Fraction of prescribed rate above which it is called "ahead". */
  RATE_AHEAD_FRACTION: 1.4,
  /** Deficit weeks per maintenance week — `athlete-profile.md` §4.3. */
  DIET_BREAK_EVERY_N_WEEKS: 7,
  /** Weeks of adherence/plateau buffer added to every projection. §4.2. */
  TIMELINE_BUFFER_WEEKS: [2, 4] as const,
  /** Zone 2 weekly dose, minutes — methodology §9.2. */
  ZONE2_MIN_PER_WEEK: [150, 180] as const,
  /** Hard interval sessions per week. */
  VO2MAX_SESSIONS_PER_WEEK: [1, 2] as const,
  /** Grey-zone minutes above which polarization has broken down. */
  ZONE3_GREY_ZONE_MIN: 60,
  /** Interval output drop, as % of block best, that demotes the second dose. §4.3. */
  INTERVAL_OUTPUT_DROP_PCT: 5,
  /** Days after starting creatine during which the water shift is still loading. */
  CREATINE_SETTLING_DAYS: PERTURBATION_DEFAULTS['creatine-start'].settlingDays,
  /** Days after starting creatine before the estimator can be trusted again. §6.5. */
  CREATINE_ESTIMATOR_RECOVERY_DAYS: 56,
  /** Logged days in a week below which the expenditure estimate should not move. */
  MIN_LOGGED_DAYS_TO_ACT: 4,
} as const;

/**
 * Copy patterns this module refuses to emit.
 *
 * `dietary-guardrails.checkDaySummaryCopy` covers congratulating a low day.
 * These cover the two failures specific to a *weekly* surface: celebrating the
 * scale going down, and framing a bigger deficit as the better outcome. Both
 * are easy to write by accident and both teach exactly the wrong thing.
 */
export const COACH_FORBIDDEN_COPY: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /\b(great|excellent|fantastic|amazing|awesome|brilliant)\b[^.!?]{0,40}\b(loss|losing|lost|down|deficit|drop)\b/i,
    why: 'Praise attached to the scale going down. State the number; do not score it.',
  },
  {
    pattern: /\b(congratulations|congrats|well done|great job|nice work|proud of you)\b/i,
    why: 'Congratulation on a weekly body-composition surface reads as praise for restriction.',
  },
  {
    pattern: /\b(bigger|larger|deeper|harder|more aggressive)\s+(deficit|cut)\b[^.!?]{0,40}\b(better|faster|great|good|ideal|best)\b/i,
    why: 'Frames a larger deficit as a better outcome. It is not; it costs lean mass.',
  },
  {
    pattern: /\b(streak|days? in a row|perfect week|keep it going)\b/i,
    why: 'Streak mechanics convert a missed day into a loss. §3.4 requirement 3.',
  },
];

/** Findings that close the numeric-target gate. Not overridable by any tier. */
const NUMERIC_GATE_CODES: readonly string[] = [
  'ED_SCREEN_POSITIVE',
  'ED_HISTORY',
  'BEHAVIOUR_SEVERE_UNDEREATING',
  'BMI_SEVERE_THINNESS',
  'BMI_UNDERWEIGHT_CUT',
  'GOAL_WEIGHT_UNDERWEIGHT',
  'AGE_UNDER_18',
  'PREGNANCY',
  'LACTATION_EARLY',
];

/** Domains whose insights quote a calorie or weight number. */
const NUMERIC_DOMAINS: readonly InsightDomain[] = ['body-composition', 'nutrition'];

/* ------------------------------------------------------------------ */
/* Finding helpers                                                     */
/* ------------------------------------------------------------------ */

function mk(level: FindingLevel, code: string, message: string): Finding {
  return { ok: false, level, code, message };
}

/* ------------------------------------------------------------------ */
/* Scoring and ranking                                                 */
/* ------------------------------------------------------------------ */

/**
 * Rank score for an insight, 0..1, higher sorts earlier.
 *
 * Band dominates severity by construction: the band term steps by 10 and the
 * severity term spans 1..4, so no severity can lift an insight out of its band.
 * That is what makes the adequacy-above-deficit-progress rule a guarantee
 * rather than a hope.
 */
export function insightScore(domain: InsightDomain, severity: InsightSeverity): number {
  const key = DOMAIN_RANK[domain] * 10 - SEVERITY_WEIGHT[severity];
  // Max key is 11*10 - 1 = 109; min is 0*10 - 4 = -4.
  const normalised = 1 - (key + 4) / 117;
  return Math.round(Math.max(0, Math.min(1, normalised)) * 1000) / 1000;
}

/** Sort in place by score descending, then by id for a stable order. */
function rankInsights(insights: CoachInsight[]): CoachInsight[] {
  return [...insights].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ */
/* The guardrail pipeline                                              */
/* ------------------------------------------------------------------ */

/** What a draft looks like before scoring. */
type Draft = Omit<CoachInsight, 'score'>;

function draft(d: Omit<Draft, 'suppressesAlarm'> & { suppressesAlarm?: boolean }): Draft {
  return { suppressesAlarm: false, ...d };
}

/** Context the guardrail pass needs beyond the insight itself. */
export interface GuardContext {
  /** True when the ED rules have closed the numeric-target gate. */
  numericTargetsSuppressed: boolean;
}

/**
 * Run every guardrail over one draft insight.
 *
 * Four gates, in the order that a failure is cheapest to diagnose:
 *
 * 1. **Medication directives** (`advice-policy.md` Tier 3 rule 1). Run over the
 *    headline, detail and action with `assertNoMedicationDirective`. This is a
 *    blunt lint and that is deliberate — rewording a false positive is cheaper
 *    than shipping a sentence that tells someone to change a prescribed dose.
 * 2. **Celebratory copy** (`dietary-guardrails.checkDaySummaryCopy`).
 * 3. **This module's own lints** ({@link COACH_FORBIDDEN_COPY}).
 * 4. **The insight's own findings** — `hasBlock()` means it is not shown, which
 *    is the same contract `validateTargets` has with the targets screen.
 *
 * The ED gate is applied separately and by domain rather than by copy, because
 * it suppresses a *category* of number, not a phrasing.
 *
 * @returns the insight when it passes, or the blocking finding when it does not
 */
export function guardInsight(
  d: Draft,
  ctx: GuardContext,
): { ok: true; insight: CoachInsight } | { ok: false; blockedBy: Finding } {
  const findings = [...d.findings];
  const copy = [d.headline, d.detail, d.action ?? '', d.caveat ?? ''].join(' ');

  const directive = assertNoMedicationDirective(copy);
  if (directive !== null) {
    return {
      ok: false,
      blockedBy: mk(
        'block',
        'COACH_COPY_MEDICATION_DIRECTIVE',
        `Insight "${d.id}" contains advice about a prescribed medication ("${directive}"). Prescriptions are the doctor's; this is the one boundary the engine does not cross.`,
      ),
    };
  }

  const celebratory = checkDaySummaryCopy(copy).find((f) => f.level === 'block');
  if (celebratory) return { ok: false, blockedBy: celebratory };

  for (const rule of COACH_FORBIDDEN_COPY) {
    if (rule.pattern.test(copy)) {
      return {
        ok: false,
        blockedBy: mk('block', 'COACH_COPY_FORBIDDEN', `Insight "${d.id}": ${rule.why}`),
      };
    }
  }

  if (ctx.numericTargetsSuppressed && NUMERIC_DOMAINS.includes(d.domain)) {
    return {
      ok: false,
      blockedBy: mk(
        'block',
        'COACH_NUMERIC_GATE_CLOSED',
        `Insight "${d.id}" quotes calorie or weight numbers, and the eating-disorder rules have turned those off. This is not overridable by any recommendation tier.`,
      ),
    };
  }

  if (hasBlock(findings)) {
    // `actionable` sorts block > warn > info, so the head is the blocker.
    return { ok: false, blockedBy: actionable(findings)[0] };
  }

  return {
    ok: true,
    insight: { ...d, findings, score: insightScore(d.domain, d.severity) },
  };
}

/* ------------------------------------------------------------------ */
/* Rule: body-composition trajectory                                   */
/* ------------------------------------------------------------------ */

/**
 * Honest calendar for a body-fat goal, in weeks.
 *
 * `projectBodyFatOutcome` gives the deficit weeks. `athlete-profile.md` §4.2 is
 * explicit that quoting that number alone reads as a promise the engine cannot
 * keep, because one maintenance week per seven and a two-to-four-week
 * adherence buffer are not padding — they are what every real cut does. So the
 * projection returned here is a *range*, and the copy says months.
 *
 * @param deficitWeeks weeks of actual deficit from the projection
 * @returns inclusive `[low, high]` calendar weeks
 */
export function honestCalendarWeeks(deficitWeeks: number): [number, number] {
  const breaks = Math.floor(deficitWeeks / COACH_LIMITS.DIET_BREAK_EVERY_N_WEEKS);
  const base = deficitWeeks + breaks;
  const [lo, hi] = COACH_LIMITS.TIMELINE_BUFFER_WEEKS;
  return [Math.round(base + lo), Math.round(base + hi)];
}

/** Weeks to a rounded "about N months" phrase. Never a single-week promise. */
function monthsPhrase([lo, hi]: [number, number]): string {
  const loM = lo / 4.345;
  const hiM = hi / 4.345;
  const a = Math.round(loM * 2) / 2;
  const b = Math.round(hiM * 2) / 2;
  if (Math.abs(a - b) < 0.6) return `about ${b} months`;
  return `about ${a} to ${b} months`;
}

function trajectoryInsights(input: CoachInput): Draft[] {
  const out: Draft[] = [];
  const { trend, goals, profile } = input;
  const targetRate = goals.targetRatePctBwPerWeek;

  if (!trend) {
    out.push(
      draft({
        id: 'trajectory-no-data',
        domain: 'body-composition',
        severity: 'info',
        headline: 'Not enough weigh-ins to say anything about the rate yet',
        detail:
          'The rate of change is estimated from the smoothed trend, not from any single reading, and it needs a fortnight of weigh-ins before the estimate is tighter than the week-to-week noise it is trying to see through. Until then the honest answer is that I do not know.',
        action: 'Weigh in at the same time each morning. Five in a fortnight is enough to start.',
        caveat: null,
        inputs: [{ label: 'Weigh-ins in last 14 days', value: input.weighInsLast14d ?? 0, unit: null }],
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
    return out;
  }

  const observedPct = trend.weeklyChangePctBw;
  const evidence: CoachEvidence[] = [
    { label: 'Observed rate', value: round(observedPct, 2), unit: '%bw/wk' },
    { label: 'Prescribed rate', value: round(targetRate, 2), unit: '%bw/wk' },
    { label: 'Trend weight', value: round(trend.trendKg, 1), unit: 'kg' },
    { label: 'Weigh-ins, last 14 days', value: trend.weighInsLast14d, unit: null },
  ];

  // --- The confounder branch comes first, because it changes the reading ----
  if (trend.perturbationActive) {
    out.push(
      draft({
        id: 'trajectory-confounded',
        domain: 'confounder',
        severity: 'info',
        suppressesAlarm: true,
        headline: 'The scale is being moved by something that is not fat',
        detail:
          'A logged perturbation is still settling, so this week\'s trend is not a clean read on the cut. I am not going to tell you the loss has slowed, because I cannot tell the difference between a slowdown and water from here — and the wrong response to that ambiguity is to cut your food.',
        action: 'Keep everything where it is. The trend becomes readable again once the window closes.',
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
    return out;
  }

  // --- Observed-progress guardrails (fast-loss branches stay fully live) ----
  const observed: ObservedProgress = {
    weeklyChangeKg: trend.weeklyChangeKg,
    trendKg: trend.trendKg,
    weeksSustained: goals.weeksElapsed ?? 1,
    intentional: profile.goal !== 'maintain',
  };
  const progressFindings = validateObservedProgress(observed).filter((f) => !f.ok);

  if (!trend.rateIsActionable) {
    out.push(
      draft({
        id: 'trajectory-imprecise',
        domain: 'body-composition',
        severity: 'info',
        headline: 'The rate estimate is still too loose to act on',
        detail: `The trend puts you at ${fmtRate(observedPct)} against a prescribed ${fmtRate(targetRate)}, but the confidence interval on that is wider than the difference between the two. Changing anything on the strength of it would be changing it on noise.`,
        action:
          'Hold the current targets and keep weighing in. Five weigh-ins in a fortnight is where the interval starts to be narrower than the decision.',
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: progressFindings,
      }),
    );
    return out;
  }

  // --- On, ahead of, or behind the prescribed rate -------------------------
  const magnitudeRatio = targetRate === 0 ? 1 : observedPct / targetRate;
  const losing = observedPct < 0;

  if (losing && magnitudeRatio > COACH_LIMITS.RATE_AHEAD_FRACTION) {
    const leanPct = Math.round(leanLossFraction(Math.abs(observedPct)) * 100);
    const tradeoff =
      typeof profile.bodyFatPct === 'number' && typeof goals.targetBodyFatPct === 'number'
        ? explainRateTradeoff(
            profile.bodyweightKg,
            profile.bodyFatPct,
            goals.targetBodyFatPct,
            Math.abs(observedPct),
          ).filter((f) => !f.ok)
        : [];

    out.push(
      draft({
        id: 'trajectory-faster-than-prescribed',
        domain: 'body-composition',
        severity: 'warning',
        headline: 'You are losing faster than the plan calls for',
        detail: `The trend is running at ${fmtRate(observedPct)} against a prescribed ${fmtRate(targetRate)}. At that rate roughly ${leanPct}% of what comes off is projected to be lean tissue, against about 5% at half a percent a week. This is not the plan working better than expected — a body-fat *percentage* is fat over total weight, and burning muscle shrinks the bottom of that fraction as well as the top.`,
        action:
          'Add food back until the trend sits on the prescribed rate. If the logs already say you are eating the target, the target is too low and the expenditure estimate needs to come up.',
        caveat: null,
        inputs: [...evidence, { label: 'Projected lean share of loss', value: leanPct, unit: '%' }],
        confidence: 'well-established',
        tier: 1,
        findings: [...progressFindings, ...tradeoff],
      }),
    );
  } else if (losing && magnitudeRatio < COACH_LIMITS.RATE_BEHIND_FRACTION) {
    out.push(
      draft({
        id: 'trajectory-behind',
        domain: 'body-composition',
        severity: 'suggestion',
        headline: 'The cut is running behind the prescribed rate',
        detail: `The trend is at ${fmtRate(observedPct)} against a prescribed ${fmtRate(targetRate)}. Two explanations fit equally well and they need opposite responses: the deficit is genuinely smaller than intended, or some food is not making it into the log. Under-logging is extremely common and is not a character flaw.`,
        action:
          'Log two or three days as completely as you can — including oils, drinks and anything eaten standing up. That single change resolves the ambiguity faster than any adjustment I could make blind.',
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: progressFindings,
      }),
    );
  } else if (!losing && profile.goal === 'cut') {
    out.push(
      draft({
        id: 'trajectory-flat',
        domain: 'body-composition',
        severity: 'suggestion',
        headline: 'The trend is flat or rising while the plan is a deficit',
        detail: `The trend is at ${fmtRate(observedPct)}. One flat week inside a cut is unremarkable — glycogen, sodium and gut contents swamp a week of fat loss. A month of flat is a different thing and means the energy budget is wrong.`,
        action:
          'Nothing this week. If it is still flat in three weeks with the logs intact, the expenditure estimate is the thing to revise, not your discipline.',
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: progressFindings,
      }),
    );
  } else {
    out.push(
      draft({
        id: 'trajectory-on-plan',
        domain: 'body-composition',
        severity: 'info',
        headline: 'The trend is sitting on the prescribed rate',
        detail: `Observed ${fmtRate(observedPct)} against a prescribed ${fmtRate(targetRate)}. Nothing to change.`,
        action: 'Hold everything.',
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: progressFindings,
      }),
    );
  }

  // --- The revised timeline ------------------------------------------------
  if (
    typeof profile.bodyFatPct === 'number' &&
    typeof goals.targetBodyFatPct === 'number' &&
    goals.targetBodyFatPct < profile.bodyFatPct &&
    losing
  ) {
    const atObserved = projectBodyFatOutcome(
      trend.trendKg,
      profile.bodyFatPct,
      goals.targetBodyFatPct,
      Math.abs(observedPct),
    );
    const atPrescribed = projectBodyFatOutcome(
      trend.trendKg,
      profile.bodyFatPct,
      goals.targetBodyFatPct,
      Math.abs(targetRate),
    );

    if (atObserved.weeksToTarget !== null && atPrescribed.weeksToTarget !== null) {
      const observedCal = honestCalendarWeeks(atObserved.weeksToTarget);
      const prescribedCal = honestCalendarWeeks(atPrescribed.weeksToTarget);
      out.push(
        draft({
          id: 'trajectory-timeline',
          domain: 'body-composition',
          severity: 'info',
          headline: `${goals.targetBodyFatPct}% body fat is ${monthsPhrase(observedCal)} away at this rate`,
          detail: `At the rate you are actually running, ${goals.targetBodyFatPct}% arrives in ${monthsPhrase(observedCal)}; at the prescribed rate it is ${monthsPhrase(prescribedCal)}. Those numbers include one maintenance week every seven and a two-to-four week buffer for travel, illness and ordinary life, because every cut spends them and a projection that pretends otherwise is a projection you stop believing in week six.`,
          action: null,
          caveat: null,
          inputs: [
            { label: 'Current body fat', value: profile.bodyFatPct, unit: '%' },
            { label: 'Target body fat', value: goals.targetBodyFatPct, unit: '%' },
            { label: 'Deficit weeks at observed rate', value: atObserved.weeksToTarget, unit: 'weeks' },
            { label: 'Calendar weeks, low', value: observedCal[0], unit: 'weeks' },
            { label: 'Calendar weeks, high', value: observedCal[1], unit: 'weeks' },
            { label: 'Lean mass cost at this rate', value: atObserved.leanMassLostKg ?? 0, unit: 'kg' },
          ],
          confidence: 'reasonable-inference',
          tier: 1,
          findings: [],
        }),
      );
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Rule: expenditure confidence                                        */
/* ------------------------------------------------------------------ */

function expenditureInsights(input: CoachInput): Draft[] {
  const est = input.expenditure;
  if (!est) return [];
  const suff = input.dataSufficiency ?? null;

  const evidence: CoachEvidence[] = [
    { label: 'Estimated expenditure', value: Math.round(est.tdeeKcal), unit: 'kcal' },
    { label: '95% interval', value: `${Math.round(est.ci95[0])}–${Math.round(est.ci95[1])}`, unit: 'kcal' },
    { label: 'Confidence', value: est.confidenceLabel, unit: null },
    { label: 'Days in window', value: est.daysUsed, unit: 'days' },
    { label: 'Share from your data', value: Math.round(est.dataWeight * 100), unit: '%' },
  ];

  const holding = suff !== null && suff.status !== 'updating';
  const shouldHold =
    est.suppressAdjustment ||
    holding ||
    est.confidenceLabel === 'none' ||
    est.confidenceLabel === 'low';

  if (shouldHold) {
    const reasons = [
      ...(suff?.reasons ?? []),
      ...(est.suppressAdjustment ? ['The estimate is too uncertain to drive a target change.'] : []),
      ...(est.imputedDays > 0 ? [`${est.imputedDays} day(s) of intake had to be filled in.`] : []),
    ];
    return [
      draft({
        id: 'expenditure-holding',
        domain: 'nutrition',
        severity: 'suggestion',
        headline: 'Holding your targets — the expenditure estimate is not solid enough to move them',
        detail: `The current estimate is ${Math.round(est.tdeeKcal)} kcal with a 95% interval of ${Math.round(est.ci95[0])} to ${Math.round(est.ci95[1])}. That interval is wide enough that any adjustment I made from it would be as likely to be in the wrong direction as the right one. ${reasons.join(' ')}`.trim(),
        action:
          suff && suff.intakeDaysLast7 < 6
            ? `Log ${6 - suff.intakeDaysLast7} more day(s) this week and the interval tightens materially. Six or seven complete days is where the estimate stops being a guess with a number attached.`
            : 'Keep logging and weighing in as you are. The estimate sharpens on its own.',
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: est.regimeChangeSuspected && est.userPrompt
          ? [mk('info', 'COACH_EXPENDITURE_REGIME_CHANGE', est.userPrompt)]
          : [],
      }),
    ];
  }

  return [
    draft({
      id: 'expenditure-actionable',
      domain: 'nutrition',
      severity: 'info',
      headline: `Expenditure estimate is solid enough to work from: ${Math.round(est.tdeeKcal)} kcal`,
      detail: `${Math.round(est.dataWeight * 100)}% of that number now comes from your own logged data rather than from the population prior, over ${est.daysUsed} days, with a 95% interval of ${Math.round(est.ci95[0])} to ${Math.round(est.ci95[1])} kcal. It is an estimate calculated from what you log and how your weight trends — not a measurement — but it is precise enough to set targets from.`,
      action: 'Targets can move this week if the trend calls for it.',
      caveat: null,
      inputs: evidence,
      confidence: 'reasonable-inference',
      tier: 1,
      findings: [mk('info', 'COACH_EXPENDITURE_ESTIMATE', DISCLAIMERS.estimateUncertainty)],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* Rule: adequacy floors                                               */
/* ------------------------------------------------------------------ */

function adequacyInsights(input: CoachInput): Draft[] {
  const intake = input.intake;
  if (!intake) return [];
  const out: Draft[] = [];

  const floors = checkMacroFloors({
    bodyweightKg: input.profile.bodyweightKg,
    proteinG: intake.meanProteinG,
    fatG: intake.meanFatG,
    fiberG: intake.meanFiberG,
    energyKcal: intake.meanKcal,
    inDeficit: input.profile.goal === 'cut',
  }).filter((f) => !f.ok);

  const proteinPerKg = intake.meanProteinG / Math.max(1, input.profile.bodyweightKg);
  const fibreTarget = Math.round((14 * intake.meanKcal) / 1000);

  const proteinFinding = floors.find((f) => f.code.startsWith('PROTEIN_'));
  const fatFinding = floors.find((f) => f.code.startsWith('FAT_'));
  const fibreFinding = floors.find((f) => f.code.startsWith('FIBER_'));

  if (proteinFinding) {
    out.push(
      draft({
        id: 'adequacy-protein',
        domain: 'adequacy',
        severity: proteinFinding.level === 'warn' ? 'warning' : 'suggestion',
        headline: `Protein averaged ${proteinPerKg.toFixed(1)} g/kg this week`,
        detail: `${proteinFinding.message} Protein is the one macro whose floor does real work in a deficit: it is what decides how much of the weight you lose is fat rather than muscle, and it is also the most satiating of the three, so hitting it makes the rest of the week easier rather than harder.`,
        action: `Aim for ${DIET_LIMITS.PROTEIN_FLOOR_G_PER_KG} g/kg — about ${Math.round(DIET_LIMITS.PROTEIN_FLOOR_G_PER_KG * input.profile.bodyweightKg)} g a day — spread over three to five feedings of 20 to 40 g.`,
        caveat: null,
        inputs: [
          { label: 'Mean protein', value: Math.round(intake.meanProteinG), unit: 'g' },
          { label: 'Per kg bodyweight', value: round(proteinPerKg, 2), unit: null },
          { label: 'Floor', value: DIET_LIMITS.PROTEIN_FLOOR_G_PER_KG, unit: null },
        ],
        confidence: 'well-established',
        tier: 1,
        findings: [proteinFinding],
      }),
    );
  }

  if (fatFinding) {
    out.push(
      draft({
        id: 'adequacy-fat',
        domain: 'adequacy',
        severity: 'warning',
        headline: 'Fat intake is under the floor',
        detail: fatFinding.message,
        action: `Get fat to at least ${Math.round(LIMITS.FAT.minGPerKg * input.profile.bodyweightKg)} g a day. Whole eggs, oily fish and olive oil are the cheapest ways to do it without displacing protein.`,
        caveat: null,
        inputs: [
          { label: 'Mean fat', value: Math.round(intake.meanFatG), unit: 'g' },
          { label: 'Floor', value: Math.round(LIMITS.FAT.minGPerKg * input.profile.bodyweightKg), unit: 'g' },
        ],
        confidence: 'well-established',
        tier: 1,
        findings: [fatFinding],
      }),
    );
  }

  if (fibreFinding) {
    out.push(
      draft({
        id: 'adequacy-fibre',
        domain: 'adequacy',
        severity: 'suggestion',
        headline: `Fibre averaged ${Math.round(intake.meanFiberG)} g against about ${fibreTarget} g`,
        detail: `${fibreFinding.message} In a deficit this is mostly a hunger problem rather than a health one — fibre is the cheapest way to make a smaller number of calories feel like more food, and hunger is what ends cuts.`,
        action:
          'Psyllium husk, 5 g before the largest meal, ramped up by 5 g a week to 10 g, closes most of a gap this size. Take it with a full glass of water.',
        caveat: null,
        inputs: [
          { label: 'Mean fibre', value: Math.round(intake.meanFiberG), unit: 'g' },
          { label: 'Energy-scaled target', value: fibreTarget, unit: 'g' },
        ],
        confidence: 'well-established',
        tier: 1,
        findings: [fibreFinding],
      }),
    );
  }

  // --- Under-eating -------------------------------------------------------
  const under: UnderEatingAssessment = detectSustainedUnderEating(intake.days);
  const underFindings = under.findings.filter((f) => !f.ok && f.code !== 'LOGGING_SPARSE');
  if (underFindings.length > 0) {
    const worst = underFindings[0];
    out.push(
      draft({
        id: 'adequacy-under-eating',
        domain: 'adequacy',
        severity: worst.level === 'warn' ? 'warning' : 'suggestion',
        headline: `Intake came in under target on ${under.underEatenDays} of ${under.daysLogged} logged days`,
        detail: `${worst.message} Two readings fit: either the target is set higher than how you actually eat, or the deficit is bigger than the one you signed up for. Under-logging is the first thing to rule out and it is not a failing.`,
        action:
          'If it is under-logging, nothing needs to change. If it is not, eating closer to target will buy you better training and a better lean-mass split than the extra deficit will.',
        caveat: null,
        inputs: [
          { label: 'Days logged', value: under.daysLogged, unit: 'days' },
          { label: 'Under target', value: under.underEatenDays, unit: 'days' },
          { label: 'Mean shortfall', value: Math.round(under.meanShortfallKcal), unit: 'kcal' },
        ],
        confidence: 'well-established',
        tier: 1,
        findings: underFindings,
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Rule: training volume against the landmarks                         */
/* ------------------------------------------------------------------ */

/** One muscle's ledger totals. Exported because `/review` renders them. */
export interface MuscleBudget {
  muscle: string;
  /** App + trainer upper bound + prehab. */
  totalSets: number;
  trainerShare: number;
  /** Ceiling in a deficit is `mavHigh`, not `mrv` — methodology §10. */
  ceiling: number;
  /** Negative means the week is already over the ceiling. */
  headroom: number;
  state: 'under-mev' | 'in-range' | 'at-ceiling' | 'over-ceiling';
}

/**
 * Reduce a muscle's week to a budget position.
 *
 * The ceiling is `mavHigh` rather than `mrv` because the athlete is in a
 * deficit and `training-methodology.md` §10 caps progression at MAV there —
 * recovery capacity is a function of energy availability, and ramping toward
 * MRV on a deficit is how you buy fatigue instead of adaptation.
 */
export function muscleBudget(m: MuscleWeek): MuscleBudget {
  const total = m.appSets + m.trainerSetsUpperBound + m.prehabSets;
  const ceiling = m.landmarks.mavHigh;
  const headroom = ceiling - total;
  const state: MuscleBudget['state'] =
    total < m.landmarks.mev
      ? 'under-mev'
      : headroom < 0
        ? 'over-ceiling'
        : headroom < 1
          ? 'at-ceiling'
          : 'in-range';
  return {
    muscle: m.muscle,
    totalSets: round(total, 1),
    trainerShare: round(m.trainerSetsUpperBound, 1),
    ceiling,
    headroom: round(headroom, 1),
    state,
  };
}

function trainingInsights(input: CoachInput): Draft[] {
  const t = input.training;
  if (!t || t.volume.length === 0) return [];
  const out: Draft[] = [];

  const budgets = t.volume.map((m) => ({ week: m, budget: muscleBudget(m) }));

  // --- Sustained overreach ------------------------------------------------
  const sustained = budgets.filter(
    ({ week, budget }) =>
      budget.state === 'over-ceiling' &&
      (week.weeksOverCeiling ?? 1) >= 2 &&
      (week.confirmations ?? 0) >= 2,
  );
  const freshOverreach = budgets.filter(
    ({ week, budget }) => budget.state === 'over-ceiling' && !sustained.some((s) => s.week === week),
  );

  if (sustained.length > 0) {
    const names = list(sustained.map((s) => s.budget.muscle));
    out.push(
      draft({
        id: 'training-over-ceiling-sustained',
        domain: 'training',
        severity: 'warning',
        headline: `By my model, ${names} has been over the weekly ceiling for two weeks running`,
        detail: `By my model, three sessions a week on ${names} is above the weekly ceiling I would normally plan to. My model does not see your sessions and could easily be wrong — your trainer does. It works from a population prior with wide error bars, and it deliberately rounds your trainer's volume *up*, because under-estimating it is the error that hurts. Here is what I can do about it on my end, and here is a question worth asking them.`,
        action:
          'Three options, and they are options rather than a verdict: ask your trainer about rotating emphasis across the three days; accept it and let me pull everything else back further; or drop to two trainer sessions a week. Tell me which and I will plan around it.',
        caveat: null,
        inputs: sustained.flatMap(({ budget }) => [
          { label: `${budget.muscle} total`, value: budget.totalSets, unit: 'sets' as const },
          { label: `${budget.muscle} ceiling`, value: budget.ceiling, unit: 'sets' as const },
          { label: `${budget.muscle} from trainer`, value: budget.trainerShare, unit: 'sets' as const },
        ]),
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [
          mk(
            'warn',
            'COACH_VOLUME_OVER_CEILING_SUSTAINED',
            `${names}: modelled weekly volume has exceeded the deficit ceiling for ${Math.max(...sustained.map((s) => s.week.weeksOverCeiling ?? 2))} consecutive weeks with confirmed sessions behind the estimate.`,
          ),
        ],
      }),
    );
  }

  if (freshOverreach.length > 0) {
    const names = list(freshOverreach.map((s) => s.budget.muscle));
    out.push(
      draft({
        id: 'training-over-ceiling-new',
        domain: 'training',
        severity: 'suggestion',
        headline: `${names} came out above the weekly ceiling on my estimate`,
        detail:
          'One week over is far more often my estimate being too generous with what your trainer did than a real overreach — I round their volume up on purpose, because under-counting it is the error that pushes you past MRV three days a week. A confirmation sharpens the estimate immediately.',
        action: 'Confirm this week\'s trainer sessions. It tightens the bound and usually hands sets back rather than taking them away.',
        caveat: null,
        inputs: freshOverreach.map(({ budget }) => ({
          label: `${budget.muscle}`,
          value: `${budget.totalSets} of ${budget.ceiling}`,
          unit: 'sets' as const,
        })),
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [],
      }),
    );
  }

  // --- Budget already spent ------------------------------------------------
  const spent = budgets.filter(({ budget }) => budget.state === 'at-ceiling');
  if (spent.length > 0) {
    const names = list(spent.map((s) => s.budget.muscle));
    out.push(
      draft({
        id: 'training-budget-spent',
        domain: 'training',
        severity: 'info',
        headline: `Your trainer is already covering ${names}`,
        detail: `Between the trainer's three days and your prehab work, ${names} is at its weekly ceiling before I program anything. So I have left it alone. That is the budget working, not a gap.`,
        action: null,
        caveat: null,
        inputs: spent.map(({ budget }) => ({
          label: budget.muscle,
          value: `${budget.totalSets} of ${budget.ceiling}`,
          unit: 'sets' as const,
        })),
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [],
      }),
    );
  }

  // --- Under-stimulated ----------------------------------------------------
  const underMev = budgets.filter(({ budget }) => budget.state === 'under-mev');
  if (underMev.length > 0) {
    const names = list(underMev.map((s) => s.budget.muscle));
    out.push(
      draft({
        id: 'training-under-mev',
        domain: 'training',
        severity: 'suggestion',
        headline: `${names} is below minimum effective volume`,
        detail: `${names} came in under MEV once the trainer's estimated contribution is counted. In a deficit, below MEV is where a muscle starts giving ground rather than holding it — and holding is the whole job this block.`,
        action: `There is headroom to add ${underMev.map((u) => `${Math.max(1, Math.round(u.week.landmarks.mev - u.budget.totalSets))} to ${u.budget.muscle}`).join(', ')}. Straight sets, two reps in reserve, on a day away from the trainer block.`,
        caveat: null,
        inputs: underMev.map(({ week, budget }) => ({
          label: budget.muscle,
          value: `${budget.totalSets} of ${week.landmarks.mev} MEV`,
          unit: 'sets' as const,
        })),
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [],
      }),
    );
  }

  // --- Dropped indicator lifts --------------------------------------------
  if (t.indicatorLiftsDropped && t.indicatorLiftsDropped.length > 0) {
    out.push(
      draft({
        id: 'training-indicator-dropped',
        domain: 'training',
        severity: 'info',
        headline: `Not tracking ${list([...t.indicatorLiftsDropped])} this week`,
        detail:
          'There was not enough fatigue headroom to reserve sets for it, so I dropped it rather than tipping a muscle over its ceiling to keep a measurement. Telling you is the point — a silently dropped indicator looks exactly like a silently plateaued lift.',
        action: 'It comes back automatically as soon as there are four sets of headroom on that muscle.',
        caveat: null,
        inputs: [{ label: 'Dropped', value: t.indicatorLiftsDropped.join(', '), unit: null }],
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Rule: conditioning dose against the VO2max goal                     */
/* ------------------------------------------------------------------ */

function conditioningInsights(input: CoachInput): Draft[] {
  const c = input.conditioning;
  if (!c) return [];
  const out: Draft[] = [];
  const [z2Lo, z2Hi] = COACH_LIMITS.ZONE2_MIN_PER_WEEK;
  const [hardLo, hardHi] = COACH_LIMITS.VO2MAX_SESSIONS_PER_WEEK;

  const evidence: CoachEvidence[] = [
    { label: 'Zone 2 minutes', value: c.zone2Minutes, unit: 'min' },
    { label: 'Zone 2 target', value: `${z2Lo}–${z2Hi}`, unit: 'min' },
    { label: 'Hard interval sessions', value: c.hardIntervalSessions, unit: null },
  ];

  if (c.hardIntervalSessions < hardLo) {
    out.push(
      draft({
        id: 'conditioning-no-intervals',
        domain: 'conditioning',
        severity: 'suggestion',
        headline: 'No hard interval session this week',
        detail: `VO2max is the goal that intervals move and nothing else does — Zone 2 builds the base, but the 4×4 is what shifts the ceiling. Helgerud's group got 7 to 10% in eight weeks at three sessions a week; at one session a week in a deficit the honest expectation is ${input.goals.vo2max ? `${input.goals.vo2max.targetImprovementPct}%` : '5 to 8%'} over ${input.goals.vo2max?.horizonWeeks ?? 16} weeks. Missing the session does not just slow that down, it is the entire dose.`,
        action:
          'One session: 4 × 4 minutes at 90–95% of max heart rate, 3 minutes easy between. On the assault bike or the sled rather than running — both are near-zero eccentric, so they cost the lifting almost nothing.',
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  } else if (c.hardIntervalSessions > hardHi) {
    out.push(
      draft({
        id: 'conditioning-too-many-intervals',
        domain: 'conditioning',
        severity: 'suggestion',
        headline: `${c.hardIntervalSessions} hard interval sessions is more than the plan calls for`,
        detail:
          'Intervals carry the highest fatigue cost per minute of anything in the week, and on top of three trainer days they are the thing most likely to start eating into lifting quality. More is not more here — the dose-response for VO2max flattens fast past two sessions.',
        action: 'Two hard sessions a week is the ceiling. Put the extra time into Zone 2 instead.',
        caveat: null,
        inputs: evidence,
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [],
      }),
    );
  }

  if (c.zone2Minutes < z2Lo) {
    const short = z2Lo - c.zone2Minutes;
    out.push(
      draft({
        id: 'conditioning-zone2-short',
        domain: 'conditioning',
        severity: 'info',
        headline: `Zone 2 came in ${short} minutes under the weekly dose`,
        detail: `${c.zone2Minutes} minutes against ${z2Lo} to ${z2Hi}. Zone 2 is the cheapest work in the week: it is recovery-positive, it adds expenditure without much fatigue, and it is the last thing that should be cut when the week gets tight.`,
        action: `Add ${short} minutes across the week — incline walking or cycling, both low-eccentric so they do not compete with the trainer's leg work. Rowing and swimming are the wrong choice here specifically because upper back and lats are the most crowded muscles in your week.`,
        caveat: null,
        inputs: evidence,
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  }

  if ((c.zone3Minutes ?? 0) > COACH_LIMITS.ZONE3_GREY_ZONE_MIN) {
    out.push(
      draft({
        id: 'conditioning-grey-zone',
        domain: 'conditioning',
        severity: 'suggestion',
        headline: `${c.zone3Minutes} minutes in the grey zone`,
        detail:
          'Zone 3 is hard enough to cost real recovery and not hard enough to drive the VO2max adaptation you are after. The polarized split — roughly 80% of conditioning time easy, 20% genuinely hard, and very little in between — exists because the middle is where effort goes to be wasted.',
        action: 'Push the hard sessions harder and let the easy ones be genuinely easy. If you can hold a conversation, it is Zone 2; if you can only manage a few words, it is Zone 4.',
        caveat: null,
        inputs: [...evidence, { label: 'Zone 3 minutes', value: c.zone3Minutes ?? 0, unit: 'min' }],
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  }

  if (
    typeof c.intervalOutputPctOfBest === 'number' &&
    c.intervalOutputPctOfBest < 100 - COACH_LIMITS.INTERVAL_OUTPUT_DROP_PCT
  ) {
    out.push(
      draft({
        id: 'conditioning-output-down',
        domain: 'conditioning',
        severity: 'suggestion',
        headline: `Interval output is ${Math.round(100 - c.intervalOutputPctOfBest)}% below the block's best`,
        detail:
          'That is the pre-agreed backstop for the second hard session. Interval quality is the first thing to go when the week carries too much residual fatigue, and it is a better early signal than how you feel, because it is a number.',
        action:
          'Demote the second hard conditioning session to Zone 3 for a fortnight. If output recovers, it goes back up. One measurement, one rule, no debate.',
        caveat: null,
        inputs: [
          ...evidence,
          { label: 'Output vs block best', value: Math.round(c.intervalOutputPctOfBest), unit: '%' },
        ],
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [],
      }),
    );
  }

  // --- The deficit interaction, said once ---------------------------------
  if (input.profile.goal === 'cut' && c.hardIntervalSessions >= hardLo) {
    out.push(
      draft({
        id: 'conditioning-deficit-interaction',
        domain: 'conditioning',
        severity: 'info',
        headline: 'Hard intervals in a deficit are run on low glycogen',
        detail:
          'This is the one real cost of chasing fat loss and VO2max at the same time, and it is a fuelling problem rather than a reason to drop either goal. Interval quality tracks muscle glycogen closely, and a deficit is by definition short of it.',
        action:
          'Put 40 to 60 g of carbohydrate in the 90 minutes before the hard session and take it out of the same day\'s later meals. Same weekly total, better session.',
        caveat: null,
        inputs: [{ label: 'Hard sessions', value: c.hardIntervalSessions, unit: null }],
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Rule: micronutrient gaps and what closes them                       */
/* ------------------------------------------------------------------ */

function describeDose(r: SupplementRecommendation): string {
  const range = r.doseLow === r.doseHigh ? `${r.doseLow}` : `${r.doseLow}–${r.doseHigh}`;
  return `${r.compound}, ${range} ${r.unit}, ${timingPhrase(r.timing)}`;
}

function timingPhrase(t: SupplementRecommendation['timing']): string {
  switch (t) {
    case 'with-breakfast':
      return 'with breakfast';
    case 'with-dinner':
      return 'with dinner';
    case 'pre-workout':
      return 'before training';
    case 'post-workout':
      return 'after training';
    case 'morning':
      return 'in the morning';
    case 'midday':
      return 'at midday';
    case 'evening':
      return 'in the evening';
    default:
      return 'any time of day';
  }
}

function micronutrientInsights(input: CoachInput): Draft[] {
  const mn = input.micronutrients;
  if (!mn || mn.assessments.length === 0) return [];
  const out: Draft[] = [];

  const gaps = rankGaps(mn.assessments);
  if (gaps.length === 0) return out;

  const stack: SupplementStack = input.supplementStack ?? { products: [] };
  const { safe, wouldExceedUpperLimit } = recommendationsForGaps(
    gaps,
    stack,
    mn.database,
    mn.person,
  );

  const topGaps = gaps.slice(0, 4);
  const gapEvidence: CoachEvidence[] = topGaps.map((g) => ({
    label: g.name,
    value: g.pctOfReference === null ? 'no reference' : `${Math.round(g.pctOfReference)}% of reference`,
    unit: null,
  }));

  if (safe.length > 0) {
    out.push(
      draft({
        id: 'micronutrients-closeable-gaps',
        domain: 'micronutrients',
        severity: 'suggestion',
        headline: `${safe.length} gap${safe.length === 1 ? '' : 's'} worth closing with a supplement`,
        detail: `The shortfalls that a supplement genuinely closes, with the form that matters and why: ${safe
          .map((r) => `**${describeDose(r)}** — ${r.closes} ${r.formRationale}`)
          .join(' ')} This is what you ate, not what is in your blood. A food log points at a likely gap; only a test confirms one.`,
        action: safe.map((r) => describeDose(r)).join('; ') + '.',
        caveat: null,
        inputs: gapEvidence,
        confidence: lowestConfidence(safe.map((r) => r.confidence)),
        tier: 1,
        findings: safe
          .filter((r) => r.tier === 2 && r.caveat)
          .map((r) => mk('info', `COACH_SUPPLEMENT_CAVEAT_${r.id.toUpperCase()}`, r.caveat as string)),
      }),
    );
  }

  if (wouldExceedUpperLimit.length > 0) {
    out.push(
      draft({
        id: 'micronutrients-upper-limit-blocked',
        domain: 'micronutrients',
        severity: 'warning',
        headline: `Not suggesting ${list(wouldExceedUpperLimit.map((r) => r.compound))} — your stack is already near the limit`,
        detail:
          'Adding it on top of what you already take would put you over the tolerable upper intake level for at least one nutrient in it. Stacking a multivitamin with singles is the ordinary way people end up over a UL, and it is invisible unless something adds the products up.',
        action: 'The gap stays open. Closing it from food, or swapping one of the products in the stack, is the way through rather than adding another.',
        caveat: 'Upper limits are set for chronic daily intake in healthy adults; a single day over is not the same thing as a chronic excess.',
        inputs: wouldExceedUpperLimit.map((r) => ({ label: r.compound, value: 'would exceed UL', unit: null })),
        confidence: 'well-established',
        tier: 2,
        findings: [],
      }),
    );
  }

  const unclosable = gapsSupplementsCannotClose(gaps);
  if (unclosable.length > 0) {
    out.push(
      draft({
        id: 'micronutrients-food-only-gaps',
        domain: 'micronutrients',
        severity: 'info',
        headline: `${list(unclosable.slice(0, 3).map((g) => g.name))}: a pill is the wrong tool`,
        detail:
          'These are the gaps where supplementation is a poor substitute and saying otherwise would be overclaiming. Potassium is the clearest case — the daily reference is 3,400 mg for adult men and supplement products are capped by convention at 99 mg per tablet, so you would need dozens. It is a food problem wearing a supplement problem\'s clothes.',
        action:
          'Potassium: a quarter to a half teaspoon of potassium-chloride salt substitute on food gets you 700 to 1,600 mg, which is a real dent. Otherwise this is a food-choice problem and worth treating as one.',
        caveat: 'Potassium-chloride substitutes are the one item here that interacts with kidney function and with several blood-pressure drug classes — worth a word with a clinician if either applies to you.',
        inputs: unclosable.slice(0, 3).map((g) => ({
          label: g.name,
          value: g.pctOfReference === null ? 'not assessed' : `${Math.round(g.pctOfReference)}% of reference`,
          unit: null,
        })),
        confidence: 'well-established',
        tier: 2,
        findings: [],
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Rule: confounders — standing an alarm down is an insight            */
/* ------------------------------------------------------------------ */

function findMedication(meds: readonly MedicationEntry[] | undefined, id: string): MedicationEntry | null {
  if (!meds) return null;
  return meds.find((m) => m.id === id) ?? null;
}

/**
 * Confounder insights: the alarms that are probably not alarms.
 *
 * Every entry here states the alarm plainly, gives the mechanism, and names the
 * thing that would settle it. None of them silently swallow the signal — a
 * suppressed alarm the user never sees is one they will meet later somewhere
 * with less context and more fear.
 */
function confounderInsights(input: CoachInput): Draft[] {
  const out: Draft[] = [];
  const today = input.weekEndingDate;
  const meds = input.medications ?? [];

  const creatine = findMedication(meds, 'creatine');
  const creatineDays =
    creatine?.startedOn != null ? daysBetween(creatine.startedOn, today) : null;
  const creatineActive = creatine !== null && isActiveOn(creatine, today);
  const creatineLoading =
    creatineActive && creatineDays !== null && creatineDays >= 0 && creatineDays <= COACH_LIMITS.CREATINE_SETTLING_DAYS;

  // --- 1. Creatine and the scale ------------------------------------------
  if (creatineLoading) {
    out.push(
      draft({
        id: 'confounder-creatine-water',
        domain: 'confounder',
        severity: 'info',
        suppressesAlarm: true,
        headline: 'Your scale is carrying creatine water this month, not stalled fat loss',
        detail: `You started creatine ${creatineDays} days ago. Creatine is stored in muscle as phosphocreatine and water follows it in osmotically — intracellular water specifically — so total body mass rises by somewhere around a kilo over roughly four weeks at 5 g a day with no loading phase. The scale flattening or ticking up during that window is the expected reading, not a stalled cut. I have paused expenditure updates rather than cutting your food for a water-weight plateau, because that is the harm this check exists to prevent.`,
        action: `Nothing. Expenditure updates resume about ${COACH_LIMITS.CREATINE_ESTIMATOR_RECOVERY_DAYS} days after you started, once there is enough post-window data to fit cleanly. Body-fat readings from smart scales also read low during this period — creatine raises intracellular water and bioimpedance infers lean mass from total body water — so I am leaving those out of the trend.`,
        caveat: null,
        inputs: [
          { label: 'Days on creatine', value: creatineDays ?? 0, unit: 'days' },
          { label: 'Settling window', value: COACH_LIMITS.CREATINE_SETTLING_DAYS, unit: 'days' },
          {
            label: 'Modelled water shift',
            value: PERTURBATION_DEFAULTS['creatine-start'].expectedShiftKg,
            unit: 'kg',
          },
        ],
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  }

  // --- 2. Creatine, creatinine and eGFR -----------------------------------
  const labs = input.labs ?? [];
  if (creatineActive) {
    for (const analyteId of ['creatinine', 'egfr-creatinine']) {
      const lab = labs.find((l) => l.analyteId === analyteId);
      if (!lab) continue;
      const flagged =
        analyteId === 'creatinine'
          ? lab.interpretation === 'high' || lab.interpretation === 'abnormal'
          : lab.interpretation === 'low' || lab.interpretation === 'abnormal';
      if (!flagged) continue;
      const effect = LAB_EFFECTS.find(
        (e) => e.agentId === 'creatine' && e.analyteId === analyteId,
      );
      if (!effect) continue;

      out.push(
        draft({
          id: `confounder-creatine-${analyteId}`,
          domain: 'confounder',
          severity: 'info',
          suppressesAlarm: true,
          headline: `${lab.displayName} came back flagged, and creatine may be affecting it`,
          detail: effect.message,
          action:
            'Tell whoever reads your results that you take creatine. When creatinine is unreliable, ask whether a combined creatinine-cystatin C eGFR or measured GFR is appropriate; the combined estimate is generally more accurate than either marker alone.',
          caveat:
            'Creatine is a plausible confounder, not proof of the cause. The effect varies between people, and a clinician can interpret the result in context and rule out alternatives.',
          inputs: [
            { label: lab.displayName, value: `${lab.value} ${lab.unit}`, unit: null },
            { label: 'Drawn', value: lab.drawnOn, unit: null },
            { label: 'Evidence', value: effect.confidence, unit: null },
          ],
          confidence: effect.confidence,
          tier: 2,
          findings: [],
        }),
      );
    }
  }

  // --- 3. Resistance training and the liver panel -------------------------
  const liver = labs.find((l) => l.analyteId === 'alt-ast');
  const hardSessions = input.hardSessionsBeforeLastDraw ?? 0;
  if (liver && (liver.interpretation === 'high' || liver.interpretation === 'abnormal') && hardSessions > 0) {
    out.push(
      draft({
        id: 'confounder-training-liver-enzymes',
        domain: 'confounder',
        severity: 'info',
        suppressesAlarm: true,
        headline: 'Raised ALT and AST after a heavy training week usually come from muscle, not liver',
        detail: `You trained hard ${hardSessions} time${hardSessions === 1 ? '' : 's'} in the week before that draw. Skeletal muscle contains both AST and ALT, and resistance training releases them — so in someone lifting seriously, a modest rise on a liver panel has a far more common explanation than anything hepatic. This is one of the most frequent false alarms in athletes, and it is why the panel is worth repeating rested rather than acted on cold.`,
        action:
          'Two things separate them. GGT is made in the liver and not in muscle, so a normal GGT alongside raised ALT and AST points at muscle. And repeating the panel after three or four days without training usually settles it on its own.',
        caveat:
          'Common does not mean certain — a genuinely raised liver enzyme can sit underneath a training effect, and that is a conversation for a clinician rather than for an app.',
        inputs: [
          { label: liver.displayName, value: `${liver.value} ${liver.unit}`, unit: null },
          { label: 'Hard sessions before draw', value: hardSessions, unit: null },
          { label: 'Drawn', value: liver.drawnOn, unit: null },
        ],
        confidence: 'well-established',
        tier: 2,
        findings: [],
      }),
    );
  }

  // --- 4. Everything the medication module already knows about ------------
  const active: Confounder[] = activeConfounders(meds, today);
  for (const c of active) {
    if (c.domain !== 'weight-trend') continue;
    // Creatine's water shift gets the richer dedicated insight above, with the
    // estimator-hold and the bioimpedance consequence attached. Emitting the
    // generic one as well would say the same thing twice and less well.
    if (c.id === 'creatine-water-retention') continue;
    out.push(
      draft({
        id: `confounder-${c.id}`,
        domain: 'confounder',
        severity: 'info',
        suppressesAlarm: true,
        headline: c.label,
        detail: c.message,
        action: confounderAction(c),
        caveat: confounderCaveat(c),
        inputs: [
          { label: 'Agent', value: c.agentId, unit: null },
          { label: 'Evidence', value: c.evidence, unit: null },
        ],
        confidence: c.evidence,
        tier: c.evidence === 'well-established' ? 1 : 2,
        findings: [],
      }),
    );
  }

  return out;
}

/**
 * What the app is doing about a confounder, phrased from its `action`.
 *
 * The mapping matters: `annotate-only` and `do-not-adjust` both mean *nothing
 * is subtracted from your trend*, and saying so explicitly is the difference
 * between a note the user trusts and a note they suspect is quietly moving
 * numbers behind them.
 */
function confounderAction(c: Confounder): string {
  switch (c.action) {
    case 'do-not-adjust':
      return 'Nothing is being subtracted from your trend for this. There is no honest number to use, so it is recorded as a candidate explanation and nothing more.';
    case 'annotate-only':
      return 'Nothing is being subtracted from your trend. This is recorded as a candidate explanation, and it only becomes anything more if you tell me it applies.';
    case 'widen-uncertainty':
      return 'Nothing is being subtracted. The confidence band around the affected numbers is widened instead, which is the honest way to represent knowing less.';
    case 'offer-trend-offset':
      return 'Confirm it and I will account for it in the trend. Until you do, it changes nothing.';
  }
}

/** The Tier 2 caveat for a confounder whose evidence is not settled. */
function confounderCaveat(c: Confounder): string | null {
  switch (c.evidence) {
    case 'uncertain':
      return 'Hold this loosely — it is a possibility rather than a finding, and it is offered so you have the candidate explanation rather than because it is the likely one.';
    case 'reasonable-inference':
      return 'The mechanism is well described; how much of it applies to any one person is not, so treat this as the shape of the effect rather than its size.';
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Rule: labs that are not confounded                                  */
/* ------------------------------------------------------------------ */

/**
 * Lab handling that is *not* a confounder.
 *
 * The only branch here is the Tier 3 one: a critical value gets an urgent
 * prompt with **no interpretation attached**, because a reassuring-sounding
 * explanation is the dangerous failure mode for exactly those results.
 * Everything else about a lab value belongs to `labs.ts#evaluateObservation`
 * and is rendered by the labs surface, not re-derived here.
 */
function labInsights(input: CoachInput): Draft[] {
  const labs = input.labs ?? [];
  const critical = labs.filter(
    (l) => l.interpretation === 'critical_high' || l.interpretation === 'critical_low',
  );
  if (critical.length === 0) return [];

  return [
    draft({
      id: 'labs-critical-value',
      domain: 'safety',
      severity: 'critical',
      headline: `${list(critical.map((l) => l.displayName))} came back at a level that needs a doctor promptly`,
      detail:
        'I am not going to interpret this one. Results this far out of range are the case where a plausible-sounding explanation from an app is actively dangerous, so the only thing worth saying is that it needs a person who can examine you.',
      action: 'Contact a doctor today. Bring the printed result with you.',
      caveat: null,
      inputs: critical.map((l) => ({ label: l.displayName, value: `${l.value} ${l.unit}`, unit: null })),
      confidence: 'well-established',
      tier: 3,
      findings: [
        mk(
          'warn',
          'COACH_CRITICAL_LAB_VALUE',
          'A critical lab value is present. Automated interpretation is suppressed by design.',
        ),
      ],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* Rule: readiness across the week                                     */
/* ------------------------------------------------------------------ */

function readinessInsights(input: CoachInput): Draft[] {
  const days = input.readiness ?? [];
  if (days.length === 0) return [];

  const suppressed = days.filter((d) => d.programmingSuppressed);
  if (suppressed.length > 0) {
    return [
      draft({
        id: 'readiness-programming-suppressed',
        domain: 'safety',
        severity: 'warning',
        headline: `Automated programming was off on ${suppressed.length} day${suppressed.length === 1 ? '' : 's'} this week`,
        detail:
          'Something on those days — illness, pain at rest, or a run of readings far enough below your own baseline to be worth a person looking at — put the engine outside its lane. It stopped programming rather than working around it.',
        action:
          'If it was a cold, this resolves itself. If it was pain, or if it keeps happening, that is a conversation for a qualified clinician — I cannot assess it and should not try.',
        caveat: null,
        inputs: [{ label: 'Days suppressed', value: suppressed.length, unit: 'days' }],
        confidence: 'well-established',
        tier: 3,
        findings: [],
      }),
    ];
  }

  const low = days.filter((d) => d.band === 'low' || d.band === 'poor').length;
  const mean = days.reduce((a, d) => a + d.score, 0) / days.length;

  if (low >= 3) {
    return [
      draft({
        id: 'readiness-run-of-low-days',
        domain: 'recovery',
        severity: 'suggestion',
        headline: `${low} of ${days.length} days came in below your usual range`,
        detail:
          'A single low day is noise and gets damped on purpose. A run of them across a week is the pattern worth reading, and the usual causes are ordinary: sleep debt, a heavy trainer block, life stress, or the start of something. Three trainer days plus hard intervals is a lot of week to recover from in a deficit.',
        action:
          'Take the deload rather than push through it — a trainer-only week, with the app\'s own lifting dropped, costs almost nothing and resets the run.',
        caveat: null,
        inputs: [
          { label: 'Low or poor days', value: low, unit: 'days' },
          { label: 'Mean readiness score', value: round(mean, 2), unit: null },
        ],
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [],
      }),
    ];
  }

  return [];
}

/* ------------------------------------------------------------------ */
/* Rule: goal conflicts, stated rather than resolved silently          */
/* ------------------------------------------------------------------ */

function goalConflictInsights(input: CoachInput): Draft[] {
  const tradeoffs = input.goals.tradeoffs ?? [];
  if (tradeoffs.length === 0) return [];

  const changed = tradeoffs.filter((t) => t.intent !== 'improve');
  if (changed.length === 0) return [];

  return [
    draft({
      id: 'goal-tradeoff-disclosure',
      domain: 'goal-conflict',
      severity: 'info',
      headline: 'What you asked for, and what I am actually programming',
      detail: changed
        .map((t) => `You said: "${t.statedAs}". What I am doing: ${t.intent}. Why: ${t.because}`)
        .join(' '),
      action:
        'If you would rather have it the other way round, that is a real choice and I will re-plan for it — it just costs the fat-loss timeline.',
      caveat: null,
      inputs: changed.map((t) => ({ label: t.id, value: t.intent, unit: null })),
      confidence: 'well-established',
      tier: 1,
      findings: [],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* Rule: adherence, framed without judgement                           */
/* ------------------------------------------------------------------ */

function adherenceInsights(input: CoachInput): Draft[] {
  const out: Draft[] = [];
  const intake = input.intake;
  const trend = input.trend;
  const t = input.training;

  const loggedDays = intake ? intake.days.filter((d) => d.kcal !== null).length : 0;
  const weighIns = trend?.weighInsLast14d ?? input.weighInsLast14d ?? 0;

  if (intake && loggedDays < COACH_LIMITS.MIN_LOGGED_DAYS_TO_ACT) {
    out.push(
      draft({
        id: 'adherence-sparse-logging',
        domain: 'adherence',
        severity: 'info',
        headline: `${loggedDays} day${loggedDays === 1 ? '' : 's'} of food logged this week`,
        detail:
          'This is not a scolding, and nothing here is counting consecutive days at you. It matters only because the expenditure estimate is fitted from logged intake against the weight trend, so with fewer than four days it holds rather than updates — which means your targets stay where they are whether or not that is right.',
        action: 'Four days gets the estimate moving again. Six or seven makes it materially tighter.',
        caveat: null,
        inputs: [
          { label: 'Days logged', value: loggedDays, unit: 'days' },
          { label: 'Days needed to update', value: COACH_LIMITS.MIN_LOGGED_DAYS_TO_ACT, unit: 'days' },
        ],
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  }

  if (weighIns > 0 && weighIns < 5) {
    out.push(
      draft({
        id: 'adherence-weigh-ins',
        domain: 'adherence',
        severity: 'info',
        headline: `${weighIns} weigh-in${weighIns === 1 ? '' : 's'} in the last fortnight`,
        detail:
          'The trend filter needs roughly five in a fortnight before the confidence interval on the rate becomes narrower than the decisions it would inform. Below that I can report a number but I cannot honestly act on it.',
        action: 'Same time each morning, after the bathroom, before food. Daily is ideal; every other day works.',
        caveat: null,
        inputs: [{ label: 'Weigh-ins, 14 days', value: weighIns, unit: null }],
        confidence: 'well-established',
        tier: 1,
        findings: [],
      }),
    );
  }

  if (t && t.trainerSessions > 0 && t.trainerSessionsConfirmed < t.trainerSessions) {
    const unconfirmed = t.trainerSessions - t.trainerSessionsConfirmed;
    out.push(
      draft({
        id: 'adherence-trainer-confirmations',
        domain: 'adherence',
        severity: 'suggestion',
        headline: `${unconfirmed} trainer session${unconfirmed === 1 ? '' : 's'} still unconfirmed`,
        detail:
          'An unreported trainer session still counts at full prior value — treating a missing report as zero volume would have me program *more* work exactly when I know least, which is the inversion the whole mechanism exists to prevent. But the estimate carries a wide upper bound until you confirm, and I budget against that bound rather than the mean.',
        action:
          'Confirm the sessions and the bound tightens. In practice that hands about three sets a week back across the crowded muscles rather than taking any away.',
        caveat: null,
        inputs: [
          { label: 'Trainer sessions', value: t.trainerSessions, unit: null },
          { label: 'Confirmed', value: t.trainerSessionsConfirmed, unit: null },
        ],
        confidence: 'reasonable-inference',
        tier: 1,
        findings: [],
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Data gaps — the honest empty state                                  */
/* ------------------------------------------------------------------ */

/**
 * What the engine cannot yet tell you, stated plainly.
 *
 * This is the counterpart to the insight list and it is not decoration. With
 * one week of sparse data most of the interesting questions are unanswerable,
 * and an app that fills that space with something anyway is training the user
 * to discount everything else it says.
 */
export function dataGaps(input: CoachInput): string[] {
  const gaps: string[] = [];

  if (!input.trend) {
    gaps.push(
      'No weight trend yet. Rate of loss, the projected timeline and the expenditure estimate all sit downstream of it, so none of those exist until there are weigh-ins to smooth.',
    );
  } else if (!input.trend.rateIsActionable) {
    gaps.push(
      'The rate of change has a confidence interval wider than the decisions it would drive. It narrows with weigh-ins, not with time.',
    );
  }

  if (!input.expenditure) {
    gaps.push(
      'No expenditure estimate. It needs about a week of logged intake alongside the weight trend before it is anything other than the population prior.',
    );
  }

  if (!input.intake) {
    gaps.push('No food logged this week, so nothing can be said about protein, fibre or the energy target.');
  }

  if (!input.micronutrients) {
    gaps.push(
      'Micronutrient adequacy needs food logs with nutrient data behind them. Without it I can talk about calories and protein but not about what is missing.',
    );
  }

  if (!input.training || input.training.volume.length === 0) {
    gaps.push('No training volume recorded, so the weekly set budget against your landmarks is empty.');
  }

  if (!input.conditioning) {
    gaps.push('No conditioning logged, so nothing can be said about the VO2max dose.');
  }

  if (!input.readiness || input.readiness.length === 0) {
    gaps.push(
      'No readiness check-ins. These need no wearable and no baseline — two taps a morning is enough to make the week readable.',
    );
  }

  if ((input.labs ?? []).length === 0) {
    gaps.push('No labs on file. Several of the more useful things I could say — iron status above all — need blood, not logs.');
  }

  return gaps;
}

/* ------------------------------------------------------------------ */
/* The entry point                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the week's review.
 *
 * Order of operations matters and is deliberate:
 *
 * 1. Validate the profile and fold in whatever findings the caller gathered
 *    elsewhere. This is what decides whether the numeric-target gate is closed,
 *    and that decision has to be made *before* any insight is generated, not
 *    filtered afterwards.
 * 2. Run every rule. Rules produce drafts; they never decide what is shown.
 * 3. Pass every draft through {@link guardInsight}. Survivors get scored,
 *    casualties get recorded in `suppressed` with the finding that killed them.
 * 4. Rank, and derive the headline from the top insight rather than writing a
 *    second summary that can disagree with the list underneath it.
 *
 * @param input one week of everything
 * @returns the ranked, guardrailed review
 *
 * @example
 * const review = reviewWeek({
 *   weekEndingDate: '2026-07-26',
 *   profile: { sex: 'male', ageYears: 38, heightCm: 180, bodyweightKg: 85, bodyFatPct: 21, goal: 'cut' },
 *   goals: { targetRatePctBwPerWeek: -0.65, targetBodyFatPct: 14 },
 *   trend: summarizeTrend(series),
 * });
 * review.insights[0].headline;
 */
export function reviewWeek(input: CoachInput): CoachReview {
  const profileFindings = validateProfile(input.profile);
  const external = input.externalFindings ?? [];
  const gateFindings = [...profileFindings, ...external].filter((f) => !f.ok);

  const numericTargetsSuppressed = gateFindings.some(
    (f) => f.level === 'block' && NUMERIC_GATE_CODES.includes(f.code),
  );

  const ctx: GuardContext = { numericTargetsSuppressed };

  const drafts: Draft[] = [
    ...labInsights(input),
    ...readinessInsights(input),
    ...adequacyInsights(input),
    ...confounderInsights(input),
    ...trajectoryInsights(input),
    ...expenditureInsights(input),
    ...trainingInsights(input),
    ...conditioningInsights(input),
    ...micronutrientInsights(input),
    ...goalConflictInsights(input),
    ...adherenceInsights(input),
  ];

  const insights: CoachInsight[] = [];
  const suppressed: SuppressedInsight[] = [];
  for (const d of drafts) {
    const result = guardInsight(d, ctx);
    if (result.ok) insights.push(result.insight);
    else suppressed.push({ id: d.id, domain: d.domain, blockedBy: result.blockedBy });
  }

  const ranked = rankInsights(insights);
  const allFindings = [
    ...gateFindings,
    ...ranked.flatMap((i) => i.findings),
  ];

  return {
    weekEndingDate: input.weekEndingDate,
    headline: buildHeadline(ranked, numericTargetsSuppressed),
    insights: ranked,
    suppressed,
    dataGaps: dataGaps(input),
    findings: actionable(allFindings),
    referral: professionalReferralPrompt(allFindings),
    numericTargetsSuppressed,
    disclaimer: DISCLAIMERS.short,
  };
}

/**
 * The one line the screen leads with.
 *
 * Derived from the top-ranked insight rather than written separately, so the
 * summary and the list cannot disagree — a header that says "good week" above a
 * warning is worse than no header.
 */
function buildHeadline(ranked: readonly CoachInsight[], gated: boolean): string {
  if (gated) {
    return 'Calorie and weight numbers are turned off. Everything else on this screen still works.';
  }
  if (ranked.length === 0) {
    return 'Not enough logged this week to say anything useful. What is missing is listed below.';
  }
  const top = ranked[0];
  const alarmsStoodDown = ranked.filter((i) => i.suppressesAlarm).length;
  if (alarmsStoodDown > 0 && top.suppressesAlarm) {
    return `${top.headline}. ${alarmsStoodDown === 1 ? 'One thing' : `${alarmsStoodDown} things`} that look like a problem this week probably are not — the reasoning is below.`;
  }
  return top.headline;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Signed rate as a percentage, e.g. `-0.65%/wk`. Unit-system neutral. */
function fmtRate(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%/week`;
}

/** "a", "a and b", "a, b and c". */
function list(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The weakest confidence in a set — a recommendation is only as good as that. */
function lowestConfidence(values: readonly Confidence[]): Confidence {
  if (values.includes('uncertain')) return 'uncertain';
  if (values.includes('reasonable-inference')) return 'reasonable-inference';
  return 'well-established';
}

/** True when this review contains anything that stands an alarm down. */
export function hasSuppressedAlarms(review: CoachReview): boolean {
  return review.insights.some((i) => i.suppressesAlarm);
}
