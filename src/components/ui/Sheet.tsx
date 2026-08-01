"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { haptic } from "./haptics";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Right side of the header — usually a confirm action. */
  accessory?: ReactNode;
  /** Fraction of viewport height the sheet occupies. `auto` hugs content. */
  detent?: "auto" | "half" | "large";
  /** Sticky footer, outside the scroll area. Gets safe-area padding. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

const DETENTS: Record<NonNullable<SheetProps["detent"]>, string> = {
  auto: "max-h-[88svh]",
  half: "h-[54svh]",
  large: "h-[88svh]",
};

/** Drag past this many pixels and release, and the sheet dismisses. */
const DISMISS_THRESHOLD_PX = 110;
/** Or flick faster than this, regardless of distance. */
const DISMISS_VELOCITY = 0.55;

const noopSubscribe = () => () => {};

/**
 * True once hydrated. Avoids the `useEffect(() => setMounted(true))` pattern,
 * which schedules a synchronous state update inside an effect and triggers a
 * cascading render.
 */
function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

/**
 * iOS-style bottom sheet with drag-to-dismiss.
 *
 * This is the workhorse of the app — logging food, logging a set and editing a
 * target all happen in one of these. It matters that it feels physical: the
 * panel tracks the finger 1:1, resists upward drag rather than following it,
 * and honours a flick even when the travel was short.
 */
export function Sheet(props: SheetProps) {
  const isClient = useIsClient();
  if (!isClient || !props.open) return null;
  // Keying on nothing — the panel simply mounts fresh each time the sheet
  // opens, so its transient state (enter transition, drag offset) starts
  // clean without any reset effects.
  return <SheetPanel {...props} />;
}

function SheetPanel({
  onClose,
  title,
  accessory,
  detent = "auto",
  footer,
  children,
  className,
}: SheetProps) {
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const startRef = useRef({ y: 0, t: 0 });
  const titleId = useId();

  // Animate in on the frame after mount, so the browser has a start position
  // to transition from. Deferred via rAF rather than set synchronously.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Lock background scroll while open, restoring the previous value on close.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /**
   * Escape closes, and Tab stays inside.
   *
   * `aria-modal="true"` hides the rest of the page from a screen reader's
   * virtual cursor, but it does nothing at all to the browser's tab order —
   * without this, Tab walked straight out of an open sheet and into the
   * buttons behind it, which are visually covered and, once the tab bar was
   * reached, would navigate away mid-edit. Measured before the fix: from the
   * last control in a sheet, one Tab landed on a background button on every
   * screen that has one.
   *
   * The trap wraps rather than blocking, so it is not a keyboard trap in the
   * WCAG 2.1.2 sense: Escape always leaves.
   */
  useEffect(() => {
    const FOCUSABLE =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
      'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

    const inPanel = () => {
      const panel = panelRef.current;
      if (!panel) return [];
      return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
      );
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = inPanel();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && !!panelRef.current?.contains(active);

      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Focus moves into the sheet on open and back to the opener on close.
   *
   * Not to the first control — that would put the caret in a text field and
   * raise the iOS keyboard over a sheet the user has not read yet. The panel
   * itself takes focus (`tabIndex={-1}`), which is what VoiceOver needs to
   * start reading from the title.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Only start a drag from the top of the scroll area, so dragging the sheet
    // never fights with scrolling its content.
    const scroller = scrollRef.current;
    if (scroller && scroller.scrollTop > 0) return;
    startRef.current = { y: e.clientY, t: performance.now() };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const dy = e.clientY - startRef.current.y;
      // Rubber-band upward drag rather than following it.
      setDragY(dy < 0 ? dy / 6 : dy);
    },
    [dragging]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setDragging(false);
      const dy = e.clientY - startRef.current.y;
      const dt = Math.max(1, performance.now() - startRef.current.t);

      if (dy > DISMISS_THRESHOLD_PX || dy / dt > DISMISS_VELOCITY) {
        // Only on a *drag* dismissal — a flick that crosses the threshold is
        // the one moment the user cannot see the sheet leave, because their
        // thumb is over it.
        haptic("light");
        onClose();
      } else {
        setDragY(0);
      }
    },
    [dragging, onClose]
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      {/* Tap-to-dismiss. `tabIndex={-1}` keeps it out of the tab order: it is
          the first thing in the dialog, and landing on "Close" before hearing
          the title is a poor first impression. Escape does the same job for a
          keyboard, and the sheet's own footer carries the visible action. */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/45 backdrop-blur-[2px]",
          "transition-opacity duration-[var(--duration-sheet)] ease-[var(--ease-out-ios)]",
          entered ? "opacity-100" : "opacity-0"
        )}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          transform: entered ? `translateY(${dragY}px)` : "translateY(100%)",
          transition: dragging
            ? "none"
            : "transform var(--duration-sheet) var(--ease-out-ios)",
        }}
        className={cn(
          "relative w-full max-w-[540px] flex flex-col outline-none",
          "bg-elevated border-t border-line",
          "rounded-t-[var(--radius-xl)] shadow-[var(--shadow-3)]",
          "will-change-transform",
          DETENTS[detent],
          className
        )}
      >
        {/* The whole header is draggable, not just the handle — a 4px grab
            target would be unusable with a thumb. */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="shrink-0 cursor-grab active:cursor-grabbing touch-none"
        >
          <div className="flex justify-center pt-2.5 pb-1">
            <div className="h-1 w-9 rounded-full bg-[var(--c-border-strong)]" />
          </div>
          {(title || accessory) && (
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-1">
              <h2
                id={titleId}
                className="text-lg font-semibold text-ink truncate"
              >
                {title}
              </h2>
              {accessory && <div className="shrink-0">{accessory}</div>}
            </div>
          )}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-touch px-4">
          {children}
        </div>

        <div className={cn("shrink-0 safe-b", footer ? "px-4 pt-3 pb-3" : null)}>
          {footer}
        </div>
      </div>
    </div>,
    document.body
  );
}
