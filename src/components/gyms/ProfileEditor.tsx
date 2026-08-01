"use client";

import { useMemo, useState } from "react";
import { Badge, StepBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { CheckRow } from "@/components/ui/Switch";
import { TextField } from "@/components/ui/TextField";
import { toast } from "@/components/ui/Toast";
import {
  ZONES,
  itemsInZone,
  loadUnitSuffix,
  type EquipmentItem,
} from "@/lib/gyms/equipment";
import {
  coverageOf,
  gymKindLabel,
  hasEquipment,
  selectionOf,
  seedFor,
  updateProfile,
  withEquipment,
  withoutEquipment,
  type EquipmentSelection,
  type GymKind,
  type GymProfile,
} from "@/lib/gyms/profiles";
import { EquipmentDetail } from "./EquipmentDetail";
import { PhotoStrip } from "./PhotoStrip";

/**
 * @file The capture flow — a walk-through, not a wall of tick boxes.
 *
 * The design constraint the user gave was "super intuitive", and the naive
 * implementation of this screen — 120 checkboxes on one page — fails it badly.
 * Three things fix it:
 *
 * 1. **One zone per screen, in the order you would walk the floor.** Free
 *    weights, racks, cables, machines, sled, cardio, rig. You answer by
 *    looking, not by remembering.
 * 2. **Seeded, so it is confirming rather than entering.** A new commercial
 *    profile starts with a plausible commercial gym already ticked, and the
 *    work is unticking the three things your gym lacks.
 * 3. **A live count of what it unlocks.** The number at the top moves as you
 *    tick, which is the only honest argument for why this is worth two minutes.
 *
 * Details — the dumbbell ceiling, the stack increment, whether it is a Keiser —
 * are one tap deeper, never in the way.
 */

const KIND_OPTIONS: readonly { value: GymKind; label: string }[] = [
  { value: "commercial", label: "Gym" },
  { value: "trainer", label: "Studio" },
  { value: "home", label: "Home" },
  { value: "travel", label: "Travel" },
  { value: "other", label: "Other" },
];

/** One line describing what this gym's version of an item can do. */
function detailSummary(
  item: EquipmentItem,
  selection: EquipmentSelection | null,
): string {
  const suffix = loadUnitSuffix(item.loadUnit);
  const sizes = selection?.sizes ?? item.sizes;
  if (sizes && sizes.length > 0) {
    return `${sizes.join(", ")} ${suffix}`.trim();
  }
  const min = selection?.minLoad ?? item.minLoad;
  const max = selection?.maxLoad ?? item.maxLoad;
  const step = selection?.increment ?? item.increment;
  const parts: string[] = [];
  if (min !== null && max !== null) parts.push(`${min}–${max} ${suffix}`.trim());
  else if (max !== null) parts.push(`up to ${max} ${suffix}`.trim());
  else if (min !== null) parts.push(`from ${min} ${suffix}`.trim());
  if (step !== null) parts.push(`${step} ${suffix} steps`.trim());
  if (selection?.spanM != null) {
    parts.push(`${Math.round((selection.spanM / 0.9144) * 10) / 10} yd`);
  }
  return parts.join(" · ");
}

/** Whether an item has anything worth opening the detail sheet for. */
function hasDetail(item: EquipmentItem): boolean {
  return (
    item.loadUnit !== "none" ||
    item.sizes !== null ||
    item.zone === "sled_turf"
  );
}

export interface ProfileEditorProps {
  profile: GymProfile;
  onChange: (next: GymProfile) => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

/** The zone-by-zone capture flow for one gym. */
export function ProfileEditor({
  profile,
  onChange,
  onClose,
  onDuplicate,
  onDelete,
}: ProfileEditorProps) {
  const [step, setStep] = useState(0);
  const [detailFor, setDetailFor] = useState<EquipmentItem | null>(null);

  const coverage = useMemo(() => coverageOf(profile), [profile]);
  const lastStep = ZONES.length;
  const zone = step < lastStep ? ZONES[step] : null;
  const items = useMemo(
    () => (zone === null ? [] : itemsInZone(zone.id)),
    [zone],
  );

  const toggle = (item: EquipmentItem, on: boolean) => {
    onChange(
      on
        ? withEquipment(profile, { id: item.id })
        : withoutEquipment(profile, item.id),
    );
  };

  const setAll = (on: boolean) => {
    let next = profile;
    for (const item of items) {
      next = on ? withEquipment(next, { id: item.id }) : withoutEquipment(next, item.id);
    }
    onChange(next);
  };

  const reseed = (kind: GymKind) => {
    onChange(updateProfile(profile, { kind, items: seedFor(kind) }));
    toast(`Started from the ${gymKindLabel(kind).toLowerCase()} template`);
  };

  return (
    <div className="flex min-h-[70svh] flex-col">
      <header className="pt-2 pb-4">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="-ml-1 text-sm text-accent tap active:opacity-60"
          >
            Done
          </button>
          <Badge tone="neutral" bare>
            {coverage.available} of {coverage.total} movements
          </Badge>
        </div>
        <h1 className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-[-0.02em] text-ink">
          {zone === null ? (
            "Finish up"
          ) : (
            <>
              <StepBadge n={zone.order} />
              {zone.label}
            </>
          )}
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          {zone?.blurb ?? "Name it, and you are done."}
        </p>
        <ProgressBar
          value={(step + 1) / (lastStep + 1)}
          className="mt-3"
          label="Setup progress"
        />
      </header>

      <div className="flex-1">
        {zone !== null ? (
          <>
            <div className="mb-3 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setAll(true)}>
                All of it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAll(false)}>
                None of it
              </Button>
            </div>

            <Card flush className="divide-y divide-[var(--c-border)] px-4">
              {items.map((item) => {
                const on = hasEquipment(profile, item.id);
                const selection = selectionOf(profile, item.id);
                const summary = on && hasDetail(item) ? detailSummary(item, selection) : "";
                return (
                  <div key={item.id} className="py-1">
                    <CheckRow
                      checked={on}
                      onChange={(next) => toggle(item, next)}
                      title={item.label}
                      hint={item.note || item.aka.join(" · ") || undefined}
                      className="py-3.5"
                    />
                    {on && hasDetail(item) && (
                      <button
                        type="button"
                        onClick={() => setDetailFor(item)}
                        className="mb-2 ml-8 flex items-center gap-1 text-sm text-accent tap active:opacity-60"
                      >
                        {summary === "" ? "Add details" : summary}
                        <span aria-hidden>›</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </Card>
          </>
        ) : (
          <div className="flex flex-col gap-6">
            <TextField
              label="What do you call this place?"
              value={profile.name}
              onChange={(e) => onChange(updateProfile(profile, { name: e.target.value }))}
            />

            <div>
              <p className="mb-2 text-sm text-ink-2">Kind of place</p>
              <SegmentedControl
                label="Kind of place"
                block
                options={KIND_OPTIONS}
                value={profile.kind}
                onChange={(kind) => onChange(updateProfile(profile, { kind }))}
              />
              <button
                type="button"
                onClick={() => reseed(profile.kind)}
                className="mt-2 text-sm text-accent tap active:opacity-60"
              >
                Reset to the {gymKindLabel(profile.kind).toLowerCase()} template
              </button>
            </div>

            <TextField
              label="Anything to remember"
              value={profile.note}
              placeholder="Cables are upstairs; sled lane is out back"
              onChange={(e) => onChange(updateProfile(profile, { note: e.target.value }))}
            />

            <PhotoStrip
              photos={profile.photos}
              onChange={(photos) => onChange(updateProfile(profile, { photos }))}
            />

            <Card>
              <p className="text-sm leading-relaxed text-ink-2">
                {coverage.available} of {coverage.total} movements in the library are
                possible here — {coverage.percent}%.
              </p>
            </Card>

            <div className="flex flex-col gap-2">
              <Button variant="secondary" block onClick={onDuplicate}>
                Duplicate this gym
              </Button>
              {!profile.builtIn && (
                <Button variant="destructive" block onClick={onDelete}>
                  Delete this gym
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="sticky bottom-0 mt-6 flex gap-3 bg-bg/90 py-3 backdrop-blur safe-b">
        <Button
          variant="secondary"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
        >
          Back
        </Button>
        <Button
          variant="primary"
          block
          onClick={() => (step === lastStep ? onClose() : setStep((s) => s + 1))}
        >
          {step === lastStep ? "Done" : `Next — ${ZONES[step + 1]?.label ?? "finish"}`}
        </Button>
      </div>

      <EquipmentDetail
        open={detailFor !== null}
        item={detailFor}
        selection={detailFor === null ? null : selectionOf(profile, detailFor.id)}
        onSave={(next) => onChange(withEquipment(profile, next))}
        onClose={() => setDetailFor(null)}
      />
    </div>
  );
}
