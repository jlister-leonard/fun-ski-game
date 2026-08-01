"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  configureAutoLock,
  isMediaCleanupPending,
  recordMediaCleanupComplete,
  startAutoLock,
  stopAutoLock,
} from "@/lib/vault";
import { settings } from "@/lib/db/repos";
import { deleteAllUserDemos } from "@/lib/video";
import { useVaultExists, useVaultState } from "@/lib/hooks/useVaultState";
import { Intake } from "@/components/onboarding/Intake";
import { useIntakeResume } from "@/components/onboarding/store";
import { Button } from "@/components/ui/Button";
import { LockScreen } from "./LockScreen";
import { Onboarding } from "./Onboarding";
import { TabBar, TabBarSpacer } from "./TabBar";

/**
 * How far through first-run setup we are.
 *
 * This exists because creating a vault also *unlocks* it, so the moment
 * onboarding succeeds the gate would otherwise see "vault exists, unlocked"
 * and swap straight to the app — before the user has seen the recovery code
 * that is their only way back in if they forget the passphrase.
 *
 * Driven by events from Onboarding rather than by a ref read during render or
 * a state update inside an effect, both of which are render-correctness
 * hazards under the React compiler.
 */
type Setup = "none" | "running" | "finished";
type MediaCleanup = "checking" | "ready" | "failed";

async function clearPendingMedia(): Promise<void> {
  if (!(await isMediaCleanupPending())) return;
  await deleteAllUserDemos();
  await recordMediaCleanupComplete();
}

/**
 * Decides what the user sees: onboarding, the lock screen, or the app.
 *
 * Wrapping every page means an auto-lock while a screen is open drops straight
 * back to the lock screen — there is no route that can render vault data
 * without passing through here first.
 */
export function VaultGate({ children }: { children: ReactNode }) {
  const state = useVaultState();
  const exists = useVaultExists();
  const [setup, setSetup] = useState<Setup>("none");
  const [resumeDismissed, setResumeDismissed] = useState(false);
  const [mediaCleanup, setMediaCleanup] =
    useState<MediaCleanup>("checking");

  const onVaultCreated = useCallback(() => setSetup("running"), []);
  const onSetupComplete = useCallback(() => setSetup("finished"), []);
  const finishPendingMediaCleanup = useCallback(async () => {
    try {
      await clearPendingMedia();
      setMediaCleanup("ready");
    } catch {
      setMediaCleanup("failed");
    }
  }, []);
  const retryPendingMediaCleanup = useCallback(() => {
    setMediaCleanup("checking");
    void finishPendingMediaCleanup();
  }, [finishPendingMediaCleanup]);

  // This is the crash-recovery half of replace restore. The marker is written
  // atomically with the new vault, so a force-quit between databases resumes
  // here before any screen that can record new media is enabled.
  useEffect(() => {
    let cancelled = false;
    clearPendingMedia().then(
      () => {
        if (!cancelled) setMediaCleanup("ready");
      },
      () => {
        if (!cancelled) setMediaCleanup("failed");
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * An intake abandoned in an earlier session.
   *
   * Only checked when this session did *not* run onboarding itself: the flow
   * writes `stage: 'intake'` before its first question and clears it at the
   * end, so a read taken mid-flow would resume a flow that is already on
   * screen. Absence of the key means "done", never "not started" — see
   * `readIntakeProgress`, which is what keeps this screen away from every
   * vault that predates the intake.
   */
  const resume = useIntakeResume(
    exists === true && state === "unlocked" && setup === "none"
  );

  // Idle and backgrounding both re-lock. Only meaningful once a vault exists.
  useEffect(() => {
    if (exists !== true) return;
    startAutoLock();
    return () => stopAutoLock();
  }, [exists]);

  // The encrypted preference row becomes readable only after unlock. Apply it
  // immediately on every session rather than waiting for the Settings screen
  // to be visited.
  useEffect(() => {
    if (state !== "unlocked") return;
    let cancelled = false;
    settings
      .load()
      .then((stored) => {
        if (!stored || cancelled) return;
        configureAutoLock({
          enabled: stored.autoLockEnabled,
          idleMs: stored.autoLockIdleMs,
          hiddenGraceMs: stored.autoLockHiddenGraceMs,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [state]);

  let content: ReactNode;

  // Still resolving whether a vault exists. Render a blank surface rather than
  // a spinner — the check is one IndexedDB read and resolves within a frame or
  // two, and a flashed spinner reads worse than a beat of nothing.
  if (exists === undefined || mediaCleanup === "checking") {
    content = <div className="min-h-[100svh] bg-bg" aria-busy="true" />;
  } else if (exists === "unavailable") {
    content = <StorageUnavailable />;
  } else if (mediaCleanup === "failed") {
    content = (
      <MediaCleanupUnavailable onRetry={retryPendingMediaCleanup} />
    );
  } else if (!exists || setup === "running") {
    content = (
      <Onboarding
        onVaultCreated={onVaultCreated}
        onComplete={onSetupComplete}
      />
    );
  } else if (state !== "unlocked") {
    content = <LockScreen />;
  } else if (setup === "none" && resume === undefined) {
    // The same blank surface the existence check uses, for the same reason:
    // rendering the dashboard and replacing it a frame later with an intake
    // screen is worse than a beat of nothing.
    content = <div className="min-h-[100svh] bg-bg" aria-busy="true" />;
  } else if (resume && !resumeDismissed) {
    content = (
      <Intake
        initialStep={resume.step}
        initialSkipped={resume.skipped}
        onFinish={() => setResumeDismissed(true)}
      />
    );
  } else {
    content = (
      <>
        {children}
        <TabBarSpacer />
        <TabBar />
      </>
    );
  }

  // The veil sits outside every branch, including onboarding and the
  // one-time recovery-code screen. iOS can snapshot any of them for its app
  // switcher the instant Keel backgrounds.
  return (
    <>
      {content}
      <PrivacyVeil />
    </>
  );
}

function MediaCleanupUnavailable({
  onRetry,
}: {
  onRetry: () => void;
}) {
  return (
    <main
      role="alert"
      className="min-h-[100svh] flex items-center justify-center px-6 safe-t safe-b"
    >
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-ink">
          One restore step still needs to finish
        </h1>
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Your restored vault is safe. Keel detected an interrupted media
          replacement and must remove clips whose encryption may not match the
          restored vault. No recordings will be enabled until that cleanup
          succeeds. If the backup included clips, run the restore again after
          cleanup to bring them back.
        </p>
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Close other Keel windows, then try again. If it still fails, restart
          the device and reopen this same Site.
        </p>
        <div className="mt-6">
          <Button size="lg" block onClick={onRetry}>
            Retry safely
          </Button>
        </div>
      </div>
    </main>
  );
}

function StorageUnavailable() {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main
      role="alert"
      aria-labelledby="storage-unavailable-title"
      className="min-h-[100svh] flex items-center justify-center px-6 safe-t safe-b"
    >
      <div className="w-full max-w-sm">
        <h1
          ref={headingRef}
          id="storage-unavailable-title"
          tabIndex={-1}
          className="text-2xl font-semibold text-ink outline-none"
        >
          Keel can&rsquo;t read its private storage
        </h1>
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Your vault has not been changed. Do not clear website data or create
          a new vault. Close Keel and open it again from the same place: the
          same Home Screen icon, or the same browser and Site address.
        </p>
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          If this keeps happening, restart the device and browser before trying
          anything destructive. An encrypted backup remains the safest
          recovery path.
        </p>
        <div className="mt-6">
          <Button size="lg" block onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </div>
    </main>
  );
}

/**
 * Hide health information from the iOS app-switcher snapshot immediately.
 *
 * Auto-lock still follows the user's grace period; this visual veil appears as
 * soon as the document is backgrounded and disappears on return.
 */
function PrivacyVeil() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const sync = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  if (!hidden) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-bg safe-t safe-b"
      aria-hidden
    >
      <p className="text-lg font-semibold text-ink">Keel is private</p>
    </div>
  );
}
