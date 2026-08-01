"use client";

/**
 * @file The demonstration card — the one component other screens mount.
 *
 * ```tsx
 * import { DemoVideoCard } from "@/components/video";
 *
 * <DemoVideoCard slug={exercise.slug} />
 * ```
 *
 * ## What it guarantees
 *
 * 1. **Nothing is requested from Google until a tap.** No iframe, no
 *    thumbnail, no preconnect. Rendering this card 220 times is 220 gradients.
 * 2. **The master switch is real.** With video disabled in Settings there is no
 *    code path from here to an `<iframe>`; the user's own vault-stored clips
 *    still play, because they involve no third party.
 * 3. **The user's own recording wins.** `resolveDemo` puts it above every
 *    YouTube source, because their coach's cue for their hips beats a stranger.
 */

import { useCallback, useMemo, useState } from "react";
import { Badge, Button, Card, CardHeader, Chip, ChipRow } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  COACH_LABELS,
  coachTagsFor,
  resolveDemo,
  searchQueryFor,
  searchUrl,
  watchUrl,
  type DemoResolution,
} from "@/lib/video";
import { DemoPoster } from "./DemoPoster";
import { PinVideoField } from "./PinVideoField";
import { UserDemoPlayer } from "./UserDemoPlayer";
import { UserDemoSheet } from "./UserDemoSheet";
import { YouTubeEmbed } from "./YouTubeEmbed";
import { useUserDemos, useVideoPreferences } from "./hooks";

export interface DemoVideoCardProps {
  /** Library slug, e.g. `barbell-bench-press`. */
  slug: string;
  /** Overrides the library's name — for user-created movements. */
  name?: string;
  /** Renders without the card chrome, for use inside an existing card. */
  bare?: boolean;
  className?: string;
}

/** Short label for the resolved source, shown as a badge. */
function sourceBadge(resolution: DemoResolution): { text: string; tone: "accent" | "neutral" } {
  switch (resolution.kind) {
    case "user":
      return { text: "Your clip", tone: "accent" };
    case "override":
      return { text: "Pinned", tone: "accent" };
    case "curated":
      return { text: "YouTube", tone: "neutral" };
    default:
      return { text: "Not pinned", tone: "neutral" };
  }
}

/**
 * Demonstration video for one exercise.
 *
 * @param props see {@link DemoVideoCardProps}
 */
export function DemoVideoCard({ slug, name, bare = false, className }: DemoVideoCardProps) {
  const prefs = useVideoPreferences();
  const { demos, reload } = useUserDemos(slug);
  const [coach, setCoach] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Playback and the curate panel are stored as *which slug* they are open for,
  // not as booleans. A card reused for a different exercise — the workout logger
  // does exactly that — therefore drops its iframe automatically, with no reset
  // effect and no render in which the old video is mounted under the new name.
  const [playingSlug, setPlayingSlug] = useState<string | null>(null);
  const [curatingSlug, setCuratingSlug] = useState<string | null>(null);
  const playing = playingSlug === slug;
  const curating = curatingSlug === slug;

  const resolution = useMemo(
    () =>
      resolveDemo(slug, {
        overrides: prefs.overrides,
        userDemoId: demos[0]?.id ?? null,
        coach: coach ?? undefined,
      }),
    [coach, demos, prefs.overrides, slug]
  );

  const title = name ?? resolution.name;
  const coaches = useMemo(() => coachTagsFor(slug), [slug]);
  const query = useMemo(
    () => searchQueryFor(slug, { coach: coach ?? undefined }),
    [coach, slug]
  );
  const badge = sourceBadge(resolution);

  const videoId = resolution.videoId;
  const canEmbed = prefs.enabled && videoId !== null;
  const handoffUrl = videoId ? watchUrl(videoId, resolution.startSeconds) : null;

  const play = useCallback(() => setPlayingSlug(slug), [slug]);

  return (
    <div className={cn(bare ? "" : "", className)}>
      <Wrapper bare={bare}>
        <div className="flex items-start justify-between gap-3">
          <CardHeader
            title="How it's done"
            subtitle={
              resolution.kind === "user"
                ? "Your own recording, from your vault"
                : resolution.kind === "search"
                  ? "No video pinned to this movement yet"
                  : title
            }
          />
          <Badge tone={badge.tone === "accent" ? "accent" : "neutral"}>{badge.text}</Badge>
        </div>

        <div className="mt-3">
          {/* --- The user's own clip: local, offline, no third party --------- */}
          {resolution.kind === "user" && demos[0] && (
            playing ? (
              <UserDemoPlayer demo={demos[0]} autoPlay />
            ) : (
              <DemoPoster
                title={title}
                action="Play your clip"
                hint={demos[0].note ?? "Decrypted on this device. Nothing leaves it."}
                onPlay={play}
              />
            )
          )}

          {/* --- A YouTube id, pinned or curated ---------------------------- */}
          {resolution.kind !== "user" && videoId && (
            playing && canEmbed && !prefs.preferNativeApp ? (
              <YouTubeEmbed
                videoId={videoId}
                host={prefs.host}
                startSeconds={resolution.startSeconds}
                title={title}
              />
            ) : (
              <DemoPoster
                title={title}
                action={
                  !prefs.enabled
                    ? "Video is switched off"
                    : prefs.preferNativeApp
                      ? "Open in the YouTube app"
                      : "Play from YouTube"
                }
                hint={
                  !prefs.enabled
                    ? "Turn it back on in Settings › Video"
                    : "Google sees the video and your IP — nothing else"
                }
                disabled={!prefs.enabled}
                onPlay={prefs.preferNativeApp ? undefined : play}
                href={prefs.preferNativeApp && handoffUrl ? handoffUrl : undefined}
              />
            )
          )}

          {/* --- Nothing pinned: hand off to a search ----------------------- */}
          {resolution.kind === "search" && (
            <DemoPoster
              title={title}
              action={prefs.enabled ? "Search YouTube for this" : "Video is switched off"}
              hint={
                prefs.enabled
                  ? `“${query}”`
                  : "Turn it back on in Settings › Video, or record your own"
              }
              disabled={!prefs.enabled}
              href={prefs.enabled ? searchUrl(query) : undefined}
            />
          )}
        </div>

        {/* Coach bias for the search query. The library already records which
            coaches each movement's programming came from, so this costs one
            lookup and makes the search markedly better. */}
        {resolution.kind === "search" && prefs.enabled && coaches.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs text-ink-3">Search a coach you follow</p>
            <ChipRow>
              {coaches.map((tag) => (
                <Chip
                  key={tag}
                  selected={coach === tag}
                  onPress={() => setCoach(coach === tag ? null : tag)}
                >
                  {COACH_LABELS[tag] ?? tag}
                </Chip>
              ))}
            </ChipRow>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {handoffUrl && prefs.enabled && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => window.open(handoffUrl, "_blank", "noopener,noreferrer")}
            >
              Open in YouTube
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setSheetOpen(true)}>
            {demos.length > 0 ? `Your clips (${demos.length})` : "Record your own"}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setCuratingSlug(curating ? null : slug)}>
            {curating ? "Done" : resolution.kind === "override" ? "Change video" : "Pin a video"}
          </Button>
        </div>

        {/* One line, not a lecture: this is the iOS cookie-partition problem,
            and it is the reason the handoff button exists at all. */}
        {handoffUrl && prefs.enabled && (
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            Seeing ads despite Premium? Installed web apps have their own cookie
            store — open it in the YouTube app instead.
          </p>
        )}

        {curating && (
          <div className="mt-3 border-t border-line pt-3">
            <PinVideoField
              slug={slug}
              current={prefs.overrides[slug] ?? null}
              onChanged={() => setPlayingSlug(null)}
            />
          </div>
        )}
      </Wrapper>

      <UserDemoSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        slug={slug}
        exerciseName={title}
        demos={demos}
        onChanged={reload}
      />
    </div>
  );
}

/** Card chrome, or none when the caller already has some. */
function Wrapper({ bare, children }: { bare: boolean; children: React.ReactNode }) {
  if (bare) return <div>{children}</div>;
  return <Card>{children}</Card>;
}
