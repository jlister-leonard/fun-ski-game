"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, Segmented } from "@/components/settings/Field";
import { goals, profiles, weights } from "@/lib/db/repos";
import type { Goal, GoalDirection } from "@/lib/db/types";
import { useUnits } from "@/lib/hooks/useUnits";
import { formatBodyMass, kgToLb, lbToKg, unitLabel } from "@/lib/units";
import {
  LIMITS,
  actionable,
  validateRate,
  type Finding,
  type UserProfile,
} from "@/lib/algorithms/guardrails";
import { cn } from "@/lib/cn";

/** Today, as a local `YYYY-MM-DD`. */
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

/**
 * The active goal.
 *
 * ## Every rate the user types goes through `guardrails.ts` before it is stored
 *
 * `AGENTS.md` rule 4. A goal rate is not a passive preference — it is the input
 * the whole nutrition target chain multiplies out from, so an unchecked 2%
 * per week here becomes an unsafe energy target three screens away. The
 * findings from `validateRate` are shown *before* the save button does
 * anything, and a `block` finding disables it.
 *
 * The rate is entered in pounds per week because that is how the user thinks
 * about it, converted to kg/week for storage, and validated as a percentage of
 * bodyweight because that is the only form in which the safety limits mean
 * anything — 1 lb/week is a gentle deficit at 200 lb and an aggressive one at
 * 110 lb.
 */
export function GoalSection() {
  const { system } = useUnits();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [bodyweightKg, setBodyweightKg] = useState<number | null>(null);

  const [direction, setDirection] = useState<GoalDirection>("maintain");
  const [rateText, setRateText] = useState("");
  const [targetText, setTargetText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [active, storedProfile, latestWeight] = await Promise.all([
          goals.getActive(),
          profiles.load(),
          weights.getLatest(),
        ]);
        if (cancelled) return;
        setGoal(active);
        if (active) {
          setDirection(active.direction);
          const perWeek =
            system === "metric"
              ? Math.abs(active.targetRateKgPerWeek)
              : Math.abs(kgToLb(active.targetRateKgPerWeek));
          setRateText(perWeek === 0 ? "" : perWeek.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
          if (active.targetWeightKg != null) {
            setTargetText(
              (system === "metric"
                ? active.targetWeightKg
                : kgToLb(active.targetWeightKg)
              ).toFixed(1)
            );
          }
        }
        setBodyweightKg(latestWeight?.kg ?? null);
        if (storedProfile?.sex && storedProfile.heightCm && latestWeight) {
          const ageYears = await profiles.ageYears();
          if (!cancelled && ageYears != null) {
            setProfile({
              sex: storedProfile.sex,
              ageYears,
              heightCm: storedProfile.heightCm,
              bodyweightKg: latestWeight.kg,
              goal: active?.direction ?? "maintain",
              ...(active?.targetWeightKg != null
                ? { goalWeightKg: active.targetWeightKg }
                : {}),
            });
          }
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [system]);

  /** The typed rate as signed kg/week. */
  const rateKgPerWeek = useMemo(() => {
    if (direction === "maintain") return 0;
    const magnitude = Number.parseFloat(rateText);
    if (!Number.isFinite(magnitude) || magnitude <= 0) return null;
    const kg = system === "metric" ? magnitude : lbToKg(magnitude);
    return direction === "cut" ? -kg : kg;
  }, [direction, rateText, system]);

  /** Same rate as a percentage of bodyweight — the form the limits are in. */
  const ratePctBw = useMemo(() => {
    if (rateKgPerWeek === null || !bodyweightKg) return null;
    return (rateKgPerWeek / bodyweightKg) * 100;
  }, [rateKgPerWeek, bodyweightKg]);

  const findings: Finding[] = useMemo(() => {
    if (ratePctBw === null || !profile) return [];
    return actionable(validateRate(ratePctBw, { ...profile, goal: direction }));
  }, [ratePctBw, profile, direction]);

  const blocked = findings.some((f) => f.level === "block");

  const save = useCallback(async () => {
    if (rateKgPerWeek === null || blocked) return;
    setBusy(true);
    try {
      const targetValue = Number.parseFloat(targetText);
      const targetWeightKg = Number.isFinite(targetValue)
        ? system === "metric"
          ? targetValue
          : lbToKg(targetValue)
        : null;
      const next = await goals.setActive({
        direction,
        targetRateKgPerWeek: rateKgPerWeek,
        targetWeightKg,
        targetBodyFatPct: goal?.targetBodyFatPct ?? null,
        startDateKey: todayKey(),
        endDateKey: null,
        proteinGPerKgOverride: goal?.proteinGPerKgOverride ?? null,
        note: null,
        active: true,
      });
      setGoal(next);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }, [rateKgPerWeek, blocked, targetText, system, direction, goal]);

  const rateUnit = system === "metric" ? "kg / week" : "lb / week";

  return (
    <Card>
      <CardHeader
        title="Goal"
        subtitle={
          goal
            ? `${DIRECTION_LABEL[goal.direction]} since ${goal.startDateKey}`
            : "Not set"
        }
      />

      <div className="mt-4 flex flex-col gap-4">
        <div>
          <span className="block text-sm text-ink-2">Direction</span>
          <div className="mt-1.5">
            <Segmented<GoalDirection>
              label="Goal direction"
              value={direction}
              onChange={(next) => {
                setDirection(next);
                setSaved(false);
              }}
              options={[
                { value: "cut", label: "Lose" },
                { value: "maintain", label: "Maintain" },
                { value: "gain", label: "Gain" },
              ]}
            />
          </div>
        </div>

        {direction !== "maintain" && (
          <>
            <Field
              label={`Rate (${rateUnit})`}
              value={rateText}
              onChange={(next) => {
                setRateText(next);
                setSaved(false);
              }}
              inputMode="decimal"
              disabled={!ready}
              hint={
                ratePctBw !== null
                  ? `${Math.abs(ratePctBw).toFixed(2)}% of your bodyweight per week. Keel supports up to ${
                      direction === "cut"
                        ? LIMITS.MAX_LOSS_PCT_BW_PER_WEEK
                        : LIMITS.MAX_GAIN_PCT_BW_PER_WEEK
                    }%.`
                  : bodyweightKg === null
                    ? "Log a weight first and Keel can check this rate against your bodyweight."
                    : undefined
              }
            />

            <Field
              label={`Target weight (${unitLabel("bodyMass", system)}, optional)`}
              value={targetText}
              onChange={(next) => {
                setTargetText(next);
                setSaved(false);
              }}
              inputMode="decimal"
              disabled={!ready}
              hint={
                bodyweightKg !== null
                  ? `You are at ${formatBodyMass(bodyweightKg, system).text} now.`
                  : undefined
              }
            />
          </>
        )}

        {findings.length > 0 && (
          <div className="flex flex-col gap-2">
            {findings.map((finding) => (
              <div
                key={finding.code}
                role={finding.level === "block" ? "alert" : undefined}
                className={cn(
                  "rounded-[var(--radius-md)] border px-3 py-2.5 text-sm leading-relaxed",
                  finding.level === "block"
                    ? "border-danger/35 bg-danger-quiet text-ink"
                    : finding.level === "warn"
                      ? "border-warn/35 bg-warn-quiet text-ink"
                      : "border-line bg-surface-2 text-ink-2"
                )}
              >
                {finding.message}
              </div>
            ))}
          </div>
        )}

        {profile === null && direction !== "maintain" && ready && (
          <p className="text-xs text-ink-3 leading-relaxed">
            Fill in your date of birth, sex and height above, and log a weight,
            and Keel can check this rate against the safety limits rather than
            taking it on trust.
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            loading={busy}
            disabled={
              !ready || blocked || (direction !== "maintain" && rateKgPerWeek === null)
            }
            onClick={() => void save()}
          >
            {goal ? "Update goal" : "Set goal"}
          </Button>
          {/* role="status" — without it this confirmation is visible only, and
              a screen-reader user gets no acknowledgement that the tap did
              anything at all. */}
          <span role="status" className="text-sm text-accent">
            {saved ? "Saved." : ""}
          </span>
        </div>
      </div>
    </Card>
  );
}

const DIRECTION_LABEL: Record<GoalDirection, string> = {
  cut: "Losing",
  maintain: "Maintaining",
  gain: "Gaining",
};
