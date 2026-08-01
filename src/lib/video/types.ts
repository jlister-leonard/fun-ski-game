/**
 * @file Types for exercise demonstration video (task graph node **video**).
 *
 * ## The privacy boundary, stated once
 *
 * The user accepted one specific leak: *"I don't care about Google knowing my
 * exercise routine. They already have it. They just can't have my raw health
 * data without my consent."* So the permitted disclosure is **an IP, a video
 * id and a timestamp, at the moment the user taps play** — nothing else, and
 * nothing before the tap.
 *
 * Everything in this package is arranged around keeping it to exactly that:
 *
 * - No poster image is fetched from Google. `i.ytimg.com` thumbnails would
 *   turn *browsing* the library into 220 requests announcing which movements
 *   the user looked at. The placeholder is drawn locally instead.
 * - No iframe exists in the DOM until a tap. `frame-src` in the CSP permits
 *   one; nothing mounts one on render.
 * - No `enablejsapi`, so there is no postMessage channel between our page and
 *   the embed in either direction.
 * - The user's own recordings never touch the network at all — they are
 *   AES-GCM blobs in the vault, played from a `blob:` URL.
 *
 * ## Import style
 *
 * `types` / `youtube` / `demos` are pure and unit-tested, and import their
 * siblings **relatively** — the same convention `src/lib/training/types.ts`
 * documents, for the same reason. `settings.ts` and `media.ts` do I/O and use
 * the house `@/` alias.
 */

/**
 * Which YouTube origin an embed is served from.
 *
 * `standard` is the default and it is the counterintuitive choice, so the
 * reasoning lives in `youtube.ts` next to the URL builder rather than here.
 */
export type VideoHost = 'standard' | 'nocookie';

/** Where a demonstration came from, most specific first. */
export type DemoSourceKind =
  /** A video the user (or their trainer) recorded, encrypted in the vault. */
  | 'user'
  /** A YouTube id the user pinned to this exercise themselves. */
  | 'override'
  /** A YouTube id shipped with the app because someone verified it. */
  | 'curated'
  /** No id known: we hand off to a YouTube search for a built query. */
  | 'search';

/** A YouTube id bundled with the app for one exercise. */
export interface CuratedDemo {
  /** The 11-character YouTube video id. */
  readonly videoId: string;
  /** Where in the video the demonstration actually starts. */
  readonly startSeconds?: number;
  /** Creator, shown in the UI. Attribution is not optional in practice. */
  readonly credit?: string;
}

/** A YouTube id the user pinned to one exercise. Stored in the vault. */
export interface DemoOverride {
  readonly videoId: string;
  readonly startSeconds?: number;
  /** Epoch ms the user set it, for a "you pinned this in March" affordance. */
  readonly setAt?: number;
}

/**
 * The resolved answer to "what do I show for this exercise?".
 *
 * `searchQuery` is populated for every exercise, including the ones that
 * resolve to a video id — it is both the fallback and the "this demo is wrong,
 * find me another" affordance.
 */
export interface DemoResolution {
  readonly slug: string;
  /** Human name, from the library, or the slug when unknown. */
  readonly name: string;
  readonly kind: DemoSourceKind;
  /** `null` for `search`, and for `user` (which plays from the vault). */
  readonly videoId: string | null;
  /** Seconds into the video. 0 unless a source says otherwise. */
  readonly startSeconds: number;
  /** Id of the user's recording in the media store, when `kind` is `user`. */
  readonly userDemoId: string | null;
  /** Attribution for a curated id. */
  readonly credit: string | null;
  /** Always well-formed; never empty. */
  readonly searchQuery: string;
  /** Whether this resolution can be shown in an iframe at all. */
  readonly embeddable: boolean;
}

/** User-facing video preferences. Stored in the vault, in `AppSettings.ui`. */
export interface VideoPreferences {
  /**
   * The master switch. `false` means no iframe is ever mounted — not "mounted
   * but hidden", not "loaded lazily". The user's own vault-stored recordings
   * still play, because they are local and involve no third party.
   */
  readonly enabled: boolean;
  /** Standard or nocookie embed origin. See `youtube.ts`. */
  readonly host: VideoHost;
  /** Prefer handing off to the native YouTube app over embedding in-app. */
  readonly preferNativeApp: boolean;
  /** Per-exercise pinned video ids, keyed by exercise slug. */
  readonly overrides: Readonly<Record<string, DemoOverride>>;
}

/** Metadata for one user-recorded demonstration. Encrypted alongside its bytes. */
export interface UserDemoMeta {
  /** Random id, also the media store's primary key. */
  readonly id: string;
  /** Exercise slug this demonstrates. */
  readonly slug: string;
  /** What the user called it — "Ellie's cue for my hips", say. */
  readonly label: string;
  /** MIME type as the file/recorder reported it. */
  readonly mimeType: string;
  /** Encrypted byte length of the original video. */
  readonly bytes: number;
  /** Epoch ms the recording was saved. */
  readonly savedAt: number;
  /** Duration in seconds when the browser could tell us; `null` otherwise. */
  readonly durationSec: number | null;
  /** Free text — the coach's actual cue, typed while it is fresh. */
  readonly note: string | null;
}
