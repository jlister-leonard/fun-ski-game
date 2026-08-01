"use client";

import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  /** Hides the label visually but keeps it for screen readers. */
  labelHidden?: boolean;
  hint?: ReactNode;
  /** Shown in place of the hint, and wired to `aria-describedby`. */
  error?: ReactNode;
  /** Right-aligned suffix inside the field — "kg", "kcal". */
  suffix?: ReactNode;
  className?: string;
  fieldClassName?: string;
}

/**
 * A labelled text input.
 *
 * Three versions of this existed, and one screen inlined the label-plus-hint
 * markup without using any of them. Two things here are not cosmetic:
 *
 * - **The border is `--c-control-border`, not `--c-border`.** Measured, the
 *   old border sat at 1.29:1 against the surface. A card edge may be that
 *   quiet; a text field may not, because the edge is the only thing saying
 *   "you can type here" (WCAG 1.4.11). The new token is 3.35–3.57:1.
 * - **16px minimum font size**, always. iOS zooms the viewport when a field
 *   under 16px takes focus, and the zoom does not undo itself. Most numeric
 *   entry in this app goes through NumberPad and never summons a keyboard at
 *   all, but where a real one is unavoidable this is the floor.
 *
 * `aria-describedby` points at the hint *or* the error, never both, so a
 * screen reader reads the correction rather than the original advice.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    {
      label,
      labelHidden = false,
      hint,
      error,
      suffix,
      id,
      className,
      fieldClassName,
      disabled,
      ...rest
    },
    ref
  ) {
    const auto = useId();
    const fieldId = id ?? auto;
    const describedBy = error ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined;

    return (
      <div className={className}>
        <label
          htmlFor={fieldId}
          className={cn(
            labelHidden ? "sr-only" : "block text-sm text-ink-2",
            disabled && !labelHidden && "opacity-50"
          )}
        >
          {label}
        </label>
        <div
          className={cn(
            "mt-1 flex items-center gap-2 rounded-[var(--radius-md)] border bg-surface px-3",
            "transition-colors duration-[var(--duration-fast)]",
            error
              ? "border-danger"
              : "border-[var(--c-control-border)] focus-within:border-accent",
            disabled && "opacity-50",
            fieldClassName
          )}
        >
          <input
            ref={ref}
            id={fieldId}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // Not a class: a utility can be purged, overridden or forgotten,
            // and the cost of getting this wrong is a viewport zoom the user
            // cannot undo.
            style={{ fontSize: 16 }}
            className="min-w-0 flex-1 bg-transparent py-3 text-ink outline-none placeholder:text-ink-3"
            {...rest}
          />
          {suffix && <span className="shrink-0 text-sm text-ink-3">{suffix}</span>}
        </div>
        {error ? (
          <p id={`${fieldId}-err`} className="mt-1 text-xs leading-relaxed text-danger">
            {error}
          </p>
        ) : hint ? (
          <p id={`${fieldId}-hint`} className="mt-1 text-xs leading-relaxed text-ink-3">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
