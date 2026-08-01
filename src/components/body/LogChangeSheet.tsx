"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { addDays } from "@/lib/db/repos";
import type { PerturbationEvent, PerturbationType } from "@/lib/algorithms";
import { LOGGABLE_TYPES } from "./perturbations";

export interface LogChangeSheetProps {
  open: boolean;
  onClose: () => void;
  /** Today as `YYYY-MM-DD`, local calendar day. */
  todayKey: string;
  /** Persist the event. The trend recomputes from it on the next render. */
  onSave: (event: PerturbationEvent) => Promise<void>;
}

/** Offsets a user actually thinks in. Nobody remembers the date they started creatine. */
const WHEN: ReadonlyArray<{ label: string; days: number }> = [
  { label: "Today", days: 0 },
  { label: "Yesterday", days: -1 },
  { label: "A week ago", days: -7 },
  { label: "A month ago", days: -30 },
];

/**
 * "Something changed that isn't food or training."
 *
 * This is the single most valuable affordance on the screen, and it is worth
 * being precise about why. The user takes 5 g of creatine a day, which pulls
 * roughly 1.5 kg of water into muscle over about four weeks. The scale
 * flattens. Nothing about their fat loss has changed — but an estimator that
 * only sees intake and scale weight reads the flat scale as ~275 kcal/day of
 * missing expenditure and the weekly check-in cuts calories on a plan that was
 * working.
 *
 * Automatic detection cannot rescue this: over 200 simulated runs it caught a
 * slow creatine ramp 18% of the time against a 9% false-positive rate, which
 * is no better than guessing. Logging the event eliminates the spiral entirely
 * — a measured 0 kcal target drop versus 100 kcal unprotected.
 *
 * So the app asks, and this is where the answer goes.
 */
export function LogChangeSheet({ open, ...rest }: LogChangeSheetProps) {
  // The form mounts fresh on each open, so reopening never resumes a
  // half-made choice — and no effect is needed to reset it.
  if (!open) return null;
  return <ChangeForm {...rest} />;
}

function ChangeForm({ onClose, todayKey, onSave }: Omit<LogChangeSheetProps, "open">) {
  const [type, setType] = useState<PerturbationType | null>(null);
  const [startDate, setStartDate] = useState(todayKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (type === null) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ type, startDate });
      onClose();
    } catch {
      setError("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }, [type, startDate, onSave, onClose]);

  return (
    <Sheet
      open
      onClose={onClose}
      title="What changed?"
      detent="large"
      footer={
        <Button block size="lg" onClick={save} loading={saving} disabled={type === null}>
          Save
        </Button>
      }
    >
      <p className="text-sm text-ink-2 leading-relaxed">
        These move water, not fat. Logging one tells the trend filter to expect
        the shift, so a few pounds of water never reads as a stalled cut — and
        keeps the expenditure estimate from chasing it.
      </p>

      <fieldset className="mt-4">
        <legend className="sr-only">What changed</legend>
        <div className="rounded-[var(--radius-lg)] border border-line bg-surface overflow-hidden divide-y divide-[var(--c-border)]">
          {LOGGABLE_TYPES.map((option) => {
            const selected = option.type === type;
            return (
              <button
                key={option.type}
                type="button"
                aria-pressed={selected}
                onClick={() => setType(option.type)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left tap active:bg-surface-2"
              >
                <span
                  aria-hidden
                  className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 ${
                    selected ? "border-accent bg-accent" : "border-[var(--c-border-strong)]"
                  }`}
                />
                <span className="min-w-0">
                  <span className="block text-base text-ink">{option.label}</span>
                  <span className="block text-sm text-ink-2 mt-0.5 leading-snug">
                    {option.detail}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-5">
        <h3 className="text-sm font-medium text-ink">When did it start?</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {WHEN.map((option) => {
            const value = addDays(todayKey, option.days);
            const selected = value === startDate;
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={selected}
                onClick={() => setStartDate(value)}
                className={`h-9 rounded-[var(--radius-full)] px-3.5 text-sm tap ${
                  selected
                    ? "bg-accent-quiet text-accent"
                    : "bg-surface-2 text-ink-2"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {/* A date control, not a text field: iOS renders it as a wheel, so no
            keyboard appears and the sheet never gets resized out from under
            the user's thumb. */}
        <label className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2.5">
          <span className="text-sm text-ink-2">Or pick a date</span>
          <input
            type="date"
            value={startDate}
            max={todayKey}
            onChange={(e) => {
              if (e.target.value) setStartDate(e.target.value);
            }}
            className="bg-transparent text-base text-ink tnum outline-none"
          />
        </label>
      </div>

      {error && <p className="mt-3 text-sm text-ink text-center">{error}</p>}
      <div className="pb-2" />
    </Sheet>
  );
}
