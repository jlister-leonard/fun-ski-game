"use client";

/**
 * @file Pinning a YouTube video to an exercise — one field, one button.
 *
 * The app ships with no verified video ids (see `lib/video/demos.ts` for why
 * inventing them would be worse than admitting it), so the user's own curation
 * is how coverage grows. That only happens if pinning is trivial: paste
 * whatever iOS put on the clipboard, tap Pin, done. Anything more ceremonious —
 * a modal, an id field that rejects URLs, a confirmation — and it happens once
 * and never again.
 */

import { useCallback, useState } from "react";
import { Button, TextField, toast } from "@/components/ui";
import { pinDemo, unpinDemo, type DemoOverride } from "@/lib/video";

export interface PinVideoFieldProps {
  slug: string;
  /** The current pin, when there is one. */
  current?: DemoOverride | null;
  /** Called after a successful pin or unpin. */
  onChanged?: () => void;
}

/**
 * The paste-a-link control.
 *
 * @param props see {@link PinVideoFieldProps}
 */
export function PinVideoField({ slug, current, onChanged }: PinVideoFieldProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pin = useCallback(async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await pinDemo(slug, value);
      setValue("");
      toast("Pinned. This is the demo for this movement now.");
      onChanged?.();
    } catch (err) {
      setError(
        err instanceof RangeError
          ? err.message
          : "That could not be saved. Is the vault unlocked?"
      );
    } finally {
      setBusy(false);
    }
  }, [onChanged, slug, value]);

  const unpin = useCallback(async () => {
    setBusy(true);
    try {
      await unpinDemo(slug);
      toast("Unpinned.");
      onChanged?.();
    } catch {
      setError("That could not be removed.");
    } finally {
      setBusy(false);
    }
  }, [onChanged, slug]);

  return (
    <div className="flex flex-col gap-2">
      <TextField
          label="Pin a YouTube video"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste a link or video id"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          error={error}
          hint={
            current
              ? `Pinned: ${current.videoId}${current.startSeconds ? ` at ${current.startSeconds}s` : ""}`
              : "A share link, a youtu.be link with a timestamp, or the id itself."
          }
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void pin()}
          loading={busy}
          disabled={value.trim().length === 0}
        >
          Pin this video
        </Button>
        {current && (
          <Button size="sm" variant="quiet" onClick={() => void unpin()} disabled={busy}>
            Remove pinned
          </Button>
        )}
      </div>
    </div>
  );
}
