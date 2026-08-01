"use client";

import { useCallback, useId } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { haptic } from "./haptics";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Required when no visible label is associated with the switch. */
  label?: string;
  /** Points at the id of visible text that names the switch. */
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The iOS track-and-knob switch.
 *
 * Off is a bordered track rather than a bare grey fill: an unfilled control
 * whose only boundary is `--c-border` sits at 1.29:1 against the surface, and
 * WCAG 1.4.11 wants 3:1 for something that has no text of its own to identify
 * it. `--c-control-border` exists for exactly this.
 *
 * The knob moves with `translate`, not `left`, so it composites on the GPU and
 * does not lay out on every frame.
 */
export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  disabled,
  className,
}: SwitchProps) {
  const toggle = useCallback(() => {
    haptic("selection");
    onChange(!checked);
  }, [checked, onChange]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={toggle}
      className={cn(
        "relative inline-flex h-8 w-[52px] shrink-0 items-center rounded-full",
        "tap-target-y border transition-colors",
        "duration-[var(--duration-base)] ease-[var(--ease-out-ios)]",
        checked
          ? "border-transparent bg-accent"
          : "border-[var(--c-control-border)] bg-surface-2",
        disabled && "pointer-events-none opacity-40",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-[3px] h-6 w-6 rounded-full",
          "bg-white shadow-[var(--shadow-1)]",
          "transition-transform duration-[var(--duration-base)] ease-[var(--ease-spring)]",
          checked ? "translate-x-[22px]" : "translate-x-0"
        )}
      />
    </button>
  );
}

export interface CheckRowProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * A full-width tickable row — consent, "I've saved this", opt-ins.
 *
 * Structurally a checkbox, not a switch: a switch takes effect immediately,
 * a checkbox states a fact that some later button acts on. The two existing
 * hand-rolled versions both used `role="switch"` for this shape, which tells
 * VoiceOver "on/off" where "ticked/unticked" is meant.
 */
export function CheckRow({
  checked,
  onChange,
  title,
  hint,
  disabled,
  className,
}: CheckRowProps) {
  const id = useId();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-describedby={hint ? `${id}-hint` : undefined}
      disabled={disabled}
      onClick={() => {
        haptic("selection");
        onChange(!checked);
      }}
      className={cn(
        "flex w-full items-start gap-3 py-3 text-left tap",
        "transition-colors duration-[var(--duration-fast)] active:bg-surface-2",
        disabled && "pointer-events-none opacity-40",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border",
          "transition-colors duration-[var(--duration-fast)]",
          checked
            ? "border-transparent bg-accent text-accent-ink"
            : "border-[var(--c-control-border)] bg-surface"
        )}
      >
        {checked && (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 13 4 4L19 7" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-base text-ink">{title}</span>
        {hint && (
          <span id={`${id}-hint`} className="mt-0.5 block text-sm leading-relaxed text-ink-2">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}
