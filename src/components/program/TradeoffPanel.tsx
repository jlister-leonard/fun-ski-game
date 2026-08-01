'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import type { Finding } from '@/lib/algorithms/guardrails';
import { GOAL_CONFLICTS, type GoalId } from '@/lib/training/program';

/**
 * What the block will and will not do, said out loud before it starts.
 *
 * This is a product requirement rather than a nicety (`athlete-profile.md`
 * §3.3): every automated tradeoff must produce a user-visible statement of
 * **what was asked, what was done instead, why, and what it costs.** No silent
 * downgrades.
 *
 * The specific thing this panel refuses to do is promise all four goals at full
 * speed. Fat loss and VO2max are compatible and help each other. Fat loss and
 * hypertrophy are not, at this rate — so the panel says so, in the same place
 * it shows the plan, rather than burying it.
 */
export function GoalConflicts({ goals }: { goals: readonly GoalId[] }) {
  const [open, setOpen] = useState(false);
  const selected = new Set(goals);
  const conflicts = GOAL_CONFLICTS.filter((conflict) => {
    if (conflict.pair.startsWith('Fat loss + VO2max')) return selected.has('fat_loss') && selected.has('vo2max');
    if (conflict.pair.startsWith('Fat loss + joint')) return selected.has('fat_loss') && selected.has('joint_integrity');
    if (conflict.pair.startsWith('Fat loss + strength')) return selected.has('fat_loss') && selected.has('strength');
    if (conflict.pair.startsWith('Fat loss + hypertrophy')) return selected.has('fat_loss') && selected.has('hypertrophy');
    if (conflict.pair.startsWith('VO2max + strength')) return selected.has('vo2max') && selected.has('strength');
    return false;
  });
  if (conflicts.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="What this block will and won't do"
        subtitle={`${goals.length} selected goals; these are the interactions that matter`}
        accessory={
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Less' : 'More'}
          </Button>
        }
      />

      <p className="mt-2 text-sm text-ink-2">
        The planner ranks the goals you selected during onboarding. Compatible goals can
        share the same block; competing goals produce an explicit tradeoff instead of a
        silent promise that everything can improve at once.
      </p>

      {open && (
        <ul className="mt-3 divide-y divide-[var(--c-border)]">
          {conflicts.map((conflict) => (
            <li key={conflict.pair} className="py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-ink">{conflict.pair}</span>
                <Verdict compatible={conflict.compatible} />
              </div>
              <p className="mt-1 text-xs leading-relaxed text-ink-2">{conflict.why}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Verdict({ compatible }: { compatible: 'yes' | 'partly' | 'no' }) {
  const label = compatible === 'yes' ? 'Works' : compatible === 'partly' ? 'Partly' : "Doesn't";
  return (
    <span
      className={cn(
        'shrink-0 rounded-[var(--radius-full)] px-2 py-0.5 text-[11px]',
        compatible === 'no'
          ? 'bg-warn-quiet text-warn'
          : compatible === 'partly'
            ? 'bg-surface-2 text-ink-2'
            : 'bg-accent-quiet text-accent',
      )}
    >
      {label}
    </span>
  );
}

export interface FindingListProps {
  findings: readonly Finding[];
  title?: string;
  subtitle?: string;
}

/**
 * The plan's findings, in severity order.
 *
 * `block` first because a block means the plan is not shown as prescribed;
 * `warn` next; `info` last. Every one of them is a sentence the engine owes the
 * user — a tradeoff it made, a muscle it left alone, an indicator it stopped
 * tracking — and dismissing one is itself logged (methodology §8.5 rule 8).
 */
export function FindingList({
  findings,
  title = 'Why the plan looks like this',
  subtitle,
}: FindingListProps) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const order: Record<Finding['level'], number> = { block: 0, warn: 1, info: 2 };
  const visible = [...findings]
    .filter((f) => !dismissed.has(f.code))
    .sort((a, b) => order[a.level] - order[b.level]);

  if (visible.length === 0) return null;

  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <ul className="mt-2 divide-y divide-[var(--c-border)]">
        {visible.map((finding) => (
          <li key={finding.code} className="flex items-start gap-3 py-3">
            <span
              className={cn(
                'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                finding.level === 'block'
                  ? 'bg-danger'
                  : finding.level === 'warn'
                    ? 'bg-warn'
                    : 'bg-accent',
              )}
              aria-hidden
            />
            <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink-2">
              {finding.message}
            </p>
            {finding.level === 'info' && (
              <button
                type="button"
                className="shrink-0 text-xs text-ink-3 tap"
                onClick={() => setDismissed((prev) => new Set(prev).add(finding.code))}
                aria-label="Dismiss"
              >
                Got it
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
        None of this is medical advice. If something hurts — sharp, radiating, swelling, or
        lasting more than a couple of weeks — that is a question for a qualified clinician,
        not for me.
      </p>
    </Card>
  );
}
