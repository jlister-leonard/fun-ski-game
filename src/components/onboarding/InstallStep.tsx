"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { requestPersistentStorage } from "@/lib/db";

/**
 * @file Add to Home Screen.
 *
 * ## This is a correctness step, not a growth prompt
 *
 * `ARCHITECTURE.md` §3: Safari evicts IndexedDB for ordinary sites after about
 * seven days without a visit, and Home Screen web apps are exempt. More
 * importantly, iOS does not copy IndexedDB from a browser into a newly
 * installed Home Screen app. Keel has no server copy of anything, so an iOS
 * vault must be created in the installed app from the start.
 *
 * The copy says why. It does not say "for the best experience", because the
 * reason is specific and a user who understands it will act on it.
 *
 * ## Duplication, declared
 *
 * `components/settings/StorageSection.tsx` holds the same four iOS steps and
 * the same standalone detection. That file belongs to the settings agent and
 * exports neither, so this is a copy rather than an import. If those helpers
 * are ever hoisted into `@/components/ui` or `@/lib`, this file should be the
 * first caller.
 */

/** Whether the app is running as an installed Home Screen app. */
export function readStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  // iOS Safari's own non-standard flag. Still the only reliable signal there.
  return (navigator as { standalone?: boolean }).standalone === true;
}

export interface InstallEnvironment {
  standalone: boolean;
  userAgent: string;
  maxTouchPoints: number;
}

function readEnvironment(): InstallEnvironment {
  return {
    standalone: readStandalone(),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    maxTouchPoints:
      typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
  };
}

/** Whether an environment is an iPhone, iPod, or iPad (including iPadOS). */
export function isIosDevice(
  environment: Pick<InstallEnvironment, "userAgent" | "maxTouchPoints"> =
    readEnvironment()
): boolean {
  const ua = environment.userAgent;
  // iPadOS 13+ reports as a Mac; the touch-point count gives it away.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes("Macintosh") && environment.maxTouchPoints > 1)
  );
}

/**
 * The launch-safety gate.
 *
 * Desktop and Android installed apps share the origin's existing storage in
 * the flows Keel supports. iOS Home Screen apps do not inherit IndexedDB from
 * the browser that installed them, so creating the vault in an iOS browser
 * would strand it in the wrong storage container.
 */
export function requiresInstallBeforeVault(
  environment: InstallEnvironment = readEnvironment()
): boolean {
  return isIosDevice(environment) && !environment.standalone;
}

const NO_SUBSCRIBE = () => () => {};

/** Live display mode: installing while this screen is open flips it. */
function useStandalone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(display-mode: standalone)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    readStandalone,
    () => false
  );
}

export function InstallStep({ required = false }: { required?: boolean }) {
  const standalone = useStandalone();
  const ios = useSyncExternalStore(
    NO_SUBSCRIBE,
    () => isIosDevice(),
    () => false
  );
  const [persisted, setPersisted] = useState<boolean | null | undefined>(
    undefined
  );

  // Channel `020-vault.md` asks first run to make this request and to surface
  // the answer honestly. It is one call, it needs no user gesture, and on iOS
  // Safari it usually returns false until the app is installed — which is the
  // very thing this screen is about, so the refusal is informative rather than
  // an error.
  useEffect(() => {
    // Before vault creation there is no user data to protect yet. Asking from
    // the browser container would also report on the wrong container.
    if (required) return;
    let cancelled = false;
    requestPersistentStorage()
      .then((granted) => {
        if (!cancelled) setPersisted(granted);
      })
      .catch(() => {
        if (!cancelled) setPersisted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [required]);

  return (
    <div className="flex flex-col gap-4">
      {required ? (
        <>
          <p className="text-sm text-ink-2 leading-relaxed">
            Keel has not created your vault yet. On iPhone and iPad, the browser
            and the Home Screen app keep separate private storage. Creating a
            passphrase here would put the vault in the browser, not in the app
            you are about to use.
          </p>
          <p className="text-sm text-ink-2 leading-relaxed">
            Add Keel to your Home Screen first, then open the new icon. Setup
            starts there, and your vault will be created in the right place.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-2 leading-relaxed">
            Everything you log lives in this browser&rsquo;s storage on this
            phone. Safari is allowed to clear that storage for ordinary
            websites, and does so after roughly a week without a visit. There
            is no copy on a server to restore from.
          </p>
          <p className="text-sm text-ink-2 leading-relaxed">
            Web apps opened from the Home Screen are exempt from that rule. It
            takes about fifteen seconds and it is the single biggest thing you
            can do to keep your data.
          </p>
        </>
      )}

      {standalone ? (
        <div className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-3">
          <p className="text-sm text-ink leading-relaxed">
            Already installed — Keel is running from the Home Screen, so its
            storage is not on the eviction clock.
          </p>
          <p className="mt-2 text-xs text-ink-3 leading-relaxed">
            Deleting the app icon still deletes the data with it, so take a
            backup once you have logged a few days.
          </p>
        </div>
      ) : ios ? (
        <>
          <ol className="flex flex-col gap-2.5 text-sm text-ink-2">
            {!required && (
              <Step n={1}>
                Before installing, finish setup. Then open{" "}
                <strong className="text-ink">Settings &rsaquo; Vault</strong>,
                export and verify an encrypted backup, and save it somewhere
                outside this app.
              </Step>
            )}
            <Step n={required ? 1 : 2}>
              Open your browser&rsquo;s{" "}
              <strong className="text-ink">Share</strong> menu. Safari and
              supported third-party browsers can add web apps to the Home
              Screen.
            </Step>
            <Step n={required ? 2 : 3}>
              Scroll down and tap{" "}
              <strong className="text-ink">Add to Home Screen</strong>.
            </Step>
            <Step n={required ? 3 : 4}>
              If you see <strong className="text-ink">Open as Web App</strong>,
              leave it turned on, then tap{" "}
              <strong className="text-ink">Add</strong>.
            </Step>
            <Step n={required ? 4 : 5}>
              {required ? (
                <>
                  Close this browser page and open Keel from the new icon. Setup
                  starts there; no passphrase or health data has been saved
                  here.
                </>
              ) : (
                <>
                  Open Keel from the new icon and restore the backup there. iOS
                  does not copy this browser&rsquo;s vault into the Home Screen
                  app.
                </>
              )}
            </Step>
          </ol>
          <p className="text-xs text-ink-3 leading-relaxed">
            Don&rsquo;t see <strong className="text-ink-2">Add to Home Screen</strong>?
            Choose <strong className="text-ink-2">Open in Safari</strong> from
            the browser&rsquo;s menu, then repeat the steps there.
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-2 leading-relaxed">
          On desktop there is usually an install icon at the right of the
          address bar. On Android, open the browser menu and choose{" "}
          <strong className="text-ink">Install app</strong> or{" "}
          <strong className="text-ink">Add to Home screen</strong>.
        </p>
      )}

      {!required && persisted === false && !standalone && (
        <p className="text-xs text-ink-3 leading-relaxed">
          Keel asked the browser to mark this storage as persistent and it
          declined. On iPhone that is the normal answer until the app is
          installed, and asking again afterwards often succeeds — Settings
          &rsaquo; Storage has the button.
        </p>
      )}
      {!required && persisted === true && (
        <p className="text-xs text-ink-3 leading-relaxed">
          The browser has granted persistent storage: it has agreed not to evict
          this data on its own.
        </p>
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 leading-relaxed">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-2xs font-medium text-ink-2">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
