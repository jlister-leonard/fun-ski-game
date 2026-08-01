"use client";

import { useCallback, useEffect, useState } from "react";
import {
  activeProfile,
  addProfile,
  copyProfile,
  deleteProfile,
  loadGyms,
  saveProfile,
  saveProfiles,
  setActiveGym,
  type GymState,
} from "@/lib/gyms/store";
import type { GymKind, GymProfile } from "@/lib/gyms/profiles";

/**
 * @file The gym list, loaded once and edited locally.
 *
 * Every mutation updates React state first and writes to the vault after,
 * without awaiting. That is the right trade here: the write is a local
 * IndexedDB round trip that cannot meaningfully fail, and making a checkbox in
 * a 120-item walk-through wait for it would make the whole flow feel syrupy.
 * If a write does fail, the next load shows the truth rather than a lie.
 */

/** What the gym screens work with. */
export interface UseGyms {
  readonly state: GymState;
  readonly active: GymProfile;
  readonly ready: boolean;
  /** Switch gyms. One tap. */
  activate: (id: string) => void;
  /** Insert or replace one profile. */
  save: (profile: GymProfile) => void;
  /** Remove one. Built-ins are refused by the store. */
  remove: (id: string) => void;
  /** Create from a template. Resolves to the new profile. */
  create: (name: string, kind: GymKind) => Promise<GymProfile | null>;
  /** Copy an existing one. */
  duplicate: (id: string, name: string) => Promise<GymProfile | null>;
}

const EMPTY: GymState = { profiles: [], activeId: "" };

/** Load and edit the gym profiles. */
export function useGyms(): UseGyms {
  const [state, setState] = useState<GymState>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadGyms()
      .then((loaded) => {
        if (cancelled) return;
        setState(loaded);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activate = useCallback((id: string) => {
    setState((prior) => ({ ...prior, activeId: id }));
    void setActiveGym(id);
  }, []);

  const save = useCallback((profile: GymProfile) => {
    setState((prior) => ({
      ...prior,
      profiles: prior.profiles.some((p) => p.id === profile.id)
        ? prior.profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...prior.profiles, profile],
    }));
    void saveProfile(profile);
  }, []);

  const remove = useCallback((id: string) => {
    setState((prior) => {
      const target = prior.profiles.find((p) => p.id === id);
      if (!target || target.builtIn) return prior;
      const profiles = prior.profiles.filter((p) => p.id !== id);
      const activeId =
        prior.activeId === id ? (profiles[0]?.id ?? "") : prior.activeId;
      return { profiles, activeId };
    });
    void deleteProfile(id);
  }, []);

  const create = useCallback(async (name: string, kind: GymKind) => {
    try {
      const profile = await addProfile(name, kind);
      setState((prior) => ({
        profiles: [...prior.profiles, profile],
        activeId: prior.activeId === "" ? profile.id : prior.activeId,
      }));
      return profile;
    } catch {
      return null;
    }
  }, []);

  const duplicate = useCallback(async (id: string, name: string) => {
    try {
      const copy = await copyProfile(id, name);
      if (copy === null) return null;
      setState((prior) => ({ ...prior, profiles: [...prior.profiles, copy] }));
      return copy;
    } catch {
      return null;
    }
  }, []);

  // Keeps the persisted list in step when a profile is edited before the very
  // first save has landed — cheap, and it removes a class of lost-update bug.
  useEffect(() => {
    if (!ready || state.profiles.length === 0) return;
    const timer = setTimeout(() => void saveProfiles(state.profiles), 1200);
    return () => clearTimeout(timer);
  }, [ready, state.profiles]);

  return {
    state,
    active: activeProfile(state),
    ready,
    activate,
    save,
    remove,
    create,
    duplicate,
  };
}
