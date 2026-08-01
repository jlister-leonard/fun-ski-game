"use client";

import { useCallback } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { haptic } from "./haptics";

export interface NumberPadProps {
  /** Current value as a string, so a trailing "." survives round-tripping. */
  value: string;
  onChange: (next: string) => void;
  /** Hidden when the value should be a whole number (reps, sets). */
  allowDecimal?: boolean;
  /** Digits permitted after the point. */
  decimalPlaces?: number;
  /** Replaces the bottom-left key. Use for a unit toggle or a quick action. */
  accessoryKey?: ReactNode;
  onAccessoryPress?: () => void;
  className?: string;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function Backspace() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 5H9.5L3 12l6.5 7H21a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z" />
      <path d="m18 9-5 6M13 9l5 6" />
    </svg>
  );
}

/**
 * In-app numeric keypad.
 *
 * The iOS system keyboard is slow to appear, resizes the viewport, and puts
 * the digits in the wrong place for one-handed use. Logging a weight or a set
 * is the single most repeated action in this app, so it gets a purpose-built
 * pad: large targets, thumb-reachable, no viewport shift, instant.
 *
 * Vibration is used where available. It is a genuine usability win on a pad
 * you operate without looking, and iOS Safari ignores it harmlessly.
 */
export function NumberPad({
  value,
  onChange,
  allowDecimal = true,
  decimalPlaces = 1,
  accessoryKey,
  onAccessoryPress,
  className,
}: NumberPadProps) {
  // Routed through the shared module rather than calling navigator.vibrate
  // directly: this pad's own version fired even when the user had asked for
  // reduced motion, which covers device vibration too.
  const tick = useCallback(() => haptic("selection"), []);

  const pressDigit = useCallback(
    (d: string) => {
      tick();
      const [, frac] = value.split(".");
      if (frac !== undefined && frac.length >= decimalPlaces) return;
      // Avoid "007" while still allowing "0.5".
      if (value === "0") {
        onChange(d);
        return;
      }
      onChange(value + d);
    },
    [value, onChange, decimalPlaces, tick]
  );

  const pressDot = useCallback(() => {
    tick();
    if (value.includes(".")) return;
    onChange(value === "" ? "0." : value + ".");
  }, [value, onChange, tick]);

  const pressBackspace = useCallback(() => {
    tick();
    onChange(value.slice(0, -1));
  }, [value, onChange, tick]);

  const keyClass = cn(
    "flex items-center justify-center h-14 select-none",
    "rounded-[var(--radius-md)] text-2xl font-medium text-ink",
    "transition-[transform,background-color] duration-[var(--duration-fast)]",
    "ease-[var(--ease-out-ios)] active:scale-[0.94] active:bg-surface-2",
    "touch-none"
  );

  return (
    <div
      className={cn("grid grid-cols-3 gap-2", className)}
      role="group"
      aria-label="Number pad"
    >
      {DIGITS.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => pressDigit(d)}
          className={keyClass}
        >
          {d}
        </button>
      ))}

      {allowDecimal ? (
        <button type="button" onClick={pressDot} className={keyClass}>
          .
        </button>
      ) : accessoryKey ? (
        <button
          type="button"
          onClick={onAccessoryPress}
          className={cn(keyClass, "text-base text-ink-2")}
        >
          {accessoryKey}
        </button>
      ) : (
        <div aria-hidden />
      )}

      <button
        type="button"
        onClick={() => pressDigit("0")}
        className={keyClass}
      >
        0
      </button>

      <button
        type="button"
        onClick={pressBackspace}
        aria-label="Delete"
        className={cn(keyClass, "text-ink-2")}
      >
        <Backspace />
      </button>
    </div>
  );
}
