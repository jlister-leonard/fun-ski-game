"use client";

import { useEffect, useState } from "react";
import { goals, profiles, settings, toDateKey, weights } from "@/lib/db/repos";
import {
  saveMedications,
  saveSupplements,
} from "@/components/settings/stack";
import type {
  MedicationEntry,
  SupplementEntry,
} from "@/lib/algorithms/medication-interactions";
import type { RecordPatch } from "@/lib/db/repos/base";
import type { GoalDirection, Profile, Sex } from "@/lib/db/types";
import { DEFAULT_UNIT_SYSTEM } from "@/lib/units";
import type { DayOfWeek } from "@/lib/training/program";
import type { TrainingAge } from "@/lib/training/mesocycle";

/**
 * @file Where the first-run intake puts what it collects.
 *
 * ## Nothing here invents a storage mechanism
 *
 * Every answer lands in a repository that already exists — `profiles`,
 * `weights`, `goals` — or, for the two shapes the vault has no table for, in a
 * namespaced key inside `AppSettings.ui`. That is the precedent
 * `components/settings/stack.ts` set for the medication list and
 * `components/body/perturbations.ts` set for confounder events, and the
 * reasoning is theirs: adding a table is the vault agent's call, `ui` is inside
 * the encrypted settings row, and migrating later is a read here and a write
 * there.
 *
 * Medications and supplements go through `stack.ts`'s own writers rather than a
 * second copy of the same keys, so the settings screen and the intake cannot
 * drift into storing different shapes for the same fact.
 *
 * ## Units
 *
 * Everything crossing this boundary is SI — kilograms, centimetres. The screens
 * convert at the input, once, via `@/lib/units`. `AGENTS.md` reason 3: flipping
 * the display preference must never alter a stored value.
 */

/** Namespaced keys inside `AppSettings.ui`. */
export const INTAKE_PROGRESS_KEY = "onboarding.v1";
/** Training answers the program generator needs. */
export const TRAINING_INTAKE_KEY = "profile.training";
/** Injuries and dietary restrictions. */
export const HEALTH_INTAKE_KEY = "profile.healthContext";
/**
 * Goals that sit alongside the primary one, as `athlete-profile.md` §1.3 ids.
 *
 * The `goals` table holds one direction, one rate and two targets — the
 * nutrition goal. It has nowhere for "and I also want to get stronger", which
 * is the half of the ranking the conflict machinery reads.
 */
export const SECONDARY_GOALS_KEY = "profile.goalPriorities";
/**
 * How the latest body-fat reading was measured.
 *
 * `WeightEntry.bodyFatPct` carries the number but not its provenance, and
 * `athlete-profile.md` §1.2 requires the trajectory to compare only
 * same-method estimates. A plain string rather than JSON: it is one value.
 */
export const BODY_FAT_METHOD_KEY = "profile.bodyFatMethod";

/** The steps after the passphrase, in order. */
export const INTAKE_STEPS = [
  "install",
  "about",
  "goals",
  "training",
  "health",
] as const;

export type IntakeStepId = (typeof INTAKE_STEPS)[number];

/**
 * How far through the intake the user is.
 *
 * `stage: 'intake'` is written the moment the vault is created and cleared when
 * the flow ends, however it ends. Its **absence means done**, not "not started"
 * — see the note on {@link readIntakeProgress}.
 */
export interface IntakeProgress {
  stage: "intake" | "done";
  /** The step to resume at. */
  step: IntakeStepId;
  /** Steps the user chose to skip, so the summary can say what is off. */
  skipped: IntakeStepId[];
}

const FRESH: IntakeProgress = Object.freeze({
  stage: "intake",
  step: "install",
  skipped: [],
});

/** What the program generator needs and currently has to assume. */
export interface TrainingIntake {
  /** Scales every volume landmark by ×0.65–×1.15 (`athlete-profile.md` §9.1). */
  trainingAge: TrainingAge | null;
  /** Days a week the user can train at all, trainer days included. */
  daysPerWeek: number | null;
  /** Typical session length in minutes. */
  sessionMinutes: number | null;
  /** Days the trainer owns. The app observes these; it never prescribes them. */
  trainerDays: DayOfWeek[];
  /** What the trainer covers, in the user's words. Interpreted only on-device. */
  trainerFocus: string;
  /** Optional seed for progression. Load in **kilograms**. */
  workingWeights: Array<{ slug: string; label: string; kg: number }>;
}

export const EMPTY_TRAINING: TrainingIntake = Object.freeze({
  trainingAge: null,
  daysPerWeek: null,
  sessionMinutes: null,
  trainerDays: [],
  trainerFocus: "",
  workingWeights: [],
});

/** Context that changes what the app may say, rather than what it computes. */
export interface HealthIntake {
  /** Sites or movements that hurt. Suppresses progression there. */
  injuries: string[];
  /** Free text, stored verbatim, never interpreted. */
  injuryNote: string;
  /** Dietary restrictions — bounds every food suggestion. */
  dietaryRestrictions: string[];
  dietaryNote: string;
}

export const EMPTY_HEALTH: HealthIntake = Object.freeze({
  injuries: [],
  injuryNote: "",
  dietaryRestrictions: [],
  dietaryNote: "",
});

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isStep(value: unknown): value is IntakeStepId {
  return INTAKE_STEPS.includes(value as IntakeStepId);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the stored progress.
 *
 * **A missing key means the intake is finished, not that it never ran.** Every
 * vault that predates this flow — a test fixture, another agent's development
 * vault, an install from before the intake shipped — has no key, and putting an
 * intake screen in front of those on the next unlock would be a worse bug than
 * the one resumption fixes. Only a vault this flow created has `stage:
 * 'intake'`, and only that vault resumes.
 *
 * @returns the progress, or `null` when there is nothing to resume
 */
export async function readIntakeProgress(): Promise<IntakeProgress | null> {
  let raw: unknown;
  try {
    raw = (await settings.load())?.ui[INTAKE_PROGRESS_KEY];
  } catch {
    // Locked, or no IndexedDB. "Nothing to resume" is the safe answer: it
    // shows the app, and the intake is reachable from Settings regardless.
    return null;
  }
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.stage !== "intake") return null;
  return {
    stage: "intake",
    step: isStep(record.step) ? record.step : "install",
    skipped: strings(record.skipped).filter(isStep),
  };
}

/** Mark the intake as running, at its first step. */
export async function beginIntake(): Promise<void> {
  await writeProgress(FRESH);
}

/** Record where the user has got to, so closing the app does not lose it. */
export async function saveIntakeProgress(
  progress: IntakeProgress
): Promise<void> {
  await writeProgress(progress);
}

/**
 * End the intake.
 *
 * Called on the summary screen and on "skip the rest" alike — an abandoned
 * intake and a completed one are the same state as far as the gate is
 * concerned, because re-showing a flow the user walked away from is nagging.
 */
export async function finishIntake(skipped: IntakeStepId[]): Promise<void> {
  await writeProgress({ stage: "done", step: "health", skipped });
}

async function writeProgress(progress: IntakeProgress): Promise<void> {
  try {
    await settings.setUiPreference(
      INTAKE_PROGRESS_KEY,
      JSON.stringify(progress)
    );
  } catch {
    // A failed progress write costs resumption, never data. The answers
    // themselves are written by their own calls and are already safe.
  }
}

/* ------------------------------------------------------------------ */
/* The answers                                                         */
/* ------------------------------------------------------------------ */

/** What "About you" collects. All optional; the engines degrade per field. */
export interface AboutAnswers {
  sex: Sex | null;
  /** `YYYY-MM-DD`. */
  birthDate: string | null;
  heightCm: number | null;
  weightKg: number | null;
  /** 0–100. Without this the body-composition projection cannot run at all. */
  bodyFatPct: number | null;
}

/**
 * Persist "About you".
 *
 * The weight and the body-fat reading become a single dated weigh-in rather
 * than profile fields, because that is where the trend filter and the
 * expenditure estimator read from — a weight stored anywhere else is invisible
 * to both.
 *
 * @param answers what the user entered, already in SI
 */
export async function saveAbout(answers: AboutAnswers): Promise<void> {
  const patch: RecordPatch<Profile> = {};
  if (answers.sex) patch.sex = answers.sex;
  if (answers.birthDate) patch.birthDate = answers.birthDate;
  if (answers.heightCm !== null) patch.heightCm = answers.heightCm;

  if (Object.keys(patch).length > 0) {
    await profiles.save(patch, {
      displayName: null,
      birthDate: null,
      sex: null,
      heightCm: null,
      activityLevel: null,
      timeZone:
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : null,
      // US customary, per `AGENTS.md`. `ProfileRepo.ensure()` still seeds
      // 'metric'; `useUnits` reads `settings.ui` rather than this field for
      // exactly that reason, so the value here is a mirror, not a source.
      unitPreference: DEFAULT_UNIT_SYSTEM,
    });
  }

  if (answers.weightKg !== null) {
    const now = new Date();
    await weights.log({
      dateKey: toDateKey(now),
      kg: answers.weightKg,
      measuredAt: now.getTime(),
      bodyFatPct: answers.bodyFatPct,
      note: null,
      source: "manual",
      sourceKey: null,
    });
  }
}

/** What the goal step collects, in SI and already validated. */
export interface GoalAnswers {
  direction: GoalDirection;
  /** Signed kg/week. Negative for a cut. */
  rateKgPerWeek: number;
  targetWeightKg: number | null;
  targetBodyFatPct: number | null;
}

/**
 * Persist the goal.
 *
 * @param answers the goal, with a rate that has already been through
 *   `guardrails.validateRate` on the screen
 */
export async function saveGoal(answers: GoalAnswers): Promise<void> {
  await goals.setActive({
    direction: answers.direction,
    targetRateKgPerWeek: answers.rateKgPerWeek,
    targetWeightKg: answers.targetWeightKg,
    targetBodyFatPct: answers.targetBodyFatPct,
    startDateKey: toDateKey(new Date()),
    endDateKey: null,
    proteinGPerKgOverride: null,
    note: null,
    active: true,
  });
}

/** Record the secondary goals, as ids the conflict machinery understands. */
export async function saveSecondaryGoals(
  ids: readonly string[]
): Promise<void> {
  await settings.setUiPreference(SECONDARY_GOALS_KEY, JSON.stringify(ids));
}

/** Read the secondary goals. */
export async function loadSecondaryGoals(): Promise<string[]> {
  try {
    return strings(parseJson((await settings.load())?.ui[SECONDARY_GOALS_KEY]));
  } catch {
    return [];
  }
}

/** Record how the stored body-fat percentage was measured. */
export async function saveBodyFatMethod(method: string): Promise<void> {
  await settings.setUiPreference(BODY_FAT_METHOD_KEY, method);
}

/** Read how the stored body-fat percentage was measured. */
export async function loadBodyFatMethod(): Promise<string | null> {
  try {
    const value = (await settings.load())?.ui[BODY_FAT_METHOD_KEY];
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Read the training answers. Exported for the program planner. */
export async function loadTrainingIntake(): Promise<TrainingIntake> {
  let raw: unknown;
  try {
    raw = (await settings.load())?.ui[TRAINING_INTAKE_KEY];
  } catch {
    return EMPTY_TRAINING;
  }
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return EMPTY_TRAINING;
  const record = parsed as Record<string, unknown>;
  const age = record.trainingAge;
  return {
    trainingAge:
      age === "beginner" || age === "intermediate" || age === "advanced"
        ? age
        : null,
    daysPerWeek: finiteOrNull(record.daysPerWeek),
    sessionMinutes: finiteOrNull(record.sessionMinutes),
    trainerDays: Array.isArray(record.trainerDays)
      ? record.trainerDays.filter(
          (d): d is DayOfWeek =>
            typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6
        )
      : [],
    trainerFocus: text(record.trainerFocus),
    workingWeights: Array.isArray(record.workingWeights)
      ? record.workingWeights.flatMap((w) => {
          if (!w || typeof w !== "object") return [];
          const item = w as Record<string, unknown>;
          const kg = finiteOrNull(item.kg);
          if (kg === null || typeof item.slug !== "string") return [];
          return [{ slug: item.slug, label: text(item.label), kg }];
        })
      : [],
  };
}

/** Persist the training answers. */
export async function saveTrainingIntake(
  intake: TrainingIntake
): Promise<void> {
  await settings.setUiPreference(TRAINING_INTAKE_KEY, JSON.stringify(intake));
}

/** Read the health context. */
export async function loadHealthIntake(): Promise<HealthIntake> {
  let raw: unknown;
  try {
    raw = (await settings.load())?.ui[HEALTH_INTAKE_KEY];
  } catch {
    return EMPTY_HEALTH;
  }
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return EMPTY_HEALTH;
  const record = parsed as Record<string, unknown>;
  return {
    injuries: strings(record.injuries),
    injuryNote: text(record.injuryNote),
    dietaryRestrictions: strings(record.dietaryRestrictions),
    dietaryNote: text(record.dietaryNote),
  };
}

/** Persist the health context. */
export async function saveHealthIntake(intake: HealthIntake): Promise<void> {
  await settings.setUiPreference(HEALTH_INTAKE_KEY, JSON.stringify(intake));
}

/**
 * Persist the medication list and supplement stack.
 *
 * Delegates to `components/settings/stack.ts` rather than writing the keys
 * here. Two writers for one fact is how the `startedOn` date that makes
 * `isActiveOn()` work gets quietly dropped by one of them.
 */
export async function saveStackFromIntake(
  medications: readonly MedicationEntry[],
  supplements: readonly SupplementEntry[]
): Promise<void> {
  await saveMedications(medications);
  await saveSupplements(supplements);
}

/* ------------------------------------------------------------------ */
/* Resumption                                                          */
/* ------------------------------------------------------------------ */

/**
 * Whether an unfinished intake is waiting.
 *
 * `undefined` while the check is in flight, `null` when there is nothing to
 * resume. The gate renders a blank surface for `undefined` rather than the app,
 * because flashing the dashboard and then replacing it with an intake screen is
 * worse than a beat of nothing.
 *
 * @param enabled false while the vault is locked, when the read would throw
 */
export function useIntakeResume(
  enabled: boolean
): IntakeProgress | null | undefined {
  const [progress, setProgress] = useState<IntakeProgress | null | undefined>(
    undefined
  );

  useEffect(() => {
    // No setState on the disabled path: `enabled` is already known at render,
    // so resetting through state here would only schedule a second render to
    // reach a value the component can compute directly. See the return.
    if (!enabled) return;
    let cancelled = false;
    readIntakeProgress()
      .then((found) => {
        if (!cancelled) setProgress(found);
      })
      .catch(() => {
        if (!cancelled) setProgress(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Derived, not stored: while disabled the answer is `undefined` regardless of
  // what a previous enabled pass left behind.
  return enabled ? progress : undefined;
}
