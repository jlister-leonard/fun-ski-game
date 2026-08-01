"use client";

import { useCallback, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { haptic } from "./haptics";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Used for the accessible name when `label` is an icon or a fragment. */
  name?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * `radiogroup` — picking a value (units, sex, goal). The default.
   * `tablist` — switching which panel is shown. Only correct when the segments
   * actually control a `role="tabpanel"` region; using it for a value picker
   * makes VoiceOver announce "tab" for something that is not navigation.
   */
  role?: "radiogroup" | "tablist";
  /** Required unless a visible `<label>`/`<legend>` already names the group. */
  label?: string;
  /** Stretches each segment to an equal share of the width. */
  block?: boolean;
  size?: "sm" | "md";
  className?: string;
}

/**
 * The iOS segmented control.
 *
 * Six near-identical versions of this existed across Settings, Train, Recovery
 * and two training sheets before it was extracted — three of them inside a
 * single file. Two of those six put `role="radio"` on the buttons with no
 * `radiogroup` ancestor, which makes a screen reader announce every option as
 * "1 of 1".
 *
 * Three things this gets right that a hand-rolled version usually does not:
 *
 * - **Roving tabindex.** The group is one Tab stop, and arrow keys move
 *   between segments — the behaviour a native radio group has and the one
 *   VoiceOver users expect. Eight separate Tab stops for one setting is a
 *   worse experience than the visual design implies.
 * - **A 44pt hit region** without a 44px-tall control. The pill stays 35–40px
 *   for the sake of the layout; `tap-target-y` grows only the height, so
 *   neighbouring segments never steal each other's taps.
 * - **The thumb moves, it does not appear.** The selected segment's background
 *   transitions, which is what makes it read as one control rather than a row
 *   of buttons.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  role = "radiogroup",
  label,
  block = true,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  const groupId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const isTabs = role === "tablist";

  const select = useCallback(
    (next: T) => {
      if (next === value) return;
      haptic("selection");
      onChange(next);
    },
    [onChange, value]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(e.key)) return;
      const usable = options.filter((o) => !o.disabled);
      if (usable.length === 0) return;
      const at = Math.max(0, usable.findIndex((o) => o.value === value));
      const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      const next =
        e.key === "Home"
          ? usable[0]
          : e.key === "End"
            ? usable[usable.length - 1]
            : usable[(at + step + usable.length) % usable.length];
      e.preventDefault();
      select(next.value);
      // Move DOM focus with the selection, or the roving tabindex leaves focus
      // on a segment that is no longer the active one.
      ref.current
        ?.querySelector<HTMLButtonElement>(`[data-seg="${CSS.escape(next.value)}"]`)
        ?.focus();
    },
    [options, select, value]
  );

  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex rounded-[var(--radius-sm)] bg-surface-2 p-0.5",
        block && "flex w-full",
        className
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-seg={o.value}
            role={isTabs ? "tab" : "radio"}
            id={isTabs ? `${groupId}-${o.value}` : undefined}
            {...(isTabs ? { "aria-selected": active } : { "aria-checked": active })}
            // Roving tabindex: one stop for the whole group.
            tabIndex={active ? 0 : -1}
            disabled={o.disabled}
            aria-label={o.name}
            onClick={() => select(o.value)}
            className={cn(
              "tap-target-y min-w-0 flex-1 select-none truncate rounded-[calc(var(--radius-sm)-2px)]",
              "font-medium transition-[background-color,color,box-shadow]",
              "duration-[var(--duration-fast)] ease-[var(--ease-out-ios)]",
              size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-sm",
              active
                ? "bg-surface text-ink shadow-[var(--shadow-1)]"
                : "text-ink-2 active:text-ink",
              o.disabled && "pointer-events-none opacity-40"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
