/**
 * Haptic feedback, degrading to nothing.
 *
 * iOS Safari does not implement the Vibration API at all, and there is no web
 * equivalent of `UIImpactFeedbackGenerator` — so on the device this app is
 * built for, every call here is a no-op today. That is deliberate rather than
 * an oversight:
 *
 * 1. Android Chrome and installed PWAs on Android *do* support it, and the
 *    patterns below are tuned so a shared component feels right there.
 * 2. When Safari ships support (the API is behind a flag in recent WebKit
 *    builds), every press in the app starts responding with no code change,
 *    because the primitives already call through this module.
 * 3. Screens never touch `navigator.vibrate` directly, so there is exactly one
 *    place to add a user preference or a kill switch.
 *
 * The one rule: a haptic never carries information on its own. Anything the
 * buzz says must also be said visually, or a user with vibration disabled
 * loses it.
 */

/** Vibration patterns in milliseconds, keyed by what the feedback *means*. */
const PATTERNS = {
  /** A control was pressed. The default. */
  light: 8,
  /** A discrete step landed — a segment changed, a digit was entered. */
  selection: 5,
  /** Something committed: a set logged, a sheet confirmed. */
  success: [10, 40, 14],
  /** A destructive or blocked action. Never used to scold. */
  warning: [16, 60, 16],
} as const;

export type Haptic = keyof typeof PATTERNS;

let enabled = true;

/** Turns every haptic off for the session. Exposed for a settings toggle. */
export function setHapticsEnabled(next: boolean): void {
  enabled = next;
}

export function hapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/**
 * Fires a haptic if the platform has one. Safe to call during a render commit,
 * on the server, and in a test environment.
 *
 * Also silent when the user has asked for reduced motion — the request is
 * about vestibular comfort, and a device-wide buzz is part of that.
 */
export function haptic(kind: Haptic = "light"): void {
  if (!enabled) return;
  if (typeof window === "undefined") return;
  if (!hapticsSupported()) return;
  try {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    navigator.vibrate(PATTERNS[kind] as number | number[]);
  } catch {
    // A vibrate() call can throw in an unfocused document. Never surface it —
    // failing to buzz is not an error worth telling anyone about.
  }
}
