'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { NumberPad } from '@/components/ui/NumberPad';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/cn';
import { gToOz, ozToG } from '@/lib/units';
import { defaultServing, scaleMacros } from '@/lib/food/portions';
import type { FoodItem } from '@/data/foods';
import type { MealSlot } from '@/lib/db/types';
import { DIARY_COPY, SLOT_LABELS, SLOT_ORDER } from './copy';
import { EnergyValue, Note, formatGrams } from './atoms';

/**
 * @file Portion entry — the second half of "log a food in under five seconds".
 *
 * ## Why there is no system keyboard here
 *
 * iOS's numeric keyboard takes ~300 ms to appear, resizes the viewport, and
 * puts the digits at the top of the pad rather than under the thumb. Logging a
 * portion is the most-repeated action in this app, so it gets `NumberPad` from
 * the design system instead — no viewport shift, instant, one-handed.
 *
 * ## Why named servings come first
 *
 * The seed database ships 3,418 named servings with real gram weights, roughly
 * 2.2 per food. A tracker that only accepts grams is a tracker nobody uses:
 * nobody weighs a banana. The default serving is preselected with a count of
 * one, so the common case is *open, confirm* — the pad is there for the case
 * where it is not.
 *
 * ## The two notes that are not decoration
 *
 * Raw and cooked are separate database entries, and the same chicken breast is
 * 120 kcal/100 g raw against 165 cooked. That is the single most-mislogged
 * thing in any tracker, so the distinction is surfaced rather than buried in a
 * result list. And restaurant rows are derived from a published panel divided
 * by a published item weight, so they are logged by the named item and never
 * by typing grams.
 */

type AmountUnit = 'serving' | 'g' | 'oz';

export interface PortionSheetProps {
  open: boolean;
  onClose: () => void;
  item: FoodItem | null;
  /** Preselected meal. */
  slot: MealSlot;
  /** Existing quantity in grams, when editing rather than adding. */
  initialGrams?: number;
  hideCalories: boolean;
  /** `true` shows US customary as an alternative to grams. */
  imperial: boolean;
  onSubmit: (params: { grams: number; slot: MealSlot }) => void | Promise<void>;
  /** Shown instead of "Add to diary" when editing. */
  editing?: boolean;
  onRemove?: () => void | Promise<void>;
}

function parseAmount(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function PortionSheet({
  open,
  onClose,
  item,
  slot,
  initialGrams,
  hideCalories,
  imperial,
  onSubmit,
  editing = false,
  onRemove,
}: PortionSheetProps) {
  if (!open || !item) return null;
  return (
    <PortionSheetBody
      key={`${item.id}:${initialGrams ?? ''}`}
      onClose={onClose}
      item={item}
      slot={slot}
      initialGrams={initialGrams}
      hideCalories={hideCalories}
      imperial={imperial}
      onSubmit={onSubmit}
      editing={editing}
      onRemove={onRemove}
    />
  );
}

function PortionSheetBody({
  onClose,
  item,
  slot: initialSlot,
  initialGrams,
  hideCalories,
  imperial,
  onSubmit,
  editing,
  onRemove,
}: Omit<PortionSheetProps, 'open' | 'item'> & { item: FoodItem }) {
  const preselected = useMemo(() => defaultServing(item), [item]);

  const [servingLabel, setServingLabel] = useState(preselected.label);
  const [unit, setUnit] = useState<AmountUnit>(initialGrams === undefined ? 'serving' : 'g');
  const [value, setValue] = useState(() =>
    initialGrams === undefined ? '1' : String(Math.round(initialGrams)),
  );
  const [slot, setSlot] = useState<MealSlot>(initialSlot);
  const [saving, setSaving] = useState(false);

  const serving = useMemo(
    () => item.servings.find((s) => s.label === servingLabel) ?? preselected,
    [item.servings, servingLabel, preselected],
  );

  const grams = useMemo(() => {
    const amount = parseAmount(value);
    if (unit === 'serving') return amount * serving.grams;
    if (unit === 'oz') return ozToG(amount);
    return amount;
  }, [value, unit, serving]);

  const preview = useMemo(() => scaleMacros(item.per100g, grams), [item.per100g, grams]);

  const isRestaurant = item.category === 'restaurant';
  const nameSuggestsState = /\b(raw|cooked|roasted|boiled|grilled|fried|baked|dry|uncooked)\b/i.test(
    item.name,
  );

  const chipClass = (active: boolean) =>
    cn(
      'shrink-0 rounded-full px-3 h-9 text-sm border transition-colors',
      'duration-[var(--duration-fast)] active:scale-[0.97]',
      active
        ? 'bg-accent-quiet text-accent border-transparent font-medium'
        : 'bg-surface-2 text-ink-2 border-line',
    );

  const submit = async () => {
    if (!(grams > 0) || saving) return;
    setSaving(true);
    try {
      await onSubmit({ grams, slot });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      detent="large"
      title={item.name}
      footer={
        <div className="flex gap-2">
          {editing && onRemove && (
            <Button variant="secondary" size="lg" onClick={() => void onRemove()}>
              {DIARY_COPY.removeEntry}
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            block
            loading={saving}
            disabled={!(grams > 0)}
            onClick={() => void submit()}
          >
            {editing ? DIARY_COPY.updateEntry : DIARY_COPY.saveEntry}
          </Button>
        </div>
      }
    >
      <div className="pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {item.brand && <span className="text-sm text-ink-2">{item.brand}</span>}
          {!item.verified && (
            <span className="text-xs rounded-full px-2 py-0.5 bg-surface-2 text-ink-3">
              {DIARY_COPY.unverifiedBadge}
            </span>
          )}
        </div>

        {/* --- live preview of what is about to be logged ------------------ */}
        <div className="mt-3 rounded-[var(--radius-md)] bg-surface-2 px-3 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-ink-2">{formatGrams(grams)}</span>
            <EnergyValue
              kcal={preview.kcal}
              hidden={hideCalories}
              className="text-xl font-semibold text-ink"
            />
          </div>
          <div className="mt-1 flex gap-4 text-xs text-ink-3 tnum">
            <span>P {Math.round(preview.protein_g)} g</span>
            <span>C {Math.round(preview.carbs_g)} g</span>
            <span>F {Math.round(preview.fat_g)} g</span>
            <span>Fibre {Math.round(preview.fiber_g)} g</span>
          </div>
        </div>

        {/* --- servings ---------------------------------------------------- */}
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wide text-ink-3">
            {DIARY_COPY.servingsHeading}
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto scroll-touch pb-1 -mx-1 px-1">
            {item.servings.map((s) => (
              <button
                key={s.label}
                type="button"
                className={chipClass(unit === 'serving' && s.label === serving.label)}
                onClick={() => {
                  setServingLabel(s.label);
                  setUnit('serving');
                  setValue('1');
                }}
              >
                {s.label}
              </button>
            ))}
            <button
              type="button"
              className={chipClass(unit !== 'serving')}
              onClick={() => {
                setUnit('g');
                setValue(String(Math.round(grams)));
              }}
              disabled={isRestaurant}
            >
              {DIARY_COPY.customAmount}
            </button>
          </div>
        </div>

        {isRestaurant && <Note className="mt-2 text-ink-3">{DIARY_COPY.restaurantNote}</Note>}
        {nameSuggestsState && <Note className="mt-2 text-ink-3">{DIARY_COPY.rawCookedNote}</Note>}
        {!item.verified && (
          <Note className="mt-2 text-ink-3">
            {item.source.startsWith('Open Food Facts')
              ? DIARY_COPY.openFoodFactsNote
              : DIARY_COPY.unverifiedNote}
          </Note>
        )}

        {/* --- the pad ----------------------------------------------------- */}
        <div className="mt-4 flex items-baseline justify-between">
          <span className="text-sm text-ink-2">
            {unit === 'serving' ? serving.label : unit === 'oz' ? DIARY_COPY.ouncesUnit : DIARY_COPY.gramsUnit}
          </span>
          <span className="text-3xl font-semibold text-ink tnum">
            {value === '' ? '0' : value}
          </span>
        </div>

        <NumberPad
          className="mt-3"
          value={value}
          onChange={setValue}
          allowDecimal
          decimalPlaces={unit === 'serving' ? 2 : 0}
        />

        {imperial && unit !== 'serving' && (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={chipClass(unit === 'g')}
              onClick={() => {
                setUnit('g');
                setValue(String(Math.round(grams)));
              }}
            >
              {DIARY_COPY.gramsUnit}
            </button>
            <button
              type="button"
              className={chipClass(unit === 'oz')}
              onClick={() => {
                setUnit('oz');
                setValue(String(Math.round(gToOz(grams) * 10) / 10));
              }}
            >
              {DIARY_COPY.ouncesUnit}
            </button>
          </div>
        )}

        {/* --- meal slot --------------------------------------------------- */}
        <div className="mt-5">
          <div className="text-xs uppercase tracking-wide text-ink-3">
            {DIARY_COPY.slotHeading}
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto scroll-touch pb-1 -mx-1 px-1">
            {SLOT_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                className={chipClass(s === slot)}
                onClick={() => setSlot(s)}
              >
                {SLOT_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
