/**
 * The bundled exercise library must stay identical to the spec file, and the
 * two fields the logger cannot render without — `rep_unit` and `rom_tracked` —
 * must survive the copy intact.
 *
 * The drift assertion is the important one. `docs/` is excluded from the build,
 * so the library is duplicated into `src/lib/training/`; this test is what
 * turns that duplication from a slow-rotting risk into a checked invariant.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXERCISE_LIBRARY,
  exerciseBySlug,
  isRomTracked,
  libraryForMuscles,
  repUnitFor,
  romMeasurementOf,
  searchLibrary,
} from '../library';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

describe('the bundled copy', () => {
  it('is byte-identical to docs/kg/specs/exercise-library.json', () => {
    const spec = readFileSync(
      join(REPO_ROOT, 'docs', 'kg', 'specs', 'exercise-library.json'),
      'utf8',
    );
    const bundled = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'training', 'exercise-library.json'),
      'utf8',
    );
    expect(bundled).toBe(spec);
  });

  it('has 220 entries with unique slugs', () => {
    expect(EXERCISE_LIBRARY).toHaveLength(220);
    expect(new Set(EXERCISE_LIBRARY.map((e) => e.slug)).size).toBe(220);
  });

  it('carries all 19 keys, in the contracted order', () => {
    const expected = [
      'slug',
      'name',
      'aliases',
      'primary_muscles',
      'secondary_muscles',
      'equipment',
      'pattern',
      'mechanic',
      'unilateral',
      'rom_tracked',
      'default_rep_range',
      'rep_unit',
      'sfr_rating',
      'joint_stress',
      'coach_tags',
      'regressions',
      'progressions',
      'cues',
      'notes',
    ];
    for (const entry of EXERCISE_LIBRARY) {
      expect(Object.keys(entry)).toEqual(expected);
    }
  });
});

describe('rep_unit — read it, never infer it', () => {
  it('matches the validator output exactly', () => {
    const counts: Record<string, number> = {};
    for (const e of EXERCISE_LIBRARY) counts[e.rep_unit] = (counts[e.rep_unit] ?? 0) + 1;
    expect(counts).toEqual({ reps: 192, seconds: 25, steps: 1, meters: 2 });
  });

  it('is metres for sled work even though the pattern is conditioning', () => {
    // The row that would slip through any pattern-based rule: every other
    // conditioning entry is seconds.
    expect(exerciseBySlug('sled-drag-backward')?.pattern).toBe('conditioning');
    expect(repUnitFor('sled-drag-backward')).toBe('meters');
    expect(repUnitFor('sled-push-forward')).toBe('meters');
  });

  it('is seconds for isometrics living in non-conditioning patterns', () => {
    expect(exerciseBySlug('dead-hang')?.pattern).toBe('vertical_pull');
    expect(repUnitFor('dead-hang')).toBe('seconds');
    expect(repUnitFor('wall-sit')).toBe('seconds');
    expect(repUnitFor('plank')).toBe('seconds');
  });

  it('is steps for the banded lateral walk', () => {
    expect(repUnitFor('banded-lateral-walk')).toBe('steps');
  });

  it('reads Zone 2 cycling as a half-hour to an hour, not 1800 reps', () => {
    const z2 = exerciseBySlug('zone2-cycling');
    expect(z2?.rep_unit).toBe('seconds');
    expect(z2?.default_rep_range).toEqual([1800, 3600]);
  });

  it('never falls outside the four-value vocabulary', () => {
    for (const e of EXERCISE_LIBRARY) {
      expect(['reps', 'seconds', 'meters', 'steps']).toContain(e.rep_unit);
    }
  });
});

describe('rom_tracked — depth is the progression', () => {
  const SIXTEEN = [
    'atg-split-squat',
    'patrick-step',
    'poliquin-step-up',
    'sissy-squat',
    'reverse-nordic-curl',
    'assisted-nordic-curl',
    'nordic-hamstring-curl-eccentric',
    'nordic-hamstring-curl',
    'knees-over-toes-calf-raise',
    'cossack-squat',
    'ab-wheel-rollout',
    'deep-squat-hold',
    'ankle-dorsiflexion-mobilization',
    'couch-stretch',
    'elephant-walk',
    'jefferson-curl',
  ];

  it('flags exactly the 16 named in the schema-fix post', () => {
    const flagged = EXERCISE_LIBRARY.filter((e) => e.rom_tracked).map((e) => e.slug);
    expect(flagged.sort()).toEqual([...SIXTEEN].sort());
  });

  it('extracts a measurement statement for every one of them', () => {
    for (const slug of SIXTEEN) {
      expect(isRomTracked(slug)).toBe(true);
      const measurement = romMeasurementOf(slug);
      expect(measurement, slug).toBeTruthy();
      expect(measurement!.length, slug).toBeGreaterThan(4);
    }
  });

  it('returns nothing for movements that progress by load', () => {
    expect(isRomTracked('barbell-bench-press')).toBe(false);
    expect(romMeasurementOf('barbell-bench-press')).toBeNull();
  });
});

describe('search', () => {
  it('finds a movement by its name', () => {
    expect(searchLibrary('bench press')[0].slug).toBe('barbell-bench-press');
  });

  it('finds a movement by an alias the gym actually uses', () => {
    const hits = searchLibrary('bb bench').map((e) => e.slug);
    expect(hits).toContain('barbell-bench-press');
  });

  it('ANDs multiple words rather than ORing them', () => {
    const hits = searchLibrary('cable row');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const haystack = `${hit.name} ${hit.aliases.join(' ')} ${hit.slug}`.toLowerCase();
      expect(haystack).toContain('cable');
      expect(haystack).toContain('row');
    }
  });

  it('returns nothing for an empty query rather than the whole library', () => {
    expect(searchLibrary('')).toEqual([]);
    expect(searchLibrary('   ')).toEqual([]);
  });

  it('finds nothing for gibberish', () => {
    expect(searchLibrary('qzxwv')).toEqual([]);
  });
});

describe('muscle lookup', () => {
  it('puts primary movers before secondary ones', () => {
    const hits = libraryForMuscles(['tibialis'], { limit: 12 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].primary_muscles).toContain('tibialis');
  });

  it('can exclude indirect work', () => {
    const hits = libraryForMuscles(['side_delts'], { primaryOnly: true });
    for (const hit of hits) expect(hit.primary_muscles).toContain('side_delts');
  });
});
