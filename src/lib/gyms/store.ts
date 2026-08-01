/**
 * @file Where gym profiles live: inside the encrypted vault, as everything does.
 *
 * ## Why `AppSettings.ui` rather than a table of their own
 *
 * There is no `gyms` table in the vault schema, and adding one is the vault
 * agent's call, not this feature's — `docs/kg/specs/vault-schema.md` owns the
 * justification for every table's plaintext index, and inventing one here
 * would route around that review. So profiles are stored as a JSON string
 * under a namespaced key in `AppSettings.ui`, which is *inside* the encrypted
 * settings row. Nothing about a gym is plaintext, including the photos.
 *
 * This is the same call `src/components/settings/stack.ts` made for
 * medications, and for the same reason. If a `gyms` table lands later,
 * migrating is a read from here and a write to there.
 *
 * ## What never happens here
 *
 * No network. Not one fetch, not one image upload, not one "analyse my gym"
 * call. The photos are bytes in IndexedDB, encrypted with the same DEK as the
 * user's weight history, and there is no code path out of the device.
 */

import { settings } from '@/lib/db/repos';
import {
  TRAVEL_PROFILE,
  TRAVEL_PROFILE_ID,
  createProfile,
  duplicateProfile,
  type EquipmentSelection,
  type GymKind,
  type GymPhoto,
  type GymProfile,
} from './profiles';
import { isEquipmentId } from './equipment';

/** Namespaced key inside `AppSettings.ui` holding the profile list. */
export const GYM_PROFILES_KEY = 'gyms.profiles';
/** Namespaced key holding the id of the active profile. */
export const ACTIVE_GYM_KEY = 'gyms.activeId';

/** Everything the gym screens need in one read. */
export interface GymState {
  readonly profiles: readonly GymProfile[];
  readonly activeId: string;
}

/**
 * A fresh id.
 *
 * `crypto.randomUUID` where it exists — every browser this app supports has
 * it — with a time-plus-random fallback so a test in bare Node does not need a
 * polyfill.
 */
export function newGymId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `gym-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Coerce anything into a selection, dropping ids this build does not know. */
function parseSelection(value: unknown): EquipmentSelection | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !isEquipmentId(raw.id)) return null;
  const num = (v: unknown): number | null | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : v === null ? null : undefined;
  return {
    id: raw.id,
    brand: typeof raw.brand === 'string' ? (raw.brand as EquipmentSelection['brand']) : undefined,
    increment: num(raw.increment),
    minLoad: num(raw.minLoad),
    maxLoad: num(raw.maxLoad),
    sizes: Array.isArray(raw.sizes)
      ? raw.sizes.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : undefined,
    spanM: num(raw.spanM),
    note: typeof raw.note === 'string' ? raw.note : undefined,
  };
}

function parsePhoto(value: unknown): GymPhoto | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.dataUrl !== 'string' || !raw.dataUrl.startsWith('data:image/')) return null;
  return {
    dataUrl: raw.dataUrl,
    capturedAt: typeof raw.capturedAt === 'number' ? raw.capturedAt : 0,
    label: typeof raw.label === 'string' ? raw.label : '',
  };
}

/**
 * Coerce a stored object into a profile.
 *
 * Tolerant on purpose: a malformed profile must never be able to stop the
 * settings screen rendering, because the settings screen is the only place the
 * user could repair it.
 */
function parseProfile(value: unknown): GymProfile | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const kinds: readonly GymKind[] = ['commercial', 'trainer', 'home', 'travel', 'other'];
  const kind = kinds.find((k) => k === raw.kind) ?? 'other';
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : 'Gym',
    kind,
    items: Array.isArray(raw.items)
      ? raw.items.map(parseSelection).filter((s): s is EquipmentSelection => s !== null)
      : [],
    photos: Array.isArray(raw.photos)
      ? raw.photos.map(parsePhoto).filter((p): p is GymPhoto => p !== null)
      : [],
    note: typeof raw.note === 'string' ? raw.note : '',
    builtIn: raw.builtIn === true,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

/**
 * Normalise a profile list: parse what is there, and guarantee the travel
 * profile exists.
 *
 * The guarantee is the point. "Somewhere I have not profiled" has to resolve
 * to *something*, and a bodyweight-and-bands floor is the only answer that is
 * true everywhere.
 *
 * @param value whatever was in the vault
 * @returns a usable list, never empty
 */
export function normaliseProfiles(value: unknown): readonly GymProfile[] {
  let parsed: GymProfile[] = [];
  if (typeof value === 'string' && value !== '') {
    try {
      const json: unknown = JSON.parse(value);
      if (Array.isArray(json)) {
        parsed = json.map(parseProfile).filter((p): p is GymProfile => p !== null);
      }
    } catch {
      parsed = [];
    }
  }
  if (!parsed.some((p) => p.id === TRAVEL_PROFILE_ID)) parsed.push({ ...TRAVEL_PROFILE });
  return parsed;
}

/**
 * Read every profile and which one is active.
 *
 * @returns the state. On a fresh install this is the travel profile alone,
 *   active — so the training surfaces have a valid gym from the first run.
 */
export async function loadGyms(): Promise<GymState> {
  const ui = (await settings.load())?.ui ?? {};
  const profiles = normaliseProfiles(ui[GYM_PROFILES_KEY]);
  const storedActive = ui[ACTIVE_GYM_KEY];
  const activeId =
    typeof storedActive === 'string' && profiles.some((p) => p.id === storedActive)
      ? storedActive
      : (profiles[0]?.id ?? TRAVEL_PROFILE_ID);
  return { profiles, activeId };
}

/** Persist the whole list, replacing what was stored. */
export async function saveProfiles(profiles: readonly GymProfile[]): Promise<void> {
  await settings.setUiPreference(GYM_PROFILES_KEY, JSON.stringify(profiles));
}

/** Switch gyms. One tap in the UI; one write here. */
export async function setActiveGym(id: string): Promise<void> {
  await settings.setUiPreference(ACTIVE_GYM_KEY, id);
}

/**
 * Insert or replace one profile.
 *
 * @param profile the profile to store
 * @returns the new full list
 */
export async function saveProfile(profile: GymProfile): Promise<readonly GymProfile[]> {
  const { profiles } = await loadGyms();
  const next = profiles.some((p) => p.id === profile.id)
    ? profiles.map((p) => (p.id === profile.id ? profile : p))
    : [...profiles, profile];
  await saveProfiles(next);
  return next;
}

/**
 * Delete a profile.
 *
 * Built-in profiles are never removed — the travel floor has to stay. If the
 * deleted profile was active, the first remaining one takes over, so there is
 * no window in which no gym is selected.
 *
 * @param id the profile to remove
 * @returns the new state
 */
export async function deleteProfile(id: string): Promise<GymState> {
  const { profiles, activeId } = await loadGyms();
  const target = profiles.find((p) => p.id === id);
  if (!target || target.builtIn) return { profiles, activeId };
  const next = profiles.filter((p) => p.id !== id);
  await saveProfiles(next);
  if (activeId === id) {
    const fallback = next[0]?.id ?? TRAVEL_PROFILE_ID;
    await setActiveGym(fallback);
    return { profiles: next, activeId: fallback };
  }
  return { profiles: next, activeId };
}

/**
 * Create a profile from a template and store it.
 *
 * @param name what to call it
 * @param kind which seed to start from
 * @returns the new profile
 */
export async function addProfile(name: string, kind: GymKind): Promise<GymProfile> {
  const profile = createProfile(name, kind, newGymId(), Date.now());
  await saveProfile(profile);
  return profile;
}

/**
 * Copy an existing profile.
 *
 * @param sourceId the profile to copy
 * @param name the new name
 * @returns the copy, or `null` if the source is gone
 */
export async function copyProfile(
  sourceId: string,
  name: string,
): Promise<GymProfile | null> {
  const { profiles } = await loadGyms();
  const source = profiles.find((p) => p.id === sourceId);
  if (!source) return null;
  const copy = duplicateProfile(source, name, newGymId(), Date.now());
  await saveProfile(copy);
  return copy;
}

/**
 * The active profile, resolved.
 *
 * @param state from {@link loadGyms}
 * @returns the active profile, falling back to the first, then to the built-in
 *   travel profile. Never null — every caller would otherwise need a branch
 *   that cannot be exercised.
 */
export function activeProfile(state: GymState): GymProfile {
  return (
    state.profiles.find((p) => p.id === state.activeId) ??
    state.profiles[0] ??
    TRAVEL_PROFILE
  );
}
