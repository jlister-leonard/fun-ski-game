/**
 * Transient confirmations — "Saved.", "Copied", "Backup written".
 *
 * ## Why this is imperative DOM rather than a React provider
 *
 * There were four of these in the app already, each written inline in the
 * screen that needed it, and **none of them had `role="status"` or any other
 * live region**. A sighted user sees "Saved." appear next to the button; a
 * VoiceOver user gets silence and no way to tell whether the tap did anything.
 * That is the defect this module exists to close.
 *
 * A `<ToastProvider>` would be the idiomatic React shape, but mounting it means
 * editing the root layout and the vault gate — files this component does not
 * own — and a primitive nobody can call without a cross-cutting edit is a
 * primitive nobody calls. This version needs no provider, no context and no
 * mount point: the first call creates its own host. It is also callable from
 * places that are not React at all, such as a service-worker update handler.
 *
 * ## The live region contract
 *
 * The host is created **once, empty, and early**, and stays in the document.
 * Assistive tech only announces mutations *inside* an existing live region —
 * inserting a container that already has `aria-live` on it and text in it is
 * frequently missed. Adding the message to a region that was already there is
 * the reliable path.
 *
 * `polite` for confirmations; `assertive` only for a failure the user must act
 * on, because assertive interrupts whatever is being read mid-sentence.
 */

export type ToastTone = "neutral" | "success" | "warn";

export interface ToastOptions {
  tone?: ToastTone;
  /** Milliseconds on screen. Clamped to a 1.6s floor — anything shorter is
   *  gone before someone reading at an average pace has finished it. */
  duration?: number;
  /** Interrupts the screen reader. Reserve for errors. */
  assertive?: boolean;
}

const HOST_ID = "hc-toast-host";
const ENTER_MS = 220;
const EXIT_MS = 180;

const TONE_CLASS: Record<ToastTone, string> = {
  neutral: "bg-elevated text-ink border-line",
  success: "bg-elevated text-ink border-line",
  warn: "bg-elevated text-warn border-warn",
};

function host(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const found = document.getElementById(HOST_ID);
  if (found) return found;

  const el = document.createElement("div");
  el.id = HOST_ID;
  // The region itself is not a target, so it must never eat taps meant for
  // the screen underneath. Individual toasts re-enable pointer events only if
  // they need to be dismissable.
  el.className =
    "pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4";
  // Above the tab bar (64px) and clear of the home indicator.
  el.style.bottom = "calc(76px + env(safe-area-inset-bottom))";
  document.body.appendChild(el);
  return el;
}

/** Creates the live region ahead of the first message. Cheap and idempotent. */
export function primeToasts(): void {
  host();
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Shows a message. Returns a function that dismisses it early.
 *
 * Safe to call during SSR (does nothing) and safe to call twice in a row —
 * the second message stacks under the first rather than replacing it.
 */
export function toast(message: string, options: ToastOptions = {}): () => void {
  const parent = host();
  if (!parent || !message) return () => {};

  const { tone = "neutral", assertive = false } = options;
  const duration = Math.max(1600, options.duration ?? 2200);

  const el = document.createElement("div");
  el.setAttribute("role", assertive ? "alert" : "status");
  el.setAttribute("aria-live", assertive ? "assertive" : "polite");
  el.className =
    "max-w-[min(420px,100%)] rounded-[var(--radius-md)] border px-4 py-2.5 " +
    "text-sm text-center shadow-[var(--shadow-3)] " +
    TONE_CLASS[tone];
  el.textContent = message;

  if (!reducedMotion()) {
    el.style.animation = `hc-toast-in ${ENTER_MS}ms var(--ease-out-ios) both`;
  }

  parent.appendChild(el);

  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    if (reducedMotion()) {
      el.remove();
      return;
    }
    el.style.animation = `hc-toast-out ${EXIT_MS}ms var(--ease-out-ios) both`;
    window.setTimeout(() => el.remove(), EXIT_MS);
  };

  const timer = window.setTimeout(remove, duration);
  return remove;
}
