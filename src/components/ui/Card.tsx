"use client";

import { forwardRef } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Removes internal padding, for cards whose child manages its own edges. */
  flush?: boolean;
  /** Lifts the card off the background. Use sparingly — depth loses meaning
   *  when everything has it. */
  raised?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { flush = false, raised = false, className, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        "bg-surface border border-line rounded-[var(--radius-lg)]",
        raised && "shadow-[var(--shadow-2)]",
        !flush && "p-4",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface CardHeaderProps {
  title: ReactNode;
  /** Sits under the title. Keep it to one line on a phone. */
  subtitle?: ReactNode;
  /** Right-aligned slot — usually a button or a value. */
  accessory?: ReactNode;
  className?: string;
}

export function CardHeader({
  title,
  subtitle,
  accessory,
  className,
}: CardHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink truncate">{title}</h2>
        {subtitle && (
          <p className="text-sm text-ink-2 mt-0.5 truncate">{subtitle}</p>
        )}
      </div>
      {accessory && <div className="shrink-0">{accessory}</div>}
    </div>
  );
}
