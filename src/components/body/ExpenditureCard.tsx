"use client";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import type { ExpenditureView } from "./useExpenditure";

export interface ExpenditureCardProps {
  view: ExpenditureView;
  /** Opens the "log a change" sheet, when the estimator has a question. */
  onLogChange: () => void;
}

const KCAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** How much of the posterior is the user's own data rather than the equation. */
const CONFIDENCE_COPY: Record<string, string> = {
  none: "Not enough logged data to say anything yet.",
  low: "Early. Expect this to move as more days land.",
  moderate: "Settling. The range narrows as you keep logging.",
  high: "Steady. Your logs, not an equation.",
};

/**
 * Adaptive energy expenditure, with its uncertainty.
 *
 * The rule this card exists to obey: **never show a confident number the data
 * does not support.** Expenditure is a regression of logged intake against the
 * smoothed weight trend, and for the first fortnight it is dominated by a
 * predictive equation with a ±400 kcal standard error. Printing "2,812
 * kcal/day" on day three would be a fabrication in the shape of a fact.
 *
 * So there are three states, and which one shows is decided by the estimator,
 * not by the layout:
 *
 * 1. **Nothing yet** — no day has both a weigh-in and a food log. The card
 *    says what is missing and how many days of each it has.
 * 2. **Starting estimate** — a cold-start prior from height, weight, age and
 *    activity. Shown, labelled as an equation rather than a measurement.
 * 3. **Measured** — blended or fully data-driven. Shown with the 95% interval
 *    beside it, always: the interval *is* the honesty.
 *
 * No target, no deficit, no score. This is one side of an energy balance, not
 * a verdict on the person.
 */
export function ExpenditureCard({ view, onLogChange }: ExpenditureCardProps) {
  const { estimate, hasPrior, sufficiency, intakeDays, weighInDays, ready } = view;

  if (!ready) {
    return (
      <Card aria-busy>
        <CardHeader title="Energy expenditure" subtitle="Reading your logs" />
      </Card>
    );
  }

  // No prior and no data means `estimateExpenditure` reports a TDEE of zero.
  // That is a placeholder, not a measurement, and must never reach the screen.
  const unusable =
    estimate === null || (estimate.source === "prior" && !hasPrior);

  if (unusable) {
    return (
      <Card>
        <CardHeader title="Energy expenditure" subtitle="Not enough to say yet" />
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Working out what you burn needs both sides of the balance over the
          same days: what you ate, and what the scale did. Until there are a
          couple of weeks of each, any number here would be invented.
        </p>
        <div className="mt-4 grid gap-2">
          <Requirement label="Days with food logged" value={intakeDays} />
          <Requirement label="Days with a weigh-in" value={weighInDays} />
        </div>
        {sufficiency && sufficiency.reasons.length > 0 && (
          <ul className="mt-3 space-y-1">
            {sufficiency.reasons.slice(0, 2).map((reason) => (
              <li key={reason} className="text-2xs text-ink-3 leading-snug">
                {reason}
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  const priorOnly = estimate.source === "prior";
  const [lo, hi] = estimate.ci95;
  const dataShare = Math.round(estimate.dataWeight * 100);

  return (
    <Card>
      <CardHeader
        title="Energy expenditure"
        subtitle={
          priorOnly
            ? "Starting estimate — from your profile, not your data"
            : `From ${estimate.daysUsed} day${estimate.daysUsed === 1 ? "" : "s"} of your logs`
        }
      />

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-4xl font-semibold text-ink tnum tracking-[-0.02em]">
          {KCAL.format(estimate.tdeeKcal)}
        </span>
        <span className="text-base text-ink-2">kcal / day</span>
      </div>

      {/* The interval is not an optional decoration. It travels with the
          number, at the same weight, every time the number is shown. */}
      <p className="mt-1 text-sm text-ink-2 tnum">
        95% range {KCAL.format(lo)} to {KCAL.format(hi)} kcal
      </p>

      <p className="mt-3 text-sm text-ink-2 leading-relaxed">
        {priorOnly
          ? "This comes from a predictive equation using your height, weight, age and activity. It is a starting point with a wide error bar, and your own logs will replace it within a few weeks."
          : `${CONFIDENCE_COPY[estimate.confidenceLabel] ?? ""} ${dataShare}% of this figure now comes from your own logs rather than the starting equation.`}
      </p>

      {estimate.perturbationDays > 0 && (
        <p className="mt-2 text-sm text-ink-2 leading-relaxed">
          {estimate.perturbationDays} day
          {estimate.perturbationDays === 1 ? "" : "s"} in this window fall inside
          a change you logged. Those days are down-weighted rather than dropped —
          water moving is not energy moving.
        </p>
      )}

      {estimate.userPrompt && (
        // Asked once, in place, with the answer one tap away. The maths cannot
        // separate a slow water shift from a genuine fall in expenditure —
        // measured at 18% detection — so it asks instead of guessing.
        <div className="mt-4 rounded-[var(--radius-sm)] bg-surface-2 p-3">
          <p className="text-sm text-ink leading-relaxed">{estimate.userPrompt}</p>
          <Button size="sm" variant="secondary" className="mt-2.5" onClick={onLogChange}>
            Log a change
          </Button>
        </div>
      )}

      {estimate.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {estimate.notes.slice(0, 3).map((note) => (
            <li key={note} className="text-2xs text-ink-3 leading-snug">
              {note}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Requirement({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2">
      <span className="text-sm text-ink-2">{label}</span>
      <span className="text-base text-ink tnum">{value}</span>
    </div>
  );
}
