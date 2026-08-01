/**
 * @file Public surface of the video package.
 *
 * ```ts
 * import { resolveDemo, loadVideoPreferences } from '@/lib/video';
 * ```
 *
 * Headless: no React, no JSX. The components live in `@/components/video`.
 * Importing this module during a prerender is inert — everything that touches
 * `indexedDB` or WebCrypto does so inside a function.
 */

export type {
  CuratedDemo,
  DemoOverride,
  DemoResolution,
  DemoSourceKind,
  UserDemoMeta,
  VideoHost,
  VideoPreferences,
} from './types';

export {
  COACH_LABELS,
  COACH_SEARCH_NAMES,
  CURATED_DEMOS,
  coachTagsFor,
  demoCoverage,
  humanizeSlug,
  resolveDemo,
  searchQueryFor,
  type DemoCoverage,
  type ResolveOptions,
} from './demos';

export {
  embedUrl,
  isValidVideoId,
  parseYouTubeLink,
  searchUrl,
  watchUrl,
  type EmbedOptions,
  type ParsedLink,
} from './youtube';

export {
  DEFAULT_VIDEO_PREFERENCES,
  UI_KEYS,
  clearPinnedDemos,
  loadVideoPreferences,
  parseOverrides,
  parseVideoPreferences,
  pinDemo,
  resetPreferenceCacheForTests,
  serializeOverrides,
  setPreferNativeApp,
  setVideoEnabled,
  setVideoHost,
  subscribeVideoPreferences,
  unpinDemo,
  videoPreferencesSnapshot,
} from './settings';

export {
  DemoTooLargeError,
  MAX_DEMO_BYTES,
  MEDIA_DB_NAME,
  MEDIA_DB_VERSION,
  deleteAllUserDemos,
  deleteUserDemo,
  listAllUserDemos,
  listUserDemos,
  loadUserDemoBlob,
  primaryUserDemo,
  recordedSlugs,
  saveUserDemo,
  userDemoStorageUsage,
  type DemoStorageUsage,
  type SaveDemoInput,
} from './media';
