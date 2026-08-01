"use client";

/**
 * @file React bindings for the video package.
 *
 * `src/lib/video` is deliberately React-free — same convention the vault
 * follows — so the `useSyncExternalStore` pair and the object-URL lifecycle
 * live here instead.
 *
 * Both async hooks below keep **one** state object keyed by what was asked for,
 * and derive `loading` by comparing that key with the current props. The
 * obvious shape — `setLoading(true)` at the top of the effect — schedules a
 * synchronous state update inside an effect body and costs a cascading render
 * on every exercise change; the repo's lint rules reject it, correctly.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_VIDEO_PREFERENCES,
  listUserDemos,
  loadUserDemoBlob,
  loadVideoPreferences,
  subscribeVideoPreferences,
  videoPreferencesSnapshot,
  type UserDemoMeta,
  type VideoPreferences,
} from "@/lib/video";
import { subscribe as subscribeVault } from "@/lib/vault";

/**
 * The user's video preferences, kept live.
 *
 * Renders with defaults on the first paint and again on the server — the
 * snapshot is a frozen constant until the vault read resolves, so there is no
 * hydration mismatch and no flash of an iframe that should not exist. A locked
 * vault leaves the defaults in place rather than throwing into a render.
 *
 * @returns the current preferences
 */
export function useVideoPreferences(): VideoPreferences {
  const prefs = useSyncExternalStore(
    subscribeVideoPreferences,
    videoPreferencesSnapshot,
    () => DEFAULT_VIDEO_PREFERENCES
  );

  useEffect(() => {
    // A locked vault is an expected state here, not an error worth surfacing.
    void loadVideoPreferences().catch(() => undefined);
  }, []);

  return prefs;
}

/** What {@link useUserDemos} returns. */
export interface UserDemosState {
  readonly demos: readonly UserDemoMeta[];
  readonly loading: boolean;
  /** Re-read after a save or a delete. */
  readonly reload: () => void;
}

interface DemosSnapshot {
  readonly key: string;
  readonly demos: readonly UserDemoMeta[];
}

const NO_DEMOS: DemosSnapshot = { key: "", demos: [] };

/**
 * The user's own recordings for one exercise, newest first.
 *
 * @param slug the exercise slug
 * @returns the recordings, a loading flag, and a reload callback
 */
export function useUserDemos(slug: string): UserDemosState {
  const [nonce, setNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<DemosSnapshot>(NO_DEMOS);
  const key = `${slug}#${nonce}`;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    listUserDemos(slug)
      // A locked vault, or no media database yet on a fresh install, both mean
      // "no recordings" — which is what the empty array already says.
      .catch(() => [] as UserDemoMeta[])
      .then((found) => {
        if (!cancelled) setSnapshot({ key, demos: found });
      });
    return () => {
      cancelled = true;
    };
  }, [key, slug]);

  // A lock invalidates what we are holding: the list is decrypted vault data.
  useEffect(
    () =>
      subscribeVault((event) => {
        if (event.state !== "unlocked") setSnapshot((prev) => ({ key: prev.key, demos: [] }));
      }),
    []
  );

  return {
    demos: snapshot.key === key ? snapshot.demos : [],
    loading: snapshot.key !== key,
    reload,
  };
}

/** What {@link useUserDemoUrl} returns. */
export interface UserDemoUrlState {
  /** A `blob:` URL, or null while decrypting or when nothing is requested. */
  readonly url: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

interface UrlSnapshot {
  readonly id: string | null;
  readonly url: string | null;
  readonly error: string | null;
}

const NO_URL: UrlSnapshot = { id: null, url: null, error: null };

/**
 * Decrypt one recording into a `blob:` URL for a `<video>` element.
 *
 * Object URLs pin their blob in memory until revoked, and a 40 MB video pinned
 * across a navigation is a real leak on a phone — so the URL is revoked on
 * unmount, when the id changes, and **when the vault locks**. The last one
 * matters: auto-lock exists to make decrypted data inaccessible, and a live
 * object URL would quietly outlive it.
 *
 * @param id the recording id, or null to hold nothing
 * @returns the URL, a loading flag, and any error message
 */
export function useUserDemoUrl(id: string | null): UserDemoUrlState {
  const [snapshot, setSnapshot] = useState<UrlSnapshot>(NO_URL);

  useEffect(() => {
    if (!id) return;
    let disposed = false;
    let created: string | null = null;

    loadUserDemoBlob(id)
      .then((blob) => {
        if (disposed) return;
        created = URL.createObjectURL(blob);
        setSnapshot({ id, url: created, error: null });
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setSnapshot({
          id,
          url: null,
          error: err instanceof Error ? err.message : "That video could not be opened.",
        });
      });

    const unsubscribe = subscribeVault((event) => {
      if (event.state === "unlocked") return;
      if (created) {
        URL.revokeObjectURL(created);
        created = null;
      }
      // Keep the id so the caller sees a settled, empty state rather than an
      // eternal spinner.
      setSnapshot({ id, url: null, error: "Vault locked." });
    });

    return () => {
      disposed = true;
      unsubscribe();
      if (created) URL.revokeObjectURL(created);
    };
  }, [id]);

  const settled = snapshot.id === id;
  return {
    url: settled ? snapshot.url : null,
    loading: id !== null && !settled,
    error: settled ? snapshot.error : null,
  };
}
