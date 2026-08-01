/**
 * @file YouTube URL construction and link parsing. Pure; no network, no DOM.
 *
 * ## Why the default is `www.youtube.com` and not `youtube-nocookie.com`
 *
 * This is the one decision in the package that looks backwards, so it is
 * documented where the URLs are built rather than in a design doc nobody
 * reopens.
 *
 * `youtube-nocookie.com` sounds strictly better and for a public website it
 * usually is. Here it is worse, for a concrete reason: the nocookie origin
 * deliberately does not carry the viewer's YouTube session. No session means
 * **no YouTube Premium**, and no Premium means **ads** — mid-set, on a phone,
 * in a gym. Premium users may expect ad-free playback. The standard
 * embed inherits whatever session the browser already holds, so Premium
 * applies exactly as it does on youtube.com.
 *
 * What the nocookie origin actually buys is narrower than the name suggests:
 * it defers cookies until playback starts, which for us is *already* true —
 * nothing loads an iframe until the user taps play. So the marginal privacy
 * gain over click-to-load is small, and the cost is ads. Both are available;
 * the toggle in Settings states the tradeoff in those terms rather than
 * labelling one "private" and the other not.
 *
 * Neither origin can read the vault. A cross-origin iframe gets no access to
 * our DOM, our IndexedDB or our keys, and we never open a postMessage channel
 * to it (`enablejsapi` is deliberately absent below).
 */

import type { VideoHost } from './types';

/** Hosts we will build an embed for. Nothing else is ever framed. */
const EMBED_ORIGIN: Record<VideoHost, string> = {
  standard: 'https://www.youtube.com',
  nocookie: 'https://www.youtube-nocookie.com',
};

/** Where "Open in YouTube" and search links point. */
const WATCH_ORIGIN = 'https://www.youtube.com';

/** YouTube ids are exactly 11 characters of URL-safe base64. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Hosts a pasted link may come from. Anything else is rejected outright. */
const LINK_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);

/** Path prefixes that carry the id as the next segment. */
const ID_BEARING_SEGMENTS = new Set(['embed', 'shorts', 'live', 'v']);

/**
 * Whether a string is a syntactically valid YouTube video id.
 *
 * Syntax only — we cannot check that a video exists without a network call,
 * and this container has no route to YouTube. Everything downstream treats an
 * id as a claim, not a fact.
 *
 * @param value candidate id
 * @returns true when it is 11 URL-safe base64 characters
 */
export function isValidVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value);
}

/** What {@link parseYouTubeLink} extracts. */
export interface ParsedLink {
  readonly videoId: string;
  /** From `?t=` / `&start=`; 0 when absent or unparseable. */
  readonly startSeconds: number;
}

/**
 * Parse a bare id, or any YouTube URL, into an id and a start offset.
 *
 * The user curates by pasting whatever iOS put on their clipboard — a share
 * sheet link, a `youtu.be` short link with `?t=90`, a Shorts URL. Making them
 * hand-extract an 11-character id would guarantee they never do it twice.
 *
 * @param input a video id or a YouTube URL, with or without whitespace
 * @returns the id and start offset, or `null` when the input is not a YouTube
 *   video reference. A non-YouTube URL always returns `null` — we never build
 *   an embed for a host outside the CSP's `frame-src`.
 */
export function parseYouTubeLink(input: string): ParsedLink | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (isValidVideoId(trimmed)) return { videoId: trimmed, startSeconds: 0 };

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!LINK_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  let candidate: string | null = url.searchParams.get('v');

  if (!candidate) {
    if (url.hostname.toLowerCase().endsWith('youtu.be')) {
      candidate = segments[0] ?? null;
    } else if (segments.length >= 2 && ID_BEARING_SEGMENTS.has(segments[0])) {
      candidate = segments[1] ?? null;
    }
  }
  if (!candidate || !isValidVideoId(candidate)) return null;

  const start =
    parseTimeParam(url.searchParams.get('t')) ??
    parseTimeParam(url.searchParams.get('start')) ??
    0;
  return { videoId: candidate, startSeconds: start };
}

/**
 * `?t=` comes in three shapes in the wild: `90`, `90s`, and `1m30s`.
 *
 * @param raw the parameter value, or null
 * @returns whole seconds, or null when there is nothing usable
 */
function parseTimeParam(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/** Options for {@link embedUrl}. */
export interface EmbedOptions {
  readonly host?: VideoHost;
  readonly startSeconds?: number;
  /**
   * Autoplay. Default true, and legitimate here precisely because the iframe
   * only ever exists as the direct result of a tap — the user asked for
   * playback, so making them tap a second time inside the embed is friction,
   * not consent.
   */
  readonly autoplay?: boolean;
}

/**
 * Build the embed URL for a video id.
 *
 * Parameters, and why each is there:
 *
 * - `playsinline=1` — without it iOS hijacks the screen into the native
 *   fullscreen player. Someone checking a cue mid-set wants the card, not a
 *   takeover.
 * - `rel=0` — keeps end-screen suggestions within the same channel. It no
 *   longer suppresses them entirely; it is still the strictest value available.
 * - `modestbranding=1` — deprecated by YouTube but harmless, and still honoured
 *   by some clients.
 * - `autoplay=1` — see {@link EmbedOptions.autoplay}.
 * - **No `enablejsapi`** — that parameter is what would open a postMessage
 *   channel between our page and the embed. We have nothing to say to it and
 *   want nothing it might say to us.
 *
 * @param videoId an id that has passed {@link isValidVideoId}
 * @param options host, start offset, autoplay
 * @returns an absolute https URL on one of the two permitted origins
 * @throws {RangeError} when the id is not a valid YouTube id — a malformed id
 *   must never reach an `iframe.src`, where it would become an unpredictable
 *   navigation.
 */
export function embedUrl(videoId: string, options: EmbedOptions = {}): string {
  if (!isValidVideoId(videoId)) {
    throw new RangeError(`Not a YouTube video id: ${JSON.stringify(videoId)}`);
  }
  const { host = 'standard', startSeconds = 0, autoplay = true } = options;
  const params = new URLSearchParams({
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
    autoplay: autoplay ? '1' : '0',
  });
  if (startSeconds > 0) params.set('start', String(Math.floor(startSeconds)));
  return `${EMBED_ORIGIN[host]}/embed/${videoId}?${params.toString()}`;
}

/**
 * The plain watch URL — what "Open in YouTube" navigates to.
 *
 * This is a normal https link, so on iOS it is a universal link: the installed
 * YouTube app claims it and opens natively, falling back to Safari when the app
 * is absent. It is deliberately *not* the `youtube://` scheme, which fails
 * silently for anyone without the app.
 *
 * The reason this button exists at all: **an installed Home Screen web app has
 * a separate cookie store from Safari.** A Premium session in Safari does not
 * necessarily carry into the PWA, so an in-app embed can show ads to a Premium
 * subscriber. Handing off to the native app sidesteps the partition entirely.
 *
 * @param videoId a valid video id
 * @param startSeconds optional offset
 * @returns the watch URL
 * @throws {RangeError} on a malformed id
 */
export function watchUrl(videoId: string, startSeconds = 0): string {
  if (!isValidVideoId(videoId)) {
    throw new RangeError(`Not a YouTube video id: ${JSON.stringify(videoId)}`);
  }
  const params = new URLSearchParams({ v: videoId });
  if (startSeconds > 0) params.set('t', `${Math.floor(startSeconds)}s`);
  return `${WATCH_ORIGIN}/watch?${params.toString()}`;
}

/**
 * The search-results URL for a query.
 *
 * Search results cannot be framed — YouTube sends `X-Frame-Options: SAMEORIGIN`
 * on them — so this is always a link out, never an embed. That is the honest
 * shape of the fallback: for an exercise with no verified id, the app hands the
 * user to YouTube rather than pretending to know which video is right.
 *
 * @param query free text; encoded here, so callers pass it raw
 * @returns the search URL
 */
export function searchUrl(query: string): string {
  return `${WATCH_ORIGIN}/results?${new URLSearchParams({ search_query: query }).toString()}`;
}
