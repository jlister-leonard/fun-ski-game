"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, Segmented, SettingRow } from "@/components/settings/Field";
import { profiles } from "@/lib/db/repos";
import type { RecordPatch } from "@/lib/db/repos/base";
import type { ActivityLevel, Profile, Sex } from "@/lib/db/types";
import { useUnits } from "@/lib/hooks/useUnits";
import { cmToFeetInches, feetInchesToCm } from "@/lib/units";

/** Labels for the stored activity-level vocabulary. */
const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: "Sedentary — desk job, little walking",
  lightly_active: "Lightly active — some walking most days",
  moderately_active: "Moderately active — on your feet a fair amount",
  very_active: "Very active — physical job or lots of walking",
  extremely_active: "Extremely active — heavy physical work",
};

const ACTIVITY_ORDER: ActivityLevel[] = [
  "sedentary",
  "lightly_active",
  "moderately_active",
  "very_active",
  "extremely_active",
];

/**
 * The profile.
 *
 * ## Why these fields and no others
 *
 * Each one is an input to an equation, not a form field for its own sake.
 * `birthDate` and `sex` feed the BMR estimate; `heightCm` feeds BMR and BMI;
 * `activityLevel` is only used for the **cold-start** expenditure estimate,
 * before there is enough weight and intake history to measure it. The screen
 * says so, because a user who knows why a field exists gives a better answer —
 * and knows which ones they can leave blank.
 *
 * Height is entered in feet and inches and stored in centimetres. Changing the
 * unit preference never rewrites the stored value; see `lib/units`.
 */
export function ProfileSection() {
  const { system } = useUnits();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    profiles
      .load()
      .then((loaded) => {
        if (cancelled) return;
        setProfile(loaded);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(
    (change: RecordPatch<Profile>) => {
      setProfile((prior) => (prior ? { ...prior, ...change } : prior));
      setSaved(false);
      void profiles
        .save(change, {
          displayName: null,
          birthDate: null,
          sex: null,
          heightCm: null,
          activityLevel: null,
          timeZone:
            typeof Intl !== "undefined"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : null,
          unitPreference: system,
        })
        .then((next) => {
          setProfile(next);
          setSaved(true);
        })
        .catch(() => undefined);
    },
    [system]
  );

  const heightImperial =
    profile?.heightCm != null ? cmToFeetInches(profile.heightCm) : null;
  const [feet, setFeet] = useState("");
  const [inches, setInches] = useState("");

  const commitHeight = useCallback(
    (nextFeet: string, nextInches: string) => {
      const f = Number.parseFloat(nextFeet);
      const i = Number.parseFloat(nextInches || "0");
      if (!Number.isFinite(f) || f <= 0) return;
      patch({ heightCm: Math.round(feetInchesToCm(f, Number.isFinite(i) ? i : 0) * 10) / 10 });
    },
    [patch]
  );

  return (
    <Card flush>
      <div className="px-4 pt-4">
        <CardHeader
          title="About you"
          subtitle="Only what the equations actually need"
        />
      </div>

      <div className="mt-3 flex flex-col gap-4 px-4 pb-4">
        <Field
          label="Name"
          value={profile?.displayName ?? ""}
          onChange={(next) => patch({ displayName: next || null })}
          placeholder="Optional"
          disabled={!ready}
          hint="Shown on the Today screen. Nothing else reads it."
        />

        <Field
          label="Date of birth"
          type="date"
          value={profile?.birthDate ?? ""}
          onChange={(next) => patch({ birthDate: next || null })}
          disabled={!ready}
          hint="Used for age in the resting-metabolism estimate."
        />

        {system === "imperial" ? (
          <div>
            <span className="block text-sm text-ink-2">Height</span>
            <div className="mt-1 flex gap-3">
              <div className="flex-1">
                <Field
                  label="Feet"
                  value={feet !== "" ? feet : String(heightImperial?.feet ?? "")}
                  onChange={(next) => {
                    setFeet(next);
                    commitHeight(next, inches !== "" ? inches : String(heightImperial?.inches ?? "0"));
                  }}
                  inputMode="numeric"
                  disabled={!ready}
                />
              </div>
              <div className="flex-1">
                <Field
                  label="Inches"
                  value={
                    inches !== "" ? inches : String(heightImperial?.inches ?? "")
                  }
                  onChange={(next) => {
                    setInches(next);
                    commitHeight(feet !== "" ? feet : String(heightImperial?.feet ?? "0"), next);
                  }}
                  inputMode="numeric"
                  disabled={!ready}
                />
              </div>
            </div>
            <p className="mt-1 text-xs text-ink-3">
              Stored in centimetres — switching units never changes the number
              on record.
            </p>
          </div>
        ) : (
          <Field
            label="Height (cm)"
            value={profile?.heightCm != null ? String(profile.heightCm) : ""}
            onChange={(next) => {
              const cm = Number.parseFloat(next);
              patch({ heightCm: Number.isFinite(cm) && cm > 0 ? cm : null });
            }}
            inputMode="decimal"
            disabled={!ready}
          />
        )}
      </div>

      <div className="divide-y divide-[var(--c-border)] border-t border-line">
        <SettingRow
          title="Sex"
          subtitle="An input to the BMR equation and nothing else"
        >
          <Segmented<Sex | "unset">
            label="Sex"
            value={profile?.sex ?? "unset"}
            onChange={(next) => patch({ sex: next === "unset" ? null : next })}
            options={[
              { value: "female", label: "Female" },
              { value: "male", label: "Male" },
            ]}
          />
        </SettingRow>
      </div>

      <div className="px-4 py-4">
        <span className="block text-sm text-ink-2">Daily activity</span>
        <p className="mt-1 text-xs text-ink-3 leading-relaxed">
          Used only until Keel has enough weight and intake history to measure
          your expenditure directly. After that it is ignored.
        </p>
        {/* role="radio" needs a radiogroup ancestor. Without one VoiceOver
            announces every option as "1 of 1" and gives no sense of how many
            choices there are. */}
        <div
          role="radiogroup"
          aria-label="Daily activity"
          className="mt-3 flex flex-col gap-1.5"
        >
          {ACTIVITY_ORDER.map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={profile?.activityLevel === level}
              disabled={!ready}
              onClick={() => patch({ activityLevel: level })}
              className={`tap-target-y rounded-[var(--radius-sm)] border px-3 py-2 text-left text-sm ${
                profile?.activityLevel === level
                  ? "border-accent bg-accent-quiet text-ink"
                  : "border-line bg-surface-2 text-ink-2"
              }`}
            >
              {ACTIVITY_LABELS[level]}
            </button>
          ))}
        </div>
      </div>

      <p className="px-4 pb-4 text-xs text-ink-3 leading-relaxed">
        {profile?.timeZone
          ? `Days are counted in ${profile.timeZone}, taken from this device.`
          : "Days are counted in this device's time zone."}
        {/* Live region, and mounted unconditionally: assistive tech announces
            changes *inside* an existing region, and one that appears already
            populated is routinely missed. */}
        <span role="status" className="ml-1 text-accent">
          {saved ? "Saved." : ""}
        </span>
      </p>
    </Card>
  );
}
