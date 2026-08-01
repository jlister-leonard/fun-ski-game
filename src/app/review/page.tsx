'use client';

/**
 * The weekly review — the coaching moment.
 *
 * Every other screen in this app answers "what happened". This one answers
 * "what would you do differently", which is the only question that makes the
 * difference between a tracker and a coach. Nothing here is a new calculation:
 * the ranked insights come from `reviewWeek` in `@/lib/algorithms/coach`, the
 * inputs come from the vault through `useReview`, and this file is wiring.
 *
 * ## Three things this screen deliberately does not do
 *
 * **It does not lead with a score.** There is no week grade, no percentage
 * complete and no streak. The lead is the top-ranked insight's own headline, so
 * the summary and the list can never disagree — a cheerful header above a
 * warning is worse than no header.
 *
 * **It does not hide what it cannot say.** `DataGaps` renders in every state,
 * not just the empty one. With a week of sparse data most of the interesting
 * questions are genuinely unanswerable, and filling that space anyway is how an
 * app teaches a user to discount everything else it says.
 *
 * **It does not show insights the guardrails blocked.** `reviewWeek` has
 * already dropped those and recorded why. If the eating-disorder rules have
 * closed the numeric-target gate, every calorie and weight insight is gone from
 * `review.insights` before this file sees it — there is no filtering here to
 * get wrong, by design.
 */

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { DataGaps } from '@/components/review/DataGaps';
import { InsightCard } from '@/components/review/InsightCard';
import { WeekOverview } from '@/components/review/WeekOverview';
import { Eyebrow, Note } from '@/components/review/atoms';
import { useReview } from '@/components/review/useReview';
import { useUnits } from '@/lib/hooks/useUnits';
import { SUPPORT_RESOURCES } from '@/lib/algorithms';
import { visibleCoachInsights, visibleReviewHeadline } from '@/components/review/memory';

/** "26 July" — the week under review, as a person would say it. */
function formatWeekEnding(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export default function ReviewPage() {
  const { system } = useUnits();
  const {
    status,
    weekEndingDate,
    build,
    review,
    memory,
    markActedOn,
    dismiss,
    memoryWriteFailed,
  } = useReview();

  const loading = status === 'loading';
  const visibleInsights = review ? visibleCoachInsights(review.insights, memory) : [];

  return (
    <main className="px-4 pt-3 safe-t">
      <header className="pt-2 pb-5">
        <h1 className="text-3xl font-semibold text-ink tracking-[-0.02em]">This week</h1>
        <p className="text-sm text-ink-2 mt-1">
          Week ending {formatWeekEnding(weekEndingDate)}
        </p>
      </header>

      <div className="flex flex-col gap-4 pb-6">
        {loading && <Card aria-busy className="h-28" />}

        {status === 'unavailable' && (
          <Card>
            <Note>
              This screen reads from the vault on your device, and the vault is
              not available right now. Nothing has been lost — reopen the app
              from the Home Screen and it will be here.
            </Note>
          </Card>
        )}

        {!loading && status === 'ready' && review === null && (
          <Card>
            <Eyebrow>Not enough to review yet</Eyebrow>
            <p className="text-base text-ink mt-2 leading-snug">
              I need your height, date of birth, sex and at least one weigh-in
              before any of this means anything.
            </p>
            <Note className="mt-2">
              Every energy figure on this screen is a function of those four. I
              would rather say nothing than build a week&rsquo;s coaching on a
              guessed bodyweight — a review made of assumptions reads exactly
              like one made of measurements, and that is the problem with it.
            </Note>
            <Link
              href="/settings/profile/"
              className="inline-block mt-3 text-sm text-accent underline underline-offset-4"
            >
              Fill those in
            </Link>
          </Card>
        )}

        {!loading && review && build && (
          <>
            <Card>
              <Eyebrow>The short version</Eyebrow>
              <p className="text-base text-ink mt-2 leading-snug">
                {visibleReviewHeadline(review, visibleInsights)}
              </p>
            </Card>

            {memoryWriteFailed && (
              <Card>
                <Note>
                  This review is available, but Keel could not save its coach history in the
                  encrypted vault. Your acted-on and dismissed choices may not persist until
                  local storage is available again.
                </Note>
              </Card>
            )}

            <WeekOverview input={build.input} trendSeries={build.trendSeries} system={system} />

            {visibleInsights.length > 0 && (
              <section className="flex flex-col gap-4">
                <h2 className="sr-only">What I&rsquo;d change</h2>
                {visibleInsights.map((insight) => (
                  <InsightCard
                    key={insight.id}
                    insight={insight}
                    system={system}
                    memory={memory.get(insight.id)}
                    onActedOn={() => markActedOn(insight)}
                    onDismiss={() => dismiss(insight)}
                  />
                ))}
              </section>
            )}

            <DataGaps gaps={review.dataGaps} />

            {review.referral && (
              <Card className="border-warn/35">
                <Eyebrow>Worth talking to someone</Eyebrow>
                <p className="text-sm text-ink mt-2 leading-relaxed">{review.referral.message}</p>
                {review.referral.showResources && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {SUPPORT_RESOURCES.map((r) => (
                      <li key={`${r.region}-${r.name}`} className="text-sm">
                        <span className="text-ink">{r.name}</span>
                        <span className="text-ink-2"> · {r.contact}</span>
                        <span className="block text-ink-3 text-2xs mt-0.5">{r.note}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {/* Once, at the foot. Stapling it to every card is how a disclaimer
                becomes wallpaper — see advice-policy.md §Tone. */}
            <p className="text-2xs text-ink-3 leading-relaxed px-1">{review.disclaimer}</p>
          </>
        )}
      </div>
    </main>
  );
}
