"use client";

import { useId } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A labelled text field.
 *
 * Local to settings rather than promoted into `components/ui` because the UI
 * package is another agent's; if a second screen needs it, that is the moment
 * to move it rather than now.
 */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  placeholder,
  hint,
  invalid,
  disabled,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: "text" | "password" | "date" | "number";
  autoComplete?: string;
  placeholder?: string;
  hint?: ReactNode;
  invalid?: boolean;
  disabled?: boolean;
  inputMode?: "text" | "numeric" | "decimal";
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm text-ink-2">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        // The comment here used to say "16px minimum, or iOS Safari zooms the
        // viewport on focus" while the class next to it was `text-base`, which
        // this design system defines as 15px. Measured: all seven text fields
        // in the app rendered at 15px, so focusing any of them zoomed the page
        // and iOS never zooms back. An inline style rather than a class,
        // because this must not be overridable by accident.
        style={{ fontSize: 16 }}
        className={cn(
          "mt-1 w-full rounded-[var(--radius-md)] border bg-surface-2 px-3 py-2.5",
          "text-ink placeholder:text-ink-3",
          "outline-none focus:border-accent",
          // --c-border is 1.29:1 against the surface. On a card edge that is
          // the point; on a text field the border is the only thing saying
          // "type here", and WCAG 1.4.11 asks for 3:1. This token is 3.45.
          invalid ? "border-danger" : "border-[var(--c-control-border)]",
          disabled && "opacity-50"
        )}
      />
      {hint && <p className="mt-1 text-xs text-ink-3 leading-relaxed">{hint}</p>}
    </div>
  );
}

/** A row with a label on the left and a control on the right. */
export function SettingRow({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-base text-ink">{title}</div>
        {subtitle && (
          <div className="mt-0.5 text-sm text-ink-2 leading-snug">{subtitle}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A segmented control — the iOS pattern for two or three exclusive choices. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-[var(--radius-sm)] bg-surface-2 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              // Measured at 31x58 — under Apple's 44pt floor on the short
              // axis. `tap-target-y` grows only the hit height, so adjacent
              // segments never steal each other's taps.
              "px-3 py-1.5 text-sm rounded-[calc(var(--radius-sm)-2px)] tap-target-y",
              "transition-colors duration-[var(--duration-fast)]",
              active
                ? "bg-surface text-ink font-medium shadow-[var(--shadow-1)]"
                : "text-ink-2"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
