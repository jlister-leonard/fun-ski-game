"use client";

/**
 * @file Recording, naming and managing the user's own demonstrations.
 *
 * This is the part of the feature worth the most. A curated YouTube video shows
 * a stranger doing the movement well; a ten-second clip from the user's coach
 * shows *them* doing it, with the cue that fixed *their* hips, filmed on the
 * equipment they actually use. It also works with no signal, and no third party
 * ever learns it exists.
 */

import { useCallback, useRef, useState } from "react";
import { Button, Sheet, TextField, toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  DemoTooLargeError,
  MAX_DEMO_BYTES,
  deleteUserDemo,
  saveUserDemo,
  type UserDemoMeta,
} from "@/lib/video";
import { UserDemoPlayer } from "./UserDemoPlayer";

export interface UserDemoSheetProps {
  open: boolean;
  onClose: () => void;
  /** Exercise the recordings belong to. */
  slug: string;
  /** Human name, for labels and default naming. */
  exerciseName: string;
  /** Existing recordings, newest first. */
  demos: readonly UserDemoMeta[];
  /** Called after a save or a delete so the caller can re-read. */
  onChanged: () => void;
}

/** Bytes → "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Read a video's duration without decoding it, using a throwaway object URL.
 *
 * Best-effort: some containers report `Infinity` or nothing at all, and a
 * missing duration is not worth failing a save over.
 *
 * @param file the selected video
 * @returns whole seconds, or null
 */
async function probeDuration(file: Blob): Promise<number | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const el = document.createElement("video");
      el.preload = "metadata";
      const done = (value: number | null) => resolve(value);
      el.onloadedmetadata = () =>
        done(Number.isFinite(el.duration) ? Math.round(el.duration) : null);
      el.onerror = () => done(null);
      // Never hang the save on a container the browser cannot parse.
      setTimeout(() => done(null), 4000);
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The "your demos" sheet: record or choose a video, name it, keep the coach's
 * words with it, and delete any of them.
 *
 * @param props see {@link UserDemoSheetProps}
 */
export function UserDemoSheet({
  open,
  onClose,
  slug,
  exerciseName,
  demos,
  onChanged,
}: UserDemoSheetProps) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<UserDemoMeta | null>(null);

  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setFile(null);
    setLabel("");
    setNote("");
  }, []);

  const save = useCallback(async () => {
    if (!file) return;
    setSaving(true);
    try {
      const durationSec = await probeDuration(file);
      await saveUserDemo({
        slug,
        file,
        label: label.trim() || `${exerciseName} — my demo`,
        note: note.trim() || null,
        durationSec,
      });
      toast("Saved to your vault, encrypted.");
      reset();
      onChanged();
    } catch (err) {
      const message =
        err instanceof DemoTooLargeError
          ? err.message
          : err instanceof Error
            ? err.message
            : "That video could not be saved.";
      toast(message, { tone: "warn", assertive: true });
    } finally {
      setSaving(false);
    }
  }, [exerciseName, file, label, note, onChanged, reset, slug]);

  const remove = useCallback(
    async (demo: UserDemoMeta) => {
      try {
        await deleteUserDemo(demo.id);
        if (preview?.id === demo.id) setPreview(null);
        toast("Deleted.");
        onChanged();
      } catch {
        toast("Could not delete that video.", { tone: "warn", assertive: true });
      }
    },
    [onChanged, preview]
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Your demonstrations"
      detent="large"
      footer={
        file ? (
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={reset} disabled={saving}>
              Discard
            </Button>
            <Button block loading={saving} onClick={() => void save()}>
              Save to vault
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5 pb-2">
        <p className="text-sm leading-relaxed text-ink-2">
          Film your coach&rsquo;s version of{" "}
          <span className="text-ink">{exerciseName}</span>, or save a clip they sent
          you. It is encrypted in your vault with everything else, plays offline, and
          no one else ever sees it.
        </p>

        {/* Two inputs rather than one: `capture` forces the camera, which is
            right for "film this now" and wrong for "save the clip my trainer
            texted me". iOS gives no way to offer both from a single control. */}
        <input
          ref={cameraRef}
          type="file"
          accept="video/*"
          capture="environment"
          className="hidden"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <input
          ref={libraryRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />

        {!file && (
          <div className="flex gap-2">
            <Button block onClick={() => cameraRef.current?.click()}>
              Record now
            </Button>
            <Button variant="secondary" block onClick={() => libraryRef.current?.click()}>
              Choose a video
            </Button>
          </div>
        )}

        {file && (
          <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-line p-3">
            <p className="text-sm text-ink">
              {file.name || "New recording"}{" "}
              <span className="text-ink-3">({formatBytes(file.size)})</span>
            </p>
            <TextField
              label="Name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={`${exerciseName} — my demo`}
            />
            <TextField
              label="What did they say?"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Drive the knee out, don't let the hip drop"
            />
            <p className="text-xs leading-relaxed text-ink-3">
              Up to {(MAX_DEMO_BYTES / 1024 / 1024).toFixed(0)} MB. Longer clips are
              better trimmed in Photos first — a form check is ten seconds.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">
            Saved {demos.length === 1 ? "clip" : "clips"} ({demos.length})
          </h3>
          {demos.length === 0 && (
            <p className="text-sm text-ink-3">Nothing saved for this movement yet.</p>
          )}
          {demos.map((demo) => (
            <div
              key={demo.id}
              className={cn(
                "flex flex-col gap-2 rounded-[var(--radius-md)] border border-line p-3"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{demo.label}</p>
                  <p className="text-xs text-ink-3">
                    {new Date(demo.savedAt).toLocaleDateString()} ·{" "}
                    {formatBytes(demo.bytes)}
                    {demo.durationSec ? ` · ${demo.durationSec}s` : ""}
                  </p>
                  {demo.note && (
                    <p className="mt-1 text-xs leading-relaxed text-ink-2">{demo.note}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => setPreview(preview?.id === demo.id ? null : demo)}
                  >
                    {preview?.id === demo.id ? "Hide" : "Play"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void remove(demo)}>
                    Delete
                  </Button>
                </div>
              </div>
              {preview?.id === demo.id && <UserDemoPlayer demo={demo} autoPlay />}
            </div>
          ))}
        </div>

        <p className="text-xs leading-relaxed text-ink-3">
          Heads up: your own clips are encrypted on this device but are{" "}
          <span className="text-ink-2">included in “Back up vault and clips” files</span>.
          Vault-only backups exclude them, so keep originals in Photos too.
        </p>
      </div>
    </Sheet>
  );
}
