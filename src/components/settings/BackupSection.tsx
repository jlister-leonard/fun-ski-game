"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/settings/Field";
import {
  BACKUP_EXTENSION,
  MediaBackupCapabilityError,
  daysSinceLastBackup,
  exportAndVerify,
  importPortableBackup,
  isMediaCleanupPending,
  previewPortableImport,
  recordBackupDelivered,
  stagePortableBackupAndVerify,
  suggestBackupFilename,
  type BackupPreview,
  type ImportMode,
  type ImportResult,
  type PortableBackupPreview,
} from "@/lib/vault";

type Stage = "idle" | "verifying" | "ready" | "delivering" | "saved";

interface PendingBackup {
  readonly blob: Blob;
  readonly filename: string;
  readonly preview: BackupPreview & { mediaCount?: number };
  readonly cleanup?: () => Promise<void>;
}

/**
 * Export and restore the encrypted `.hcvault`.
 *
 * ## Why export always verifies first
 *
 * There is no server-side copy of anything. A backup that turns out to be
 * corrupt is discovered at exactly the wrong moment — when the phone is gone.
 * `exportAndVerify` round-trips the file through the real parser and confirms
 * the passphrase opens its keyring *before* the user is offered the download,
 * so "backed up" means the file was proven to open, not that a blob was
 * written.
 */
export function BackupSection() {
  const [days, setDays] = useState<number | null | undefined>(undefined);
  const [stage, setStage] = useState<Stage>("idle");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<(BackupPreview & { mediaCount?: number }) | null>(null);
  const [pending, setPending] = useState<PendingBackup | null>(null);

  const refresh = useCallback(() => {
    daysSinceLastBackup()
      .then(setDays)
      .catch(() => setDays(null));
  }, []);

  useEffect(refresh, [refresh]);

  const save = useCallback(async () => {
    setStage("verifying");
    setError(null);
    try {
      const staged = await stagePortableBackupAndVerify({
        kind: "passphrase",
        value: passphrase,
      });
      const { file: blob, preview } = staged;
      if (!preview.canDecrypt) {
        setError(
          "That passphrase does not open the backup that was just written. Nothing was saved — check the passphrase and try again."
        );
        setStage("idle");
        return;
      }
      if (!preview.integrityOk) {
        setError(
          "The backup failed its own integrity check. Nothing was saved. This is worth reporting — do not rely on this file."
        );
        setStage("idle");
        return;
      }
      if (!preview.recordsOk) {
        setError(
          "At least one encrypted record could not be verified. Nothing was saved — do not rely on this file."
        );
        setStage("idle");
        return;
      }
      if (!preview.compatible) {
        setError(
          "This version of Keel cannot safely read every record in that backup. Update the app and try again."
        );
        setStage("idle");
        return;
      }
      setPending({
        blob,
        filename: blob.name || suggestBackupFilename(),
        preview,
        cleanup: staged.cleanup,
      });
      setPassphrase("");
      setStage("ready");
    } catch (err) {
      setError(
        err instanceof MediaBackupCapabilityError
          ? `${err.message} You can still make a vault-only backup below.`
          : (err as Error)?.message ?? "The backup could not be written."
      );
      setStage("idle");
    }
  }, [passphrase]);

  const saveVaultOnly = useCallback(async () => {
    setStage("verifying");
    setError(null);
    try {
      const { blob, preview } = await exportAndVerify({
        kind: "passphrase",
        value: passphrase,
      });
      setPending({ blob, filename: suggestBackupFilename(), preview });
      setPassphrase("");
      setStage("ready");
    } catch (err) {
      setError((err as Error)?.message ?? "The vault-only backup could not be written.");
      setStage("idle");
    }
  }, [passphrase]);

  const deliverPending = useCallback(async () => {
    if (!pending) return;
    setStage("delivering");
    setError(null);
    try {
      // This callback runs directly from the second button tap. `deliver`
      // invokes navigator.share before its first await, preserving iOS's
      // transient user activation even when verification took several seconds.
      const delivered = await deliver(pending.blob, pending.filename);
      if (!delivered) {
        // Dismissing the iOS share sheet is a normal cancellation, not a
        // successful backup and not an error. Keep the verified file ready.
        setStage("ready");
        return;
      }
      await recordBackupDelivered();
      await pending.cleanup?.();
      setVerified(pending.preview);
      setPending(null);
      setStage("saved");
      refresh();
    } catch (err) {
      setError((err as Error)?.message ?? "The backup could not be saved.");
      setStage("ready");
    }
  }, [pending, refresh]);

  return (
    <Card>
      <CardHeader
        title="Back up your vault"
        subtitle={backupLabel(days)}
        accessory={days !== null && days !== undefined && days < 7 ? <Fresh /> : undefined}
      />

      {stage === "saved" && verified ? (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Handed off and verified: {verified.recordCount.toLocaleString()}{" "}
            records{verified.mediaCount ? ` and ${verified.mediaCount.toLocaleString()} recorded clips` : ""},
            and the file was re-opened with your passphrase before you got it.
          </p>
          <div className="mt-4">
            <Button size="sm" variant="secondary" onClick={() => setStage("idle")}>
              Back up again
            </Button>
          </div>
        </>
      ) : (stage === "ready" || stage === "delivering") && pending ? (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Verified: all {pending.preview.recordCount.toLocaleString()} encrypted
            records opened correctly. Tap below to choose Files, iCloud Drive,
            AirDrop or another safe destination.
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger leading-relaxed">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <Button
              block
              loading={stage === "delivering"}
              onClick={() => void deliverPending()}
            >
              Save verified backup
            </Button>
            <Button
              block
              variant="ghost"
              disabled={stage === "delivering"}
              onClick={() => {
                void pending.cleanup?.();
                setPending(null);
                setStage("idle");
              }}
            >
              Not now
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            The backup is a single <code>{BACKUP_EXTENSION}</code> file. Health
            values and notes stay encrypted, and Keel verifies the whole file
            with your vault key before restore. The file leaves structural
            details readable — including its date, record categories and local
            calendar dates — so treat the whole file as private and put it
            somewhere that is not this phone.
          </p>
          <p className="mt-2 text-sm text-ink-2 leading-relaxed">
            On supported Safari versions, recorded demonstration clips are
            included as raw encrypted ciphertext. Keel stages the file on this
            device before opening Share, so all clips are never copied into
            memory at once.
          </p>

          <div className="mt-4">
            <Field
              label="Passphrase"
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={setPassphrase}
              hint="Used to prove the backup opens before you keep it."
            />
          </div>

          {error && (
            <p role="alert" className="mt-3 text-sm text-danger leading-relaxed">
              {error}
            </p>
          )}

          <div className="mt-4">
            <Button
              block
              loading={stage === "verifying"}
              disabled={passphrase.length === 0}
              onClick={() => void save()}
            >
              {stage === "verifying" ? "Verifying…" : "Back up vault and clips"}
            </Button>
            <Button
              block
              variant="ghost"
              disabled={passphrase.length === 0 || stage === "verifying"}
              onClick={() => void saveVaultOnly()}
            >
              Back up vault only (exclude clips)
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** Restore from a `.hcvault`, always through the dry run first. */
export function RestoreSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [secret, setSecret] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [preview, setPreview] = useState<PortableBackupPreview | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState(0);

  const reset = useCallback(() => {
    setFile(null);
    setPreview(null);
    setSecret("");
    setResult(null);
    setError(null);
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const inspect = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const p = await previewPortableImport(file, {
        kind: useRecoveryCode ? "recovery-code" : "passphrase",
        value: secret,
      });
      setPreview(p);
      setMode(p.mediaCount > 0 ? "replace" : p.sameVault ? "merge" : "replace");
    } catch (err) {
      setError((err as Error)?.message ?? "That file could not be read.");
    } finally {
      setBusy(false);
    }
  }, [file, secret, useRecoveryCode]);

  const restore = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await importPortableBackup(
        file,
        {
          kind: useRecoveryCode ? "recovery-code" : "passphrase",
          value: secret,
        },
        { mode, onProgress: setProgress }
      );
      if (mode === "replace") {
        try {
          sessionStorage.setItem("keel.restore-complete", "1");
        } catch {
          // The message is optional; restore safety does not depend on it.
        }
        window.location.reload();
        return;
      }
      setResult(outcome);
    } catch (err) {
      if (mode === "replace" && (await isMediaCleanupPending().catch(() => false))) {
        try {
          sessionStorage.setItem("keel.media-restore-interrupted", "1");
        } catch {
          // The durable cleanup marker, not this notice, is the safety gate.
        }
        window.location.reload();
        return;
      }
      setError((err as Error)?.message ?? "The restore failed.");
    } finally {
      setBusy(false);
    }
  }, [file, secret, useRecoveryCode, mode]);

  if (result) {
    return (
      <Card>
        <CardHeader title="Restore finished" />
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          <Line label="Records written" value={result.applied.toLocaleString()} />
          <Line
            label="Left alone (this device was newer)"
            value={result.skipped.toLocaleString()}
          />
          {result.failed > 0 && (
            <Line label="Records not written" value={result.failed.toLocaleString()} />
          )}
        </ul>
        <div className="mt-4">
          <Button size="sm" variant="secondary" onClick={reset}>
            Done
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Restore from a backup"
        subtitle="Nothing is written until you have seen what it contains"
      />

      {!file && (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Pick a <code>{BACKUP_EXTENSION}</code> file. Keel opens it, checks
            its integrity and tells you what is inside before it writes a single
            row.
          </p>
          <div className="mt-4">
            <Button
              block
              variant="secondary"
              onClick={() => inputRef.current?.click()}
            >
              Choose a backup file
            </Button>
          </div>
        </>
      )}

      {file && !preview && (
        <>
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <Field
              label={useRecoveryCode ? "Recovery code" : "Passphrase"}
              type={useRecoveryCode ? "text" : "password"}
              autoComplete={useRecoveryCode ? "off" : "current-password"}
              value={secret}
              onChange={setSecret}
              hint={
                useRecoveryCode
                  ? "The code you were shown when this backup's vault was created."
                  : "The passphrase that was in use when this backup was made — not necessarily this device's."
              }
            />
            <button
              type="button"
              className="self-start text-sm text-accent tap"
              onClick={() => setUseRecoveryCode((v) => !v)}
            >
              {useRecoveryCode
                ? "Use a passphrase instead"
                : "Use a recovery code instead"}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger leading-relaxed">
              {error}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button
              loading={busy}
              disabled={secret.length === 0}
              onClick={() => void inspect()}
            >
              Inspect it
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {preview && (
        <>
          <ul className="mt-4 flex flex-col gap-1.5 text-sm">
            <Line
              label="Written"
              value={new Date(preview.createdAt).toLocaleString()}
            />
            <Line label="Records" value={preview.recordCount.toLocaleString()} />
            <Line label="Recorded clips" value={preview.mediaCount.toLocaleString()} />
            <Line
              label="On this device now"
              value={preview.currentRecordCount.toLocaleString()}
            />
            <Line
              label="Integrity check"
              value={preview.integrityOk ? "passed" : "FAILED"}
            />
            <Line
              label="Opens with that secret"
              value={preview.canDecrypt ? "yes" : "no"}
            />
            <Line
              label="Encrypted records"
              value={preview.recordsOk ? "verified" : "FAILED"}
            />
            <Line
              label="App compatibility"
              value={preview.compatible ? "supported" : "UPDATE REQUIRED"}
            />
            <Line
              label="Same vault as this device"
              value={preview.sameVault ? "yes" : "no"}
            />
          </ul>

          {preview.warnings.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2 text-sm text-ink-2 leading-relaxed">
              {preview.warnings.map((warning) => (
                <li key={warning}>· {warning}</li>
              ))}
            </ul>
          )}

          {preview.restorable && (
            <div className="mt-4">
              <p className="text-sm font-medium text-ink">How should it land?</p>
              {/* ModeChoice puts role="radio" on its button, which needs a
                  radiogroup ancestor to be announced as one of two options. */}
              <div
                role="radiogroup"
                aria-label="How should it land?"
                className="mt-2 flex flex-col gap-2"
              >
                <ModeChoice
                  selected={mode === "merge"}
                  onSelect={() => setMode("merge")}
                  title="Merge"
                  body={preview.mediaCount > 0 ? "Unavailable for backups containing clips; replacing is required to preserve their encryption safely." : "Keep what is on this device and fold the backup in. Where both have the same record, the newer one wins."}
                  disabled={preview.mediaCount > 0}
                />
                <ModeChoice
                  selected={mode === "replace"}
                  onSelect={() => setMode("replace")}
                  title="Replace everything"
                  body="Erase this device's vault and adopt the backup wholesale, including its passphrase and recorded clips. A vault-only format-2 backup contains no clips."
                  destructive
                />
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 text-sm text-danger leading-relaxed">
              {error}
            </p>
          )}

          {busy && progress > 0 && (
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${(progress * 100).toFixed(0)}%` }}
              />
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <Button
              loading={busy}
              disabled={!preview.restorable}
              variant={mode === "replace" ? "destructive" : "primary"}
              onClick={() => void restore()}
            >
              {mode === "replace" ? "Replace everything" : "Merge it in"}
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={`${BACKUP_EXTENSION},application/json,application/octet-stream`}
        // sr-only does not remove an element from the tab order, so this was a
        // 1x1 unnamed stop that VoiceOver read as "unlabelled, choose file".
        // A visible button above already opens the picker; this stays reachable
        // by script only, and carries a name for anything that finds it anyway.
        tabIndex={-1}
        aria-label="Choose a backup file"
        className="sr-only"
        onChange={(event) => {
          const picked = event.target.files?.[0];
          if (picked) {
            setFile(picked);
            setError(null);
          }
        }}
      />
    </Card>
  );
}

function ModeChoice({
  selected,
  onSelect,
  title,
  body,
  destructive,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`rounded-[var(--radius-md)] border px-3 py-2.5 text-left disabled:opacity-50 ${
        selected
          ? destructive
            ? "border-danger bg-danger-quiet"
            : "border-accent bg-accent-quiet"
          : "border-line bg-surface-2"
      }`}
    >
      <div className="text-base font-medium text-ink">{title}</div>
      <div className="mt-0.5 text-sm text-ink-2 leading-snug">{body}</div>
    </button>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex justify-between gap-3">
      <span className="text-ink-2">{label}</span>
      <span className="tnum text-ink shrink-0">{value}</span>
    </li>
  );
}

function Fresh() {
  return (
    <span className="text-2xs uppercase tracking-wide text-accent">Recent</span>
  );
}

function backupLabel(days: number | null | undefined): string {
  if (days === undefined) return "Checking…";
  if (days === null) return "You have never taken a backup";
  if (days === 0) return "Last backed up today";
  if (days === 1) return "Last backed up yesterday";
  return `Last backed up ${days} days ago`;
}

/**
 * Hand the file to the user.
 *
 * Prefers the iOS share sheet, because on an installed Home Screen web app a
 * download anchor drops the file somewhere the user cannot easily find, while
 * the share sheet offers Files, AirDrop and iCloud Drive — which is where a
 * backup should actually go. Falls back to a download when sharing files is
 * unavailable or fails for a non-cancellation reason. Dismissing the sheet
 * returns `false`, so the app does not claim a backup was delivered.
 */
async function deliver(blob: Blob, filename: string): Promise<boolean> {
  const file = blob instanceof File
    ? blob
    : new File([blob], filename, { type: "application/json" });
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AbortError") {
        return false;
      }
      // Unsupported in this context — fall through to download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task so Safari has actually started the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
