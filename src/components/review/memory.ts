/**
 * @file Durable, encrypted memory for the pure weekly coach.
 *
 * The rules engine stays deterministic and side-effect free. This adapter is
 * the only place that translates its output into vault records or interprets
 * those records as history.
 */

import type { CoachInsight, CoachReview } from '@/lib/algorithms';
import type { InsightRepo, NewRecord } from '@/lib/db/repos';
import type { Insight, InsightType } from '@/lib/db/types';

const TYPE_BY_DOMAIN: Record<CoachInsight['domain'], InsightType> = {
  safety: 'safety',
  labs: 'safety',
  adequacy: 'nutrition',
  nutrition: 'nutrition',
  micronutrients: 'nutrition',
  training: 'training',
  conditioning: 'training',
  recovery: 'recovery',
  confounder: 'body',
  'body-composition': 'body',
  adherence: 'adherence',
  'goal-conflict': 'adherence',
};

/** The history attached to one currently generated rule output. */
export interface InsightMemory {
  /** This review's stored row, once persistence has completed. */
  current: Insight | null;
  /** Earlier review dates on which this exact stable rule was generated. */
  priorOccurrences: number;
  /** Earlier occurrences the user explicitly marked acted-on. */
  priorActedOn: number;
}

/** Convert a guardrailed coach output into the encrypted vault schema. */
export function toStoredInsight(
  insight: CoachInsight,
  dateKey: string,
): NewRecord<Insight> {
  const evidence: Insight['evidence'] = {
    action: insight.action,
    caveat: insight.caveat,
    confidence: insight.confidence,
    tier: insight.tier,
    suppressesAlarm: insight.suppressesAlarm,
  };
  insight.inputs.forEach((input, index) => {
    evidence[`input.${index}.label`] = input.label;
    evidence[`input.${index}.value`] = input.value;
    evidence[`input.${index}.unit`] = input.unit;
  });

  return {
    type: TYPE_BY_DOMAIN[insight.domain],
    dateKey,
    severity: insight.severity,
    title: insight.headline,
    body: insight.detail,
    ruleId: insight.id,
    score: insight.score,
    guardrailPassed: true,
    evidence,
    dismissedAt: null,
    acknowledgedAt: null,
  };
}

/** Persist exactly the outputs the guardrailed review returned. */
export async function persistCoachInsights(
  repo: Pick<InsightRepo, 'upsertRuleOutput'>,
  dateKey: string,
  generated: readonly CoachInsight[],
): Promise<Insight[]> {
  return Promise.all(
    generated.map((insight) =>
      repo.upsertRuleOutput(insight.id, dateKey, toStoredInsight(insight, dateKey)),
    ),
  );
}

/**
 * Read repeat state strictly from encrypted records dated before this review.
 * A same-day regeneration is the current occurrence, never invented history.
 */
export function memoryForRule(
  ruleId: string,
  dateKey: string,
  history: readonly Insight[],
): InsightMemory {
  const matching = history.filter((row) => row.ruleId === ruleId && row.guardrailPassed);
  const prior = matching.filter((row) => row.dateKey < dateKey);
  return {
    current: matching.find((row) => row.dateKey === dateKey) ?? null,
    priorOccurrences: new Set(prior.map((row) => row.dateKey)).size,
    priorActedOn: new Set(
      prior.filter((row) => row.acknowledgedAt !== null).map((row) => row.dateKey),
    ).size,
  };
}

/** Keep the engine's rank, removing only this review's explicit dismissals. */
export function visibleCoachInsights(
  generated: readonly CoachInsight[],
  memory: ReadonlyMap<string, InsightMemory>,
): CoachInsight[] {
  return generated.filter((insight) => !memory.get(insight.id)?.current?.dismissedAt);
}

/** Keep the short version aligned with the highest-ranked visible card. */
export function visibleReviewHeadline(
  review: CoachReview,
  visible: readonly CoachInsight[],
): string {
  if (review.numericTargetsSuppressed) return review.headline;
  if (visible.length === 0) {
    return 'You have reviewed every current insight. Dismissed items remain in your encrypted history.';
  }
  return visible[0].id === review.insights[0]?.id ? review.headline : visible[0].headline;
}
