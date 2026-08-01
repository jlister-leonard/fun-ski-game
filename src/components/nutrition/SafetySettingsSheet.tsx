'use client';

import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { DIARY_COPY } from './copy';
import { Note } from './atoms';

/**
 * @file Display and safety settings.
 *
 * ## Requirement 9, in one screen
 *
 * > Safety settings are re-offerable, never one-shot. A user who declined
 * > "hide calories" at onboarding must be able to find it later without
 * > hunting. A setting offered once and buried is a setting that does not
 * > exist.
 *
 * This sheet is reachable from a permanently visible row at the bottom of the
 * diary — not from a global settings tab two screens away, and not only from
 * onboarding. The intro copy says explicitly that it works in both directions,
 * because a safety setting a user believes is irreversible is one they will
 * not try.
 *
 * ## What is *not* here
 *
 * Streaks, gamification, celebration and weight projections are not settings.
 * They are absent from the product, and `validateTrackingSafety()` treats them
 * as `block`-level invariants rather than preferences. Rendering them as
 * switched-off toggles would imply they could be switched on.
 */

export interface SafetySettingsSheetProps {
  open: boolean;
  onClose: () => void;
  hideCalories: boolean;
  onChangeHideCalories: (next: boolean) => void | Promise<void>;
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-8 w-[52px] shrink-0 rounded-full transition-colors',
        'duration-[var(--duration-base)] ease-[var(--ease-out-ios)]',
        checked ? 'bg-accent' : 'bg-surface-2 border border-line',
      )}
    >
      <span
        className={cn(
          'absolute top-1 h-6 w-6 rounded-full bg-white shadow-[var(--shadow-1)]',
          'transition-transform duration-[var(--duration-base)] ease-[var(--ease-out-ios)]',
          checked ? 'translate-x-[22px]' : 'translate-x-1',
        )}
      />
    </button>
  );
}

export function SafetySettingsSheet({
  open,
  onClose,
  hideCalories,
  onChangeHideCalories,
}: SafetySettingsSheetProps) {
  if (!open) return null;

  return (
    <Sheet
      open
      onClose={onClose}
      detent="auto"
      title={DIARY_COPY.settingsHeading}
      footer={
        <Button variant="secondary" size="lg" block onClick={onClose}>
          {DIARY_COPY.done}
        </Button>
      }
    >
      <div className="pb-2 space-y-4">
        <Note>{DIARY_COPY.settingsIntro}</Note>

        <div className="rounded-[var(--radius-lg)] border border-line bg-surface p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-base text-ink">{DIARY_COPY.hideCaloriesLabel}</div>
            </div>
            <Toggle
              checked={hideCalories}
              onChange={(next) => void onChangeHideCalories(next)}
              label={DIARY_COPY.hideCaloriesLabel}
            />
          </div>
          <Note className="mt-2 text-ink-3">{DIARY_COPY.hideCaloriesDetail}</Note>
        </div>

        <Note className="text-ink-3">{DIARY_COPY.notMedicalAdvice}</Note>
      </div>
    </Sheet>
  );
}
