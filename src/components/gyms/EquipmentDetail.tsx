"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { Sheet } from "@/components/ui/Sheet";
import { TextField } from "@/components/ui/TextField";
import {
  EQUIPMENT_BRANDS,
  brandLabel,
  loadUnitLabel,
  loadUnitSuffix,
  type EquipmentBrand,
  type EquipmentItem,
} from "@/lib/gyms/equipment";
import type { EquipmentSelection } from "@/lib/gyms/profiles";
import { cmToIn, feetInchesToCm } from "@/lib/units";

/**
 * @file The "tell me about *your* one" sheet.
 *
 * Ticking "dumbbells" is enough to know a movement is possible. It is not
 * enough to program: a rack that stops at 50 lb and one that stops at 100 lb
 * produce different top sets from the same algorithm, and a bar with
 * micro-plates beside it can progress in ways a bar without them cannot. This
 * is where those facts get captured — optionally, one item at a time, never as
 * a prerequisite for finishing the walk-through.
 *
 * Loads are entered in **pounds**, which is what is painted on the plate and
 * printed on the pin. Distances are entered in **yards** and stored in metres,
 * because a distance is a distance and the app stores those in SI everywhere.
 *
 * The form is a separate component mounted with `key={item.id}`, so opening a
 * different item remounts it and the fields initialise from that item. The
 * obvious alternative — an effect that pushes the item into state — is the
 * cascading-render pattern the React lint rules reject, and rightly: the sheet
 * would render once with the previous machine's numbers.
 */

/** A yards figure as metres. Goes through `@/lib/units` rather than a local
 *  0.9144: one conversion table, one place to be wrong. */
const yardsToM = (yd: number): number => feetInchesToCm(yd * 3, 0) / 100;
/** And back. */
const mToYards = (m: number): number => cmToIn(m * 100) / 36;

function numberOrNull(text: string): number | null {
  const n = Number.parseFloat(text.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sizesFrom(text: string): number[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => Number.parseFloat(p))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts.sort((a, b) => a - b) : null;
}

export interface EquipmentDetailProps {
  open: boolean;
  item: EquipmentItem | null;
  selection: EquipmentSelection | null;
  onSave: (next: EquipmentSelection) => void;
  onClose: () => void;
}

/** Per-gym overrides for one piece of equipment. */
export function EquipmentDetail({
  open,
  item,
  selection,
  onSave,
  onClose,
}: EquipmentDetailProps) {
  if (item === null) return null;
  return (
    <Sheet open={open} onClose={onClose} title={item.label} detent="auto">
      <DetailForm
        key={item.id}
        item={item}
        selection={selection}
        onSave={onSave}
        onClose={onClose}
      />
    </Sheet>
  );
}

function DetailForm({
  item,
  selection,
  onSave,
  onClose,
}: {
  item: EquipmentItem;
  selection: EquipmentSelection | null;
  onSave: (next: EquipmentSelection) => void;
  onClose: () => void;
}) {
  const [minLoad, setMinLoad] = useState(
    String(selection?.minLoad ?? item.minLoad ?? ""),
  );
  const [maxLoad, setMaxLoad] = useState(
    String(selection?.maxLoad ?? item.maxLoad ?? ""),
  );
  const [increment, setIncrement] = useState(
    String(selection?.increment ?? item.increment ?? ""),
  );
  const [sizes, setSizes] = useState(
    (selection?.sizes ?? item.sizes ?? []).join(", "),
  );
  const [span, setSpan] = useState(
    selection?.spanM != null ? String(Math.round(mToYards(selection.spanM))) : "",
  );
  const [brand, setBrand] = useState<EquipmentBrand>(selection?.brand ?? item.brand);

  const scalar =
    item.loadUnit !== "none" &&
    item.loadUnit !== "bodyweight" &&
    item.loadUnit !== "band";
  const suffix = loadUnitSuffix(item.loadUnit) || undefined;
  const showSpan = item.zone === "sled_turf";

  const commit = () => {
    const spanYards = numberOrNull(span);
    onSave({
      id: item.id,
      brand: brand === item.brand ? undefined : brand,
      minLoad: scalar ? numberOrNull(minLoad) : undefined,
      maxLoad: scalar ? numberOrNull(maxLoad) : undefined,
      increment: scalar ? numberOrNull(increment) : undefined,
      sizes: item.sizes !== null ? sizesFrom(sizes) : undefined,
      spanM: showSpan && spanYards !== null ? yardsToM(spanYards) : undefined,
      note: selection?.note,
    });
    onClose();
  };

  return (
    <div className="flex flex-col gap-5 pb-2">
      <p className="text-sm leading-relaxed text-ink-2">
        {item.note || `Loaded in ${loadUnitLabel(item.loadUnit).toLowerCase()}.`}
      </p>

      {scalar && (
        <div className="flex gap-3">
          <TextField
            label="Lightest"
            inputMode="decimal"
            value={minLoad}
            suffix={suffix}
            onChange={(e) => setMinLoad(e.target.value)}
            className="flex-1"
          />
          <TextField
            label="Heaviest"
            inputMode="decimal"
            value={maxLoad}
            suffix={suffix}
            onChange={(e) => setMaxLoad(e.target.value)}
            className="flex-1"
          />
        </div>
      )}

      {scalar && (
        <TextField
          label="Smallest jump"
          inputMode="decimal"
          value={increment}
          suffix={suffix}
          hint={
            item.loadUnit === "plates"
              ? "5 lb is a pair of 2.5s. Set 1 if there are micro-plates."
              : "The step between two settings you can actually select."
          }
          onChange={(e) => setIncrement(e.target.value)}
        />
      )}

      {item.sizes !== null && (
        <TextField
          label="Sizes here"
          inputMode="decimal"
          value={sizes}
          suffix={suffix}
          hint="Comma separated, in pounds. Only the ones this gym owns."
          onChange={(e) => setSizes(e.target.value)}
        />
      )}

      {showSpan && (
        <TextField
          label="Lane length"
          inputMode="numeric"
          value={span}
          suffix="yd"
          hint="A 15 yd lane and a 40 yd lane are different sessions."
          onChange={(e) => setSpan(e.target.value)}
        />
      )}

      <div>
        <p className="mb-2 text-sm text-ink-2">Make</p>
        <ChipRow>
          {EQUIPMENT_BRANDS.map((b) => (
            <Chip key={b} selected={b === brand} onPress={() => setBrand(b)}>
              {brandLabel(b)}
            </Chip>
          ))}
        </ChipRow>
      </div>

      <Button variant="primary" block onClick={commit}>
        Save
      </Button>
    </div>
  );
}
