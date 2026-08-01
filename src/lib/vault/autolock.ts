/**
 * @file The auto-lock controller. Headless — no React, no DOM rendering, just
 * listeners and timers.
 *
 * Two independent triggers, because they defend against different things:
 *
 * | Trigger | Defends against |
 * |---|---|
 * | **Idle timeout** | the phone left unlocked on a desk |
 * | **Backgrounded past a grace period** | the app-switcher screenshot, and handing someone your unlocked phone to show them a photo |
 *
 * The grace period exists because iOS Safari fires `visibilitychange` for
 * trivial things — pulling down Notification Centre, a bank app's OTP
 * round-trip, the share sheet. Locking instantly on every one of those would
 * make the app unusable and train the user to pick a short passphrase.
 *
 * Timers are **wall-clock checked**, not trusted. iOS aggressively throttles
 * and suspends background timers, so a `setTimeout(idleMs)` can fire minutes
 * late or not at all. Every tick re-reads `Date.now()` and compares, and the
 * visibility handler re-evaluates on resume. A suspended tab that wakes up
 * after the deadline locks immediately.
 */

import { isUnlocked, lock } from './session';

/** Tunables for {@link startAutoLock}. */
export interface AutoLockConfig {
  /** Master switch. */
  enabled: boolean;
  /** Milliseconds of no user activity before locking. Default 5 minutes. */
  idleMs: number;
  /**
   * Milliseconds the app may stay hidden before locking. Default 30 s — long
   * enough to survive an OTP round-trip, short enough that a handed-over phone
   * is not a data breach.
   */
  hiddenGraceMs: number;
  /** Lock when the page is being unloaded. Default true. */
  lockOnUnload: boolean;
}

/** Sensible defaults, mirrored into `AppSettings` at first run. */
export const DEFAULT_AUTOLOCK: AutoLockConfig = {
  enabled: true,
  idleMs: 5 * 60_000,
  hiddenGraceMs: 30_000,
  lockOnUnload: true,
};

/** Activity events that reset the idle timer. Passive listeners only. */
const ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'touchstart',
  'wheel',
  'focus',
] as const;

/** How often the idle watchdog re-checks the wall clock. */
const TICK_MS = 15_000;

let config: AutoLockConfig = { ...DEFAULT_AUTOLOCK };
let lastActivityAt = Date.now();
let hiddenSince: number | null = null;
let tickHandle: ReturnType<typeof setInterval> | null = null;
let attached = false;

/** True when the DOM listeners are installed. */
export function isAutoLockRunning(): boolean {
  return attached;
}

/** The configuration currently in force. */
export function getAutoLockConfig(): AutoLockConfig {
  return { ...config };
}

/**
 * Update the configuration, applying it immediately.
 *
 * @param patch fields to change; omitted fields keep their current value
 */
export function configureAutoLock(patch: Partial<AutoLockConfig>): void {
  config = { ...config, ...patch };
  if (!config.enabled) {
    hiddenSince = null;
    return;
  }
  noteActivity();
}

/**
 * Reset the idle timer.
 *
 * Called automatically on user input. Call it manually around long non-input
 * work the user is still watching — a 100 MB Apple Health import, say — so the
 * vault does not lock mid-parse.
 */
export function noteActivity(): void {
  lastActivityAt = Date.now();
}

/** Milliseconds until the idle lock fires, or `null` when it cannot. */
export function msUntilIdleLock(): number | null {
  if (!config.enabled || !isUnlocked()) return null;
  return Math.max(0, lastActivityAt + config.idleMs - Date.now());
}

/** Evaluate both deadlines against the wall clock and lock if either passed. */
function evaluate(): void {
  if (!config.enabled || !isUnlocked()) return;
  const now = Date.now();
  if (hiddenSince !== null && now - hiddenSince >= config.hiddenGraceMs) {
    lock('hidden');
    return;
  }
  if (now - lastActivityAt >= config.idleMs) lock('idle');
}

/** `visibilitychange` handler: start or clear the hidden grace window. */
function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'hidden') {
    hiddenSince = Date.now();
  } else {
    // Returning from the background: a suspended timer may never have fired,
    // so re-check the deadline before clearing it.
    evaluate();
    hiddenSince = null;
    noteActivity();
  }
}

/** `pagehide` handler. */
function onPageHide(): void {
  if (config.lockOnUnload) lock('unload');
}

/**
 * Install the auto-lock listeners and watchdog.
 *
 * Idempotent, and a no-op outside the browser so importing this module during
 * a Next.js prerender is inert.
 *
 * @param patch optional configuration to apply first
 */
export function startAutoLock(patch?: Partial<AutoLockConfig>): void {
  if (patch) configureAutoLock(patch);
  if (attached) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, noteActivity, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  tickHandle = setInterval(evaluate, TICK_MS);
  noteActivity();
  attached = true;
}

/**
 * Remove the listeners and stop the watchdog.
 *
 * Called on lock, and by the UI on unmount. Does **not** itself lock.
 */
export function stopAutoLock(): void {
  if (!attached) return;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    for (const type of ACTIVITY_EVENTS) {
      window.removeEventListener(type, noteActivity, { capture: true });
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
  }
  if (tickHandle !== null) clearInterval(tickHandle);
  tickHandle = null;
  hiddenSince = null;
  attached = false;
}
