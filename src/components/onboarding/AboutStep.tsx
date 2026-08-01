"use client";

import { useMemo, useState } from "react";
import { NumberPad } from "@/components/ui/NumberPad";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { Sex } from "@/lib/db/types";
import {
  feetInchesToCm,
  lbToKg,
  type UnitSystem,
} from "@/lib/units";
import { BODY_FAT_UNLOCK } from "./copy";
import { ChipChoice, PadCell, Question } from "./fields";
import type { AboutAnswers } from "./store";

/**
 * @file Sex, date of birth, height, weight, body fat.
 *
 * ## Why these five and nothing else
 *
 * Mifflin-St Jeor takes sex, age, height and mass, and it is what stands in for
 * measured expenditure until there are two or three weeks of weight and intake
 * history to fit against. Miss one and the cold start is a guess wearing a
 * number's clothes.
 *
 * **Body fat is different in kind.** It is not an input that makes an estimate
 * better; it is the input without which `guardrails.projectBodyFatOutcome` has
 * nothing to project from, so the body-composition goal cannot be modelled at
 * all. The screen says exactly that, once, and then leaves it alone — no nag,
 * no empty state, no prompt to go and measure.
 *
 * ## Method matters, which is why it is asked
 *
 * A bathroom-scale estimate and a DEXA measurement are
 * different claims, and a trajectory that mixes methods is a bug rather than a
 * data-quality nuisance. One chip row is cheap insurance against comparing
 * unlike numbers for the next five months.
 */

/** How the user measured their body fat. Vocabulary from `athlete-profile.md` §1.2. */
export const BODY_FAT_METHODS = [
  { value: "dexa", label: "DEXA" },
  { value: "bia_scale", label: "Smart scale" },
  { value: "calipers_3site", label: "Calipers" },
  { value: "navy_tape", label: "Tape" },
  { value: "visual_estimate", label: "Rough guess" },
] as const;

export type BodyFatMethod = (typeof BODY_FAT_METHODS)[number]["value"];

/** Raw text exactly as typed, so a trailing "." survives a round trip. */
export interface AboutDraft {
  sex: Sex | null;
  month: string;
  day: string;
  year: string;
  feet: string;
  inches: string;
  cm: string;
  weight: string;
  bodyFat: string;
  bodyFatMethod: BodyFatMethod | null;
}

export const EMPTY_ABOUT: AboutDraft = Object.freeze({
  sex: null,
  month: "",
  day: "",
  year: "",
  feet: "",
  inches: "",
  cm: "",
  weight: "",
  bodyFat: "",
  bodyFatMethod: null,
});

type PadTarget = "month" | "day" | "year" | "feet" | "inches" | "cm" | "weight" | "bodyFat";

/**
 * Assemble a `YYYY-MM-DD` from three typed fields.
 *
 * Returns `null` rather than clamping: a day of 31 in February is a typo, and
 * silently storing the 28th would put the wrong age into the BMR equation
 * without ever telling anyone.
 *
 * @returns the ISO date, or `null` when the three parts are not a real date
 */
export function toBirthDate(
  month: string,
  day: string,
  year: string
): string | null {
  const m = Number.parseInt(month, 10);
  const d = Number.parseInt(day, 10);
  const y = Number.parseInt(year, 10);
  if (!Number.isInteger(m) || !Number.isInteger(d) || !Number.isInteger(y)) {
    return null;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // A 120-year-old and an unborn user are both data-entry errors.
  const thisYear = new Date().getFullYear();
  if (y < thisYear - 120 || y > thisYear - 13) return null;
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Convert the typed draft into stored SI values.
 *
 * Every field is independently optional: a user who knows their weight but not
 * their body fat gets the weight stored and nothing invented for the rest.
 *
 * @param draft what was typed
 * @param system the display units the numbers were typed in
 */
export function toAboutAnswers(
  draft: AboutDraft,
  system: UnitSystem
): AboutAnswers {
  const heightCm = (() => {
    if (system === "metric") {
      const cm = Number.parseFloat(draft.cm);
      return Number.isFinite(cm) && cm > 50 && cm < 260 ? cm : null;
    }
    const feet = Number.parseFloat(draft.feet);
    if (!Number.isFinite(feet) || feet <= 0 || feet > 8) return null;
    const inches = Number.parseFloat(draft.inches);
    const safeInches = Number.isFinite(inches) && inches >= 0 && inches < 12 ? inches : 0;
    return Math.round(feetInchesToCm(feet, safeInches) * 10) / 10;
  })();

  const weightKg = (() => {
    const value = Number.parseFloat(draft.weight);
    if (!Number.isFinite(value) || value <= 0) return null;
    const kg = system === "metric" ? value : lbToKg(value);
    // The same sanity window `validateWeightEntry` uses. A 20 kg or 400 kg
    // reading is a units mix-up or a typo, and storing it would poison the
    // trend filter's first fit.
    return kg >= 25 && kg <= 300 ? kg : null;
  })();

  const bodyFatPct = (() => {
    const value = Number.parseFloat(draft.bodyFat);
    if (!Number.isFinite(value)) return null;
    return value >= 3 && value <= 60 ? value : null;
  })();

  return {
    sex: draft.sex,
    birthDate: toBirthDate(draft.month, draft.day, draft.year),
    heightCm,
    weightKg,
    bodyFatPct,
  };
}

export function AboutStep({
  value,
  onChange,
  system,
}: {
  value: AboutDraft;
  onChange: (next: AboutDraft) => void;
  system: UnitSystem;
}) {
  const [target, setTarget] = useState<PadTarget>(
    system === "metric" ? "cm" : "month"
  );

  const set = (patch: Partial<AboutDraft>) => onChange({ ...value, ...patch });
  const answers = useMemo(
    () => toAboutAnswers(value, system),
    [value, system]
  );

  const padValue = value[target];
  const padDecimals = target === "weight" || target === "bodyFat" || target === "cm" ? 1 : 0;

  const dobTyped =
    value.month !== "" || value.day !== "" || value.year !== "";
  const dobBad = dobTyped && answers.birthDate === null;
  const bodyFatBad = value.bodyFat !== "" && answers.bodyFatPct === null;
  const weightBad = value.weight !== "" && answers.weightKg === null;

  return (
    <div className="flex flex-col gap-5">
      <Question
        label="Sex"
        hint="An input to the resting-metabolism equation, and to the safety limits. Nothing else reads it."
      >
        <SegmentedControl<Sex | "unset">
          label="Sex"
          value={value.sex ?? "unset"}
          onChange={(next) => set({ sex: next === "unset" ? null : (next as Sex) })}
          options={[
            { value: "female", label: "Female" },
            { value: "male", label: "Male" },
          ]}
        />
      </Question>

      <Question
        label="Date of birth"
        hint="Age changes the metabolism estimate and the maximum-heart-rate model."
      >
        <div className="flex gap-2">
          <PadCell
            value={value.month}
            caption="Month"
            active={target === "month"}
            onFocus={() => setTarget("month")}
          />
          <PadCell
            value={value.day}
            caption="Day"
            active={target === "day"}
            onFocus={() => setTarget("day")}
          />
          <PadCell
            value={value.year}
            caption="Year"
            active={target === "year"}
            onFocus={() => setTarget("year")}
            className="flex-[1.4]"
          />
        </div>
        {dobBad && (
          <p className="mt-1.5 text-xs text-ink-2">
            That is not a date Keel can use, so it will not be saved. Everything
            else on this screen still will.
          </p>
        )}
      </Question>

      <Question label="Height">
        {system === "metric" ? (
          <PadCell
            value={value.cm}
            unit="cm"
            caption="Height"
            active={target === "cm"}
            onFocus={() => setTarget("cm")}
          />
        ) : (
          <div className="flex gap-2">
            <PadCell
              value={value.feet}
              unit="ft"
              caption="Feet"
              active={target === "feet"}
              onFocus={() => setTarget("feet")}
            />
            <PadCell
              value={value.inches}
              unit="in"
              caption="Inches"
              active={target === "inches"}
              onFocus={() => setTarget("inches")}
            />
          </div>
        )}
      </Question>

      <Question
        label="Today's weight"
        hint="Stored as a dated weigh-in, which is where the trend filter and the expenditure estimator both read from."
      >
        <PadCell
          value={value.weight}
          unit={system === "metric" ? "kg" : "lb"}
          caption="Weight"
          active={target === "weight"}
          onFocus={() => setTarget("weight")}
        />
        {weightBad && (
          <p className="mt-1.5 text-xs text-ink-2">
            That reading is outside the range Keel will store. Check whether it
            is in {system === "metric" ? "kilograms" : "pounds"}.
          </p>
        )}
      </Question>

      <Question label="Body fat, if you know it" hint={BODY_FAT_UNLOCK}>
        <PadCell
          value={value.bodyFat}
          unit="%"
          caption="Body fat · optional"
          active={target === "bodyFat"}
          onFocus={() => setTarget("bodyFat")}
        />
        {bodyFatBad && (
          <p className="mt-1.5 text-xs text-ink-2">
            Keel stores readings between 3% and 60%. Outside that it is almost
            always a typo or a broken scale, so it will be left out.
          </p>
        )}
        {answers.bodyFatPct !== null && (
          <div className="mt-3">
            <p className="text-xs text-ink-3 leading-relaxed">
              How was it measured? Methods disagree by several points, so Keel
              only ever compares a reading with another from the same method.
            </p>
            <div className="mt-2">
              <ChipChoice<BodyFatMethod>
                label="Measurement method"
                options={BODY_FAT_METHODS.map((m) => ({ ...m }))}
                value={value.bodyFatMethod}
                onChange={(next) => set({ bodyFatMethod: next })}
              />
            </div>
            {(value.bodyFatMethod === "bia_scale" ||
              value.bodyFatMethod === "visual_estimate") && (
              <p className="mt-2 text-xs text-ink-3 leading-relaxed">
                Keel will treat that as a trend on your own device rather than a
                physiological number, because it is sensitive to how hydrated you
                are — and creatine, if you take it, makes it read low.
              </p>
            )}
          </div>
        )}
      </Question>

      <NumberPad
        value={padValue}
        onChange={(next) => set({ [target]: next } as Partial<AboutDraft>)}
        allowDecimal={padDecimals > 0}
        decimalPlaces={padDecimals}
        className="pt-1"
      />
    </div>
  );
}
