"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { requestPersistentStorage, storageStatus } from "@/lib/db";
import {
  isIosDevice,
  readStandalone,
} from "@/components/onboarding/InstallStep";

interface Status {
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

/**
 * Display mode as a live value.
 *
 * A `useSyncExternalStore` binding rather than `useState` + `useEffect`,
 * because the display mode is external state that genuinely changes: launching
 * the installed app from the Home Screen while this tab is open flips it, and
 * the install instructions should disappear when it does.
 */
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

/** Never changes within a session; subscribed to nothing. */
const NO_SUBSCRIBE = () => () => {};

function useIos(): boolean {
  return useSyncExternalStore(NO_SUBSCRIBE, () => isIosDevice(), () => false);
}

/**
 * Storage durability.
 *
 * ## This is a correctness screen, not a growth prompt
 *
 * `ARCHITECTURE.md` §3: Safari evicts IndexedDB for regular websites after
 * roughly seven days without a visit. Home Screen web apps are exempt. This app
 * has no server copy of anything, so for a non-installed user "eviction" and
 * "all your data was deleted" are the same event. Asking someone to install the
 * app is therefore load-bearing, and the copy says why rather than nagging.
 *
 * ## And it reports the grant honestly
 *
 * `navigator.storage.persist()` returns false on iOS Safari for a
 * non-installed site, and the honest response to that is to say it was refused
 * and explain the fix — not to hide the result or claim success because the
 * call did not throw.
 */
export function StorageSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const standalone = useStandalone();
  const ios = useIos();
  const [asking, setAsking] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<boolean | null | undefined>(
    undefined
  );

  const refresh = useCallback(() => {
    storageStatus()
      .then(setStatus)
      .catch(() =>
        setStatus({ persisted: null, usageBytes: null, quotaBytes: null })
      );
  }, []);

  useEffect(refresh, [refresh]);

  const ask = useCallback(async () => {
    setAsking(true);
    try {
      const granted = await requestPersistentStorage();
      setLastAnswer(granted);
    } finally {
      setAsking(false);
      refresh();
    }
  }, [refresh]);

  const persisted = status?.persisted;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Will the browser keep your data?"
          subtitle={persistLabel(persisted)}
        />

        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Everything lives in this browser&rsquo;s storage on this device.
          Browsers are allowed to clear that storage to reclaim space, and
          Safari does exactly that to ordinary websites after about a week
          without a visit. There is no copy on a server to restore from, so this
          matters more here than it would in most apps.
        </p>

        {persisted === true && (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            This origin has been granted persistent storage: the browser has
            agreed not to evict it automatically. It can still be cleared by you,
            or by deleting the app.
          </p>
        )}

        {persisted === false && (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            The browser has <strong className="text-ink">not</strong> granted
            persistent storage. Asking again is free and sometimes succeeds once
            the app is installed to the Home Screen.
          </p>
        )}

        {persisted === null && (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            This browser does not expose the Storage API, so there is no way to
            ask and no way to know. Take backups.
          </p>
        )}

        {lastAnswer === false && (
          <p className="mt-3 text-sm text-danger leading-relaxed">
            The browser refused. On iPhone that is the usual answer until the
            app is on your Home Screen — see below.
          </p>
        )}
        {lastAnswer === true && (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">Granted.</p>
        )}
        {lastAnswer === null && (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            This browser has no way to make the request.
          </p>
        )}

        {persisted !== true && (
          <div className="mt-4">
            <Button
              size="sm"
              variant="secondary"
              loading={asking}
              onClick={() => void ask()}
            >
              Ask the browser to keep it
            </Button>
          </div>
        )}

        {status && (status.usageBytes !== null || status.quotaBytes !== null) && (
          <dl className="mt-5 grid grid-cols-2 gap-3">
            <Stat label="Used" value={bytes(status.usageBytes)} />
            <Stat label="Available to this app" value={bytes(status.quotaBytes)} />
          </dl>
        )}
      </Card>

      <Card>
        <CardHeader
          title={standalone ? "Installed" : "Add Keel to your Home Screen"}
          subtitle={
            standalone
              ? "Running as an installed app"
              : "The single biggest thing you can do for durability"
          }
        />

        {standalone ? (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Keel is running from the Home Screen, which is what exempts its
            storage from Safari&rsquo;s seven-day eviction rule. Note that
            deleting the app icon deletes the data with it — so keep a backup
            regardless.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm text-ink-2 leading-relaxed">
              Installed web apps get their own storage that Safari does not
              evict on a timer. Running Keel in a browser tab, your data is on a
              roughly seven-day clock that resets each time you visit — which is
              fine until a holiday.
            </p>
            {ios ? (
              <>
                <ol className="mt-4 flex flex-col gap-2 text-sm text-ink-2">
                  <Step n={1}>
                    Before installing,{" "}
                    <Link
                      href="/settings/vault/"
                      className="font-medium text-accent underline underline-offset-2"
                    >
                      export and verify an encrypted backup
                    </Link>{" "}
                    and save it somewhere outside this app.
                  </Step>
                  <Step n={2}>
                    Open your browser&rsquo;s{" "}
                    <strong className="text-ink">Share</strong> menu. Safari and
                    supported third-party browsers can add web apps.
                  </Step>
                  <Step n={3}>
                    Scroll down and tap{" "}
                    <strong className="text-ink">Add to Home Screen</strong>.
                  </Step>
                  <Step n={4}>
                    Leave <strong className="text-ink">Open as Web App</strong>{" "}
                    turned on if that choice appears, then tap Add.
                  </Step>
                  <Step n={5}>
                    Open Keel from the new icon and restore the backup there.
                    iOS does not copy this browser&rsquo;s vault into the Home
                    Screen app.
                  </Step>
                </ol>
                <p className="mt-4 text-xs text-ink-3 leading-relaxed">
                  Don&rsquo;t see{" "}
                  <strong className="text-ink-2">Add to Home Screen</strong>?
                  Choose <strong className="text-ink-2">Open in Safari</strong>{" "}
                  from the browser&rsquo;s menu, then repeat the steps there.
                </p>
              </>
            ) : (
              <p className="mt-4 text-sm text-ink-2 leading-relaxed">
                In most desktop browsers there is an install icon at the right
                of the address bar. On Android, use the browser menu and choose{" "}
                <strong className="text-ink">Install app</strong> or{" "}
                <strong className="text-ink">Add to Home screen</strong>.
              </p>
            )}
            <p className="mt-4 text-xs text-ink-3 leading-relaxed">
              On iPhone and iPad, the installed app has separate private
              storage. iOS does not copy IndexedDB from this browser tab. New
              users are asked to install before vault setup; existing browser
              users must move data with an encrypted backup.
            </p>
          </>
        )}
      </Card>

      <p className="px-1 text-xs text-ink-3 leading-relaxed">
        None of this replaces a backup. Persistent storage stops the browser
        from evicting your data; it does not survive a lost phone, a factory
        reset, or deleting the app.
      </p>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-ink-3">{label}</dt>
      <dd className="text-lg font-semibold tnum text-ink">{value}</dd>
    </div>
  );
}

function persistLabel(persisted: boolean | null | undefined): string {
  if (persisted === undefined) return "Checking…";
  if (persisted === true) return "Yes — storage is marked persistent";
  if (persisted === false) return "Not yet — eviction is possible";
  return "This browser won’t say";
}

function bytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = value / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[unit]}`;
}
