'use client';

/**
 * @file One coaching insight, with its working.
 *
 * The card renders, in order: what changed, why, what to do, the specific
 * caveat when there is one, the inputs, and the guardrail findings. That order
 * is the `advice-policy.md` Tier 1 contract read top to bottom, and it is also
 * the order a person actually wants — the recommendation before the evidence,
 * the evidence before the disclaimer.
 *
 * Everything a user reads here comes from `@/lib/algorithms/coach`. Nothing is
 * paraphrased in this file. That is not a style preference: the copy in the
 * engine is what `coach.test.ts` pins, and a component that reworded it would
 * pass every one of those tests while shipping different sentences.
 *
 * ## The evidence is collapsed, not hidden
 *
 * Six evidence rows on a phone push the next insight off the screen, and the
 * ranked list is the product. So the inputs sit behind a `<details>` that
 * carries its own label — the *number* of inputs is visible without opening it,
 * so "show me the working" is a tap rather than a discovery.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import type { CoachInsight } from '@/lib/algorithms';
import type { UnitSystem } from '@/lib/units';
import type { InsightMemory } from './memory';
import {
  ConfidenceTag,
  EvidenceList,
  Eyebrow,
  FindingNote,
  RichText,
  SEVERITY_STYLE,
  SeverityTag,
  TierTag,
} from './atoms';

const DOMAIN_LABEL: Record<CoachInsight['domain'], string> = {
  safety: 'Safety',
  adequacy: 'Getting enough',
  confounder: 'Probably not what it looks like',
  'body-composition': 'Body composition',
  nutrition: 'Nutrition',
  training: 'Training volume',
  conditioning: 'Conditioning',
  micronutrients: 'Micronutrients',
  labs: 'Labs',
  'goal-conflict': 'Your goals',
  recovery: 'Recovery',
  adherence: 'What was logged',
};

export interface InsightCardProps {
  insight: CoachInsight;
  system: UnitSystem;
  className?: string;
  memory?: InsightMemory;
  onActedOn?: () => Promise<void>;
  onDismiss?: () => Promise<void>;
}

export function InsightCard({
  insight,
  system,
  className,
  memory,
  onActedOn,
  onDismiss,
}: InsightCardProps) {
  const findings = insight.findings.filter((f) => !f.ok && f.message.length > 0);
  const [saving, setSaving] = useState<'acted' | 'dismissed' | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  async function save(kind: 'acted' | 'dismissed', action?: () => Promise<void>) {
    if (!action) return;
    setSaving(kind);
    setSaveFailed(false);
    try {
      await action();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card className={cn(SEVERITY_STYLE[insight.severity], className)}>
      <div className="flex items-start justify-between gap-3">
        <Eyebrow>{DOMAIN_LABEL[insight.domain]}</Eyebrow>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <SeverityTag severity={insight.severity} />
          <TierTag tier={insight.tier} />
        </div>
      </div>

      <h2 className="text-base font-semibold text-ink mt-2 leading-snug">{insight.headline}</h2>

      <RichText text={insight.detail} className="mt-2" />

      {insight.action && (
        <div className="mt-3 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2.5">
          <Eyebrow>What I&rsquo;d do</Eyebrow>
          <RichText text={insight.action} className="mt-1 text-ink" />
        </div>
      )}

      {insight.caveat && (
        <p className="mt-3 text-sm text-ink-2 leading-relaxed border-l-2 border-line pl-3">
          {insight.caveat}
        </p>
      )}

      {insight.inputs.length > 0 && (
        <details className="mt-3 group">
          <summary className="text-sm text-ink-2 cursor-pointer list-none select-none marker:hidden">
            <span className="underline decoration-line underline-offset-4">
              What this is based on
            </span>
            <span className="text-ink-3"> · {insight.inputs.length}</span>
          </summary>
          <EvidenceList inputs={insight.inputs} system={system} />
        </details>
      )}

      {findings.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {findings.map((f, i) => (
            <FindingNote key={`${f.code}-${i}`} finding={f} />
          ))}
        </div>
      )}

      {memory && memory.priorOccurrences > 0 && (
        <p className="mt-3 text-xs text-ink-2">
          This pattern appeared in {memory.priorOccurrences}{' '}
          {memory.priorOccurrences === 1 ? 'earlier review' : 'earlier reviews'}
          {memory.priorActedOn > 0
            ? ` · marked acted on ${memory.priorActedOn} ${memory.priorActedOn === 1 ? 'time' : 'times'}`
            : ''}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ConfidenceTag confidence={insight.confidence} />
        {memory?.current?.acknowledgedAt ? (
          <span className="text-xs text-accent">Marked acted on</span>
        ) : insight.action && onActedOn ? (
          <Button
            type="button"
            size="sm"
            variant="quiet"
            loading={saving === 'acted'}
            onClick={() => void save('acted', onActedOn)}
          >
            Mark acted on
          </Button>
        ) : null}
        {onDismiss && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={saving === 'dismissed'}
            onClick={() => void save('dismissed', onDismiss)}
          >
            Not relevant
          </Button>
        )}
      </div>
      {saveFailed && (
        <p role="alert" className="mt-2 text-xs text-danger">
          That choice could not be saved. Your insight is unchanged.
        </p>
      )}
    </Card>
  );
}
