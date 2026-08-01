'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { Finding } from '@/lib/algorithms';
import { DIARY_COPY } from './copy';
import { Note } from './atoms';

/**
 * @file Sustained under-eating, and the one re-offer it triggers.
 *
 * ## The copy is not written here on purpose
 *
 * Every string in the notice comes from `detectSustainedUnderEating()`'s
 * findings. That copy was written against the spec and is deliberately flat:
 * it offers under-logging as a legitimate explanation *first*, argues from the
 * user's own goals rather than from concern, and does not escalate in tone.
 * Rewriting it in the UI layer is exactly how that care gets lost, so the UI
 * renders `finding.message` verbatim.
 *
 * ## What this notice must never do
 *
 * Lower the target. `guardrails.ts` encodes the rule and `useTargets.ts`
 * restates it; this component is the third place someone might be tempted to
 * break it, so: a run of low days is at least as likely to be under-logging as
 * under-eating, and prescribing less food is the wrong answer to both.
 *
 * ## Requirement 9's trigger
 *
 * The spec names this as the moment to surface the hide-calories setting once
 * more — "the app should surface it once more if under-eating findings
 * appear". Once. Dismissing it is permanent. A prompt that reappears gets
 * learned as noise, and repeatedly telling someone their eating looks
 * concerning is itself a harm, particularly for a user whose restriction is
 * sensory rather than weight-motivated.
 */

export interface UnderEatingNoticeProps {
  findings: readonly Finding[];
  /** True when the one-time safety re-offer has not yet been dismissed. */
  showSafetyReOffer: boolean;
  onOpenSettings: () => void;
  onDismissReOffer: () => void | Promise<void>;
}

export function UnderEatingNotice({
  findings,
  showSafetyReOffer,
  onOpenSettings,
  onDismissReOffer,
}: UnderEatingNoticeProps) {
  const actionable = findings.filter((f) => !f.ok);
  if (actionable.length === 0) return null;

  return (
    <Card>
      <CardHeader title={DIARY_COPY.underEatingHeading} />
      <div className="mt-2 space-y-2">
        {actionable.map((finding) => (
          <Note key={finding.code}>{finding.message}</Note>
        ))}
      </div>

      {showSafetyReOffer && (
        <div className="mt-4 rounded-[var(--radius-md)] bg-surface-2 p-3">
          <div className="text-sm font-medium text-ink">{DIARY_COPY.reOfferHeading}</div>
          <Note className="mt-1 text-ink-2">{DIARY_COPY.reOfferBody}</Note>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={onOpenSettings}>
              {DIARY_COPY.reOfferOpen}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void onDismissReOffer()}>
              {DIARY_COPY.reOfferDismiss}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
