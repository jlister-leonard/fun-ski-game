"use client";

import { loadStack } from "@/components/settings/stack";
import { goals, profiles, weights } from "@/lib/db/repos";
import { cmToFeetInches, kgToLb, type UnitSystem } from "@/lib/units";
import type { AboutDraft, BodyFatMethod } from "./AboutStep";
import { EMPTY_ABOUT } from "./AboutStep";
import { EMPTY_GOALS, type GoalsDraft } from "./GoalsStep";
import { EMPTY_HEALTH_DRAFT, type HealthDraft } from "./HealthStep";
import { EMPTY_TRAINING_DRAFT, type TrainingDraft } from "./TrainingStep";
import type { SeedLiftSlug } from "./TrainingStep";
import {
  loadBodyFatMethod,
  loadHealthIntake,
  loadSecondaryGoals,
  loadTrainingIntake,
} from "./store";
import type { GoalId } from "@/lib/training/program";

/**
 * @file Reading stored answers back into the intake's drafts.
 *
 * ## Why this is not optional
 *
 * The intake writes at the end of each step, so a user who closes the app
 * halfway through has real answers in the vault. Resuming with empty drafts
 * would look harmless — until they tapped Back or Continue on a step they had
 * already filled in, at which point an empty draft would be written over a good
 * answer. `saveStackFromIntake([], [])` in particular replaces the whole
 * medication list, so an empty draft there is destructive rather than merely
 * inert.
 *
 * So resumption hydrates. Everything converts back into the user's display
 * units on the way out, exactly as it converted into SI on the way in.
 */

/** Digits for the pad, without a trailing zero: 182.0 → "182". */
function padText(value: number, places: number): string {
  const fixed = value.toFixed(places);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

export interface HydratedDrafts {
  about: AboutDraft;
  goals: GoalsDraft;
  training: TrainingDraft;
  health: HealthDraft;
}

/**
 * Read every stored answer back into draft form.
 *
 * Each read is independent and failures degrade to the empty draft for that
 * section: a corrupt training preference must not stop the flow from resuming,
 * because the flow is the only place the user could fix it.
 *
 * @param system the display units to render the numbers in
 */
export async function hydrateDrafts(
  system: UnitSystem
): Promise<HydratedDrafts> {
  const [profile, latestWeight, method, activeGoal, secondary, training, health, stack] =
    await Promise.all([
      profiles.load().catch(() => null),
      weights.getLatest().catch(() => null),
      loadBodyFatMethod(),
      goals.getActive().catch(() => null),
      loadSecondaryGoals(),
      loadTrainingIntake(),
      loadHealthIntake(),
      loadStack().catch(() => ({ medications: [], supplements: [] })),
    ]);

  const [year, month, day] = (profile?.birthDate ?? "").split("-");
  const height =
    profile?.heightCm != null ? cmToFeetInches(profile.heightCm) : null;

  const about: AboutDraft = {
    ...EMPTY_ABOUT,
    sex: profile?.sex ?? null,
    month: month ? String(Number(month)) : "",
    day: day ? String(Number(day)) : "",
    year: year ?? "",
    feet: height ? String(height.feet) : "",
    inches: height ? String(height.inches) : "",
    cm: profile?.heightCm != null ? padText(profile.heightCm, 1) : "",
    weight:
      latestWeight != null
        ? padText(system === "metric" ? latestWeight.kg : kgToLb(latestWeight.kg), 1)
        : "",
    bodyFat:
      latestWeight?.bodyFatPct != null ? padText(latestWeight.bodyFatPct, 1) : "",
    bodyFatMethod: (method as BodyFatMethod | null) ?? null,
  };

  const goalsDraft: GoalsDraft = activeGoal
    ? {
        direction: activeGoal.direction,
        secondary: secondary as GoalId[],
        targetBodyFat:
          activeGoal.targetBodyFatPct != null
            ? padText(activeGoal.targetBodyFatPct, 1)
            : "",
        targetWeight:
          activeGoal.targetWeightKg != null
            ? padText(
                system === "metric"
                  ? activeGoal.targetWeightKg
                  : kgToLb(activeGoal.targetWeightKg),
                1
              )
            : "",
        rate: padText(
          Math.abs(
            system === "metric"
              ? activeGoal.targetRateKgPerWeek
              : kgToLb(activeGoal.targetRateKgPerWeek)
          ),
          2
        ),
        // A stored rate is a decision the user already made. Marking it touched
        // stops the default from overwriting it on the next render.
        rateTouched: true,
      }
    : { ...EMPTY_GOALS, secondary: secondary as GoalId[] };

  const lifts: Partial<Record<SeedLiftSlug, string>> = {};
  for (const entry of training.workingWeights) {
    lifts[entry.slug as SeedLiftSlug] = padText(
      system === "metric" ? entry.kg : kgToLb(entry.kg),
      1
    );
  }

  const trainingDraft: TrainingDraft = {
    ...EMPTY_TRAINING_DRAFT,
    trainingAge: training.trainingAge,
    daysPerWeek: training.daysPerWeek,
    sessionMinutes: training.sessionMinutes,
    trainerDays: training.trainerDays,
    trainerFocus: training.trainerFocus,
    lifts,
  };

  const healthDraft: HealthDraft = {
    ...EMPTY_HEALTH_DRAFT,
    injuries: health.injuries,
    injuryNote: health.injuryNote,
    dietaryRestrictions: health.dietaryRestrictions,
    dietaryNote: health.dietaryNote,
    medications: stack.medications.map((m) => m.label ?? m.id),
    supplements: stack.supplements.map((s) => s.label ?? s.id),
  };

  return {
    about,
    goals: goalsDraft,
    training: trainingDraft,
    health: healthDraft,
  };
}
