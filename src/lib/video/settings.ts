/**
 * @file Video preferences and per-exercise pinned videos.
 *
 * ## Where this is stored, and why there is no new table
 *
 * Everything here lives in `AppSettings.ui`, the namespaced preferences bag the
 * vault schema already provides, under `video.*` keys. That means:
 *
 * - it is inside the encrypted settings row like every other preference;
 * - it rides along in `.hcvault` backups with no work from me, so a user who
 *   restores a device keeps the videos they curated over months;
 * - it needs no schema change, so no other agent's file moves.
 *
 * The overrides map is a JSON string in that bag rather than a nested object,
 * because `AppSettings.ui` is typed `Record<string, string | number | boolean>`
 * and widening someone else's type for one feature is the wrong trade. At 220
 * possible entries of ~40 bytes it is a few kilobytes at absolute worst.
 *
 * ## Is a slug → video-id map health data?
 *
 * Yes — `rehab-shoulder-external-rotation` is a medical inference, which is why
 * the vault blind-indexes exercise slugs in the first place. It is in the
 * encrypted settings row and it never leaves the device. The *only* thing that
 * reaches Google is the one video id the user is playing, at the moment they
 * play it.
 */

import { settings } from '@/lib/db/repos';
import { subscribe as subscribeVault } from '@/lib/vault';
import { parseYouTubeLink } from './youtube';
import type { DemoOverride, VideoHost, VideoPreferences } from './types';

/** The `AppSettings.ui` keys this module owns. Namespaced; nothing else uses them. */
export const UI_KEYS = {
  enabled: 'video.enabled',
  host: 'video.host',
  preferNativeApp: 'video.preferNativeApp',
  overrides: 'video.overrides',
} as const;

/**
 * Defaults.
 *
 * `enabled: true` because the user asked for video; `host: 'standard'` because
 * the nocookie origin strips their YouTube session and therefore their Premium
 * (see `youtube.ts`); `preferNativeApp: false` because the in-app embed is the
 * faster path and the handoff button is always visible anyway.
 */
export const DEFAULT_VIDEO_PREFERENCES: VideoPreferences = Object.freeze({
  enabled: true,
  host: 'standard' as VideoHost,
  preferNativeApp: false,
  overrides: Object.freeze({}) as Readonly<Record<string, DemoOverride>>,
});

// ---------------------------------------------------------------------------
// Pure codec — unit tested without a database
// ---------------------------------------------------------------------------

/**
 * Read preferences out of a raw `AppSettings.ui` bag.
 *
 * Tolerant by construction: a malformed or half-written value falls back to its
 * default rather than throwing. A corrupt preference must not be able to take
 * down the training screen it is embedded in.
 *
 * @param ui the settings bag, or anything at all
 * @returns fully-populated preferences
 */
export function parseVideoPreferences(ui: unknown): VideoPreferences {
  const bag = (ui ?? {}) as Record<string, unknown>;
  const host = bag[UI_KEYS.host];
  return {
    enabled: typeof bag[UI_KEYS.enabled] === 'boolean' ? (bag[UI_KEYS.enabled] as boolean) : true,
    host: host === 'nocookie' || host === 'standard' ? host : 'standard',
    preferNativeApp: bag[UI_KEYS.preferNativeApp] === true,
    overrides: parseOverrides(bag[UI_KEYS.overrides]),
  };
}

/**
 * Parse the overrides JSON, dropping anything that is not a well-formed entry.
 *
 * @param raw the stored string
 * @returns slug → override, always an object
 */
export function parseOverrides(raw: unknown): Record<string, DemoOverride> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, DemoOverride> = {};
  for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const videoId = entry.videoId;
    if (typeof videoId !== 'string') continue;
    // Re-validate on read: a hand-edited backup must not be able to put an
    // arbitrary string into an iframe src.
    const link = parseYouTubeLink(videoId);
    if (!link) continue;
    out[slug] = {
      videoId: link.videoId,
      startSeconds: typeof entry.startSeconds === 'number' ? entry.startSeconds : 0,
      setAt: typeof entry.setAt === 'number' ? entry.setAt : undefined,
    };
  }
  return out;
}

/**
 * Serialize the overrides map for storage.
 *
 * @param overrides slug → override
 * @returns compact JSON
 */
export function serializeOverrides(overrides: Readonly<Record<string, DemoOverride>>): string {
  return JSON.stringify(overrides);
}

// ---------------------------------------------------------------------------
// Persistence + a synchronous snapshot for React
// ---------------------------------------------------------------------------

let cache: VideoPreferences = DEFAULT_VIDEO_PREFERENCES;
let loaded = false;
const listeners = new Set<() => void>();
let vaultWatch: (() => void) | null = null;

function publish(next: VideoPreferences): void {
  cache = next;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[video] preference listener threw', err);
    }
  }
}

/**
 * Drop the cached preferences when the vault locks.
 *
 * They are vault data; holding a decrypted copy across a lock would be a small
 * but real contradiction of what the lock screen claims. Registered lazily so
 * that importing this module during a prerender stays inert.
 */
function watchVault(): void {
  if (vaultWatch) return;
  vaultWatch = subscribeVault((event) => {
    if (event.state !== 'unlocked') {
      loaded = false;
      publish(DEFAULT_VIDEO_PREFERENCES);
    }
  });
}

/**
 * The current preferences without touching the database.
 *
 * Returns defaults until {@link loadVideoPreferences} has resolved once. Stable
 * by reference between writes, so it pairs with `useSyncExternalStore`.
 *
 * @returns the cached snapshot
 */
export function videoPreferencesSnapshot(): VideoPreferences {
  return cache;
}

/**
 * Subscribe to preference changes.
 *
 * @param listener called after every successful write and on vault lock
 * @returns unsubscribe
 */
export function subscribeVideoPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Load preferences from the vault, populating the snapshot.
 *
 * @param options.force re-read even if already loaded
 * @returns the preferences
 * @throws {import('@/lib/db/repos').VaultLockedError} when the vault is locked
 */
export async function loadVideoPreferences(
  options: { force?: boolean } = {},
): Promise<VideoPreferences> {
  watchVault();
  if (loaded && !options.force) return cache;
  const row = await settings.ensure();
  loaded = true;
  publish(parseVideoPreferences(row.ui));
  return cache;
}

/** Write one namespaced key and refresh the snapshot. */
async function writePreference(key: string, value: string | number | boolean): Promise<void> {
  const row = await settings.setUiPreference(key, value);
  loaded = true;
  publish(parseVideoPreferences(row.ui));
}

/**
 * Turn demonstration video on or off entirely.
 *
 * `false` is not a soft preference: `DemoVideoCard` mounts no iframe at all,
 * so the app makes zero requests to Google in any state.
 *
 * @param enabled the new value
 */
export async function setVideoEnabled(enabled: boolean): Promise<void> {
  await writePreference(UI_KEYS.enabled, enabled);
}

/**
 * Choose the embed origin.
 *
 * @param host `'standard'` (Premium applies, no ads) or `'nocookie'` (stricter,
 *   but signed out, so ads)
 */
export async function setVideoHost(host: VideoHost): Promise<void> {
  await writePreference(UI_KEYS.host, host);
}

/**
 * Whether tapping play should hand off to the YouTube app rather than embed.
 *
 * @param prefer the new value
 */
export async function setPreferNativeApp(prefer: boolean): Promise<void> {
  await writePreference(UI_KEYS.preferNativeApp, prefer);
}

/**
 * Pin a video to an exercise.
 *
 * Accepts anything the user can paste — a bare id, a watch URL, a `youtu.be`
 * share link with a timestamp, a Shorts URL.
 *
 * @param slug the exercise slug
 * @param link the pasted id or URL
 * @returns the stored override
 * @throws {RangeError} when the input is not a YouTube video reference
 */
export async function pinDemo(slug: string, link: string): Promise<DemoOverride> {
  const parsed = parseYouTubeLink(link);
  if (!parsed) {
    throw new RangeError('That does not look like a YouTube link or video id.');
  }
  const current = await loadVideoPreferences();
  const override: DemoOverride = {
    videoId: parsed.videoId,
    startSeconds: parsed.startSeconds,
    setAt: Date.now(),
  };
  await writePreference(
    UI_KEYS.overrides,
    serializeOverrides({ ...current.overrides, [slug]: override }),
  );
  return override;
}

/**
 * Remove a pinned video.
 *
 * @param slug the exercise slug
 */
export async function unpinDemo(slug: string): Promise<void> {
  const current = await loadVideoPreferences();
  if (!current.overrides[slug]) return;
  const next = { ...current.overrides };
  delete next[slug];
  await writePreference(UI_KEYS.overrides, serializeOverrides(next));
}

/** Forget every pinned video. Settings only, behind a confirmation. */
export async function clearPinnedDemos(): Promise<void> {
  await writePreference(UI_KEYS.overrides, serializeOverrides({}));
}

/** Reset the module between tests. */
export function resetPreferenceCacheForTests(): void {
  cache = DEFAULT_VIDEO_PREFERENCES;
  loaded = false;
  listeners.clear();
  vaultWatch?.();
  vaultWatch = null;
}
