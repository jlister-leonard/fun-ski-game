/**
 * @file Training guardrails for the logger (`training-methodology.md` §8.5).
 *
 * §8.5 is normative — those rules are requirements, not suggestions — and it
 * specifies the implementation contract too: *return the existing `Finding`
 * type from `algorithms/guardrails.ts`, do not invent a parallel training-only
 * guardrail type.* So this module imports `Finding` and produces nothing else.
 *
 * The division of labour the nutrition module established, applied here: **the
 * generator proposes and the guardrail disposes.** {@link suggestNextSet}
 * proposes a number; the findings it returns can trim it; a `block` finding
 * means the suggestion is not shown as prescribed at all.
 *
 * One thing this file deliberately does *not* do: block the user from logging
 * something. A log is a record of what happened. If someone lifted 405 for a
 * triple the app's job is to write it down, not to argue. Findings on a logged
 * set are informational only — the blocks are reserved for things the app
 * itself would otherwise *prescribe*.
 */

import type { Finding } from '../algorithms/guardrails';
import type { LoggedSet, RepUnit } from './types';

/** Bounds on what a readiness signal may do to a session (§8.5 rule 1). */
export const ADJUSTMENT_LIMITS = {
  /** Volume adjustment, as a fraction. Never below −50%, never above +10%. */
  volume: { min: -0.5, max: 0.1 },
  /** RIR adjustment. Negative means "go closer to failure". */
  rir: { min: -1, max: 2 },
  /**
   * Load adjustment, as a fraction. **The maximum is zero**: the engine may
   * never *increase* prescribed load on the basis of a readiness score. A good
   * night's sleep is not evidence that you got stronger.
   */
  load: { min: -0.2, max: 0 },
  /** Never prescribe below this RIR when readiness is low or poor. */
  minRirWhenSuppressed: 3,
  /** After this many consecutive readiness-driven cuts, stop adjusting (rule 2). */
  maxConsecutiveReductions: 3,
} as const;

/** Copy required verbatim by §8.5 rule 4. Pain is not soreness. */
export const PAIN_COPY =
  "Pain isn't soreness. If it's sharp, radiating, swelling, or lasts more than " +
  'a couple of weeks, see a qualified clinician — we can’t assess that.';

/** Copy for the trainer-volume conversation (§3.7). Never blames the trainer. */
export const TRAINER_MODEL_CAVEAT =
  "My model doesn't see your sessions and could easily be wrong — your trainer does.";

function finding(level: Finding['level'], code: string, message: string): Finding {
  return { ok: false, level, code, message };
}

/**
 * Clamp a proposed adjustment into the §8.5 bounds.
 *
 * @param kind which axis is being adjusted
 * @param proposed the proposed fractional or absolute change
 * @returns the clamped value
 */
export function clampAdjustment(kind: 'volume' | 'rir' | 'load', proposed: number): number {
  const limits = ADJUSTMENT_LIMITS[kind];
  return Math.min(limits.max, Math.max(limits.min, proposed));
}

/**
 * Sanity findings for a set the user just logged.
 *
 * Informational only — see the file header. The point is to catch a fat-finger
 * `1850` where `185` was meant, at the moment it is still cheap to fix, without
 * ever telling someone their own training was wrong.
 *
 * @param input the set as entered
 * @returns findings, empty when nothing looks off
 */
export function checkLoggedSet(input: {
  weightKg: number;
  unitValue: number;
  repUnit: RepUnit;
  effort: number | null;
  bodyweightKg?: number | null;
}): Finding[] {
  const out: Finding[] = [];

  if (input.weightKg < 0) {
    out.push(finding('warn', 'set.negative_load', 'A load below zero is not a load.'));
  }
  if (input.bodyweightKg && input.weightKg > input.bodyweightKg * 4) {
    out.push(
      finding(
        'info',
        'set.load_implausible',
        'That is over four times your bodyweight — worth a second look before you move on.',
      ),
    );
  }
  if (input.unitValue <= 0) {
    out.push(finding('warn', 'set.empty_count', 'This set has no work recorded against it.'));
  }
  if (input.repUnit === 'reps' && input.unitValue > 60) {
    out.push(
      finding(
        'info',
        'set.reps_implausible',
        'Over 60 reps in one set. If you meant seconds, this movement is logged in reps.',
      ),
    );
  }
  if (input.effort !== null && (input.effort < 0 || input.effort > 10)) {
    out.push(finding('warn', 'set.effort_range', 'Effort is recorded on a 0–10 scale.'));
  }
  return out;
}

/**
 * Findings raised when the user flags pain (§8.5 rule 4).
 *
 * Three obligations, all of them here: never increase load or volume, offer a
 * substitution *for discomfort only*, and show the clinician copy. No
 * substitution is ever framed as a fix — the library's `regressions` are
 * alternatives that hurt less, not treatments.
 *
 * @param options.hasSubstitutes whether the movement has easier variants to offer
 * @returns the findings to display
 */
export function painFindings(options: { hasSubstitutes: boolean }): Finding[] {
  const out: Finding[] = [
    finding('warn', 'training.pain_flagged', PAIN_COPY),
    finding(
      'block',
      'training.no_progression_on_pain',
      "While pain is flagged the app won't suggest more load or more sets.",
    ),
  ];
  if (options.hasSubstitutes) {
    out.push(
      finding(
        'info',
        'training.substitution_offered',
        'There are gentler variants of this movement. They are alternatives that may ' +
          'be more comfortable — not a treatment for whatever is causing the pain.',
      ),
    );
  }
  return out;
}

/** A proposed next set, and the reasoning behind it. */
export interface SetSuggestion {
  weightKg: number;
  unitValue: number;
  /** Target RIR, or `null` when effort is not being prescribed. */
  targetRir: number | null;
  /** Plain-language reason. §8.5 rule 10: always show what drove the number. */
  reason: string;
  /** Guardrail output. A `block` finding means: do not present this as prescribed. */
  findings: Finding[];
}

/** Readiness bands, from §8.4. */
export type ReadinessBand = 'high' | 'normal' | 'low' | 'poor';

/**
 * Propose the next set for a movement, from what happened last time.
 *
 * Double progression, §3.3: hit the top of the rep range at or below the target
 * RIR and the load goes up; otherwise add a rep at the same load; if reps
 * regressed, repeat.
 *
 * **What this function will never do**, per §8.5:
 *
 * - Increase load because readiness is good. `high` gets at most an extra set
 *   on the last exercise; it never touches the bar.
 * - Prescribe below 3 RIR when readiness is `low` or `poor`.
 * - Suggest anything at all while pain is flagged.
 *
 * @param previous the last performed set of this movement, or `null`
 * @param options.repRange the exercise's `default_rep_range`
 * @param options.upperBody smaller load jumps than lower body
 * @param options.readiness the day's band, when known
 * @param options.painFlag whether the user has flagged pain on this movement
 * @returns the suggestion and its findings
 */
export function suggestNextSet(
  previous: Pick<LoggedSet, 'weightKg' | 'unitValue' | 'repUnit' | 'effort' | 'effortKind'> | null,
  options: {
    repRange: readonly [number, number];
    upperBody?: boolean;
    readiness?: ReadinessBand;
    painFlag?: boolean;
  },
): SetSuggestion | null {
  if (previous === null) return null;

  const [repMin, repMax] = options.repRange;
  const findings: Finding[] = [];

  if (options.painFlag) {
    return {
      weightKg: previous.weightKg,
      unitValue: previous.unitValue,
      targetRir: null,
      reason: 'Pain is flagged, so this repeats your last set rather than progressing it.',
      findings: painFindings({ hasSubstitutes: false }),
    };
  }

  const rir = previous.effortKind === 'rir' ? previous.effort : null;
  let weightKg = previous.weightKg;
  let unitValue = previous.unitValue;
  let reason: string;

  const atTopOfRange = previous.repUnit === 'reps' && previous.unitValue >= repMax;
  if (atTopOfRange && rir !== null && rir <= 2 && previous.weightKg > 0) {
    // Smallest sensible jump: 2.5% upper body, 5% lower — §3.3.
    const step = options.upperBody ? 0.025 : 0.05;
    weightKg = previous.weightKg * (1 + step);
    unitValue = repMin;
    reason = `You hit ${previous.unitValue} at ${rir} RIR last time, so the load goes up and the reps reset.`;
  } else if (previous.repUnit === 'reps' && previous.unitValue < repMax) {
    unitValue = previous.unitValue + 1;
    reason = `Same load, one more rep — you were at ${previous.unitValue} of a ${repMin}–${repMax} range.`;
  } else {
    reason = 'Repeat of your last set.';
  }

  // ---- readiness, bounded and one-directional ----------------------------
  let targetRir = rir;
  if (options.readiness === 'low' || options.readiness === 'poor') {
    const loadCut = clampAdjustment('load', options.readiness === 'poor' ? -0.1 : -0.03);
    weightKg = weightKg * (1 + loadCut);
    const rirBump = clampAdjustment('rir', options.readiness === 'poor' ? 2 : 1);
    targetRir = Math.max(
      ADJUSTMENT_LIMITS.minRirWhenSuppressed,
      (targetRir ?? 2) + rirBump,
    );
    reason +=
      options.readiness === 'poor'
        ? " Your recovery metrics are below your usual range, so today is a technique-and-blood-flow day: load is trimmed and there's more left in the tank."
        : ' Recovery looks a bit down, so the load is trimmed slightly and a rep is left in the tank.';
    findings.push(
      finding(
        'info',
        'training.readiness_reduction',
        `Adjusted down because recovery is ${options.readiness === 'poor' ? 'well ' : ''}below your usual range. You can override this.`,
      ),
    );
  } else if (options.readiness === 'high') {
    // Deliberately no load increase. §8.5 rule 1.
    findings.push(
      finding(
        'info',
        'training.readiness_no_increase',
        'Recovery looks good. That is a green light on the plan, not a reason to add weight — ' +
          'readiness never raises a prescribed load.',
      ),
    );
  }

  return { weightKg, unitValue, targetRir, reason, findings };
}

/**
 * Findings about the week's volume, including the trainer conversation (§3.7).
 *
 * The escalation is deliberately slow: a single week over the ceiling is far
 * more likely to be an over-estimate than a real overreach, so it only ever
 * produces an `info` asking for a confirmation to sharpen the estimate. A
 * `warn` needs two consecutive weeks *and* two confirmations behind it.
 *
 * @param options.muscleLabel the muscle in question, already humanised
 * @param options.unclamped the unclamped budget — negative means over
 * @param options.consecutiveWeeksOver how long it has been negative
 * @param options.confirmations how many trainer sessions have been confirmed
 * @returns findings for the weekly review
 */
export function volumeFindings(options: {
  muscleLabel: string;
  unclamped: number;
  consecutiveWeeksOver: number;
  confirmations: number;
}): Finding[] {
  const { muscleLabel, unclamped, consecutiveWeeksOver, confirmations } = options;
  if (unclamped >= 1) return [];

  if (unclamped >= 0) {
    return [
      finding(
        'info',
        'volume.covered_by_trainer',
        `Your trainer's already covering ${muscleLabel} — I've left it alone this week.`,
      ),
    ];
  }

  if (consecutiveWeeksOver >= 2 && confirmations >= 2) {
    return [
      finding(
        'warn',
        'volume.sustained_overreach',
        `On my estimate, ${muscleLabel} is over its weekly ceiling two weeks running. ` +
          `${TRAINER_MODEL_CAVEAT} Three options, all reasonable: ask your trainer about rotating ` +
          'emphasis across trainer days, accept it and let me pull everything else back further, ' +
          'or reduce trainer frequency.',
      ),
    ];
  }

  return [
    finding(
      'info',
      'volume.over_ceiling_unconfirmed',
      `My estimate has ${muscleLabel} over its ceiling this week. ${TRAINER_MODEL_CAVEAT} ` +
        'Confirming your trainer sessions sharpens this — right now it is mostly a guess.',
    ),
  ];
}
