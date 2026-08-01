'use client';

/**
 * @file What the review cannot yet tell you.
 *
 * This is not an empty state that appears when there is nothing else — it sits
 * under the insights in every state, including a full week. `advice-policy.md`
 * asks the app to be honest about confidence, and the most honest thing a
 * coaching surface can do is name the questions it has not got the data to
 * answer. An app that quietly answers only the questions it can, and never says
 * which those are, reads as more complete than it is.
 *
 * The strings come from `dataGaps()` in the rules engine, so the screen and the
 * engine cannot drift about what is missing.
 */

import { Card } from '@/components/ui/Card';
import { Eyebrow } from './atoms';

export interface DataGapsProps {
  gaps: readonly string[];
}

export function DataGaps({ gaps }: DataGapsProps) {
  if (gaps.length === 0) return null;
  return (
    <Card>
      <Eyebrow>What I can&rsquo;t tell you yet</Eyebrow>
      <ul className="mt-2.5 flex flex-col gap-2.5">
        {gaps.map((gap, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-ink-3" aria-hidden />
            <span className="text-sm text-ink-2 leading-relaxed">{gap}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
