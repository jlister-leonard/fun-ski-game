"use client";

import { useMemo, useState } from "react";
import { NumberPad } from "@/components/ui/NumberPad";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { CheckRow } from "@/components/ui/Switch";
import {
  LIMITS,
  actionable,
  projectBodyFatOutcome,
  validateRate,
  type Finding,
  type UserProfile,
} from "@/lib/algorithms/guardrails";
import { defaultRatePctBwPerWeek } from "@/lib/algorithms/macro-targets";
import { TRADEOFF_COPY, type GoalId } from "@/lib/training/program";
import type { GoalDirection } from "@/lib/db/types";
import { formatBodyMass, kgToLb, lbToKg, type UnitSystem } from "@/lib/units";
import { cn } from "@/lib/cn";
import { RATE_DENOMINATOR_ARGUMENT } from "./copy";
import { ChipMulti, PadCell, Question } from "./fields";
import type { AboutAnswers } from "./store";

/**
 * @file The goal, and the rate that follows from it.
 *
 * ## The rate field is the one that has to be right
 *
 * `AGENTS.md` rule 4 and `athlete-profile.md` §3.5 rule 2: the rate the user
 * sets is the input the whole nutrition chain multiplies out from, and the cap
 * is the cap. But refusing a number is a weak form of enforcement — a user who
 * does not understand the cap sets 0.9%, watches nothing happen, and stops
 * trusting the app.
 *
 * So this screen does three things in order. It runs `validateRate` on every
 * keystroke and lets a `block` finding disable Continue. It shows what the
 * requested rate actually buys, projected against the recommended one with
 * `projectBodyFatOutcome`. And it states the arithmetic reason a faster cut is
 * self-defeating when the goal is a body-fat *percentage*: lean mass is in the
 * denominator, so spending it moves the number you are trying to move in the
 * wrong direction. `athlete-profile.md` §4.2 calls that comparison "the most
 * persuasive honest argument available", and it is.
 *
 * ## Goal conflicts use the spec's words
 *
 * `TRADEOFF_COPY` in `@/lib/training/program` carries the four statements
 * `athlete-profile.md` §3.3 specifies **verbatim**. Where a pair of goals
 * conflicts, that copy is shown as written rather than paraphrased — the point
 * of a verbatim requirement is that the argument survives being re-explained by
 * four different screens.
 *
 * ## And nothing here celebrates a target
 *
 * `nutrition-personalization.md` §3.4 is normative and not overridable. Setting
 * a goal is a configuration change, reported as one. There is no progress
 * imagery, no encouragement, and the projection is expressed as a cost in
 * lean mass and a duration, never as a reward.
 */

/** Goals that can sit alongside the primary one. Ids from `athlete-profile.md` §1.3. */
const SECONDARY_GOALS: ReadonlyArray<{ value: GoalId; label: string }> = [
  { value: "strength", label: "Get stronger" },
  { value: "vo2max", label: "Better conditioning" },
  { value: "hypertrophy", label: "Build muscle" },
  { value: "joint_integrity", label: "Stay injury-free" },
];

export interface GoalsDraft {
  direction: GoalDirection;
  secondary: GoalId[];
  /** Target body-fat percentage, as typed. */
  targetBodyFat: string;
  /** Target weight in display units, as typed. */
  targetWeight: string;
  /** Rate magnitude in display units per week, as typed. */
  rate: string;
  /** Whether the user has touched the rate, so a default never overwrites them. */
  rateTouched: boolean;
}

export const EMPTY_GOALS: GoalsDraft = Object.freeze({
  direction: "cut",
  secondary: [],
  targetBodyFat: "",
  targetWeight: "",
  rate: "",
  rateTouched: false,
});

export interface RateReading {
  /** Signed kg/week, or `null` when nothing usable is typed. */
  rateKgPerWeek: number | null;
  /** The same rate as a percentage of bodyweight, or `null` without a weight. */
  ratePctBw: number | null;
  targetBodyFatPct: number | null;
  targetWeightKg: number | null;
  /** Complete enough to validate against the safety limits. */
  profile: UserProfile | null;
  findings: Finding[];
  blocked: boolean;
}

/** Age in whole years, from a `YYYY-MM-DD`. */
function ageFrom(birthDate: string | null, at: Date = new Date()): number | null {
  if (!birthDate) return null;
  const [y, m, d] = birthDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  let age = at.getFullYear() - y;
  const monthDiff = at.getMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && at.getDate() < d)) age--;
  return age;
}

/**
 * Everything the rate field needs, derived rather than stored.
 *
 * Exported because the shell gates Continue on `blocked` and writes
 * `rateKgPerWeek`; deriving it in two places is how the screen and the write
 * end up disagreeing about what was validated.
 *
 * @param draft the typed goal
 * @param about the answers from the previous step, in SI
 * @param system the display units the rate was typed in
 */
export function readRate(
  draft: GoalsDraft,
  about: AboutAnswers,
  system: UnitSystem
): RateReading {
  const targetBodyFatPct = (() => {
    const value = Number.parseFloat(draft.targetBodyFat);
    return Number.isFinite(value) && value >= 3 && value <= 60 ? value : null;
  })();

  const targetWeightKg = (() => {
    const value = Number.parseFloat(draft.targetWeight);
    if (!Number.isFinite(value) || value <= 0) return null;
    const kg = system === "metric" ? value : lbToKg(value);
    return kg >= 25 && kg <= 300 ? kg : null;
  })();

  const magnitude = Number.parseFloat(draft.rate);
  const rateKgPerWeek = (() => {
    if (draft.direction === "maintain") return 0;
    if (!Number.isFinite(magnitude) || magnitude <= 0) return null;
    const kg = system === "metric" ? magnitude : lbToKg(magnitude);
    return draft.direction === "cut" ? -kg : kg;
  })();

  const ratePctBw =
    rateKgPerWeek !== null && about.weightKg
      ? (rateKgPerWeek / about.weightKg) * 100
      : null;

  const ageYears = ageFrom(about.birthDate);
  const profile: UserProfile | null =
    about.sex && about.heightCm && about.weightKg && ageYears !== null
      ? {
          sex: about.sex,
          ageYears,
          heightCm: about.heightCm,
          bodyweightKg: about.weightKg,
          goal: draft.direction,
          ...(about.bodyFatPct !== null ? { bodyFatPct: about.bodyFatPct } : {}),
          ...(targetWeightKg !== null ? { goalWeightKg: targetWeightKg } : {}),
          ...(targetBodyFatPct !== null
            ? { goalBodyFatPct: targetBodyFatPct }
            : {}),
        }
      : null;

  const findings =
    ratePctBw !== null && profile ? actionable(validateRate(ratePctBw, profile)) : [];

  return {
    rateKgPerWeek,
    ratePctBw,
    targetBodyFatPct,
    targetWeightKg,
    profile,
    findings,
    blocked: findings.some((f) => f.level === "block"),
  };
}

/**
 * The rate Keel would pick, in display units, as a string for the pad.
 *
 * Prefilled rather than left blank because an empty rate field invites the
 * round number the user already had in mind, and `defaultRatePctBwPerWeek`
 * already encodes the leanness scaling the literature supports. They can change
 * it; the point is that the sensible value is the one on screen first.
 */
export function defaultRateText(
  direction: GoalDirection,
  about: AboutAnswers,
  system: UnitSystem
): string {
  if (direction === "maintain") return "";
  const pct = defaultRatePctBwPerWeek(
    direction,
    about.sex ?? "male",
    about.bodyFatPct ?? undefined
  );
  if (!about.weightKg) {
    // No bodyweight, so no percentage to scale. These are the mid-band
    // absolute rates the same function implies at a typical bodyweight.
    const kg = direction === "cut" ? 0.55 : 0.3;
    return (system === "metric" ? kg : kgToLb(kg)).toFixed(1);
  }
  const kg = Math.abs((pct / 100) * about.weightKg);
  return (system === "metric" ? kg : kgToLb(kg)).toFixed(1);
}

/** Weeks read as a promise; months read as an estimate. `athlete-profile.md` §4.2. */
function months(weeks: number): string {
  const value = weeks / 4.345;
  const rounded = Math.round(value * 2) / 2;
  if (rounded < 1) return "under a month";
  return `about ${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} months`;
}

export function GoalsStep({
  value,
  onChange,
  system,
  about,
  hideCalories,
  onHideCaloriesChange,
}: {
  value: GoalsDraft;
  onChange: (next: GoalsDraft) => void;
  system: UnitSystem;
  about: AboutAnswers;
  hideCalories: boolean;
  onHideCaloriesChange: (next: boolean) => void;
}) {
  const [target, setTarget] = useState<"rate" | "targetBodyFat" | "targetWeight">(
    "rate"
  );
  const set = (patch: Partial<GoalsDraft>) => onChange({ ...value, ...patch });

  const reading = useMemo(
    () => readRate(value, about, system),
    [value, about, system]
  );

  const rateUnit = system === "metric" ? "kg/wk" : "lb/wk";

  /** The projection comparison. Only meaningful with a body-fat start and target. */
  const projection = useMemo(() => {
    if (
      value.direction !== "cut" ||
      about.weightKg === null ||
      about.bodyFatPct === null ||
      reading.targetBodyFatPct === null ||
      reading.ratePctBw === null ||
      reading.targetBodyFatPct >= about.bodyFatPct
    ) {
      return null;
    }
    const recommendedPct = Math.abs(
      defaultRatePctBwPerWeek("cut", about.sex ?? "male", about.bodyFatPct)
    );
    const requestedPct = Math.abs(reading.ratePctBw);
    const requested = projectBodyFatOutcome(
      about.weightKg,
      about.bodyFatPct,
      reading.targetBodyFatPct,
      requestedPct
    );
    const recommended = projectBodyFatOutcome(
      about.weightKg,
      about.bodyFatPct,
      reading.targetBodyFatPct,
      recommendedPct
    );
    if (requested.weeksToTarget === null || recommended.weeksToTarget === null) {
      return null;
    }
    // The comparison is only worth showing when the user has asked to go
    // *faster* than the recommendation. Below it, putting a quicker option
    // beside their choice reads as a suggestion to take it, which is the
    // opposite of what this screen is for.
    const compare = requestedPct > recommendedPct + 0.01;
    return { requested, recommended, requestedPct, recommendedPct, compare };
  }, [value.direction, about, reading.targetBodyFatPct, reading.ratePctBw]);

  /**
   * Past a certain rate `validateRate` emits its own projection through
   * `explainRateTradeoff`, with the same comparison and the same denominator
   * argument. Showing both would state the case twice in slightly different
   * numbers, which reads as two disagreeing estimates rather than one. The
   * guardrail's version wins: it is the one the rest of the app quotes.
   */
  const guardrailProjects = useMemo(
    () => reading.findings.some((f) => f.code.startsWith("RATE_TRADEOFF")),
    [reading.findings]
  );

  const showProjection = projection !== null && !guardrailProjects;

  const conflicts = useMemo(
    () => conflictCopy(value.direction, value.secondary),
    [value.direction, value.secondary]
  );

  const padValue =
    target === "rate"
      ? value.rate
      : target === "targetBodyFat"
        ? value.targetBodyFat
        : value.targetWeight;

  return (
    <div className="flex flex-col gap-5">
      <Question label="Right now, the main thing is">
        <SegmentedControl<GoalDirection>
          label="Primary goal"
          value={value.direction}
          onChange={(next) =>
            set({
              direction: next,
              rate: value.rateTouched
                ? value.rate
                : defaultRateText(next, about, system),
            })
          }
          options={[
            { value: "cut", label: "Lose fat" },
            { value: "maintain", label: "Maintain" },
            { value: "gain", label: "Gain" },
          ]}
        />
      </Question>

      <Question
        label="And these matter too"
        hint="Pick as many as apply. Where two of them pull against each other, Keel says so rather than promising both."
      >
        <ChipMulti<GoalId>
          label="Secondary goals"
          options={SECONDARY_GOALS}
          values={value.secondary}
          onChange={(next) => set({ secondary: next })}
        />
      </Question>

      {conflicts.length > 0 && (
        <div className="flex flex-col gap-3">
          {conflicts.map((entry) => (
            <div
              key={entry.title}
              className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-3"
            >
              <p className="text-sm font-medium text-ink">{entry.title}</p>
              <p className="mt-1.5 text-sm text-ink-2 leading-relaxed">
                {entry.body}
              </p>
            </div>
          ))}
        </div>
      )}

      {value.direction !== "maintain" && (
        <>
          <Question
            label="Target"
            hint={
              value.direction === "cut"
                ? "A body-fat target is what the projection runs on. A weight target is optional and Keel treats it as secondary."
                : "Optional. Keel tracks the rate either way."
            }
          >
            <div className="flex gap-2">
              {value.direction === "cut" && (
                <PadCell
                  value={value.targetBodyFat}
                  unit="%"
                  caption="Body fat"
                  active={target === "targetBodyFat"}
                  onFocus={() => setTarget("targetBodyFat")}
                />
              )}
              <PadCell
                value={value.targetWeight}
                unit={system === "metric" ? "kg" : "lb"}
                caption="Weight · optional"
                active={target === "targetWeight"}
                onFocus={() => setTarget("targetWeight")}
              />
            </div>
          </Question>

          <Question
            label="How fast"
            hint={
              reading.ratePctBw !== null
                ? `${Math.abs(reading.ratePctBw).toFixed(2)}% of your bodyweight a week. Keel will not prescribe past ${
                    value.direction === "cut"
                      ? LIMITS.MAX_LOSS_PCT_BW_PER_WEEK
                      : LIMITS.MAX_GAIN_PCT_BW_PER_WEEK
                  }%.`
                : "Enter today's weight on the previous step and Keel can check this against the safety limits instead of taking it on trust."
            }
          >
            <PadCell
              value={value.rate}
              unit={rateUnit}
              caption="Rate"
              active={target === "rate"}
              onFocus={() => setTarget("rate")}
            />
          </Question>

          {reading.findings.length > 0 && (
            <ul className="flex flex-col gap-2">
              {reading.findings.map((finding) => (
                <li
                  key={finding.code}
                  role={finding.level === "block" ? "alert" : undefined}
                  className={cn(
                    "rounded-[var(--radius-md)] border px-3.5 py-3 text-sm leading-relaxed",
                    finding.level === "block"
                      ? "border-danger/35 bg-danger-quiet text-ink"
                      : finding.level === "warn"
                        ? "border-warn/35 bg-warn-quiet text-ink"
                        : "border-line bg-surface-2 text-ink-2"
                  )}
                >
                  {finding.message}
                </li>
              ))}
            </ul>
          )}

          {showProjection && projection && (
            <div className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-3">
              <p className="text-sm text-ink-2 leading-relaxed">
                At {projection.requestedPct.toFixed(2)}% a week you reach{" "}
                {reading.targetBodyFatPct}% body fat in{" "}
                {months(projection.requested.weeksToTarget ?? 0)}, and about{" "}
                {
                  formatBodyMass(
                    projection.requested.leanMassLostKg ?? 0,
                    system
                  ).text
                }{" "}
                of what you lose is lean tissue.
                {projection.compare && (
                  <>
                    {" "}
                    At {projection.recommendedPct.toFixed(2)}% it takes{" "}
                    {months(projection.recommended.weeksToTarget ?? 0)} and
                    costs about{" "}
                    {
                      formatBodyMass(
                        projection.recommended.leanMassLostKg ?? 0,
                        system
                      ).text
                    }
                    .
                  </>
                )}
              </p>
              {projection.compare && (
                <p className="mt-2 text-xs text-ink-3 leading-relaxed">
                  {RATE_DENOMINATOR_ARGUMENT}
                </p>
              )}
            </div>
          )}

          {reading.profile === null && (
            <p className="text-xs text-ink-3 leading-relaxed">
              Keel checks every rate against the safety limits, but it needs
              your sex, date of birth, height and today&rsquo;s weight to do it.
              Fill those in — here or later in Settings — and this rate gets
              checked rather than trusted.
            </p>
          )}

          <NumberPad
            value={padValue}
            onChange={(next) => {
              if (target === "rate") set({ rate: next, rateTouched: true });
              else if (target === "targetBodyFat") set({ targetBodyFat: next });
              else set({ targetWeight: next });
            }}
            allowDecimal
            decimalPlaces={target === "rate" ? 2 : 1}
          />
        </>
      )}

      <CheckRow
        checked={hideCalories}
        onChange={onHideCaloriesChange}
        title="Hide calorie numbers"
        hint="Protein and micronutrient adequacy keep working with the energy numbers switched off. If counting calories is a bad idea for you, this is the switch — and it is in Settings whenever you want it, in either direction."
      />
    </div>
  );
}

/**
 * The verbatim tradeoff statements that apply to this combination of goals.
 *
 * `athlete-profile.md` §3.3 requires that every automated tradeoff produce a
 * user-visible statement saying what was asked, what is being done instead,
 * why, and what it costs — and it specifies the wording. `TRADEOFF_COPY` holds
 * that wording; this function only decides which entries apply.
 *
 * The fat-loss/hypertrophy pair has no entry there because §3.1 states it as a
 * table row rather than as copy, so it is quoted from §3.1 instead.
 *
 * @param direction the primary goal
 * @param secondary the goals selected alongside it
 */
export function conflictCopy(
  direction: GoalDirection,
  secondary: readonly GoalId[]
): Array<{ title: string; body: string }> {
  if (direction !== "cut") return [];
  const out: Array<{ title: string; body: string }> = [];

  if (secondary.includes("hypertrophy")) {
    out.push({
      title: 'On "build muscle" while losing fat',
      body:
        "Building meaningful new contractile tissue requires energy that a deficit by definition does not provide. " +
        "True novices, people returning after a layoff and people carrying a lot of fat are the exceptions, and " +
        "Keel does not yet know whether any of those is you. So it will program to keep what you have rather than " +
        "promise you more, and it will say so every week rather than quietly counting on the exception.",
    });
  }
  if (secondary.includes("strength")) {
    out.push({
      title: TRADEOFF_COPY.strength_held.title,
      body: TRADEOFF_COPY.strength_held.body,
    });
  }
  if (secondary.includes("vo2max")) {
    out.push({
      title: TRADEOFF_COPY.vo2max_realistic.title,
      body: TRADEOFF_COPY.vo2max_realistic.body,
    });
  }
  return out;
}
