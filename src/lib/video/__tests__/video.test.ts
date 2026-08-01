/**
 * Tests for exercise demonstration video.
 *
 * Two kinds of assertion live here, and the second kind is the point:
 *
 * 1. Ordinary unit tests of the URL builders, the resolution order and the
 *    preference codec.
 * 2. **Privacy invariants read off the real files** — the CSP in
 *    `layout.tsx`, and every module in `src/lib/video` and
 *    `src/components/video`. A future edit that widens `connect-src`, fetches a
 *    YouTube thumbnail on render, or mounts an iframe outside the one gated
 *    component fails here rather than in production. Comments do not enforce a
 *    promise; these do.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXERCISE_LIBRARY } from '../../training/library';
import {
  CURATED_DEMOS,
  coachTagsFor,
  demoCoverage,
  humanizeSlug,
  resolveDemo,
  searchQueryFor,
} from '../demos';
import {
  DEFAULT_VIDEO_PREFERENCES,
  parseOverrides,
  parseVideoPreferences,
  serializeOverrides,
  UI_KEYS,
} from '../settings';
import { embedUrl, isValidVideoId, parseYouTubeLink, searchUrl, watchUrl } from '../youtube';

/** A syntactically valid id used throughout. Not claimed to be a real video. */
const ID = 'aaaaaaaaaaa';

describe('video ids', () => {
  it('accepts exactly eleven URL-safe base64 characters', () => {
    expect(isValidVideoId(ID)).toBe(true);
    expect(isValidVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isValidVideoId('-_-_-_-_-_-')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidVideoId('')).toBe(false);
    expect(isValidVideoId('short')).toBe(false);
    expect(isValidVideoId('waaaaaaaaaay-too-long')).toBe(false);
    expect(isValidVideoId('aaaaaaaaaa!')).toBe(false);
    expect(isValidVideoId('aaaa aaaaaa')).toBe(false);
  });
});

describe('parseYouTubeLink', () => {
  it('accepts a bare id', () => {
    expect(parseYouTubeLink(`  ${ID} `)).toEqual({ videoId: ID, startSeconds: 0 });
  });

  it('accepts every shape the iOS share sheet produces', () => {
    const cases = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}&feature=share`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `youtube.com/watch?v=${ID}`,
    ];
    for (const url of cases) {
      expect(parseYouTubeLink(url), url).toEqual({ videoId: ID, startSeconds: 0 });
    }
  });

  it('reads a timestamp in all three notations', () => {
    expect(parseYouTubeLink(`https://youtu.be/${ID}?t=90`)?.startSeconds).toBe(90);
    expect(parseYouTubeLink(`https://youtu.be/${ID}?t=90s`)?.startSeconds).toBe(90);
    expect(parseYouTubeLink(`https://youtu.be/${ID}?t=1m30s`)?.startSeconds).toBe(90);
    expect(parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}&start=42`)?.startSeconds).toBe(
      42,
    );
  });

  it('refuses any host that is not YouTube', () => {
    // This is the load-bearing case: whatever comes back from here can end up
    // in an iframe src, and the CSP only permits two origins.
    expect(parseYouTubeLink(`https://vimeo.com/${ID}`)).toBeNull();
    expect(parseYouTubeLink(`https://youtube.com.evil.test/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeLink(`javascript:alert(1)`)).toBeNull();
    expect(parseYouTubeLink('')).toBeNull();
    expect(parseYouTubeLink('not a link at all')).toBeNull();
    expect(parseYouTubeLink('https://www.youtube.com/watch?v=tooshort')).toBeNull();
  });
});

describe('embedUrl', () => {
  it('uses the standard origin by default, so a Premium session applies', () => {
    expect(embedUrl(ID)).toContain('https://www.youtube.com/embed/');
  });

  it('uses the nocookie origin only when asked', () => {
    expect(embedUrl(ID, { host: 'nocookie' })).toContain(
      'https://www.youtube-nocookie.com/embed/',
    );
  });

  it('sets playsinline, so iOS does not hijack the screen', () => {
    expect(embedUrl(ID)).toContain('playsinline=1');
  });

  it('never enables the JS API — there is no channel to the embed', () => {
    expect(embedUrl(ID)).not.toContain('enablejsapi');
  });

  it('carries a start offset only when there is one', () => {
    expect(embedUrl(ID)).not.toContain('start=');
    expect(embedUrl(ID, { startSeconds: 12.7 })).toContain('start=12');
  });

  it('throws rather than putting a malformed id in an iframe src', () => {
    expect(() => embedUrl('../../evil')).toThrow(RangeError);
    expect(() => watchUrl('nope')).toThrow(RangeError);
  });
});

describe('link-out URLs', () => {
  it('watchUrl is a plain https link, which iOS hands to the YouTube app', () => {
    expect(watchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(watchUrl(ID, 90)).toBe(`https://www.youtube.com/watch?v=${ID}&t=90s`);
  });

  it('searchUrl encodes the query', () => {
    expect(searchUrl('barbell bench press proper form')).toBe(
      'https://www.youtube.com/results?search_query=barbell+bench+press+proper+form',
    );
  });
});

describe('search queries', () => {
  it('uses the library name and an instructional intent', () => {
    expect(searchQueryFor('barbell-bench-press')).toBe(
      'Barbell Bench Press proper form technique',
    );
  });

  it('asks "how to" for mobility work, which is taught rather than "formed"', () => {
    expect(searchQueryFor('wall-slide')).toContain('how to perform');
  });

  it('appends a coach the library already associates with the movement', () => {
    expect(searchQueryFor('barbell-bench-press', { coach: 'nippard' })).toContain(
      'Jeff Nippard',
    );
  });

  it('still produces something usable for a slug the library has never seen', () => {
    expect(searchQueryFor('user-made-up-movement')).toBe(
      'User Made Up Movement proper form technique',
    );
    expect(humanizeSlug('atg-split-squat')).toBe('Atg Split Squat');
  });

  it('only offers coaches the library actually tagged', () => {
    expect(coachTagsFor('barbell-bench-press')).toContain('nippard');
    expect(coachTagsFor('not-a-real-slug')).toEqual([]);
  });
});

describe('resolveDemo precedence', () => {
  const overrides = { 'barbell-bench-press': { videoId: ID } };

  it('puts the user’s own recording above every YouTube source', () => {
    const r = resolveDemo('barbell-bench-press', { overrides, userDemoId: 'demo-1' });
    expect(r.kind).toBe('user');
    expect(r.userDemoId).toBe('demo-1');
    expect(r.videoId).toBeNull();
  });

  it('uses a pinned id when there is no recording', () => {
    const r = resolveDemo('barbell-bench-press', { overrides });
    expect(r.kind).toBe('override');
    expect(r.videoId).toBe(ID);
    expect(r.embeddable).toBe(true);
  });

  it('falls back to search, which is a link-out and not embeddable', () => {
    const r = resolveDemo('barbell-bench-press');
    expect(r.kind).toBe('search');
    expect(r.videoId).toBeNull();
    expect(r.embeddable).toBe(false);
  });

  it('always has a non-empty query, whatever it resolved to', () => {
    for (const options of [{}, { overrides }, { overrides, userDemoId: 'x' }]) {
      expect(resolveDemo('barbell-bench-press', options).searchQuery.length).toBeGreaterThan(0);
    }
  });
});

describe('the whole library', () => {
  it('every one of the 220 movements resolves to something usable', () => {
    expect(EXERCISE_LIBRARY.length).toBe(220);
    for (const exercise of EXERCISE_LIBRARY) {
      const r = resolveDemo(exercise.slug);
      expect(r.searchQuery, exercise.slug).toContain(exercise.name);
      expect(r.name, exercise.slug).toBe(exercise.name);
    }
  });

  it('ships no unverified video ids', () => {
    // The table is empty on purpose: no id in this container could be checked
    // against YouTube, and a wrong id is worse than an honest search fallback.
    // If it stops being empty, every entry must at least be well-formed.
    for (const [slug, demo] of Object.entries(CURATED_DEMOS)) {
      expect(isValidVideoId(demo.videoId), slug).toBe(true);
    }
  });

  it('counts coverage honestly', () => {
    const slugs = EXERCISE_LIBRARY.map((e) => e.slug);
    const coverage = demoCoverage(slugs, { 'barbell-bench-press': { videoId: ID } }, [
      'back-squat',
    ]);
    expect(coverage.total).toBe(220);
    expect(coverage.pinned).toBe(1);
    expect(coverage.recorded).toBe(1);
    expect(coverage.searchOnly).toBe(220 - 2 - coverage.curated);
  });
});

describe('preference codec', () => {
  it('defaults to enabled, standard host, no overrides', () => {
    expect(parseVideoPreferences(undefined)).toEqual(DEFAULT_VIDEO_PREFERENCES);
    expect(DEFAULT_VIDEO_PREFERENCES.host).toBe('standard');
  });

  it('reads what was written', () => {
    const prefs = parseVideoPreferences({
      [UI_KEYS.enabled]: false,
      [UI_KEYS.host]: 'nocookie',
      [UI_KEYS.preferNativeApp]: true,
      [UI_KEYS.overrides]: serializeOverrides({ squat: { videoId: ID, startSeconds: 30 } }),
    });
    expect(prefs.enabled).toBe(false);
    expect(prefs.host).toBe('nocookie');
    expect(prefs.preferNativeApp).toBe(true);
    expect(prefs.overrides.squat).toEqual({
      videoId: ID,
      startSeconds: 30,
      setAt: undefined,
    });
  });

  it('survives junk rather than taking a screen down with it', () => {
    expect(parseVideoPreferences({ [UI_KEYS.host]: 'wat' }).host).toBe('standard');
    expect(parseVideoPreferences({ [UI_KEYS.overrides]: 'not json' }).overrides).toEqual({});
    expect(parseOverrides('[]')).toEqual({});
    expect(parseOverrides('{"a":null}')).toEqual({});
    expect(parseOverrides('{"a":{"videoId":42}}')).toEqual({});
  });

  it('re-validates ids on read, so a hand-edited backup cannot inject a URL', () => {
    expect(parseOverrides('{"a":{"videoId":"https://evil.test/x"}}')).toEqual({});
    expect(
      parseOverrides(`{"a":{"videoId":"https://youtu.be/${ID}?t=15"}}`).a,
    ).toMatchObject({ videoId: ID });
  });
});

// ---------------------------------------------------------------------------
// Privacy invariants, asserted against the real source files
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

/**
 * Strip comments, so an invariant is asserted against the *code* and not
 * against a comment explaining the invariant. (These files discuss `ytimg` and
 * `<iframe>` at length precisely because neither may appear in the code.)
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    // `[^:]` keeps `https://` out of the line-comment pattern.
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function sourceFiles(dir: string): { path: string; text: string }[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => ({
      path: `${dir}/${entry.name}`,
      text: code(read(dir, entry.name)),
    }));
}

describe('privacy invariants', () => {
  const policy = read('src/lib/security/policy.ts');
  const cspLines = policy
    .split('\n')
    .filter((line) => /^\s*"[a-z-]+-src|^\s*"default-src/.test(line));

  it('the CSP frames YouTube and nothing else', () => {
    const frameSrc = cspLines.find((line) => line.includes('frame-src'));
    expect(frameSrc).toBeDefined();
    expect(frameSrc).toContain('https://www.youtube.com');
    expect(frameSrc).toContain('https://www.youtube-nocookie.com');
  });

  it('connect-src permits only self and the reviewed barcode-only vendor', () => {
    const connectSrc = cspLines.find((line) => line.includes('connect-src')) ?? '';
    expect(connectSrc).not.toContain('youtube');
    expect(connectSrc).toBe(
      `  "connect-src 'self' https://world.openfoodfacts.org",`,
    );
  });

  it('media-src permits the local blob: URLs the user’s own clips need', () => {
    const mediaSrc = cspLines.find((line) => line.includes('media-src')) ?? '';
    expect(mediaSrc).toContain("'self'");
    expect(mediaSrc).toContain('blob:');
  });

  it('nothing fetches a YouTube thumbnail — browsing must be zero requests', () => {
    for (const file of [...sourceFiles('src/lib/video'), ...sourceFiles('src/components/video')]) {
      expect(file.text, file.path).not.toContain('ytimg');
      expect(file.text, file.path).not.toContain('img.youtube');
    }
  });

  it('exactly one component can mount an iframe', () => {
    const mounting = sourceFiles('src/components/video').filter((file) =>
      /<iframe/.test(file.text),
    );
    expect(mounting.map((f) => f.path)).toEqual(['src/components/video/YouTubeEmbed.tsx']);
  });

  it('the iframe component is not exported from the barrel', () => {
    // Reachable only through DemoVideoCard, which checks the master switch
    // first. Exporting it would make "video off" a suggestion.
    expect(code(read('src/components/video/index.ts'))).not.toContain('YouTubeEmbed');
  });
});
