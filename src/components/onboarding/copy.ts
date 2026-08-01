import { INTAKE_STEPS, type IntakeStepId } from "./store";

/**
 * @file What each step is for, and what skipping it actually turns off.
 *
 * ## Why this is a data table and not prose in five components
 *
 * The same sentence has to appear in three places — under the Skip button, on
 * the summary at the end, and in whatever empty state the affected screen shows
 * later. Three copies drift, and the drift is invisible until a user is told
 * two different things about the same missing field.
 *
 * ## The rule these strings follow
 *
 * Each `disables` line names a **specific capability that stops working**, not
 * a benefit the user is missing out on. "Your coach can't project your
 * body-composition goal" is a fact about the software. "Get the most out of
 * Keel!" is marketing, and marketing in a health app is how a user learns to
 * skim the parts that matter.
 *
 * Nothing here celebrates completing a step, because
 * `nutrition-personalization.md` §3.4 forbids gamifying intake and a progress
 * bar that congratulates is the thin end of it. The flow reports position, not
 * achievement.
 */

export interface StepCopy {
  id: IntakeStepId;
  /** Screen title. */
  title: string;
  /** One line under the title: why this is being asked. */
  subtitle: string;
  /** What stops working without it. Shown on skip and in the summary. */
  disables: string;
  /** Label for the skip control. */
  skipLabel: string;
}

export const STEP_COPY: Readonly<Record<IntakeStepId, StepCopy>> = {
  install: {
    id: "install",
    title: "Put Keel on your Home Screen",
    subtitle:
      "Safari deletes the storage of sites you have not opened in about a week. Installed web apps are exempt.",
    disables:
      "Your vault stays on Safari's eviction clock. There is no server copy, so eviction and deletion are the same event.",
    skipLabel: "I'll do this later",
  },
  about: {
    id: "about",
    title: "About you",
    subtitle:
      "Five numbers. Every one of them is an input to an equation, and the screen says which.",
    disables:
      "Calorie and macro targets fall back to a generic estimate until Keel has your height, sex, age and weight.",
    skipLabel: "Skip for now",
  },
  goals: {
    id: "goals",
    title: "What are you working toward?",
    subtitle:
      "The rate you pick drives every calorie target, so it is checked against the safety limits as you type.",
    disables:
      "Keel tracks and reports, but prescribes nothing — no calorie target, no rate, no weekly check-in.",
    skipLabel: "Skip for now",
  },
  training: {
    id: "training",
    title: "Training",
    subtitle:
      "Weekly set targets scale with experience, and sessions the app does not program still have to be budgeted for.",
    disables:
      "The program generator assumes an intermediate lifter with no trainer, which will over-prescribe volume on whatever your trainer already covers.",
    skipLabel: "Skip for now",
  },
  health: {
    id: "health",
    title: "Anything Keel should know?",
    subtitle:
      "So it can check interactions, avoid false alarms in your labs, and never suggest something that hurts.",
    disables:
      "No interaction checking on supplements, no correction of lab values your medications move, and food suggestions that ignore your restrictions.",
    skipLabel: "Skip for now",
  },
};

/**
 * The one thing body fat unlocks, stated once.
 *
 * `guardrails.projectBodyFatOutcome` needs a starting percentage; there is no
 * substitute and no default that would not be a fabrication. Every other field
 * on that screen degrades an estimate. This one removes a feature.
 */
export const BODY_FAT_UNLOCK =
  "Without a body-fat percentage the body-composition projection cannot run at all — there is nothing to project from. A smart scale, calipers or a DEXA number are all fine; Keel compares like with like and will ask which method you used.";

/**
 * Why a faster cut is counterproductive when the goal is a body-fat
 * *percentage*, as opposed to a weight.
 *
 * This is the argument the rate field makes, and it is the one that has to land
 * for the cap to be respected rather than routed around
 * (`athlete-profile.md` §4.2).
 */
export const RATE_DENOMINATOR_ARGUMENT =
  "Body fat is fat mass over total mass. Lose lean tissue and the denominator falls with the numerator, so the percentage barely moves — you end up lighter at the same body fat. That is why a faster cut buys far fewer weeks than the arithmetic suggests.";

/**
 * The steps whose answers are still missing at the end.
 *
 * @param skipped steps the user skipped
 * @returns their copy, in step order, for the summary screen
 */
export function skippedCopy(
  skipped: readonly IntakeStepId[]
): StepCopy[] {
  const seen = new Set(skipped);
  return INTAKE_STEPS.filter((id) => seen.has(id)).map((id) => STEP_COPY[id]);
}
