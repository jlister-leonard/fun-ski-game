"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import type { GymPhoto } from "@/lib/gyms/profiles";
import { PhotoError, toStoredPhoto } from "./photo";

/**
 * @file Photos of the gym, as a memory aid.
 *
 * The claim made in the UI copy below is one the architecture actually keeps,
 * not a reassurance: the image is resized in this tab and written into the
 * same AES-GCM-encrypted IndexedDB row as everything else. There is no
 * backend to send it to, no third party in the bundle, and the privacy audit
 * in CI fails on a same-origin request carrying user data.
 *
 * It is said out loud because a health app asking for camera access without
 * explaining itself has earned every bit of suspicion it gets.
 */

export interface PhotoStripProps {
  photos: readonly GymPhoto[];
  onChange: (next: GymPhoto[]) => void;
}

/** Add and remove gym photos. */
export function PhotoStrip({ photos, onChange }: PhotoStripProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const add = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await toStoredPhoto(file);
      onChange([
        ...photos,
        { dataUrl, capturedAt: Date.now(), label: file.name.slice(0, 40) },
      ]);
    } catch (error) {
      toast(
        error instanceof PhotoError ? error.message : "That photo could not be added.",
        { tone: "warn", assertive: true },
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div>
      <p className="text-sm text-ink-2">Photos</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-3">
        A reminder of what is where. Stored encrypted on this phone, never
        uploaded and never analysed — there is no server to send it to.
      </p>

      {photos.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {photos.map((photo, i) => (
            <div key={`${photo.capturedAt}-${i}`} className="relative shrink-0">
              <Image
                src={photo.dataUrl}
                alt={photo.label || "Gym photo"}
                width={112}
                height={112}
                unoptimized
                className="h-28 w-28 rounded-[var(--radius-md)] border border-line object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${photo.label || "photo"}`}
                onClick={() => onChange(photos.filter((_, j) => j !== i))}
                className="absolute right-1 top-1 h-7 w-7 rounded-full bg-bg/80 text-sm text-ink tap active:opacity-60"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => void add(e.target.files?.[0])}
      />
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        loading={busy}
        onClick={() => input.current?.click()}
      >
        Add a photo
      </Button>
    </div>
  );
}
