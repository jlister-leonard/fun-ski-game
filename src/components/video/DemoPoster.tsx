"use client";

/**
 * @file The click-to-load placeholder.
 *
 * ## Why the poster is drawn, not fetched
 *
 * The obvious poster is `https://i.ytimg.com/vi/<id>/hqdefault.jpg`. It would
 * look better and it would also mean that *scrolling* a workout — never mind
 * tapping anything — sends Google one request per exercise, each one naming a
 * movement. That is browsing history, not playback, and it is exactly the leak
 * the user did not agree to.
 *
 * So the poster is CSS: a gradient, a play glyph, and a line of text saying
 * what tapping will do. It is honest about the tradeoff too — a poster that
 * pretends to be a video frame would imply the video is already loaded.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { haptic } from "@/components/ui/haptics";

export interface DemoPosterProps {
  /** Large label — the exercise name. */
  title: string;
  /** What happens on tap: "Plays from YouTube", "Opens a YouTube search"… */
  action: string;
  /** Small print under the action, usually the privacy consequence. */
  hint?: ReactNode;
  /** Tap handler. Mutually exclusive with `href`. */
  onPlay?: () => void;
  /** Renders as a link instead of a button — for handoffs to YouTube. */
  href?: string;
  disabled?: boolean;
  className?: string;
}

function PlayGlyph() {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-14 w-14 items-center justify-center rounded-full",
        "bg-[rgba(255,255,255,0.92)] shadow-[var(--shadow-2)]",
        "transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out-ios)]",
        "group-active:scale-90"
      )}
    >
      <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6" fill="#101620">
        <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.9-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
      </svg>
    </span>
  );
}

/**
 * The tappable placeholder that stands in for a video until the user asks.
 *
 * @param props see {@link DemoPosterProps}
 */
export function DemoPoster({
  title,
  action,
  hint,
  onPlay,
  href,
  disabled,
  className,
}: DemoPosterProps) {
  const body = (
    <>
      <span
        aria-hidden
        className="absolute inset-0 bg-[linear-gradient(155deg,#1d2530_0%,#0e1319_55%,#161d27_100%)]"
      />
      <span className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <PlayGlyph />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-white">{action}</span>
          {hint && (
            <span className="text-xs leading-snug text-[rgba(255,255,255,0.62)]">{hint}</span>
          )}
        </span>
      </span>
    </>
  );

  const classes = cn(
    "group relative flex aspect-video w-full items-center justify-center",
    "overflow-hidden rounded-[var(--radius-md)]",
    "transition-opacity duration-[var(--duration-fast)]",
    disabled && "pointer-events-none opacity-45",
    className
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${title} — ${action}`}
        className={classes}
        onClick={() => haptic("light")}
      >
        {body}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        haptic("light");
        onPlay?.();
      }}
      disabled={disabled}
      aria-label={`${title} — ${action}`}
      className={classes}
    >
      {body}
    </button>
  );
}
