"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { NumberPad } from "@/components/ui/NumberPad";
import { Sheet } from "@/components/ui/Sheet";
import { toDateKey, weights } from "@/lib/db/repos";
import { validateWeightEntry } from "@/lib/algorithms";
import {
  formatBodyMass,
  formatBodyMassDelta,
  parseBodyMass,
  unitLabel,
  type UnitSystem,
} from "@/lib/units";

export interface LogWeightSheetProps {
  open: boolean;
  onClose: () => void;
  system: UnitSystem;
  /** The most recent reading in kilograms, for the delta and the sanity check. */
  previousKg: number | null;
  /** Days since that reading, for the sanity check. */
  daysSincePrevious: number;
  /** Called after a successful write. The chart updates on its own via the live query. */
  onLogged?: () => void;
}

/**
 * Log a weigh-in.
 *
 * Entry is through the in-app `NumberPad`, never the iOS keyboard: the system
 * keyboard takes a beat to appear, resizes the viewport under a sheet, and
 * puts the digits where a thumb is not. This is the most repeated action in
 * the app.
 *
 * The typed number is in the user's own units and is converted to kilograms
 * exactly once, at the write. Nothing downstream ever sees pounds.
 */
export function LogWeightSheet({
  open,
  onClose,
  system,
  previousKg,
  daysSincePrevious,
  onLogged,
}: LogWeightSheetProps) {
  const [text, setText] = useState("");
  const [bodyFatText, setBodyFatText] = useState("");
  /** Which value the pad is currently editing. */
  const [field, setField] = useState<"weight" | "bodyFat">("weight");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kg = useMemo(() => parseBodyMass(text, system), [text, system]);

  /**
   * Body fat percentage, optional.
   *
   * Without it a body-composition projection cannot run at all — body-fat
   * percentage exists nowhere else in the vault, so a weigh-in that discards it
   * silently disables the user's primary goal. Out-of-range entries are simply
   * not stored rather than clamped: 3% and 70% are both real numbers and both
   * almost certainly a typo or a broken scale.
   */
  const bodyFatPct = useMemo(() => {
    const n = Number.parseFloat(bodyFatText);
    if (!Number.isFinite(n)) return null;
    return n >= 3 && n <= 60 ? n : null;
  }, [bodyFatText]);

  const bodyFatRejected = bodyFatText.length > 0 && bodyFatPct === null;

  // The guardrail that catches a pounds/kilograms mix-up and a physically
  // impossible reading. It runs before the write, not after.
  const findings = useMemo(() => {
    if (kg === null) return [];
    return validateWeightEntry({ kg, previousKg, daysSincePrevious });
  }, [kg, previousKg, daysSincePrevious]);

  const blocking = findings.find((f) => f.level === "block") ?? null;
  const warning = findings.find((f) => f.level === "warn") ?? null;

  const delta =
    kg !== null && previousKg !== null && blocking === null
      ? formatBodyMassDelta(kg - previousKg, system)
      : null;

  const close = useCallback(() => {
    setText("");
    setBodyFatText("");
    setField("weight");
    setError(null);
    onClose();
  }, [onClose]);

  const save = useCallback(async () => {
    if (kg === null || blocking !== null) return;
    setSaving(true);
    setError(null);
    try {
      const now = new Date();
      await weights.log({
        dateKey: toDateKey(now),
        kg,
        measuredAt: now.getTime(),
        bodyFatPct,
        note: null,
        source: "manual",
        sourceKey: null,
      });
      setText("");
      setBodyFatText("");
      setField("weight");
      onLogged?.();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.name === "VaultLockedError"
          ? "The vault locked while you were typing. Unlock and try again — nothing was lost."
          : "That didn't save. Try again."
      );
    } finally {
      setSaving(false);
    }
  }, [kg, bodyFatPct, blocking, onClose, onLogged]);

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Log weight"
      detent="auto"
      footer={
        <Button
          block
          size="lg"
          onClick={save}
          loading={saving}
          disabled={kg === null || blocking !== null}
        >
          Save
        </Button>
      }
    >
      <div className="pb-2">
        {/* Two fields, one pad. Tapping a value moves the pad to it rather than
            opening a second sheet — body fat is optional and adding it should
            cost one tap, not a detour. */}
        <div className="flex items-stretch justify-center gap-2 py-5">
          <button
            type="button"
            onClick={() => setField("weight")}
            aria-pressed={field === "weight"}
            className={`flex-1 rounded-[var(--radius-md)] px-3 py-3 text-center transition-colors duration-[var(--duration-fast)] ${
              field === "weight" ? "bg-surface-2" : "bg-transparent"
            }`}
          >
            <span className="flex items-baseline justify-center gap-1.5">
              <span
                className={`text-4xl font-semibold tnum tracking-[-0.02em] ${
                  text ? "text-ink" : "text-ink-3"
                }`}
              >
                {text || "0"}
              </span>
              <span className="text-lg text-ink-2">
                {unitLabel("bodyMass", system)}
              </span>
            </span>
            <span className="mt-1 block text-2xs text-ink-3">Weight</span>
          </button>

          <button
            type="button"
            onClick={() => setField("bodyFat")}
            aria-pressed={field === "bodyFat"}
            className={`flex-1 rounded-[var(--radius-md)] px-3 py-3 text-center transition-colors duration-[var(--duration-fast)] ${
              field === "bodyFat" ? "bg-surface-2" : "bg-transparent"
            }`}
          >
            <span className="flex items-baseline justify-center gap-1.5">
              <span
                className={`text-4xl font-semibold tnum tracking-[-0.02em] ${
                  bodyFatText ? "text-ink" : "text-ink-3"
                }`}
              >
                {bodyFatText || "\u2014"}
              </span>
              <span className="text-lg text-ink-2">%</span>
            </span>
            <span className="mt-1 block text-2xs text-ink-3">
              Body fat &middot; optional
            </span>
          </button>
        </div>

        <div className="min-h-10 text-center">
          {blocking ? (
            <p className="text-sm text-ink leading-relaxed px-2">{blocking.message}</p>
          ) : warning ? (
            <p className="text-sm text-ink-2 leading-relaxed px-2">{warning.message}</p>
          ) : delta ? (
            // Factual, not a verdict. No colour, no arrow, no congratulation —
            // and the sign is never dropped.
            <p className="text-sm text-ink-2 tnum">
              {delta.text} since your last weigh-in
              {daysSincePrevious > 0
                ? ` ${daysSincePrevious} day${daysSincePrevious === 1 ? "" : "s"} ago`
                : " today"}
            </p>
          ) : previousKg !== null ? (
            <p className="text-sm text-ink-3 tnum">
              Last: {formatBodyMass(previousKg, system).text}
            </p>
          ) : (
            <p className="text-sm text-ink-3">
              Weigh in first thing, after the bathroom, before eating.
            </p>
          )}
          {bodyFatRejected && (
            <p className="mt-1 text-sm text-ink-2">
              That body-fat reading looks off, so it won&rsquo;t be saved. The
              weight still will.
            </p>
          )}
        </div>

        <NumberPad
          value={field === "weight" ? text : bodyFatText}
          onChange={field === "weight" ? setText : setBodyFatText}
          allowDecimal
          decimalPlaces={1}
          className="mt-4"
        />

        {error && <p className="mt-3 text-sm text-ink text-center">{error}</p>}
      </div>
    </Sheet>
  );
}
