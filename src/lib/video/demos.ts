/**
 * @file Mapping the 220 library movements to demonstrations.
 *
 * ## Why {@link CURATED_DEMOS} is empty
 *
 * The obvious implementation of this node is a 220-entry table of YouTube ids.
 * It is not written because it cannot be written honestly: this container has
 * no route to YouTube, so no id in it could be checked. A plausible-looking
 * eleven-character string that resolves to a deleted video, a music video, or
 * somebody else's exercise is worse than admitting we do not know — it is a
 * wrong answer wearing the costume of a right one, and the user would only find
 * out mid-workout.
 *
 * So the model is built around **not knowing**, with three ways to fix it:
 *
 * 1. **Search fallback** (the default for all 220). A well-formed query built
 *    from the movement's name and its coach tags, opened on YouTube. Costs one
 *    extra tap and is never wrong.
 * 2. **Override** — the user pastes a link once and it is pinned forever, in
 *    the vault. Curation accretes on the movements they actually train.
 * 3. **Curated** — this table, for ids someone has genuinely verified. Adding
 *    one is a two-line edit and needs no other change.
 *
 * The user's own recording (see `media.ts`) outranks all three.
 */

import { exerciseBySlug } from '../training/library';
import type { LibraryExercise } from '../training/types';
import type { CuratedDemo, DemoOverride, DemoResolution } from './types';

/**
 * Verified YouTube ids, by exercise slug.
 *
 * Empty on purpose — see the file header. To add one:
 *
 * ```ts
 * 'barbell-bench-press': { videoId: '...', startSeconds: 42, credit: 'Jeff Nippard' },
 * ```
 *
 * The bar for an entry is that someone **watched the video** and confirmed it
 * shows that movement. An id copied from a search-results page is not verified.
 */
export const CURATED_DEMOS: Readonly<Record<string, CuratedDemo>> = Object.freeze({});

/**
 * The coach tags in the library, mapped to the names people search by.
 *
 * The library already records which coaches a movement's programming came from
 * (`coach_tags`), which makes the search query better for free: someone looking
 * up an ATG split squat almost certainly wants Ben Patrick demonstrating it,
 * and the library already knows that.
 */
export const COACH_SEARCH_NAMES: Readonly<Record<string, string>> = Object.freeze({
  israetel: 'Renaissance Periodization',
  nippard: 'Jeff Nippard',
  cavaliere: 'Athlean-X',
  kneesovertoes: 'Knees Over Toes Guy',
  galpin: 'Andy Galpin',
});

/** Short labels for the coach chips in the UI. */
export const COACH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  israetel: 'Dr Mike',
  nippard: 'Nippard',
  cavaliere: 'Athlean-X',
  kneesovertoes: 'ATG',
  galpin: 'Galpin',
});

/**
 * Words that make a YouTube search return an instructional video rather than a
 * competition clip or a compilation. Kept short: three words of intent beats a
 * long query, which YouTube treats as increasingly fuzzy.
 */
const INTENT_TERMS = 'proper form technique';

/** Mobility work is taught, not "formed"; "how to" pulls better results. */
const MOBILITY_TERMS = 'how to perform';

/**
 * Build the YouTube search query for one movement.
 *
 * @param slug library slug, e.g. `atg-split-squat`
 * @param options.coach a coach tag from the movement's `coach_tags`, to bias
 *   the search toward a creator the user already follows
 * @returns a non-empty query string, raw (the caller encodes it)
 */
export function searchQueryFor(slug: string, options: { coach?: string } = {}): string {
  const entry = exerciseBySlug(slug);
  const name = entry?.name ?? humanizeSlug(slug);
  const intent = entry?.pattern === 'mobility' ? MOBILITY_TERMS : INTENT_TERMS;
  const coachName = options.coach ? COACH_SEARCH_NAMES[options.coach] : undefined;
  return [name, intent, coachName].filter(Boolean).join(' ');
}

/**
 * The coach tags on a movement that we have a search name for.
 *
 * @param slug library slug
 * @returns tags, in library order; empty for unknown or untagged movements
 */
export function coachTagsFor(slug: string): string[] {
  const entry = exerciseBySlug(slug);
  if (!entry) return [];
  return entry.coach_tags.filter((tag) => tag in COACH_SEARCH_NAMES);
}

/**
 * Turn a slug into something printable when the library has never heard of it —
 * a user-created movement, or a slug from a newer library version.
 *
 * @param slug e.g. `single-arm-row`
 * @returns e.g. `Single Arm Row`
 */
export function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Inputs to {@link resolveDemo}. */
export interface ResolveOptions {
  /** The user's pinned ids, keyed by slug. */
  readonly overrides?: Readonly<Record<string, DemoOverride>>;
  /** Id of the user's own recording for this slug, when one exists. */
  readonly userDemoId?: string | null;
  /** Bias the search query toward one coach. */
  readonly coach?: string;
}

/**
 * Decide what to show for one exercise.
 *
 * Precedence, most specific first: **the user's own recording**, then an id
 * they pinned, then a curated id, then search. The ordering is not arbitrary —
 * for someone training with a coach three days a week, their trainer's cue for
 * *their* hips is the most useful demonstration that exists, and a generic
 * video from a stranger should never displace it.
 *
 * @param slug library slug
 * @param options overrides, the user's recording, coach preference
 * @returns a resolution that always has a usable `searchQuery`
 */
export function resolveDemo(slug: string, options: ResolveOptions = {}): DemoResolution {
  const entry: LibraryExercise | null = exerciseBySlug(slug);
  const name = entry?.name ?? humanizeSlug(slug);
  const searchQuery = searchQueryFor(slug, { coach: options.coach });

  if (options.userDemoId) {
    return {
      slug,
      name,
      kind: 'user',
      videoId: null,
      startSeconds: 0,
      userDemoId: options.userDemoId,
      credit: null,
      searchQuery,
      // Local video, played from a blob: URL in a <video> element. No iframe,
      // no third party, works on a plane.
      embeddable: true,
    };
  }

  const override = options.overrides?.[slug];
  if (override) {
    return {
      slug,
      name,
      kind: 'override',
      videoId: override.videoId,
      startSeconds: override.startSeconds ?? 0,
      userDemoId: null,
      credit: null,
      searchQuery,
      embeddable: true,
    };
  }

  const curated = CURATED_DEMOS[slug];
  if (curated) {
    return {
      slug,
      name,
      kind: 'curated',
      videoId: curated.videoId,
      startSeconds: curated.startSeconds ?? 0,
      userDemoId: null,
      credit: curated.credit ?? null,
      searchQuery,
      embeddable: true,
    };
  }

  return {
    slug,
    name,
    kind: 'search',
    videoId: null,
    startSeconds: 0,
    userDemoId: null,
    credit: null,
    searchQuery,
    // Search results carry X-Frame-Options: SAMEORIGIN. There is nothing to
    // embed; the UI shows a link out, and says so.
    embeddable: false,
  };
}

/** How much of the library has a specific demonstration. */
export interface DemoCoverage {
  readonly total: number;
  readonly curated: number;
  readonly pinned: number;
  readonly recorded: number;
  /** Movements resolving to a plain search. */
  readonly searchOnly: number;
}

/**
 * Coverage across the whole library, for the Settings screen.
 *
 * Shown because the honest version of "220 exercises, all with demos" is
 * "220 exercises, 6 of which you have pinned a video for". The number going up
 * over months is the point of the override mechanism.
 *
 * @param slugs every slug to consider — pass the library's slugs
 * @param overrides the user's pinned ids
 * @param recordedSlugs slugs with a vault-stored recording
 * @returns the counts
 */
export function demoCoverage(
  slugs: readonly string[],
  overrides: Readonly<Record<string, DemoOverride>> = {},
  recordedSlugs: readonly string[] = [],
): DemoCoverage {
  const recorded = new Set(recordedSlugs);
  let curated = 0;
  let pinned = 0;
  let withRecording = 0;
  let searchOnly = 0;
  for (const slug of slugs) {
    if (recorded.has(slug)) withRecording += 1;
    else if (overrides[slug]) pinned += 1;
    else if (CURATED_DEMOS[slug]) curated += 1;
    else searchOnly += 1;
  }
  return {
    total: slugs.length,
    curated,
    pinned,
    recorded: withRecording,
    searchOnly,
  };
}
