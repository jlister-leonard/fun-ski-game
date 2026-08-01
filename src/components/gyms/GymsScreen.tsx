"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { EmptyNote } from "@/components/ui/EmptyState";
import { ListGroup, ListRow } from "@/components/ui/ListRow";
import { Sheet } from "@/components/ui/Sheet";
import { TextField } from "@/components/ui/TextField";
import { toast } from "@/components/ui/Toast";
import {
  coverageOf,
  gymKindLabel,
  powerCapableEquipment,
  type GymKind,
  type GymProfile,
} from "@/lib/gyms/profiles";
import { ProfileEditor } from "./ProfileEditor";
import { useGyms } from "./useGyms";

/**
 * @file Gyms & equipment.
 *
 * The hub does two jobs, and they are deliberately different shapes:
 *
 * - **Switching gyms is a chip row.** One tap, no sheet, no confirmation. It
 *   is the thing that happens three times a week and it should cost nothing.
 * - **Editing a gym is a list row** that opens the walk-through. It happens
 *   twice a year and can afford a screen of its own.
 *
 * Merging them into one control would make the frequent action carry the
 * ceremony of the rare one.
 */

const NEW_KINDS: readonly { kind: GymKind; label: string; blurb: string }[] = [
  {
    kind: "commercial",
    label: "Commercial gym",
    blurb: "Starts fully ticked. Untick what yours does not have.",
  },
  {
    kind: "trainer",
    label: "Trainer's studio",
    blurb: "Pneumatic machines, sled and turf, not much chrome.",
  },
  { kind: "home", label: "Home", blurb: "Adjustable dumbbells, a bench, bands." },
  { kind: "travel", label: "Travel", blurb: "Bodyweight and whatever fits in a bag." },
  { kind: "other", label: "Start from nothing", blurb: "Tick it all yourself." },
];

/** The gyms hub: switch, add, edit. */
export function GymsScreen() {
  const gyms = useGyms();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const editing = useMemo(
    () => gyms.state.profiles.find((p) => p.id === editingId) ?? null,
    [gyms.state.profiles, editingId],
  );

  const add = async (kind: GymKind) => {
    const name = newName.trim() || gymKindLabel(kind);
    const created = await gyms.create(name, kind);
    setAdding(false);
    setNewName("");
    if (created === null) {
      toast("That gym could not be saved.", { tone: "warn" });
      return;
    }
    gyms.activate(created.id);
    setEditingId(created.id);
  };

  const duplicate = async (source: GymProfile) => {
    const copy = await gyms.duplicate(source.id, `${source.name} copy`);
    if (copy === null) {
      toast("That gym could not be copied.", { tone: "warn" });
      return;
    }
    setEditingId(copy.id);
    toast("Copied. Edit the differences.");
  };

  if (!gyms.ready) {
    return <p className="py-8 text-sm text-ink-2">Opening your gyms…</p>;
  }

  if (editing !== null) {
    return (
      <ProfileEditor
        profile={editing}
        onChange={gyms.save}
        onClose={() => setEditingId(null)}
        onDuplicate={() => void duplicate(editing)}
        onDelete={() => {
          gyms.remove(editing.id);
          setEditingId(null);
          toast(`${editing.name} deleted`);
        }}
      />
    );
  }

  const active = gyms.active;
  const coverage = coverageOf(active);
  const power = powerCapableEquipment(active);

  return (
    <div className="flex flex-col gap-6 pb-6">
      <section>
        <p className="mb-2 px-1 text-sm text-ink-2">Training at</p>
        <ChipRow>
          {gyms.state.profiles.map((profile) => (
            <Chip
              key={profile.id}
              selected={profile.id === gyms.state.activeId}
              onPress={() => gyms.activate(profile.id)}
            >
              {profile.name}
            </Chip>
          ))}
        </ChipRow>
      </section>

      <Card>
        <CardHeader
          title={active.name}
          subtitle={gymKindLabel(active.kind)}
          accessory={<Badge tone="accent">{coverage.percent}%</Badge>}
        />
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          {coverage.available} of {coverage.total} movements in the library are
          possible here.
          {power.length > 0 && (
            <>
              {" "}
              {power.length} {power.length === 1 ? "piece" : "pieces"} of kit here
              read power in watts, so intervals can be prescribed in watts rather
              than in effort.
            </>
          )}
        </p>
        {active.note !== "" && (
          <p className="mt-2 text-sm leading-relaxed text-ink-3">{active.note}</p>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => setEditingId(active.id)}
        >
          Edit equipment
        </Button>
      </Card>

      <section>
        <p className="mb-2 px-1 text-sm text-ink-2">Your gyms</p>
        <ListGroup>
          {gyms.state.profiles.map((profile) => {
            const c = coverageOf(profile);
            return (
              <ListRow
                key={profile.id}
                title={profile.name}
                subtitle={`${gymKindLabel(profile.kind)} · ${c.available} movements`}
                value={profile.id === gyms.state.activeId ? "Active" : undefined}
                onPress={() => setEditingId(profile.id)}
              />
            );
          })}
        </ListGroup>
        <EmptyNote>
          The travel profile is built in and cannot be deleted — it is the floor
          you fall back to somewhere new.
        </EmptyNote>
      </section>

      <Button variant="primary" block onClick={() => setAdding(true)}>
        Add a gym
      </Button>

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a gym"
        detent="auto"
      >
        <div className="flex flex-col gap-4 pb-2">
          <TextField
            label="Name"
            placeholder="Main gym"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <p className="text-sm leading-relaxed text-ink-2">
            Pick a starting point. Everything is seeded so you are confirming
            rather than typing — you can change any of it in the walk-through.
          </p>
          <ListGroup>
            {NEW_KINDS.map(({ kind, label, blurb }) => (
              <ListRow
                key={kind}
                title={label}
                subtitle={blurb}
                onPress={() => void add(kind)}
              />
            ))}
          </ListGroup>
        </div>
      </Sheet>
    </div>
  );
}
