"use client";

import { useEffect } from "react";

/**
 * Registers the offline shell worker.
 *
 * Mounted once from the root layout. Failure here is non-fatal — the app works
 * fine without a service worker, it just won't open offline.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // A worker served from a filesystem or an insecure origin will throw.
    if (!window.isSecureContext) return;

    let cancelled = false;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        if (cancelled) return;

        // Pick up a new deploy without making the user force-quit the app.
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              installing.postMessage("SKIP_WAITING");
            }
          });
        });
      } catch {
        // Offline support is a bonus, not a requirement. Stay quiet.
      }
    };

    void register();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
