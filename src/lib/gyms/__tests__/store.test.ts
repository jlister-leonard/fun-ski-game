/**
 * @file Reading gym profiles back out of the vault.
 *
 * Only the pure half is exercised here — parsing, normalising, resolving the
 * active profile. The IndexedDB half is covered by the vault agent's own
 * `settings.setUiPreference` tests; re-testing Dexie here would be testing
 * someone else's module.
 *
 * What *is* worth pinning is the tolerance. These rows are JSON inside an
 * encrypted blob written by an older or newer build. A malformed one must
 * degrade to something usable, because the screen that could repair it is the
 * screen that would fail to render.
 */

import { describe, expect, it } from 'vitest';
import { TRAVEL_PROFILE_ID, type GymProfile } from '../profiles';
import { activeProfile, newGymId, normaliseProfiles } from '../store';

const ONE: GymProfile = {
  id: 'g1',
  name: 'Main gym',
  kind: 'commercial',
  items: [{ id: 'barbell_olympic' }, { id: 'dumbbells_fixed', maxLoad: 120 }],
  photos: [{ dataUrl: 'data:image/jpeg;base64,abc', capturedAt: 5, label: 'racks' }],
  note: 'the one on 5th',
  builtIn: false,
  createdAt: 1,
  updatedAt: 2,
};

describe('normalising what was stored', () => {
  it('round-trips a profile through JSON unchanged', () => {
    const [back] = normaliseProfiles(JSON.stringify([ONE]));
    expect(back).toEqual(ONE);
  });

  it('always includes the travel profile, so there is always a floor', () => {
    for (const stored of [undefined, '', 'not json at all', '{}', '[]', JSON.stringify([ONE])]) {
      const profiles = normaliseProfiles(stored);
      expect(profiles.some((p) => p.id === TRAVEL_PROFILE_ID)).toBe(true);
    }
  });

  it('never adds a second travel profile to a list that has one', () => {
    const first = normaliseProfiles(undefined);
    const again = normaliseProfiles(JSON.stringify(first));
    expect(again.filter((p) => p.id === TRAVEL_PROFILE_ID).length).toBe(1);
  });

  it('drops equipment ids this build does not know, keeping the rest', () => {
    const stored = JSON.stringify([
      { ...ONE, items: [{ id: 'barbell_olympic' }, { id: 'antigravity_rack' }] },
    ]);
    const [back] = normaliseProfiles(stored);
    expect(back.items.map((i) => i.id)).toEqual(['barbell_olympic']);
  });

  it('rejects a photo that is not an image data URL', () => {
    const stored = JSON.stringify([
      {
        ...ONE,
        photos: [
          { dataUrl: 'https://example.com/gym.jpg', capturedAt: 1, label: 'x' },
          { dataUrl: 'data:image/png;base64,zz', capturedAt: 1, label: 'ok' },
        ],
      },
    ]);
    const [back] = normaliseProfiles(stored);
    // A remote URL in this field would be the one thing that could make a
    // "never uploaded, never fetched" promise false. It does not survive.
    expect(back.photos.map((p) => p.label)).toEqual(['ok']);
  });

  it('repairs a profile with missing fields rather than dropping it', () => {
    const [back] = normaliseProfiles(JSON.stringify([{ id: 'g9' }]));
    expect(back.id).toBe('g9');
    expect(back.name).toBe('Gym');
    expect(back.kind).toBe('other');
    expect(back.items).toEqual([]);
    expect(back.photos).toEqual([]);
  });

  it('drops a row with no id — there is nothing to key it by', () => {
    const profiles = normaliseProfiles(JSON.stringify([{ name: 'nameless' }]));
    expect(profiles.length).toBe(1);
    expect(profiles[0].id).toBe(TRAVEL_PROFILE_ID);
  });

  it('coerces an unknown kind rather than trusting it', () => {
    const [back] = normaliseProfiles(JSON.stringify([{ ...ONE, kind: 'submarine' }]));
    expect(back.kind).toBe('other');
  });
});

describe('resolving the active gym', () => {
  const profiles = normaliseProfiles(JSON.stringify([ONE]));

  it('returns the one whose id matches', () => {
    expect(activeProfile({ profiles, activeId: 'g1' }).name).toBe('Main gym');
  });

  it('falls back to the first when the active id is stale', () => {
    expect(activeProfile({ profiles, activeId: 'deleted-last-week' }).id).toBe('g1');
  });

  it('falls back to the built-in travel profile when there is nothing at all', () => {
    expect(activeProfile({ profiles: [], activeId: 'anything' }).id).toBe(TRAVEL_PROFILE_ID);
  });
});

describe('ids', () => {
  it('are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newGymId()));
    expect(ids.size).toBe(200);
  });
});
