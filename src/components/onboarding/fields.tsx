"use client";

import { useCallback, useId, useState } from "react";
import type { ReactNode } from "react";
import { Chip } from "@/components/ui/Chip";
import { TextField } from "@/components/ui/TextField";
import { cn } from "@/lib/cn";

/**
 * @file The intake's shared input parts.
 *
 * ## One pad, several targets
 *
 * Numeric entry goes through `NumberPad`, never the iOS keyboard — the system
 * keyboard resizes the viewport, takes a beat to appear, and puts the digits
 * where a thumb is not. But a screen asking for a date of birth, a height and a
 * weight cannot afford one pad per field. So the pattern `LogWeightSheet`
 * already uses is generalised here: several {@link PadCell}s, one pad at the
 * bottom, and tapping a cell moves the pad to it. Which cell is live is
 * `aria-pressed`, so a screen reader gets the same information the fill colour
 * gives everyone else.
 *
 * Alphabetic fields — a medication name, what a trainer covers — use a real
 * keyboard, because that is what they are for.
 */

/** A labelled block with an optional explanation of why it is being asked. */
export function Question({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={className} aria-labelledby={id}>
      <h2 id={id} className="text-sm font-medium text-ink">
        {label}
      </h2>
      {hint && (
        <p className="mt-1 text-xs text-ink-3 leading-relaxed">{hint}</p>
      )}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export interface PadCellProps {
  /** The digits typed so far, as a string. */
  value: string;
  /** Shown when nothing has been typed. */
  placeholder?: string;
  /** Trailing unit, e.g. "lb" or "%". */
  unit?: string;
  /** Caption under the number. */
  caption: string;
  active: boolean;
  onFocus: () => void;
  className?: string;
}

/**
 * One numeric cell in a pad-driven form.
 *
 * Deliberately not an `<input>`: there is no keyboard to summon, and a
 * read-only input that opens nothing on tap is a worse lie than a button.
 */
export function PadCell({
  value,
  placeholder = "—",
  unit,
  caption,
  active,
  onFocus,
  className,
}: PadCellProps) {
  return (
    <button
      type="button"
      onClick={onFocus}
      aria-pressed={active}
      aria-label={caption}
      className={cn(
        "flex-1 rounded-[var(--radius-md)] border px-2 py-2.5 text-center",
        "transition-colors duration-[var(--duration-fast)]",
        active
          ? "border-accent bg-accent-quiet"
          : "border-[var(--c-control-border)] bg-surface",
        className
      )}
    >
      <span className="flex items-baseline justify-center gap-1">
        <span
          className={cn(
            "text-2xl font-semibold tnum tracking-[-0.02em]",
            value ? "text-ink" : "text-ink-3"
          )}
        >
          {value || placeholder}
        </span>
        {unit && <span className="text-sm text-ink-2">{unit}</span>}
      </span>
      <span className="mt-0.5 block text-2xs text-ink-3">{caption}</span>
    </button>
  );
}

/** A row of single-select chips. */
export function ChipChoice<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((option) => (
        <Chip
          key={String(option.value)}
          selected={value === option.value}
          onPress={() => onChange(option.value)}
        >
          {option.label}
        </Chip>
      ))}
    </div>
  );
}

/** A row of multi-select chips. */
export function ChipMulti<T extends string | number>({
  options,
  values,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  values: readonly T[];
  onChange: (next: T[]) => void;
  label: string;
}) {
  const toggle = useCallback(
    (value: T) => {
      onChange(
        values.includes(value)
          ? values.filter((v) => v !== value)
          : [...values, value]
      );
    },
    [values, onChange]
  );

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((option) => (
        <Chip
          key={String(option.value)}
          selected={values.includes(option.value)}
          onPress={() => toggle(option.value)}
        >
          {option.label}
        </Chip>
      ))}
    </div>
  );
}

/**
 * A grow-as-you-type list of free-text entries.
 *
 * Used for medications, supplements and anything else where the vocabulary is
 * the user's rather than ours. Entries are stored verbatim; nothing here parses
 * them for meaning, and nothing shows them back as a judgement.
 */
export function TextList({
  label,
  labelHidden,
  hint,
  placeholder,
  items,
  onChange,
  autoComplete = "off",
}: {
  label: string;
  /** Set when a surrounding `Question` already names the field. */
  labelHidden?: boolean;
  hint?: ReactNode;
  placeholder: string;
  items: readonly string[];
  onChange: (next: string[]) => void;
  autoComplete?: string;
}) {
  const [draft, setDraft] = useState("");

  const add = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!items.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...items, trimmed]);
    }
    setDraft("");
  }, [draft, items, onChange]);

  return (
    <div>
      <TextField
        label={label}
        labelHidden={labelHidden}
        hint={hint}
        placeholder={placeholder}
        value={draft}
        autoComplete={autoComplete}
        autoCapitalize="words"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
      {items.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {items.map((item) => (
            <li key={item}>
              <Chip selected onPress={() => onChange(items.filter((i) => i !== item))}>
                <span>{item}</span>
                {/* The chip is the remove control; the label says so rather
                    than relying on an × glyph a screen reader would read as
                    "multiplication sign". */}
                <span className="sr-only">Remove</span>
                <span aria-hidden className="text-ink-3">
                  &times;
                </span>
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
