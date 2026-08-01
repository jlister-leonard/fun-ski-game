'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { NumberPad } from '@/components/ui/NumberPad';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/cn';
import type { Per100g } from '@/data/foods';
import { DIARY_COPY } from './copy';
import { Note } from './atoms';
import type { CustomFoodInput } from './useDiary';

/**
 * @file Typing a food in by hand.
 *
 * Everything is entered **per 100 g**, matching the canonical basis the rest of
 * the app computes on, and matching the second column of a US nutrition label.
 * Entering a whole package and dividing is a separate flow that the portions
 * library already supports via `unscaleToPer100g`; it is not built here, and
 * the channel post says so rather than pretending otherwise.
 *
 * Micronutrients are not asked for and are stored as unknown. A user typing a
 * macro panel off a packet has not typed a retinol figure, and recording one
 * as zero would let a genuinely high-retinol food pass an upper-limit check
 * silently. Unknown suppresses the adequacy check and leaves the limit check
 * running on a lower bound, which is the correct pair of behaviours.
 */

interface NumericField {
  key: keyof Per100g;
  label: string;
  unit: string;
  required: boolean;
}

const FIELDS: readonly NumericField[] = [
  { key: 'kcal', label: 'Energy', unit: 'kcal', required: true },
  { key: 'protein_g', label: 'Protein', unit: 'g', required: true },
  { key: 'carbs_g', label: 'Carbs', unit: 'g', required: true },
  { key: 'fat_g', label: 'Fat', unit: 'g', required: true },
  { key: 'fiber_g', label: 'Fibre', unit: 'g', required: false },
];

export interface CustomFoodSheetProps {
  open: boolean;
  onClose: () => void;
  /** Prefilled from whatever the user had typed into search. */
  initialName?: string;
  onSave: (input: CustomFoodInput) => void | Promise<void>;
}

export function CustomFoodSheet(props: CustomFoodSheetProps) {
  if (!props.open) return null;
  return <CustomFoodBody {...props} />;
}

function CustomFoodBody({ onClose, initialName = '', onSave }: CustomFoodSheetProps) {
  const [name, setName] = useState(initialName);
  const [brand, setBrand] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<keyof Per100g>('kcal');
  const [saving, setSaving] = useState(false);

  const numeric = (key: keyof Per100g): number => {
    const n = Number.parseFloat(values[key] ?? '');
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const complete =
    name.trim().length > 0 &&
    FIELDS.filter((f) => f.required).every((f) => (values[f.key] ?? '').length > 0);

  const submit = async () => {
    if (!complete || saving) return;
    setSaving(true);
    try {
      await onSave({
        name,
        brand: brand.trim() || null,
        per100g: {
          kcal: numeric('kcal'),
          protein_g: numeric('protein_g'),
          carbs_g: numeric('carbs_g'),
          fat_g: numeric('fat_g'),
          fiber_g: numeric('fiber_g'),
          sugar_g: 0,
          satfat_g: 0,
          sodium_mg: 0,
        },
        serving: null,
      });
    } finally {
      setSaving(false);
    }
  };

  const textInput =
    'w-full h-11 rounded-[var(--radius-md)] bg-surface-2 border border-line px-3 text-base text-ink placeholder:text-ink-3 outline-none focus:border-line-strong';

  return (
    <Sheet
      open
      onClose={onClose}
      detent="large"
      title={DIARY_COPY.customFood}
      footer={
        <Button
          variant="primary"
          size="lg"
          block
          loading={saving}
          disabled={!complete}
          onClick={() => void submit()}
        >
          {DIARY_COPY.saveEntry}
        </Button>
      }
    >
      <div className="pb-2 space-y-3">
        <input
          className={textInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={DIARY_COPY.customFoodName}
          aria-label={DIARY_COPY.customFoodName}
          autoFocus={initialName === ''}
        />
        <input
          className={textInput}
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder={DIARY_COPY.brandPlaceholder}
          aria-label={DIARY_COPY.brandPlaceholder}
        />

        <div className="text-xs uppercase tracking-wide text-ink-3 pt-1">
          {DIARY_COPY.customFoodBasis}
        </div>

        <div className="rounded-[var(--radius-lg)] border border-line overflow-hidden divide-y divide-[var(--c-border)]">
          {FIELDS.map((field) => (
            <button
              key={field.key}
              type="button"
              onClick={() => setFocused(field.key)}
              className={cn(
                'flex w-full items-center justify-between px-4 py-3 text-left',
                focused === field.key ? 'bg-accent-quiet' : 'bg-surface',
              )}
            >
              <span className="text-base text-ink">
                {field.label}
                {!field.required && <span className="text-ink-3 text-sm ml-1.5">{DIARY_COPY.optional}</span>}
              </span>
              <span className="tnum text-base text-ink-2">
                {values[field.key] || '—'}
                <span className="text-ink-3 text-sm ml-1">{field.unit}</span>
              </span>
            </button>
          ))}
        </div>

        <NumberPad
          value={values[focused] ?? ''}
          onChange={(next) => setValues((prev) => ({ ...prev, [focused]: next }))}
          allowDecimal
          decimalPlaces={1}
        />

        <Note className="text-ink-3">{DIARY_COPY.customFoodSaved}</Note>
      </div>
    </Sheet>
  );
}
