/**
 * Service worker — complete offline application shell.
 *
 * User records never pass through this worker. They stay in encrypted
 * IndexedDB. The worker has four deliberately narrow jobs:
 *
 * 1. Pre-cache every user-facing route and the hashed assets referenced by
 *    those routes.
 * 2. Keep immutable Next (`/_next/static/`) and Vinext (`/assets/`) build
 *    assets available offline.
 * 3. Reject every same-origin non-GET request locally. A future regression
 *    cannot POST vault data back to the host through this worker.
 * 4. Leave every cross-origin request alone. Open Food Facts and explicitly
 *    chosen video providers remain direct browser-to-vendor traffic.
 *
 * See docs/kg/ARCHITECTURE.md.
 */

const VERSION = "v4";
const CACHE_PREFIX = "keel-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-${VERSION}`;

/**
 * Internal cache-only key. It records Vinext's per-build deployment id so an
 * ordinary app deploy can refresh and prune the shell even when sw.js itself
 * did not change.
 */
const DEPLOYMENT_MARKER_URL = new URL(
  "/__keel-cache-deployment__",
  self.location.origin
).href;

/** Every route a person can reach in the app. Keep this list explicit. */
const SHELL_ROUTES = Object.freeze([
  "/",
  "/body/",
  "/gallery/",
  "/nutrition/",
  "/recovery/",
  "/review/",
  "/settings/",
  "/settings/gyms/",
  "/settings/health/",
  "/settings/profile/",
  "/settings/shortcuts/",
  "/settings/storage/",
  "/settings/vault/",
  "/train/",
  "/train/program/",
]);

const SHELL_ROUTE_SET = new Set(SHELL_ROUTES);

/**
 * Vinext emits one static RSC payload beside each exported route. They are
 * optional during installation so the same worker remains compatible with a
 * conventional Next static export, but they are cached when Vinext serves
 * them and make in-app navigation work offline without forcing a reload.
 */
const RSC_ROUTES = Object.freeze(
  SHELL_ROUTES.map((route) =>
    route === "/" ? "/index.rsc" : `${route.slice(0, -1)}.rsc`
  )
);
const RSC_ROUTE_SET = new Set(RSC_ROUTES);

/** Install metadata and icons when the selected build actually emits them. */
const OPTIONAL_CORE_RESOURCES = Object.freeze([
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
]);
const OPTIONAL_CORE_SET = new Set(OPTIONAL_CORE_RESOURCES);

/** The local barcode reader must be present before offline scanning is claimed. */
const REQUIRED_CORE_RESOURCES = Object.freeze([
  "/wasm/reader/zxing_reader.wasm",
]);
const REQUIRED_CORE_SET = new Set(REQUIRED_CORE_RESOURCES);

/** One refresh at a time, even if several tabs discover a deploy together. */
let shellRefresh = null;

function absoluteUrl(path) {
  return new URL(path, self.location.origin).href;
}

function isOwnOrigin(url) {
  return url.origin === self.location.origin;
}

/** Both supported builders content-hash these files. */
function isImmutableAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/assets/")
  );
}

function isKnownStaticResource(url) {
  return (
    RSC_ROUTE_SET.has(url.pathname) ||
    OPTIONAL_CORE_SET.has(url.pathname) ||
    REQUIRED_CORE_SET.has(url.pathname)
  );
}

/** Convert `/body` and `/body/` to the one cache key `/body/`. */
function shellPathFor(pathname) {
  const withSlash =
    pathname === "/" || pathname.endsWith("/") ? pathname : `${pathname}/`;
  return SHELL_ROUTE_SET.has(withSlash) ? withSlash : null;
}

/**
 * Read same-origin hashed asset URLs out of trusted, generated route HTML.
 * A DOM parser is unavailable in a service worker, and generated attributes
 * are intentionally much narrower than arbitrary authored HTML.
 */
function immutableAssetsFromHtml(html) {
  const urls = new Set();
  const attribute = /\b(?:href|src)=["']([^"'<>]+)["']/gi;
  let match;
  while ((match = attribute.exec(html)) !== null) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (isOwnOrigin(url) && isImmutableAsset(url)) urls.add(url.href);
    } catch {
      // A malformed optional attribute is not a cache target.
    }
  }
  return urls;
}

/**
 * Discover static and dynamic JavaScript imports in a compiled same-origin
 * chunk. Vite emits literal relative chunk paths; following them recursively
 * makes lazy features available on their first offline use rather than only
 * after they happened to be opened online once.
 */
function immutableDependenciesFromJavaScript(source, baseUrl) {
  const urls = new Set();
  const literal = /["'`]((?:\.\.?\/|\/assets\/)[^"'`\\\s?#]+\.js(?:\?[^"'`\\\s]*)?)["'`]/g;
  let match;
  while ((match = literal.exec(source)) !== null) {
    try {
      const url = new URL(match[1], baseUrl);
      if (isOwnOrigin(url) && isImmutableAsset(url)) urls.add(url.href);
    } catch {
      // A malformed compiled literal is not a cache target.
    }
  }
  return urls;
}

/** Fetch the complete build-derived dependency graph, including lazy chunks. */
async function fetchCompleteAssetGraph(seedUrls) {
  const pending = [...seedUrls];
  const seen = new Set();
  const assets = [];
  while (pending.length > 0) {
    const url = pending.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const entry = await fetchRequired(url, "resource");
    assets.push(entry);
    if (new URL(entry.request.url).pathname.endsWith(".js")) {
      const source = await entry.response.clone().text();
      for (const dependency of immutableDependenciesFromJavaScript(source, entry.request.url)) {
        if (!seen.has(dependency)) pending.push(dependency);
      }
    }
  }
  return assets;
}

/**
 * Vinext places a UUID-like deploymentVersion in every exported page. It is
 * preferable to an asset hash because it changes even when a deploy happens
 * to reuse all of the same client chunks.
 */
function vinextDeploymentMarker(html) {
  const match = /deploymentVersion.*?([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(html);
  return match ? `vinext:${match[1]}` : null;
}

/** Deterministic fallback for a plain Next static export. */
function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function markerForShell(pages, assetUrls) {
  for (const page of pages) {
    const marker = vinextDeploymentMarker(page.html);
    if (marker) return marker;
  }
  const content = pages
    .map((page) => `${page.route}\n${page.html}`)
    .join("\n");
  return `static:${stableHash(`${content}\n${[...assetUrls].sort().join("\n")}`)}`;
}

/**
 * A cache entry must be the requested Keel resource, never an auth redirect,
 * error document, or cross-origin response.
 */
function isTrustedResponse(response, kind) {
  if (response.status !== 200 || response.redirected) return false;
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (!isOwnOrigin(finalUrl)) return false;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (kind === "html") return contentType.startsWith("text/html");
  return !contentType.startsWith("text/html");
}

async function fetchRequired(path, kind = "resource") {
  const request = new Request(absoluteUrl(path), {
    method: "GET",
    credentials: "same-origin",
    cache: "reload",
    redirect: "error",
  });
  const response = await fetch(request);
  if (!isTrustedResponse(response, kind)) {
    throw new Error(
      `Could not cache ${path}: untrusted HTTP ${response.status}`
    );
  }
  return { request, response };
}

async function fetchOptional(path, kind = "resource") {
  try {
    return await fetchRequired(path, kind);
  } catch {
    return null;
  }
}

async function pruneCache(cache, keepUrls) {
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((request) => !keepUrls.has(request.url))
      .map((request) => cache.delete(request))
  );
}

/**
 * Fetch a complete new shell before replacing the cached generation.
 *
 * Required route HTML and its hashed CSS/JS are all fetched first. A failed
 * deploy refresh therefore leaves the last complete offline shell intact.
 */
async function refreshCompleteShell() {
  const pages = await Promise.all(
    SHELL_ROUTES.map(async (route) => {
      const entry = await fetchRequired(route, "html");
      return {
        route,
        request: entry.request,
        response: entry.response,
        html: await entry.response.clone().text(),
      };
    })
  );

  const assetUrls = new Set();
  for (const page of pages) {
    for (const url of immutableAssetsFromHtml(page.html)) assetUrls.add(url);
  }

  const requiredAssets = await fetchCompleteAssetGraph(assetUrls);
  const requiredCore = await Promise.all(
    REQUIRED_CORE_RESOURCES.map((path) => fetchRequired(path, "resource"))
  );
  const optionalAssets = (
    await Promise.all(
      [...RSC_ROUTES, ...OPTIONAL_CORE_RESOURCES].map(fetchOptional)
    )
  ).filter(Boolean);

  const marker = markerForShell(pages, assetUrls);
  const shellCache = await caches.open(SHELL_CACHE);
  const assetCache = await caches.open(ASSET_CACHE);

  await Promise.all([
    ...pages.map((page) =>
      shellCache.put(absoluteUrl(page.route), page.response.clone())
    ),
    ...requiredAssets.map(({ request, response }) =>
      assetCache.put(request, response.clone())
    ),
    ...requiredCore.map(({ request, response }) =>
      assetCache.put(request, response.clone())
    ),
    ...optionalAssets.map(({ request, response }) =>
      assetCache.put(request, response.clone())
    ),
  ]);

  const shellUrls = new Set(SHELL_ROUTES.map(absoluteUrl));
  shellUrls.add(DEPLOYMENT_MARKER_URL);
  const currentAssetUrls = new Set([
    ...requiredAssets.map(({ request }) => request.url),
    ...requiredCore.map(({ request }) => request.url),
    ...optionalAssets.map(({ request }) => request.url),
  ]);

  await Promise.all([
    pruneCache(shellCache, shellUrls),
    pruneCache(assetCache, currentAssetUrls),
  ]);
  await shellCache.put(DEPLOYMENT_MARKER_URL, new Response(marker));
}

function refreshShell() {
  if (shellRefresh) return shellRefresh;
  shellRefresh = refreshCompleteShell().finally(() => {
    shellRefresh = null;
  });
  return shellRefresh;
}

async function currentDeploymentMarker() {
  const cache = await caches.open(SHELL_CACHE);
  const response = await cache.match(DEPLOYMENT_MARKER_URL);
  return response ? response.text() : null;
}

async function updateNavigationCache(response, shellPath) {
  const cacheCopy = response.clone();
  const html = await response.text();
  const incoming = vinextDeploymentMarker(html);
  if (incoming) {
    const current = await currentDeploymentMarker();
    if (current !== incoming) {
      await refreshShell();
      return;
    }
  }

  const cache = await caches.open(SHELL_CACHE);
  await cache.put(absoluteUrl(shellPath), cacheCopy);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await refreshShell();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (isTrustedResponse(response, "resource")) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}

async function networkFirstResource(request) {
  const cache = await caches.open(ASSET_CACHE);
  try {
    const response = await fetch(request);
    if (isTrustedResponse(response, "resource")) {
      await cache.put(request, response.clone());
    } else {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
    }
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) ?? Response.error();
  }
}

function handleNavigation(event, request, shellPath) {
  // One network request is shared by the visible response and the deploy
  // detector. Calling waitUntil synchronously keeps the latter alive legally.
  const network = fetch(request);

  event.respondWith(
    (async () => {
      try {
        const response = await network;
        if (!isTrustedResponse(response, "html") && shellPath) {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match(absoluteUrl(shellPath));
          if (cached) return cached;
        }
        return response;
      } catch {
        if (shellPath) {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match(absoluteUrl(shellPath));
          if (cached) return cached;
        }
        return new Response("This screen is not available offline.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    })()
  );

  event.waitUntil(
    network
      .then((response) =>
        isTrustedResponse(response, "html") && shellPath
          ? updateNavigationCache(response.clone(), shellPath)
          : undefined
      )
      .catch(() => undefined)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Cross-origin traffic is deliberately outside this worker's control.
  if (!isOwnOrigin(url)) return;

  // A local-first static app has no legitimate same-origin write endpoint.
  if (request.method !== "GET") {
    event.respondWith(
      Promise.resolve(
        new Response(null, {
          status: 405,
          statusText: "Method Not Allowed",
          headers: {
            Allow: "GET",
            "Cache-Control": "no-store",
          },
        })
      )
    );
    return;
  }

  if (request.mode === "navigate") {
    handleNavigation(event, request, shellPathFor(url.pathname));
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isKnownStaticResource(url)) {
    event.respondWith(networkFirstResource(request));
    return;
  }

  // Unknown same-origin reads go straight to the host and are never cached.
  event.respondWith(fetch(request));
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
