"use client";

/**
 * @file The YouTube iframe. The only place in the app that mounts one.
 *
 * Nothing here renders until the user has tapped play — see `DemoPoster` and
 * `DemoVideoCard`. That is the single most valuable privacy property left in
 * this feature and it costs nothing: browsing 220 exercises makes zero requests
 * to Google.
 */

import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { embedUrl, type VideoHost } from "@/lib/video";

export interface YouTubeEmbedProps {
  /** A validated 11-character video id. */
  videoId: string;
  /** Which origin to frame. */
  host: VideoHost;
  /** Seconds into the video. */
  startSeconds?: number;
  /** Accessible name — the exercise, not "YouTube video player". */
  title: string;
  className?: string;
}

/**
 * A 16:9 YouTube embed.
 *
 * The attributes are the security surface, so each is deliberate:
 *
 * - **`sandbox`** withholds `allow-top-navigation`, so the embed cannot
 *   navigate our app away to a page that looks like ours. `allow-same-origin`
 *   refers to *YouTube's* origin, which it needs for playback; it grants no
 *   access to ours. Cross-origin isolation is what stops it reading the vault,
 *   and that is enforced by the browser, not by us.
 * - **No `enablejsapi`** in the URL, so there is no postMessage channel in
 *   either direction.
 * - **`referrerPolicy`** sends our origin but never the path. `no-referrer`
 *   was tempting and is wrong: YouTube uses the referrer to enforce
 *   embed-restricted videos, and stripping it turns some videos into a black
 *   box that says "playback disabled" with no explanation.
 * - **`allow`** lists only what a player needs. `encrypted-media` is required
 *   or Premium/DRM streams refuse to start.
 */
export function YouTubeEmbed({
  videoId,
  host,
  startSeconds = 0,
  title,
  className,
}: YouTubeEmbedProps) {
  const src = useMemo(
    () => embedUrl(videoId, { host, startSeconds }),
    [videoId, host, startSeconds]
  );

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-[var(--radius-md)] bg-black",
        className
      )}
    >
      <iframe
        key={src}
        src={src}
        title={`${title} — demonstration`}
        className="absolute inset-0 h-full w-full border-0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
