"use client";

/**
 * @file Playback of a recording stored in the vault.
 *
 * No network, no third party, no iframe: the bytes are decrypted in memory and
 * handed to a `<video>` element as a `blob:` URL, which the CSP's
 * `media-src 'self' blob:` permits and nothing else does.
 */

import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui";
import type { UserDemoMeta } from "@/lib/video";
import { useUserDemoUrl } from "./hooks";

export interface UserDemoPlayerProps {
  demo: UserDemoMeta;
  /** Autoplay once decrypted. True when the user just tapped play. */
  autoPlay?: boolean;
  className?: string;
}

/**
 * Play one of the user's own demonstrations.
 *
 * Decryption starts when this mounts, so mount it on the tap rather than on
 * render — a 40 MB AES-GCM decrypt is not something to do speculatively for
 * every exercise on a workout screen.
 *
 * @param props see {@link UserDemoPlayerProps}
 */
export function UserDemoPlayer({ demo, autoPlay = false, className }: UserDemoPlayerProps) {
  const { url, loading, error } = useUserDemoUrl(demo.id);

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-[var(--radius-md)] bg-black",
        className
      )}
    >
      {url && (
        <video
          key={url}
          src={url}
          controls
          playsInline
          autoPlay={autoPlay}
          preload="metadata"
          className="absolute inset-0 h-full w-full"
        />
      )}
      {!url && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          {loading && <Spinner />}
          <p className="text-sm text-[rgba(255,255,255,0.75)]">
            {error ?? (loading ? "Decrypting…" : "Nothing to play")}
          </p>
        </div>
      )}
    </div>
  );
}
