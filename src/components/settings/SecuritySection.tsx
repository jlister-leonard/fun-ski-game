"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/settings/Field";
import { wipeVault } from "@/lib/db";
import { deleteAllUserDemos } from "@/lib/video";
import {
  addRecoveryCode,
  assessPassphrase,
  changePassphrase,
  getStatus,
  invalidateKeyringCache,
  lock,
  type VaultStatus,
} from "@/lib/vault";

/** Change the passphrase. O(1) on the vault — no row is re-encrypted. */
export function PassphraseSection() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const assessment = useMemo(
    () => (next ? assessPassphrase(next) : null),
    [next]
  );
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready =
    current.length > 0 && !!assessment?.acceptable && confirm === next && !busy;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await changePassphrase(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
      setOpen(false);
    } catch {
      // `changePassphrase` throws `UnlockFailedError` for a bad old passphrase
      // and nothing else — a GCM tag failure has exactly one cause.
      setError("That current passphrase is not right.");
    } finally {
      setBusy(false);
    }
  }, [current, next]);

  return (
    <Card>
      <CardHeader
        title="Passphrase"
        subtitle={done ? "Changed" : "The only way into this vault"}
      />

      {!open ? (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Changing it re-wraps the key, not your data, so it is instant on a
            vault of any size. Your recovery code keeps working — it wraps the
            same key by a different route.
          </p>
          <div className="mt-4">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setOpen(true);
                setDone(false);
              }}
            >
              Change passphrase
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <Field
            label="Current passphrase"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
          />
          <Field
            label="New passphrase"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={setNext}
            hint={assessment?.advice}
          />
          <Field
            label="Confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            invalid={mismatch}
            hint={mismatch ? "These don’t match yet." : undefined}
          />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button loading={busy} disabled={!ready} onClick={() => void submit()}>
              Change it
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Issue a fresh recovery code, revoking the old one. */
export function RecoveryCodeSection() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code]);

  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await addRecoveryCode());
      setSaved(false);
    } catch (err) {
      setError((err as Error)?.message ?? "Could not issue a recovery code.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Card>
      <CardHeader
        title="Recovery code"
        subtitle={
          status?.hasRecoveryCode
            ? "One is active on this vault"
            : "None — you have one way in"
        }
      />

      {code ? (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            This replaces any previous code, which no longer works. It is shown
            once and is not stored anywhere.
          </p>
          <p className="mt-3 select-all rounded-[var(--radius-md)] bg-surface-2 px-3 py-3 text-center text-base font-medium tracking-[0.08em] tnum text-ink break-all">
            {code}
          </p>
          <label className="mt-3 flex items-start gap-2.5 text-sm text-ink-2 leading-relaxed">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--c-accent)]"
            />
            <span>
              I&rsquo;ve written this down somewhere I can reach without this
              phone.
            </span>
          </label>
          <div className="mt-4">
            <Button size="sm" disabled={!saved} onClick={() => setCode(null)}>
              Hide it
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            {status?.hasRecoveryCode
              ? "Issuing a new code revokes the old one immediately. Do it if you think the old one was seen by someone else, or if you cannot find it."
              : "Without a recovery code, forgetting the passphrase means the data is gone. There is nobody to ask."}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-4">
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void issue()}>
              {status?.hasRecoveryCode ? "Issue a new code" : "Issue a recovery code"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** The word the user has to type. Deliberately not "yes". */
const CONFIRM_WORD = "DELETE";

/**
 * Delete everything on this device.
 *
 * Behind a typed word rather than a two-tap confirmation, because this is the
 * one action in the app with no undo and no copy anywhere else. The screen says
 * how many records are about to go and how long ago the last backup was, so the
 * decision is made with the relevant facts in view rather than from memory.
 */
export function DangerSection({ recordCount }: { recordCount: number | null }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wipe = useCallback(async () => {
    setBusy(true);
    setError(null);
    let clipsDeleted = false;
    try {
      // User-recorded clips live in their own encrypted IndexedDB database.
      // Clear them first: if that fails, leave the primary vault untouched so
      // "delete everything" can never silently mean "delete only some data".
      await deleteAllUserDemos();
      clipsDeleted = true;
      await wipeVault();
      invalidateKeyringCache();
      lock();
      window.location.href = "/";
    } catch {
      setError(
        clipsDeleted
          ? "The recorded clips were erased, but the vault could not be cleared. Your vault records and keys are still here; try again."
          : "Keel could not remove the recorded clips, so the vault was left untouched. Try again."
      );
      setBusy(false);
    }
  }, []);

  return (
    <Card className="border-danger/35">
      <CardHeader
        title="Delete everything"
        subtitle="Unrecoverable without a backup file"
      />

      {!open ? (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            This erases every record, every recorded demonstration clip, the
            encryption keys and your recovery code from this device. There is
            no server copy. If you do not have a <code>.hcvault</code> file
            somewhere else, the data is gone permanently. Only format-3
            backups made with “Back up vault and clips” contain recordings;
            vault-only format-2 files do not.
          </p>
          <div className="mt-4">
            <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
              Delete everything
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-ink leading-relaxed">
            {recordCount === null
              ? "Every record on this device"
              : `All ${recordCount.toLocaleString()} records on this device`}{" "}
            will be destroyed. Type <strong>{CONFIRM_WORD}</strong> to confirm.
          </p>
          <Field
            label={`Type ${CONFIRM_WORD}`}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
          />
          {error && (
            <p role="alert" className="text-sm text-danger leading-relaxed">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              loading={busy}
              disabled={typed !== CONFIRM_WORD}
              onClick={() => void wipe()}
            >
              Delete it all
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setTyped("");
              }}
            >
              Keep my data
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
