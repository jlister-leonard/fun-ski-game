"use client";

import { TextField } from "@/components/ui/TextField";
import { ChipChoice, ChipMulti, Question, TextList } from "./fields";
import type { HealthIntake } from "./store";

/**
 * @file Medications, supplements, injuries, dietary restrictions.
 *
 * ## Why the app asks about medications, stated to the user as it is
 *
 * Two concrete reasons, both true, both in the copy: `medication-interactions.ts`
 * checks the supplement stack against what the user takes, and it corrects lab
 * values that a medication moves — so a number that looks abnormal against a
 * reference range built from people not taking the drug is reported as the drug
 * working, not as a problem. "Personalisation" would be a worse answer because
 * it is vaguer, not because it is softer.
 *
 * `advice-policy.md` Tier 3 rule 1 bounds what follows: Keel will never suggest
 * starting, stopping or changing the dose of a prescription. Collecting the
 * list is not the first step toward advising on it, and the screen says so.
 *
 * ## Injuries stop progression rather than route around it
 *
 * A flagged site suppresses load and volume increases there and offers
 * substitutions (`training-methodology.md` §8.5 rule 4). It never produces a
 * workaround for training through pain.
 *
 * ## Everything here is stored verbatim and never interpreted
 *
 * Free text is inventory, not a diagnosis, and nothing in this app parses it
 * for meaning. `nutrition-personalization.md` §2.5 is absolute on the allergy
 * case: the app records what it is told, excludes those foods from every
 * suggestion, and never tells anyone a food is safe.
 */

const INJURY_SITES = [
  { value: "shoulder", label: "Shoulder" },
  { value: "elbow", label: "Elbow" },
  { value: "wrist", label: "Wrist" },
  { value: "lower_back", label: "Lower back" },
  { value: "hip", label: "Hip" },
  { value: "knee", label: "Knee" },
  { value: "ankle", label: "Ankle" },
  { value: "neck", label: "Neck" },
] as const;

const DIETARY = [
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "gluten_free", label: "Gluten-free" },
  { value: "dairy_free", label: "Dairy-free" },
  { value: "nut_allergy", label: "Nut allergy" },
  { value: "shellfish_allergy", label: "Shellfish allergy" },
  { value: "halal", label: "Halal" },
  { value: "kosher", label: "Kosher" },
  { value: "low_fodmap", label: "Low FODMAP" },
] as const;

/**
 * How long ago creatine was started.
 *
 * `athlete-profile.md` §6.5 is explicit that onboarding must ask *when*, not
 * *whether*: 5 g/day saturates muscle over about 28 days and settles over
 * another 14, and during that ramp the estimator reads ~1 kg of water as stored
 * energy — a bias worth roughly 275 kcal/day on the calorie target, arriving
 * silently and in the harmful direction. Past 42 days the offset is already
 * inside the baseline and no window is needed at all. One question, and it is
 * the difference between a correct estimator and a wrong one.
 */
export const CREATINE_STARTS = [
  { value: "this-week", label: "Just started" },
  { value: "weeks", label: "A few weeks ago" },
  { value: "months", label: "A month or two ago" },
  { value: "long", label: "Longer than that" },
] as const;

export type CreatineStart = (typeof CREATINE_STARTS)[number]["value"];

export interface HealthDraft extends HealthIntake {
  medications: string[];
  supplements: string[];
  creatineStart: CreatineStart | null;
}

export const EMPTY_HEALTH_DRAFT: HealthDraft = Object.freeze({
  medications: [],
  supplements: [],
  creatineStart: null,
  injuries: [],
  injuryNote: "",
  dietaryRestrictions: [],
  dietaryNote: "",
});

/** True when anything in the list looks like creatine. */
export function mentionsCreatine(supplements: readonly string[]): boolean {
  return supplements.some((item) => /creatine/i.test(item));
}

/**
 * The start date to log a `creatine-start` perturbation at, if any.
 *
 * Returns `null` for anything past the 42-day settling window: the water is
 * already in the baseline, the estimator is unbiased, and logging an event
 * would suppress six weeks of perfectly good data for no reason.
 *
 * @param answer how long ago the user says they started
 * @param today the reference date
 * @returns a `YYYY-MM-DD`, or `null` when no window is needed
 */
export function creatineStartDate(
  answer: CreatineStart | null,
  today: Date = new Date()
): string | null {
  const daysAgo =
    answer === "this-week" ? 2 : answer === "weeks" ? 21 : null;
  if (daysAgo === null) return null;
  const date = new Date(today);
  date.setDate(date.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function HealthStep({
  value,
  onChange,
}: {
  value: HealthDraft;
  onChange: (next: HealthDraft) => void;
}) {
  const set = (patch: Partial<HealthDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-6">
      <Question
        label="Medications"
        hint="So Keel can check anything it suggests against what you already take, and so it does not flag a lab value as abnormal when it is your medication doing its job. It will never suggest starting, stopping or changing one — that is your prescriber's."
      >
        <TextList
          label="Add a medication"
          labelHidden
          placeholder="Name it as you know it"
          items={value.medications}
          onChange={(next) => set({ medications: next })}
        />
      </Question>

      <Question
        label="Supplements"
        hint="Upper limits are breached by two sensible products taken together, not by one silly one — so Keel needs the whole list to check the arithmetic. Creatine in particular changes how your scale weight should be read."
      >
        <TextList
          label="Add a supplement"
          labelHidden
          placeholder="Creatine, vitamin D, fish oil…"
          items={value.supplements}
          onChange={(next) => set({ supplements: next })}
        />

        {mentionsCreatine(value.supplements) && (
          <div className="mt-4">
            <p className="text-sm font-medium text-ink">
              When did you start the creatine?
            </p>
            <p className="mt-1 text-xs text-ink-3 leading-relaxed">
              It pulls about a kilo of water into muscle over the first month.
              Your scale flattens or ticks up, and none of it is fat. If that is
              happening now, Keel pauses its calorie-estimate updates rather
              than cutting your food for a water-weight plateau.
            </p>
            <div className="mt-2.5">
              <ChipChoice<CreatineStart>
                label="Creatine start"
                options={CREATINE_STARTS.map((option) => ({ ...option }))}
                value={value.creatineStart}
                onChange={(next) => set({ creatineStart: next })}
              />
            </div>
            {(value.creatineStart === "months" ||
              value.creatineStart === "long") && (
              <p className="mt-2 text-xs text-ink-3 leading-relaxed">
                Past about six weeks the water is already in your baseline, so
                there is nothing to correct for and nothing to pause.
              </p>
            )}
          </div>
        )}
      </Question>

      <Question
        label="Anything that hurts?"
        hint="A flagged site stops Keel adding load or volume there and offers alternatives. It will never suggest a way to train through pain."
      >
        <ChipMulti<string>
          label="Injury sites"
          options={INJURY_SITES.map((site) => ({ ...site }))}
          values={value.injuries}
          onChange={(next) => set({ injuries: next })}
        />
        <div className="mt-3">
          <TextField
            label="Anything else, in your own words"
            labelHidden
            placeholder="Overhead pressing bothers my left shoulder"
            value={value.injuryNote}
            autoCapitalize="sentences"
            enterKeyHint="done"
            onChange={(e) => set({ injuryNote: e.target.value })}
          />
        </div>
      </Question>

      <Question
        label="Dietary restrictions"
        hint="Bounds every food suggestion Keel makes. Nothing it proposes will contain something on this list, in any preparation."
      >
        <ChipMulti<string>
          label="Dietary restrictions"
          options={DIETARY.map((item) => ({ ...item }))}
          values={value.dietaryRestrictions}
          onChange={(next) => set({ dietaryRestrictions: next })}
        />
        <div className="mt-3">
          <TextField
            label="Anything else"
            labelHidden
            placeholder="Foods you react to, or simply do not eat"
            value={value.dietaryNote}
            autoCapitalize="sentences"
            enterKeyHint="done"
            onChange={(e) => set({ dietaryNote: e.target.value })}
          />
        </div>
        <p className="mt-2 text-xs text-ink-3 leading-relaxed">
          If you react to a food, Keel excludes it and leaves it excluded. It
          will not tell you a food is safe to eat and it will not suggest you try
          one — those are questions for an allergist with a blood test, not for
          an app with a food log.
        </p>
      </Question>
    </div>
  );
}
