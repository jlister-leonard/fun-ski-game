"use client";

import Link from "next/link";
import { forwardRef, useCallback } from "react";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  MouseEvent,
  ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { haptic, type Haptic } from "./haptics";
import { Spinner } from "./Spinner";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "quiet"
  | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretches to the container. The default for anything in a sheet footer. */
  block?: boolean;
  /** Shows a spinner and blocks interaction without collapsing the layout. */
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Which haptic to fire on press. `null` for none. */
  feedback?: Haptic | null;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink active:bg-accent-hover shadow-[var(--shadow-1)]",
  secondary:
    "bg-surface-2 text-ink border border-line active:bg-elevated",
  ghost: "bg-transparent text-ink active:bg-surface-2",
  quiet: "bg-accent-quiet text-accent active:bg-accent-quiet",
  destructive: "bg-danger-quiet text-danger active:bg-danger-quiet",
};

/**
 * `sm` is 36px tall by design — a card's secondary action should not have the
 * visual weight of a primary one. 36 is under Apple's 44pt floor, so it carries
 * `tap-target`, which grows the *hit region* to 44×44 with a centred
 * pseudo-element and leaves the pill exactly where it was. Measured before the
 * change: twelve 36px-tall buttons across Today, Food, Body, Train and
 * Settings, every one of them failing the HIG minimum.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm rounded-[var(--radius-sm)] gap-1.5 tap-target",
  md: "h-11 px-4 text-base rounded-[var(--radius-md)] gap-2",
  lg: "h-[52px] px-5 text-lg rounded-[var(--radius-md)] gap-2",
};

function buttonClasses({
  variant,
  size,
  block,
  disabled,
  className,
}: {
  variant: ButtonVariant;
  size: ButtonSize;
  block: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return cn(
    "relative inline-flex items-center justify-center font-medium select-none",
    "transition-[transform,background-color,opacity]",
    "duration-[var(--duration-fast)] ease-[var(--ease-out-ios)]",
    "active:scale-[0.97]",
    disabled &&
      "opacity-40 active:scale-100 pointer-events-none",
    VARIANTS[variant],
    SIZES[size],
    block && "w-full",
    className
  );
}

/**
 * The standard button.
 *
 * Presses scale down slightly rather than changing colour alone — on a touch
 * screen the finger covers the control, so the feedback has to be visible at
 * the edges.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      block = false,
      loading = false,
      leading,
      trailing,
      disabled,
      feedback = "light",
      onClick,
      className,
      children,
      ...rest
    },
    ref
  ) {
    const isDisabled = disabled || loading;

    const handleClick = useCallback(
      (e: MouseEvent<HTMLButtonElement>) => {
        if (feedback) haptic(feedback);
        onClick?.(e);
      },
      [feedback, onClick]
    );

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        onClick={handleClick}
        className={buttonClasses({
          variant,
          size,
          block,
          disabled: isDisabled,
          className,
        })}
        {...rest}
      >
        {/* The label stays mounted and merely invisible, so the button keeps
            its width and the row does not reflow while something is saving.
            `aria-busy` on the button is what announces the state; the spinner
            itself is decorative here, hence `label={null}`. */}
        {loading && <Spinner label={null} className="absolute" />}
        <span
          className={cn(
            "inline-flex items-center justify-center gap-[inherit]",
            loading && "invisible"
          )}
        >
          {leading}
          {children}
          {trailing}
        </span>
      </button>
    );
  }
);

export interface ButtonLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  feedback?: Haptic | null;
}

/**
 * A button-shaped client-side link.
 *
 * Keel's vault key exists only in memory. A document navigation would discard
 * that key and re-lock the app. Real links let Next navigate in place and
 * preserve the live session.
 */
export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  block = false,
  leading,
  trailing,
  feedback = "light",
  onClick,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      href={href}
      onClick={(event) => {
        if (feedback) haptic(feedback);
        onClick?.(event);
      }}
      className={buttonClasses({ variant, size, block, className })}
      {...rest}
    >
      <span className="inline-flex items-center justify-center gap-[inherit]">
        {leading}
        {children}
        {trailing}
      </span>
    </Link>
  );
}
