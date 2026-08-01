"use client";

import { useState } from "react";
import { NumberPad } from "@/components/ui/NumberPad";
import { TextField } from "@/components/ui/TextField";
import { lbToKg, type UnitSystem } from "@/lib/units";
import type { DayOfWeek } from "@/lib/training/program";
import type { TrainingAge } from "@/lib/training/mesocycle";
import { ChipChoice, ChipMulti, PadCell, Question } from "./fields";
import type { TrainingIntake } from "./store";

/**
 * @file Experience, availability, the trainer, and optionally the bar.
 *
 * ## Why experience is asked before anything else
 *
 * Training age multiplies every weekly volume landmark by ×0.65 to ×1.15
 * (`training-methodology.md` §2.2, and `athlete-profile.md` §9 lists it first
 * among the open questions). Guessing "intermediate" is not neutral: for a
 * genuine beginner it prescribes roughly half again as much work as they can
 * recover from, in a calorie deficit, in week one.
 *
 * ## The trainer days are the load-bearing answer
 *
 * `program-personalized.md` §3 makes the trainer's volume the budget the app
 * allocates *around*, not on top of. Without knowing which days they are, the
 * generator either double-counts the muscles the trainer already hammers or
 * assumes nothing happened on those days — and treating missing data as zero
 * volume is the specific failure that model exists to prevent.
 *
 * ## Working weights are optional, and the screen means it
 *
 * They seed progression and nothing else. A user who does not know them loses a
 * first-week estimate, not a feature, and the copy says that rather than
 * implying a form to complete.
 */

const EXPERIENCE: ReadonlyArray<{ value: TrainingAge; label: string }> = [
  { value: "beginner", label: "Under a year" },
  { value: "intermediate", label: "One to three years" },
  { value: "advanced", label: "Longer than that" },
];

const DAYS_PER_WEEK = [2, 3, 4, 5, 6, 7].map((n) => ({
  value: n,
  label: String(n),
}));

const SESSION_MINUTES = [30, 45, 60, 75, 90].map((n) => ({
  value: n,
  label: `${n} min`,
}));

/** 0 = Sunday, matching `Date#getDay` and `program-personalized.md` §2.1. */
const WEEKDAYS: ReadonlyArray<{ value: DayOfWeek; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

/**
 * The lifts worth seeding, with slugs that resolve in the bundled library.
 *
 * Deliberately the big compounds rather than the athlete-specific indicator
 * lifts in `athlete-profile.md` §3.4 — those are chosen per program, and asking
 * a new user for their hack-squat load is asking a question most people cannot
 * answer.
 */
export const SEED_LIFTS = [
  { slug: "back-squat", label: "Back squat" },
  { slug: "barbell-bench-press", label: "Bench press" },
  { slug: "conventional-deadlift", label: "Deadlift" },
  { slug: "barbell-overhead-press", label: "Overhead press" },
] as const;

export type SeedLiftSlug = (typeof SEED_LIFTS)[number]["slug"];

/** Raw text per lift, keyed by slug. */
export type LiftDraft = Partial<Record<SeedLiftSlug, string>>;

export interface TrainingDraft extends Omit<TrainingIntake, "workingWeights"> {
  lifts: LiftDraft;
}

export const EMPTY_TRAINING_DRAFT: TrainingDraft = Object.freeze({
  trainingAge: null,
  daysPerWeek: null,
  sessionMinutes: null,
  trainerDays: [],
  trainerFocus: "",
  lifts: {},
});

/**
 * Convert the typed draft to the stored shape, in kilograms.
 *
 * @param draft what was entered
 * @param system the display units the loads were typed in
 */
export function toTrainingIntake(
  draft: TrainingDraft,
  system: UnitSystem
): TrainingIntake {
  const workingWeights = SEED_LIFTS.flatMap((lift) => {
    const typed = draft.lifts[lift.slug];
    const value = typed ? Number.parseFloat(typed) : NaN;
    if (!Number.isFinite(value) || value <= 0) return [];
    const kg = system === "metric" ? value : lbToKg(value);
    // An 800 kg bench is a typo; a 1 kg squat is a stray keystroke. Neither
    // should seed a progression.
    if (kg < 5 || kg > 500) return [];
    return [{ slug: lift.slug, label: lift.label, kg: Math.round(kg * 10) / 10 }];
  });

  return {
    trainingAge: draft.trainingAge,
    daysPerWeek: draft.daysPerWeek,
    sessionMinutes: draft.sessionMinutes,
    trainerDays: draft.trainerDays,
    trainerFocus: draft.trainerFocus,
    workingWeights,
  };
}

export function TrainingStep({
  value,
  onChange,
  system,
}: {
  value: TrainingDraft;
  onChange: (next: TrainingDraft) => void;
  system: UnitSystem;
}) {
  const [liftsOpen, setLiftsOpen] = useState(false);
  const [target, setTarget] = useState<SeedLiftSlug>(SEED_LIFTS[0].slug);
  const set = (patch: Partial<TrainingDraft>) => onChange({ ...value, ...patch });

  const hasTrainer = value.trainerDays.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <Question
        label="How long have you been training seriously?"
        hint="Weekly set targets scale with this by as much as half again. It is the single largest input to how much work Keel prescribes."
      >
        <ChipChoice<TrainingAge>
          label="Training experience"
          options={EXPERIENCE}
          value={value.trainingAge}
          onChange={(next) => set({ trainingAge: next })}
        />
      </Question>

      <Question
        label="Days a week you can train"
        hint="Including any sessions with a trainer."
      >
        <ChipChoice<number>
          label="Days per week"
          options={DAYS_PER_WEEK}
          value={value.daysPerWeek}
          onChange={(next) => set({ daysPerWeek: next })}
        />
      </Question>

      <Question label="How long a session usually runs">
        <ChipChoice<number>
          label="Session length"
          options={SESSION_MINUTES}
          value={value.sessionMinutes}
          onChange={(next) => set({ sessionMinutes: next })}
        />
      </Question>

      <Question
        label="Any sessions with a trainer?"
        hint="Keel does not program these and will not move them. It budgets its own work around them, so it needs to know which days they are."
      >
        <ChipMulti<DayOfWeek>
          label="Trainer days"
          options={WEEKDAYS}
          values={value.trainerDays}
          onChange={(next) => set({ trainerDays: next })}
        />
        {hasTrainer && (
          <div className="mt-3">
            <TextField
              label="Roughly what do they cover?"
              hint="A few words is plenty. Stored in your encrypted vault and interpreted only on this device."
              placeholder="For example: full-body strength"
              value={value.trainerFocus}
              autoCapitalize="sentences"
              autoCorrect="on"
              enterKeyHint="done"
              onChange={(e) => set({ trainerFocus: e.target.value })}
            />
          </div>
        )}
      </Question>

      <div>
        <button
          type="button"
          onClick={() => setLiftsOpen((open) => !open)}
          aria-expanded={liftsOpen}
          className="tap-target-y w-full rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-3 text-left"
        >
          <span className="block text-sm font-medium text-ink">
            I know my working weights
          </span>
          <span className="mt-0.5 block text-xs text-ink-3 leading-relaxed">
            Optional. Used only to pick a starting load so week one is not a
            guessing exercise. Leave it and Keel starts conservatively and
            adjusts from what you log.
          </span>
        </button>

        {liftsOpen && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {SEED_LIFTS.map((lift) => (
                <PadCell
                  key={lift.slug}
                  value={value.lifts[lift.slug] ?? ""}
                  unit={system === "metric" ? "kg" : "lb"}
                  caption={lift.label}
                  active={target === lift.slug}
                  onFocus={() => setTarget(lift.slug)}
                />
              ))}
            </div>
            <p className="text-xs text-ink-3 leading-relaxed">
              A weight you could do for about five clean reps today, not a
              one-rep max and not a personal best from two years ago.
            </p>
            <NumberPad
              value={value.lifts[target] ?? ""}
              onChange={(next) =>
                set({ lifts: { ...value.lifts, [target]: next } })
              }
              allowDecimal
              decimalPlaces={1}
            />
          </div>
        )}
      </div>
    </div>
  );
}
