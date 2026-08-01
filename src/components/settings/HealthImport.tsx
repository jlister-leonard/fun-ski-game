"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ListGroup, ListRow } from "@/components/ui/ListRow";
import { ingestLog, labRecords } from "@/lib/db/repos";
import type { IngestLogEntry, LabRecord } from "@/lib/db/types";
import { importShortcutPayload } from "@/lib/ingest/import-shortcut";
import type { ImportProgress, ImportReceipt } from "@/lib/ingest/types";
import {
  importAppleHealthExport,
  initialProgress,
} from "@/workers/health-import-client";

type Phase = "idle" | "running" | "done" | "error";
type RunningKind = "daily" | "export";

/** Human-readable table names for the receipt. */
const TABLE_LABELS: Record<string, string> = {
  healthMetrics: "daily metrics",
  weightEntries: "weigh-ins",
  sleepRecords: "nights of sleep",
  activities: "workouts",
  labRecords: "lab results",
};

/** What each parser phase is actually doing, in the user's terms. */
const PHASE_LABELS: Record<ImportProgress["phase"], string> = {
  "reading-archive": "Opening the archive",
  "scanning-records": "Reading your health records",
  "reading-clinical-records": "Reading lab results",
  writing: "Saving to your vault",
  done: "Finished",
};

/**
 * The Apple Health import screen.
 *
 * Three things it refuses to do, all of them deliberate:
 *
 * - **No fake percentage.** Until the archive is open there is no denominator,
 *   and a bar that sits at 90% for four minutes is a lie. Real counters —
 *   records read, rows written — are shown instead, and the bar only appears
 *   once the uncompressed size is known.
 * - **No "importing…" spinner over a frozen page.** Parsing happens in a
 *   worker; this screen stays interactive throughout.
 * - **No silent discard.** Sample types the model has no home for are counted
 *   by name and listed in the receipt, because "where is my blood pressure?"
 *   deserves an answer on screen.
 */
export function HealthImport() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ImportProgress>(initialProgress);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<IngestLogEntry[]>([]);
  const [labs, setLabs] = useState<LabRecord[]>([]);
  const [manualText, setManualText] = useState("");
  const [showManualPaste, setShowManualPaste] = useState(false);
  const [runningKind, setRunningKind] = useState<RunningKind>("export");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const supported =
    typeof window === "undefined" || typeof DecompressionStream !== "undefined";

  const loadHistory = useCallback(() => {
    ingestLog
      .recent(6)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, []);

  const loadLabs = useCallback(() => {
    labRecords
      .recent(12)
      .then(setLabs)
      .catch(() => setLabs([]));
  }, []);

  useEffect(() => {
    loadHistory();
    loadLabs();
  }, [loadHistory, loadLabs]);

  const onPick = useCallback(
    async (file: File) => {
      setRunningKind("export");
      setPhase("running");
      setError(null);
      setReceipt(null);
      setProgress(initialProgress());
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await importAppleHealthExport(file, {
          signal: controller.signal,
          onProgress: setProgress,
        });
        setReceipt(result);
        setPhase("done");
        loadHistory();
        loadLabs();
      } catch (err) {
        setError(
          (err as Error)?.message ??
            "The import failed. Try exporting from Health again."
        );
        setPhase("error");
      } finally {
        abortRef.current = null;
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [loadHistory, loadLabs]
  );

  const onDailyText = useCallback(
    async (text: string, fidelity: "shortcut" | "manual") => {
      setRunningKind("daily");
      setPhase("running");
      setError(null);
      setReceipt(null);
      try {
        const result = await importShortcutPayload(text, fidelity);
        setReceipt(result);
        setPhase("done");
        setManualText("");
        loadHistory();
      } catch (err) {
        setError(
          (err as Error)?.message ??
            "The daily health payload could not be imported. Run Sync Health and try again."
        );
        setPhase("error");
      }
    },
    [loadHistory]
  );

  const onClipboard = useCallback(async () => {
    try {
      // This call must remain directly inside the click handler. Moving it
      // behind an effect or timer would lose Safari's required user gesture.
      if (!navigator.clipboard?.readText) {
        throw new Error(
          "This browser cannot read the clipboard directly. Use Paste JSON manually below."
        );
      }
      const text = await navigator.clipboard.readText();
      await onDailyText(text, "shortcut");
    } catch (err) {
      setError(
        (err as Error)?.message ??
          "Clipboard access was not allowed. Try again and approve Paste, or use manual paste."
      );
      setPhase("error");
    }
  }, [onDailyText]);

  return (
    <div className="flex flex-col gap-4 pb-4">
      {!supported && (
        <Card>
          <CardHeader title="This browser can’t read Health exports" />
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Unzipping an export needs <code>DecompressionStream</code>, which
            arrived in iOS 16.4. Update iOS, or use a different browser on this
            device.
          </p>
        </Card>
      )}

      {phase === "idle" && (
        <>
          <Card>
            <CardHeader
              title="Import today from Sync Health"
              subtitle="A quick daily top-up from your clipboard"
            />
            <p className="mt-3 text-sm text-ink-2 leading-relaxed">
              Run the Sync Health Shortcut, then tap below. iOS will ask before
              Keel reads the clipboard. The JSON is validated and written
              directly into your encrypted vault; it is never uploaded.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button block size="lg" onClick={() => void onClipboard()}>
                Import from clipboard
              </Button>
              <Button
                block
                size="sm"
                variant="ghost"
                onClick={() => setShowManualPaste((shown) => !shown)}
              >
                {showManualPaste ? "Hide manual paste" : "Paste JSON manually"}
              </Button>
            </div>
            {showManualPaste && (
              <div className="mt-4">
                <label htmlFor="daily-health-json" className="text-xs font-medium text-ink-2">
                  Sync Health JSON
                </label>
                <textarea
                  id="daily-health-json"
                  value={manualText}
                  onChange={(event) => setManualText(event.target.value)}
                  rows={7}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder={'{"data":{"metrics":[…]}}'}
                  className="mt-2 w-full resize-y rounded-[var(--radius-sm)] border border-[var(--c-border)] bg-surface-2 px-3 py-2 text-xs text-ink outline-none focus:border-accent"
                />
                <Button
                  block
                  size="sm"
                  variant="secondary"
                  disabled={!manualText.trim()}
                  onClick={() => void onDailyText(manualText, "manual")}
                >
                  Import pasted JSON
                </Button>
              </div>
            )}
            <p className="mt-3 text-xs text-ink-3 leading-relaxed">
              The exact same payload is recognized by its content hash, so
              tapping twice cannot duplicate a day.
            </p>
          </Card>

          <Card>
            <CardHeader
              title="Import from Health"
              subtitle="Everything is read on this phone"
            />
            <p className="mt-3 text-sm text-ink-2 leading-relaxed">
              The export is the richest thing Apple gives you: sleep stages,
              individual workouts, years of history, and your lab results if
              your provider connects to Health Records. It is also the only
              path that carries any of that.
            </p>
            <ol className="mt-4 flex flex-col gap-2 text-sm text-ink-2">
              <Step n={1}>
                Open <strong className="text-ink">Health</strong> and tap your
                profile picture, top right.
              </Step>
              <Step n={2}>
                Scroll to the bottom and tap{" "}
                <strong className="text-ink">Export All Health Data</strong>,
                then <strong className="text-ink">Export</strong>.
              </Step>
              <Step n={3}>
                Save it to <strong className="text-ink">Files</strong>. It takes
                a few minutes and produces <code>export.zip</code>.
              </Step>
              <Step n={4}>Come back here and choose that file.</Step>
            </ol>
            <p className="mt-4 text-xs text-ink-3 leading-relaxed">
              If Health says “Could not export data”, increase Auto-Lock in
              Settings → Display &amp; Brightness and try again — the export
              stops when the screen locks.
            </p>
            <div className="mt-5">
              <Button
                block
                size="lg"
                disabled={!supported}
                onClick={() => inputRef.current?.click()}
              >
                Choose export.zip
              </Button>
            </div>
            <p className="mt-3 text-xs text-ink-3 leading-relaxed">
              A large export can take a few minutes. Keep this screen open and
              the phone awake.
            </p>
          </Card>

          <p className="px-1 text-xs text-ink-3 leading-relaxed">
            Re-importing the same file is safe: every record has a stable key,
            so a second import updates what changed instead of duplicating it.
            Anything you deleted stays deleted.
          </p>
        </>
      )}

      {phase === "running" &&
        (runningKind === "daily" ? (
          <Card>
            <CardHeader title="Importing today’s health data" subtitle="Saving locally to your vault" />
          </Card>
        ) : (
          <ProgressCard progress={progress} />
        ))}

      {phase === "error" && (
        <Card>
          <CardHeader title="The import stopped" />
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">{error}</p>
          <div className="mt-4">
            <Button size="sm" variant="secondary" onClick={() => setPhase("idle")}>
              Try again
            </Button>
          </div>
        </Card>
      )}

      {phase === "done" && receipt && (
        <ReceiptCard receipt={receipt} onAgain={() => setPhase("idle")} />
      )}

      {history.length > 0 && phase !== "running" && (
        <section>
          <h2 className="px-1 pb-2 text-sm font-medium text-ink-2">
            Previous imports
          </h2>
          <ListGroup>
            {history.map((entry) => (
              <ListRow
                key={entry.id}
                title={new Date(entry.updatedAt).toLocaleString()}
                subtitle={`${entry.appliedCount.toLocaleString()} rows · ${entry.channel}`}
                value={entry.status === "applied" ? "✓" : entry.status}
                muted={entry.status !== "applied"}
              />
            ))}
          </ListGroup>
        </section>
      )}

      {labs.length > 0 && phase !== "running" && (
        <section>
          <h2 className="px-1 pb-2 text-sm font-medium text-ink-2">
            Imported lab results
          </h2>
          <ListGroup>
            {labs.map((lab) => (
              <ListRow
                key={lab.id}
                title={lab.displayName}
                subtitle={`${lab.dateKey} · ${labProvenance(lab)}`}
                value={labValue(lab)}
              />
            ))}
          </ListGroup>
          <p className="mt-2 px-1 text-xs text-ink-3 leading-relaxed">
            Values and provider provenance are read from your encrypted vault.
            They stay on this device and are not medical advice.
          </p>
        </section>
      )}

      <input
        ref={inputRef}
        type="file"
        // `showOpenFilePicker` does not exist in Safari; the input element is
        // the only file picker iOS has.
        accept=".zip,application/zip"
        // sr-only keeps it in the tab order; the two visible buttons above are
        // the real trigger, so take it out and name it.
        tabIndex={-1}
        aria-label="Choose an Apple Health export"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onPick(file);
        }}
      />
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

function ProgressCard({ progress }: { progress: ImportProgress }) {
  const fraction =
    progress.bytesTotal && progress.bytesTotal > 0
      ? Math.min(1, progress.bytesRead / progress.bytesTotal)
      : null;

  return (
    <Card>
      <CardHeader
        title={PHASE_LABELS[progress.phase]}
        subtitle={progress.detail ?? undefined}
      />

      {/* Only shown once there is a real denominator. */}
      {fraction !== null && progress.phase === "scanning-records" && (
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${(fraction * 100).toFixed(1)}%` }}
          />
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3">
        <Stat label="Records read" value={progress.recordsSeen.toLocaleString()} />
        <Stat label="Rows saved" value={progress.rowsWritten.toLocaleString()} />
        {progress.clinicalFilesRead > 0 && (
          <Stat
            label="Lab files"
            value={progress.clinicalFilesRead.toLocaleString()}
          />
        )}
        {progress.bytesTotal !== null && (
          <Stat
            label="Read"
            value={`${formatBytes(progress.bytesRead)} of ${formatBytes(progress.bytesTotal)}`}
          />
        )}
      </dl>

      <p className="mt-4 text-xs text-ink-3 leading-relaxed">
        Parsing runs in the background, so the app stays usable — but leaving
        this screen while it works will cancel the import.
      </p>
    </Card>
  );
}

function ReceiptCard({
  receipt,
  onAgain,
}: {
  receipt: ImportReceipt;
  onAgain: () => void;
}) {
  const created = Object.entries(receipt.created);
  const updated = Object.entries(receipt.updated);
  const unmapped = Object.entries(receipt.unmapped).sort((a, b) => b[1] - a[1]);
  const empty = created.length === 0 && updated.length === 0;
  // Nothing new, but rows were matched and refreshed — what re-importing the
  // same export is *supposed* to look like.
  const alreadyHad = created.length === 0 && updated.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={
            receipt.duplicate
              ? "Already imported"
              : empty
              ? "Nothing to add"
              : alreadyHad
                ? "Already up to date"
                : "Import finished"
          }
          subtitle={
            receipt.dateRange.from
              ? `${receipt.dateRange.from} → ${receipt.dateRange.to}`
              : undefined
          }
        />

        {receipt.duplicate && (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Keel recognized this exact Sync Health payload. It was already
            applied, so nothing was written or duplicated.
          </p>
        )}

        {alreadyHad && !receipt.duplicate && (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Every record in this export was already in your vault. It was
            matched and refreshed rather than added again — nothing was
            duplicated.
          </p>
        )}

        {empty && !receipt.duplicate ? (
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Nothing in this file landed anywhere Keel stores data. If you
            expected sleep or workouts, the export may be incomplete — try
            exporting from Health again.
          </p>
        ) : !receipt.duplicate ? (
          <ul className="mt-4 flex flex-col gap-1.5 text-sm">
            {created.map(([table, n]) => (
              <li key={`c-${table}`} className="flex justify-between gap-3">
                <span className="text-ink-2">
                  New {TABLE_LABELS[table] ?? table}
                </span>
                <span className="tnum text-ink">{n.toLocaleString()}</span>
              </li>
            ))}
            {updated.map(([table, n]) => (
              <li key={`u-${table}`} className="flex justify-between gap-3">
                <span className="text-ink-2">
                  Refreshed {TABLE_LABELS[table] ?? table}
                </span>
                <span className="tnum text-ink">{n.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {!receipt.duplicate && (
          <p className="mt-4 text-xs text-ink-3 leading-relaxed">
            {receipt.rawSamplesSeen.toLocaleString()} raw samples were read and
            rolled up into daily values.
            {receipt.skipped > 0 &&
              ` ${receipt.skipped.toLocaleString()} were left alone to preserve a deletion or richer value from a full export.`}
          </p>
        )}

        <div className="mt-4">
          <Button size="sm" variant="secondary" onClick={onAgain}>
            Import more health data
          </Button>
        </div>
      </Card>

      {receipt.warnings.length > 0 && (
        <Card>
          <CardHeader title="Worth knowing" />
          <ul className="mt-3 flex flex-col gap-2 text-sm text-ink-2 leading-relaxed">
            {receipt.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Card>
      )}

      {unmapped.length > 0 && (
        <Card>
          <CardHeader
            title="Not imported"
            subtitle="Sample types Keel has no home for yet"
          />
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            Apple exports well over a hundred kinds of sample and Keel models a
            fraction of them. These were seen and skipped, so you know what did
            not arrive rather than assuming everything did.
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {unmapped.slice(0, 12).map(([type, n]) => (
              <li key={type} className="flex justify-between gap-3">
                <span className="text-ink-2 truncate">{humanise(type)}</span>
                <span className="tnum text-ink-3">{n.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          {unmapped.length > 12 && (
            <p className="mt-2 text-xs text-ink-3">
              …and {unmapped.length - 12} more kinds.
            </p>
          )}
        </Card>
      )}

      {receipt.failures > 0 && (
        <Card>
          <CardHeader title="Records that could not be read" />
          <p className="mt-3 text-sm text-ink-2 leading-relaxed">
            {receipt.failures.toLocaleString()} records had a date or unit that
            could not be understood and were skipped. A handful is normal in a
            large export; thousands would suggest a corrupt file worth
            re-exporting.
          </p>
        </Card>
      )}

      <p className="px-1 text-xs text-ink-3 leading-relaxed">
        Now that there is data,{" "}
        <Link href="/settings/storage/" className="text-accent">
          make sure the browser will keep it
        </Link>
        .
      </p>
    </div>
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

/** `HeartRate` → `Heart rate`. The receipt should not read as source code. */
function humanise(identifier: string): string {
  const spaced = identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function labValue(lab: LabRecord): string {
  if (lab.rawValue !== null) return `${lab.rawValue}${lab.rawUnit ? ` ${lab.rawUnit}` : ""}`;
  return lab.valueText ?? "No numeric value";
}

function labProvenance(lab: LabRecord): string {
  const providers = lab.providers.length > 0 ? lab.providers.join(", ") : "Provider not supplied";
  const releases = lab.fhirReleases.map((release) => release.toUpperCase()).join("/");
  return `${providers} · Apple Health ${releases}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
