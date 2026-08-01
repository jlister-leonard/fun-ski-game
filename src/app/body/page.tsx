"use client";

import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ExpenditureCard } from "@/components/body/ExpenditureCard";
import { LogChangeSheet } from "@/components/body/LogChangeSheet";
import { LogWeightSheet } from "@/components/body/LogWeightSheet";
import { PerturbationCard } from "@/components/body/PerturbationCard";
import { WeightTrendCard } from "@/components/body/WeightTrendCard";
import { usePerturbations } from "@/components/body/perturbations";
import { useExpenditure } from "@/components/body/useExpenditure";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  computeWeightTrend,
  daysBetween,
  summarizeTrend,
  type PerturbationEvent,
} from "@/lib/algorithms";
import { toDateKey } from "@/lib/db/repos";
import { useUnits } from "@/lib/hooks/useUnits";
import { useWeightSeries } from "@/lib/hooks/useWeightSeries";
import { formatBodyMass, formatBodyMassDelta } from "@/lib/units";

/** Which sheet is up. One at a time — a sheet over a sheet is a dead end on iOS. */
type OpenSheet = "none" | "weight" | "change";

/** Days of history the screen reads. Covers a full cut plus the 56-day expenditure window. */
const WINDOW_DAYS = 180;

/** How far back the headline trend comparison looks, at most. */
const COMPARISON_DAYS = 30;

/**
 * The Body screen.
 *
 * Everything here is one of three things: a raw fact (the scale reading), a
 * modelled estimate shown with its uncertainty (the trend, the expenditure),
 * or an explanation of why a number is missing. There is no fourth category —
 * no score, no streak, no badge, and nothing that congratulates a person for a
 * number going down. A larger deficit is not a better result, and being above
 * a target is not an error, so neither is ever rendered in a status colour.
 *
 * All arithmetic is in kilograms. Pounds appear only through `@/lib/units`, at
 * the moment of display.
 */
export default function BodyPage() {
  const { system } = useUnits();
  const { points, status, from, to } = useWeightSeries(WINDOW_DAYS);
  const { events, add, remove } = usePerturbations();
  const [sheet, setSheet] = useState<OpenSheet>("none");

  const todayKey = useMemo(() => toDateKey(new Date()), []);

  // The filter is told about logged water shifts, so a creatine plateau is
  // absorbed into the level rather than read as a change in the rate of loss.
  const trend = useMemo(
    () => computeWeightTrend(points, { perturbations: events }),
    [points, events]
  );
  const summary = useMemo(() => summarizeTrend(trend), [trend]);
  const expenditure = useExpenditure(trend, from, to);

  const latest = points.length > 0 ? points[points.length - 1] : null;
  const daysSinceLatest = latest ? daysBetween(latest.date, todayKey) : 0;

  // Trend now against trend ~30 days ago. Signed, uncoloured, and labelled
  // with the span actually available rather than a span we wish we had.
  const comparison = useMemo(() => {
    if (trend.length < 8) return null;
    const last = trend[trend.length - 1];
    const cutoff = Math.max(0, trend.length - 1 - COMPARISON_DAYS);
    const earlier = trend[cutoff];
    const span = daysBetween(earlier.date, last.date);
    if (span < 7) return null;
    return { deltaKg: last.trendKg - earlier.trendKg, span };
  }, [trend]);

  const openWeight = useCallback(() => setSheet("weight"), []);
  const openChange = useCallback(() => setSheet("change"), []);
  const closeSheet = useCallback(() => setSheet("none"), []);

  const saveChange = useCallback(
    async (event: PerturbationEvent) => {
      await add(event);
    },
    [add]
  );

  const hasPerturbation = trend.some((p) => p.perturbationActive);
  const loading = status === "loading";
  const empty = !loading && points.length === 0;

  return (
    <main className="px-4 pt-3 safe-t">
      <header className="pt-2 pb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold text-ink tracking-[-0.02em]">Body</h1>
          <p className="text-sm text-ink-2 mt-1">Weight, trend and expenditure</p>
        </div>
        {!empty && !loading && (
          <Button size="sm" onClick={openWeight}>
            Log weight
          </Button>
        )}
      </header>

      <div className="flex flex-col gap-4 pb-6">
        {loading && <Card aria-busy className="h-28" />}

        {empty && <EmptyState onLogWeight={openWeight} />}

        {!loading && latest && (
          <>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-2xs uppercase tracking-wide text-ink-3">
                    Last weigh-in
                  </div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-4xl font-semibold text-ink tnum tracking-[-0.02em]">
                      {formatBodyMass(latest.kg, system).value}
                    </span>
                    <span className="text-lg text-ink-2">
                      {formatBodyMass(latest.kg, system).unit}
                    </span>
                  </div>
                  <div className="text-sm text-ink-2 mt-1">
                    {daysSinceLatest === 0
                      ? "Today"
                      : daysSinceLatest === 1
                        ? "Yesterday"
                        : `${daysSinceLatest} days ago`}
                    {summary
                      ? ` · trend ${formatBodyMass(summary.trendKg, system).text}`
                      : ""}
                  </div>
                </div>
              </div>

              {comparison && (
                // A fact with its sign intact. Not a verdict, not a colour, and
                // never a larger number framed as a better one.
                <p className="mt-3 text-sm text-ink-2 tnum">
                  Trend {formatBodyMassDelta(comparison.deltaKg, system).text} over
                  the last {comparison.span} days
                </p>
              )}
            </Card>

            <WeightTrendCard
              trend={trend}
              summary={summary}
              system={system}
              hasPerturbation={hasPerturbation}
            />

            <ExpenditureCard view={expenditure} onLogChange={openChange} />
          </>
        )}

        {!loading && (
          <PerturbationCard
            events={events}
            todayKey={todayKey}
            system={system}
            stepSuspected={summary?.stepSuspected ?? false}
            onLogChange={openChange}
            onRemove={(startDate, type) => {
              void remove(startDate, type);
            }}
          />
        )}
      </div>

      <LogWeightSheet
        open={sheet === "weight"}
        onClose={closeSheet}
        system={system}
        previousKg={latest?.kg ?? null}
        daysSincePrevious={daysSinceLatest}
      />

      <LogChangeSheet
        open={sheet === "change"}
        onClose={closeSheet}
        todayKey={todayKey}
        onSave={saveChange}
      />
    </main>
  );
}

/**
 * Day one.
 *
 * This is the screen the user actually meets first, so it is the one that had
 * to be designed first. It does exactly two things: give the single action
 * that starts everything, and set honest expectations about when each number
 * appears. No sample chart, no placeholder figures — a fake trend line teaches
 * the user to distrust the real one.
 */
function EmptyState({ onLogWeight }: { onLogWeight: () => void }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">No weigh-ins yet</h2>
      <p className="mt-2 text-sm text-ink-2 leading-relaxed">
        Weigh yourself first thing in the morning, after the bathroom, before
        you eat or drink. The same conditions every time matter far more than
        the number itself — the trend is built out of that consistency.
      </p>

      <Button block size="lg" className="mt-4" onClick={onLogWeight}>
        Log your first weight
      </Button>

      <ul className="mt-5 space-y-3">
        <Milestone when="Today">
          Your first reading. The chart starts from it.
        </Milestone>
        <Milestone when="About ten weigh-ins">
          Enough for a trend line worth reading. Before that it swings on water,
          not fat.
        </Milestone>
        <Milestone when="Two weeks of weigh-ins and food logs">
          An expenditure estimate, shown with the range around it. Sooner than
          that, any number would be a guess dressed up as a measurement.
        </Milestone>
      </ul>
    </Card>
  );
}

function Milestone({ when, children }: { when: string; children: ReactNode }) {
  return (
    <li>
      <div className="text-2xs uppercase tracking-wide text-ink-3">{when}</div>
      <div className="text-sm text-ink-2 mt-0.5 leading-relaxed">{children}</div>
    </li>
  );
}
