/**
 * @file Profile, goals and app settings repositories.
 */

import { DEFAULT_AUTOLOCK } from '../../vault/autolock';
import { PROFILE_ID, SETTINGS_ID, type AppSettings, type Goal, type Profile } from '../types';
import { Repo, SingletonRepo, type NewRecord } from './base';

/** The user's profile. Exactly one row. */
export class ProfileRepo extends SingletonRepo<Profile> {
  constructor() {
    super('profile', PROFILE_ID);
  }

  /**
   * Read the profile, creating an empty one on first call.
   *
   * @returns the profile
   */
  async ensure(): Promise<Profile> {
    return this.loadOrCreate({
      displayName: null,
      birthDate: null,
      sex: null,
      heightCm: null,
      activityLevel: null,
      timeZone:
        typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
      unitPreference: 'metric',
    });
  }

  /**
   * Age in whole years from `birthDate`, for the BMR equations.
   *
   * @param at the reference instant; defaults to now
   * @returns the age, or `null` when no birth date is recorded
   */
  async ageYears(at: Date = new Date()): Promise<number | null> {
    const profile = await this.load();
    if (!profile?.birthDate) return null;
    const [y, m, d] = profile.birthDate.split('-').map(Number);
    let age = at.getFullYear() - y;
    const monthDiff = at.getMonth() + 1 - m;
    if (monthDiff < 0 || (monthDiff === 0 && at.getDate() < d)) age--;
    return age;
  }
}

/** Nutrition and body-composition goals. */
export class GoalRepo extends Repo<Goal> {
  constructor() {
    super('goals');
  }

  /**
   * The goal currently in force.
   *
   * @returns the active goal, or `null` when the user has not set one
   */
  async getActive(): Promise<Goal | null> {
    const all = await this.listAll({ reverse: true });
    return all.find((g) => g.active && g.endDateKey === null) ?? null;
  }

  /**
   * Make a goal active, deactivating whatever was active before.
   *
   * Exactly one goal is active at a time; the algorithms assume it.
   *
   * @param input the new goal
   * @returns the newly created, active goal
   */
  async setActive(input: NewRecord<Goal>): Promise<Goal> {
    const previous = await this.getActive();
    if (previous) {
      await this.update(previous.id, {
        active: false,
        endDateKey: input.startDateKey,
      } as Partial<Goal>);
    }
    return this.create({ ...input, active: true });
  }

  /**
   * Every goal, newest first — the "goal history" list.
   *
   * @returns goals ordered by `updatedAt` descending
   */
  async history(): Promise<Goal[]> {
    return this.listAll({ reverse: true });
  }
}

/** Non-secret app preferences. Exactly one row. */
export class SettingsRepo extends SingletonRepo<AppSettings> {
  constructor() {
    super('settings', SETTINGS_ID);
  }

  /**
   * Read the settings, creating defaults on first call.
   *
   * The auto-lock defaults are the ones in
   * {@link import('../../vault/autolock').DEFAULT_AUTOLOCK}, so the stored
   * settings and the running controller cannot disagree at first run.
   *
   * @returns the settings
   */
  async ensure(): Promise<AppSettings> {
    return this.loadOrCreate({
      autoLockIdleMs: DEFAULT_AUTOLOCK.idleMs,
      autoLockHiddenGraceMs: DEFAULT_AUTOLOCK.hiddenGraceMs,
      autoLockEnabled: DEFAULT_AUTOLOCK.enabled,
      backupReminderDays: 7,
      allowDirectVendorFetch: false,
      weekStartsOn: 1,
      ui: {},
    });
  }

  /**
   * Merge one namespaced UI preference.
   *
   * @param key the preference key, namespaced by the owning screen
   * @param value the value
   * @returns the updated settings
   */
  async setUiPreference(key: string, value: string | number | boolean): Promise<AppSettings> {
    const current = await this.ensure();
    return this.save({ ui: { ...current.ui, [key]: value } });
  }
}

/** Singleton profile repository. */
export const profiles = new ProfileRepo();
/** Goal repository. */
export const goals = new GoalRepo();
/** Singleton settings repository. */
export const settings = new SettingsRepo();
