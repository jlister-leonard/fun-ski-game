"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useNutritionPrefs } from "@/components/nutrition/prefs";
import {
  loadPerturbations,
  savePerturbations,
} from "@/components/body/perturbations";
import {
  resolveAgentId,
  resolveSupplementId,
} from "@/lib/algorithms/medication-interactions";
import type {
  MedicationEntry,
  SupplementEntry,
} from "@/lib/algorithms/medication-interactions";
import { useUnits } from "@/lib/hooks/useUnits";
import { cn } from "@/lib/cn";
import { AboutStep, EMPTY_ABOUT, toAboutAnswers, type AboutDraft } from "./AboutStep";
import { STEP_COPY, skippedCopy } from "./copy";
import {
  EMPTY_GOALS,
  GoalsStep,
  defaultRateText,
  readRate,
  type GoalsDraft,
} from "./GoalsStep";
import {
  EMPTY_HEALTH_DRAFT,
  HealthStep,
  creatineStartDate,
  type HealthDraft,
} from "./HealthStep";
import { hydrateDrafts } from "./hydrate";
import { InstallStep, readStandalone } from "./InstallStep";
import {
  EMPTY_TRAINING_DRAFT,
  TrainingStep,
  toTrainingIntake,
  type TrainingDraft,
} from "./TrainingStep";
import {
  INTAKE_STEPS,
  finishIntake,
  saveAbout,
  saveBodyFatMethod,
  saveGoal,
  saveHealthIntake,
  saveIntakeProgress,
  saveSecondaryGoals,
  saveStackFromIntake,
  saveTrainingIntake,
  type IntakeStepId,
} from "./store";

/**
 * @file The intake shell — order, skipping, resumption, and the writes.
 *
 * ## Every step after the passphrase is optional, and that is a design position
 *
 * A first run that blocks on a form is a first run a fair number of people
 * abandon, and the app works — logs food, logs training, logs weight — with
 * none of this answered. What it cannot do is *prescribe*, and each step says
 * which capability it is buying rather than asking for trust. Skipping is one
 * tap and never asks twice.
 *
 * ## Where state lives
 *
 * The shell owns every draft. Steps are controlled components with no storage
 * of their own, so Back is free, resumption is a matter of seeding the drafts,
 * and there is exactly one place that knows how a typed string becomes a stored
 * SI value. Answers are written at the end of each step rather than at the end
 * of the flow — a user who quits after "About you" keeps their weight.
 *
 * ## Nothing here is a progress game
 *
 * `nutrition-personalization.md` §3.4: no streaks, no badges, no celebration.
 * The header reports position because that is genuinely useful — a user
 * deciding whether to start knows how long it is — and the summary reports what
 * is configured and what is not. Neither congratulates.
 */

export interface IntakeProps {
  /** Where to resume. Defaults to the first visible step. */
  initialStep?: IntakeStepId;
  /** Steps already skipped in an earlier session. */
  initialSkipped?: readonly IntakeStepId[];
  /** Called once the flow is over, however it ended. */
  onFinish: () => void;
}

interface Drafts {
  about: AboutDraft;
  goals: GoalsDraft;
  training: TrainingDraft;
  health: HealthDraft;
}

const EMPTY_DRAFTS: Drafts = {
  about: EMPTY_ABOUT,
  goals: EMPTY_GOALS,
  training: EMPTY_TRAINING_DRAFT,
  health: EMPTY_HEALTH_DRAFT,
};

/**
 * The steps to show.
 *
 * Install drops out when the app is already running from the Home Screen —
 * there is nothing to ask for, and a step whose only content is "you already
 * did this" is filler. Read once at mount rather than subscribed: a step list
 * that changes length underneath a user mid-flow moves the ground under them.
 */
function visibleSteps(): IntakeStepId[] {
  return readStandalone()
    ? INTAKE_STEPS.filter((id) => id !== "install")
    : [...INTAKE_STEPS];
}

/** Free text to the shape `checkStack()` consumes. Mirrors `settings/StackSection`. */
function toMedications(labels: readonly string[]): MedicationEntry[] {
  return labels.map((label) => ({
    id: resolveAgentId(label) ?? label.toLowerCase().replace(/\s+/g, "-"),
    label,
  }));
}

function toSupplements(labels: readonly string[]): SupplementEntry[] {
  return labels.map((label) => ({
    id: resolveSupplementId(label) ?? label.toLowerCase().replace(/\s+/g, "-"),
    label,
  }));
}

export function Intake({ initialStep, initialSkipped, onFinish }: IntakeProps) {
  const { system } = useUnits();
  const prefs = useNutritionPrefs();
  const [steps] = useState<IntakeStepId[]>(visibleSteps);
  const [stepId, setStepId] = useState<IntakeStepId>(
    () => initialStep ?? visibleSteps()[0]
  );
  const [skipped, setSkipped] = useState<IntakeStepId[]>(() => [
    ...(initialSkipped ?? []),
  ]);
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS);
  const [summary, setSummary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A resumed step the current device no longer shows — installed since — must
  // not leave the flow pointing at nothing.
  const index = Math.max(0, steps.indexOf(stepId));
  const step = steps[index] ?? steps[0];
  const copy = STEP_COPY[step];

  const about = useMemo(
    () => toAboutAnswers(drafts.about, system),
    [drafts.about, system]
  );

  /**
   * The goal draft with the rate seeded.
   *
   * Derived rather than written into state by an effect. The default depends on
   * bodyweight and body fat, which are still being typed on the previous step,
   * so an effect would fire on every keystroke there and cascade a second
   * render each time — and it would race the user if they reached the rate
   * field first. Computing it makes the seed a function of the answers, and the
   * moment the user touches the field `rateTouched` pins their value for good.
   */
  const goalsDraft = useMemo<GoalsDraft>(() => {
    if (drafts.goals.rateTouched || drafts.goals.direction === "maintain") {
      return drafts.goals;
    }
    return {
      ...drafts.goals,
      rate: defaultRateText(drafts.goals.direction, about, system),
    };
  }, [drafts.goals, about, system]);

  const rate = useMemo(
    () => readRate(goalsDraft, about, system),
    [goalsDraft, about, system]
  );

  const patch = useCallback(
    <K extends keyof Drafts>(key: K, value: Drafts[K]) => {
      setDrafts((prior) => ({ ...prior, [key]: value }));
    },
    []
  );

  /**
   * Seed the drafts from whatever is already stored.
   *
   * Only on a resume. On a first run there is nothing to read, and the write it
   * would provoke — `profiles.ensure()` behaviour aside — is a round trip for a
   * guaranteed-empty result. On a resume it is load-bearing: an empty draft
   * written over a stored answer is data loss, and for the medication list it
   * would be a silent wipe.
   */
  useEffect(() => {
    if (!initialStep) return;
    let cancelled = false;
    hydrateDrafts(system)
      .then((loaded) => {
        if (!cancelled) setDrafts(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initialStep, system]);

  /** Write whatever the current step collected. Throws on a vault failure. */
  const persist = useCallback(async () => {
    switch (step) {
      case "install":
        return;
      case "about": {
        await saveAbout(about);
        if (about.bodyFatPct !== null && drafts.about.bodyFatMethod) {
          await saveBodyFatMethod(drafts.about.bodyFatMethod);
        }
        return;
      }
      case "goals": {
        // No usable rate means nothing was really answered. Writing a goal with
        // a rate of zero would read downstream as "maintain", which is a
        // different instruction from "not set" and would suppress the empty
        // state that tells the user the goal is missing.
        if (rate.rateKgPerWeek === null || rate.blocked) return;
        await saveGoal({
          direction: drafts.goals.direction,
          rateKgPerWeek: rate.rateKgPerWeek ?? 0,
          targetWeightKg: rate.targetWeightKg,
          targetBodyFatPct: rate.targetBodyFatPct,
        });
        await saveSecondaryGoals(drafts.goals.secondary);
        return;
      }
      case "training":
        await saveTrainingIntake(toTrainingIntake(drafts.training, system));
        return;
      case "health": {
        await saveHealthIntake({
          injuries: drafts.health.injuries,
          injuryNote: drafts.health.injuryNote,
          dietaryRestrictions: drafts.health.dietaryRestrictions,
          dietaryNote: drafts.health.dietaryNote,
        });
        await saveStackFromIntake(
          toMedications(drafts.health.medications),
          toSupplements(drafts.health.supplements)
        );
        // `athlete-profile.md` §6.5: a creatine start inside the 42-day window
        // is the difference between a correct expenditure estimate and one
        // biased by ~275 kcal/day in the direction that cuts the user's food.
        const startDate = creatineStartDate(drafts.health.creatineStart);
        if (startDate) {
          const events = await loadPerturbations();
          if (!events.some((e) => e.type === "creatine-start")) {
            await savePerturbations([
              ...events,
              { startDate, type: "creatine-start", label: "Creatine" },
            ]);
          }
        }
        return;
      }
    }
  }, [step, about, drafts, rate, system]);

  const go = useCallback(
    async (mode: "save" | "skip" | "skip-rest") => {
      setBusy(true);
      setError(null);
      try {
        if (mode === "save") await persist();

        const nextSkipped =
          mode === "save"
            ? skipped.filter((id) => id !== step)
            : mode === "skip"
              ? [...new Set([...skipped, step])]
              : [...new Set([...skipped, ...steps.slice(index)])];
        setSkipped(nextSkipped);

        const next = steps[index + 1];
        if (mode === "skip-rest" || !next) {
          setSummary(true);
          await finishIntake(nextSkipped);
        } else {
          setStepId(next);
          await saveIntakeProgress({
            stage: "intake",
            step: next,
            skipped: nextSkipped,
          });
        }
      } catch (err) {
        setError(
          err instanceof Error && err.name === "VaultLockedError"
            ? "The vault locked while you were typing. Unlock and this picks up where it left off."
            : "That didn't save. Try again, or skip this step — you can fill it in from Settings."
        );
      } finally {
        setBusy(false);
      }
    },
    [persist, skipped, step, steps, index]
  );

  const back = useCallback(() => {
    const previous = steps[index - 1];
    if (previous) setStepId(previous);
  }, [steps, index]);

  if (summary) {
    return <Summary skipped={skipped} onDone={onFinish} />;
  }

  return (
    <main className="flex min-h-[100svh] flex-col bg-bg safe-t safe-b">
      <header className="px-6 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-2xs uppercase tracking-[0.08em] text-ink-3">
            Step {index + 1} of {steps.length}
          </p>
          <button
            type="button"
            onClick={() => void go("skip")}
            disabled={busy}
            className="tap text-sm text-ink-2"
          >
            {copy.skipLabel}
          </button>
        </div>
        {/* Position, not progress. No fill animation, no completion state — a
            bar that fills is the first step toward rewarding form-filling. */}
        <div className="mt-2 flex gap-1" aria-hidden>
          {steps.map((id, i) => (
            <span
              key={id}
              className={cn(
                "h-0.5 flex-1 rounded-full",
                i <= index ? "bg-ink-3" : "bg-[var(--c-border)]"
              )}
            />
          ))}
        </div>
        <h1 className="mt-4 text-2xl font-semibold text-ink tracking-[-0.01em]">
          {copy.title}
        </h1>
        <p className="mt-2 text-sm text-ink-2 leading-relaxed">
          {copy.subtitle}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto scroll-touch px-6 pb-6 pt-5">
        {step === "install" && <InstallStep />}
        {step === "about" && (
          <AboutStep
            value={drafts.about}
            onChange={(next) => patch("about", next)}
            system={system}
          />
        )}
        {step === "goals" && (
          <GoalsStep
            value={goalsDraft}
            onChange={(next) => patch("goals", next)}
            system={system}
            about={about}
            hideCalories={prefs.hideCalories}
            onHideCaloriesChange={(next) => void prefs.setHideCalories(next)}
          />
        )}
        {step === "training" && (
          <TrainingStep
            value={drafts.training}
            onChange={(next) => patch("training", next)}
            system={system}
          />
        )}
        {step === "health" && (
          <HealthStep
            value={drafts.health}
            onChange={(next) => patch("health", next)}
          />
        )}

        <p className="mt-6 text-xs text-ink-3 leading-relaxed">
          Skipping this: {copy.disables}
        </p>
      </div>

      <footer className="border-t border-line bg-surface px-6 py-4">
        {error && (
          <p role="alert" className="mb-3 text-sm text-danger leading-relaxed">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          {index > 0 && (
            <Button variant="secondary" size="lg" onClick={back} disabled={busy}>
              Back
            </Button>
          )}
          <Button
            size="lg"
            block
            loading={busy}
            disabled={step === "goals" && rate.blocked}
            onClick={() => void go("save")}
          >
            {index === steps.length - 1 ? "Finish" : "Continue"}
          </Button>
        </div>
        <button
          type="button"
          onClick={() => void go("skip-rest")}
          disabled={busy}
          className="tap mt-3 block w-full text-center text-sm text-ink-3"
        >
          Skip the rest and start logging
        </button>
      </footer>
    </main>
  );
}

/**
 * What is set up, and what is not.
 *
 * The whole purpose of this screen is the second list. An app that silently
 * runs at reduced capability teaches the user that its empty states are just
 * how it looks; one that says "the projection is off because there is no
 * body-fat number" gives them something to do about it.
 */
function Summary({
  skipped,
  onDone,
}: {
  skipped: readonly IntakeStepId[];
  onDone: () => void;
}) {
  const missing = skippedCopy(skipped);

  return (
    <main className="flex min-h-[100svh] flex-col justify-between bg-bg px-6 py-8 safe-t safe-b">
      <div>
        <h1 className="text-2xl font-semibold text-ink tracking-[-0.01em]">
          {missing.length === 0 ? "That's everything." : "Set up enough to start."}
        </h1>
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          {missing.length === 0
            ? "Keel has what it needs to prescribe rather than just record. Everything you entered is on this phone, encrypted, and changeable in Settings."
            : "Keel will use what it has and say so where it cannot. Nothing here is locked — Settings has all of it whenever you want."}
        </p>

        {missing.length > 0 && (
          <ul className="mt-6 flex flex-col gap-3">
            {missing.map((entry) => (
              <li
                key={entry.id}
                className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-3"
              >
                <p className="text-sm font-medium text-ink">{entry.title}</p>
                <p className="mt-1 text-sm text-ink-2 leading-relaxed">
                  {entry.disables}
                </p>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-xs text-ink-3 leading-relaxed">
          Keel is not medical advice. It is a coach that shows its reasoning and
          its uncertainty, and it routes anything clinical to a clinician.
        </p>
      </div>

      <div className="mt-8">
        <Button size="lg" block onClick={onDone}>
          Start logging
        </Button>
      </div>
    </main>
  );
}
