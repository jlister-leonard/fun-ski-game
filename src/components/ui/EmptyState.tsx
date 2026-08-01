"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Card } from "./Card";

export interface Milestone {
  /** When it unlocks — "Today", "After 3 days", "About 2 weeks". */
  when: ReactNode;
  /** What appears then. One sentence. */
  what: ReactNode;
}

export interface EmptyStateProps {
  /** Names what is missing. Not an apology. */
  title: ReactNode;
  /** One or two sentences on how to fix it. */
  body?: ReactNode;
  /** The single action that ends the empty state. */
  action?: ReactNode;
  /** What the screen will be able to show once data arrives, and when. */
  milestones?: readonly Milestone[];
  /** Renders bare, for an empty state already inside a Card. */
  bare?: boolean;
  /** Heading level. `h2` under a screen's `h1`; `h3` inside a card section. */
  as?: "h2" | "h3";
  className?: string;
}

/**
 * The state this app spends its first week in.
 *
 * Two full versions of this existed (Body and Recovery) with the `Milestone`
 * sub-component duplicated verbatim between them, plus eight one-line
 * `<p>Nothing logged yet.</p>` stubs elsewhere.
 *
 * The milestone list is the part worth keeping. A tracking app with no data is
 * indistinguishable from a broken one, and "the trend line appears after about
 * ten weigh-ins" is the sentence that tells the user the blank space is a
 * schedule rather than a fault. Copy rules, from the chart-layer spec: name
 * what is missing, then one sentence on how to fix it. No apology, no
 * exclamation mark, no blame.
 */
export function EmptyState({
  title,
  body,
  action,
  milestones,
  bare = false,
  as: Heading = "h2",
  className,
}: EmptyStateProps) {
  const content = (
    <>
      <Heading className="text-lg font-semibold text-ink">{title}</Heading>
      {body && <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
      {milestones && milestones.length > 0 && (
        <ul className="mt-5 space-y-3">
          {milestones.map((m, i) => (
            <li key={i}>
              <span className="block text-2xs uppercase tracking-wide text-ink-3">
                {m.when}
              </span>
              <span className="mt-0.5 block text-sm leading-relaxed text-ink-2">
                {m.what}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  if (bare) return <div className={className}>{content}</div>;
  return <Card className={cn("p-5", className)}>{content}</Card>;
}

/**
 * The one-line version, for a section inside a card that has nothing in it
 * yet. Replaces the bare `<p className="text-sm text-ink-2">` stubs.
 */
export function EmptyNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("py-2 text-sm leading-relaxed text-ink-2", className)}>{children}</p>
  );
}
