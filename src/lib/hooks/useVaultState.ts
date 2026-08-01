"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getState, subscribe, isInitialized } from "@/lib/vault";
import type { VaultState } from "@/lib/vault";

/**
 * Live vault lock state.
 *
 * The vault exposes a synchronous `getState()` and a `subscribe()` returning an
 * unsubscribe, which is exactly the `useSyncExternalStore` contract — so this
 * is a direct binding with no intermediate state to fall out of sync.
 *
 * Returns `'uninitialized'` on the server, since there is no IndexedDB during
 * the static prerender.
 */
export function useVaultState(): VaultState {
  return useSyncExternalStore(
    subscribe,
    () => getState(),
    () => "uninitialized" as const
  );
}

/**
 * Whether a vault exists on this device.
 *
 * Distinct from lock state: a first-run user has no vault at all and needs
 * onboarding, whereas a returning user has one and needs the lock screen.
 * `undefined` while the check is in flight.
 */
export type VaultExistence = boolean | "unavailable" | undefined;

export function useVaultExists(): VaultExistence {
  const [exists, setExists] = useState<VaultExistence>(undefined);
  const state = useVaultState();

  const check = useCallback(() => {
    let cancelled = false;
    isInitialized()
      .then((v) => {
        if (!cancelled) setExists(v);
      })
      .catch(() => {
        // A failed IndexedDB read is not evidence that the vault is absent.
        // Treating it as first run could invite the user to overwrite or clear
        // storage that still contains their only encrypted copy.
        if (!cancelled) setExists("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-check when the vault state changes, so completing onboarding flips this
  // without a reload.
  useEffect(check, [check, state]);

  return exists;
}
