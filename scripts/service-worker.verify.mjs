/**
 * Focused, dependency-free verification for public/sw.js.
 *
 * Executes the real worker in a small in-memory Service Worker environment.
 * This is intentionally not a browser substitute; it proves the privacy and
 * cache-routing contract while the deployment smoke test proves Safari/PWA
 * integration.
 *
 * Run:
 *   node scripts/service-worker.verify.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const ORIGIN = "https://keel.example";
const EXPECTED_ROUTES = [
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
];

function urlFor(input) {
  if (typeof input === "string") return new URL(input, ORIGIN).href;
  return input.url;
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  async match(input, options = {}) {
    const wanted = new URL(urlFor(input));
    for (const [url, response] of this.entries) {
      const candidate = new URL(url);
      const matches = options.ignoreSearch
        ? candidate.origin === wanted.origin &&
          candidate.pathname === wanted.pathname
        : candidate.href === wanted.href;
      if (matches) return response.clone();
    }
    return undefined;
  }

  async put(input, response) {
    this.entries.set(urlFor(input), response.clone());
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async delete(input) {
    return this.entries.delete(urlFor(input));
  }
}

class MemoryCacheStorage {
  constructor() {
    this.stores = new Map();
  }

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache());
    return this.stores.get(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name) {
    return this.stores.delete(name);
  }
}

function routeSlug(pathname) {
  return pathname === "/"
    ? "home"
    : pathname.replace(/^\/|\/$/g, "").replaceAll("/", "-");
}

function rscPath(pathname) {
  if (pathname === "/") return "/index.rsc";
  return `${pathname.replace(/\/$/, "")}.rsc`;
}

function pageHtml(pathname, deployment) {
  const slug = routeSlug(pathname);
  return `<!doctype html>
    <link rel="stylesheet" href="/assets/app-${deployment}.css">
    <link rel="modulepreload" href="/assets/${slug}-${deployment}.js">
    <script>self.__DATA__={"deploymentVersion":"${deployment}"}</script>`;
}

const listeners = new Map();
const caches = new MemoryCacheStorage();
const fetchCalls = [];
let deployment = "11111111-1111-4111-8111-111111111111";
let offline = false;
let skippedWaiting = false;
let claimedClients = false;
let failedNavigation = null;
let spoofedResource = null;

async function fakeFetch(input) {
  const request = typeof input === "string" ? new Request(urlFor(input)) : input;
  const url = new URL(request.url);
  fetchCalls.push({ method: request.method, url: url.href });
  if (offline) throw new TypeError("offline");
  if (url.pathname === failedNavigation) {
    return new Response("temporary failure", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    });
  }
  if (url.pathname === spoofedResource) {
    return new Response("<title>Sign in</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  const route =
    EXPECTED_ROUTES.find((candidate) => candidate === url.pathname) ?? null;
  if (route) {
    return new Response(pageHtml(route, deployment), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  if (
    EXPECTED_ROUTES.some((candidate) => rscPath(candidate) === url.pathname) ||
    url.pathname.startsWith("/assets/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/icons/")
    || url.pathname === "/wasm/reader/zxing_reader.wasm"
  ) {
    const body = url.pathname === `/assets/nutrition-${deployment}.js`
      ? `import("./ponyfill-${deployment}.js")`
      : `asset:${url.pathname}:${deployment}`;
    return new Response(body, { status: 200 });
  }

  return new Response("not found", { status: 404 });
}

const workerSource = await readFile(
  new URL("../public/sw.js", import.meta.url),
  "utf8"
);

assert.equal(
  workerSource.includes("/offline/"),
  false,
  "the removed /offline/ route must not reappear"
);

const context = vm.createContext({
  URL,
  Request,
  Response,
  Headers,
  Promise,
  Set,
  Map,
  Object,
  Math,
  Error,
  TypeError,
  console,
  caches,
  fetch: fakeFetch,
  self: {
    location: new URL(`${ORIGIN}/sw.js`),
    clients: {
      async claim() {
        claimedClients = true;
      },
    },
    async skipWaiting() {
      skippedWaiting = true;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  },
});

vm.runInContext(workerSource, context, { filename: "public/sw.js" });

async function dispatchExtendable(type, extra = {}) {
  const waits = [];
  listeners.get(type)({
    ...extra,
    waitUntil(promise) {
      waits.push(Promise.resolve(promise));
    },
  });
  await Promise.all(waits);
}

async function dispatchFetch(request) {
  let responsePromise = null;
  const waits = [];
  listeners.get("fetch")({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
    waitUntil(value) {
      waits.push(Promise.resolve(value));
    },
  });
  const response = responsePromise ? await responsePromise : null;
  await Promise.all(waits);
  return response;
}

await dispatchExtendable("install");
assert.equal(skippedWaiting, true, "install activates the complete shell");

const requestedPaths = new Set(fetchCalls.map(({ url }) => new URL(url).pathname));
assert.deepEqual(
  EXPECTED_ROUTES.filter((route) => !requestedPaths.has(route)),
  [],
  "all 15 user routes are pre-cached"
);
assert.deepEqual(
  EXPECTED_ROUTES.map(rscPath).filter((route) => !requestedPaths.has(route)),
  [],
  "all Vinext route payloads are considered for pre-cache"
);

const shellCache = await caches.open("keel-shell-v4");
for (const route of EXPECTED_ROUTES) {
  assert.ok(
    await shellCache.match(new Request(`${ORIGIN}${route}`)),
    `${route} has an offline document`
  );
}

const assetCache = await caches.open("keel-assets-v4");
assert.ok(
  await assetCache.match(
    new Request(`${ORIGIN}/assets/settings-health-${deployment}.js`)
  ),
  "Vinext hashed route assets are cached"
);
assert.ok(
  await assetCache.match(new Request(`${ORIGIN}/wasm/reader/zxing_reader.wasm`)),
  "the self-hosted barcode decoder is pre-cached for offline scans"
);
assert.ok(
  await assetCache.match(new Request(`${ORIGIN}/assets/ponyfill-${deployment}.js`)),
  "the lazy decoder JavaScript is discovered from the built chunk graph and pre-cached"
);

await caches.open("keel-shell-v1");
await caches.open("keel-assets-v1");
await caches.open("another-app-cache");
await dispatchExtendable("activate");
const activeCacheNames = await caches.keys();
assert.equal(claimedClients, true, "the activated worker claims open clients");
assert.equal(activeCacheNames.includes("keel-shell-v1"), false);
assert.equal(activeCacheNames.includes("keel-assets-v1"), false);
assert.equal(
  activeCacheNames.includes("another-app-cache"),
  true,
  "activation does not delete another application's cache"
);

failedNavigation = "/body/";
const cachedDuringServerFailure = await dispatchFetch({
  method: "GET",
  mode: "navigate",
  url: `${ORIGIN}/body/`,
});
assert.equal(cachedDuringServerFailure.status, 200);
assert.match(
  await cachedDuringServerFailure.text(),
  /deploymentVersion/,
  "an HTTP failure falls back to the last trusted shell"
);
failedNavigation = null;

spoofedResource = "/manifest.webmanifest";
const cachedInsteadOfAuthPage = await dispatchFetch(
  new Request(`${ORIGIN}/manifest.webmanifest`)
);
assert.doesNotMatch(
  await cachedInsteadOfAuthPage.text(),
  /Sign in/,
  "an HTML authentication page cannot replace a cached static resource"
);
spoofedResource = null;

const beforeBlockedWrite = fetchCalls.length;
const blockedWrite = await dispatchFetch(
  new Request(`${ORIGIN}/api/health`, {
    method: "POST",
    body: "sensitive",
  })
);
assert.equal(blockedWrite.status, 405);
assert.equal(
  fetchCalls.length,
  beforeBlockedWrite,
  "same-origin writes never reach fetch"
);

const crossOriginWrite = await dispatchFetch(
  new Request("https://world.openfoodfacts.org/api/v2/product", {
    method: "POST",
    body: "vendor request",
  })
);
assert.equal(
  crossOriginWrite,
  null,
  "cross-origin traffic is untouched by the worker"
);

offline = true;
for (const route of EXPECTED_ROUTES) {
  const offlinePage = await dispatchFetch({
    method: "GET",
    mode: "navigate",
    url: `${ORIGIN}${route}`,
  });
  assert.equal(offlinePage.status, 200, `${route} opens offline`);
  assert.match(await offlinePage.text(), /deploymentVersion/);
}

const offlineAsset = await dispatchFetch(
  new Request(`${ORIGIN}/assets/body-${deployment}.js`)
);
assert.equal(offlineAsset.status, 200);

const offlineUnknown = await dispatchFetch({
  method: "GET",
  mode: "navigate",
  url: `${ORIGIN}/not-a-route/`,
});
assert.equal(offlineUnknown.status, 503);

offline = false;
const oldAssetUrl = `${ORIGIN}/assets/body-${deployment}.js`;
assert.ok(await assetCache.match(new Request(oldAssetUrl)));

deployment = "22222222-2222-4222-8222-222222222222";
const updatedBody = await dispatchFetch({
  method: "GET",
  mode: "navigate",
  url: `${ORIGIN}/body/`,
});
assert.equal(updatedBody.status, 200);
assert.equal(
  await assetCache.match(new Request(oldAssetUrl)),
  undefined,
  "a new Vinext deploy prunes the previous hashed generation"
);
assert.ok(
  await assetCache.match(
    new Request(`${ORIGIN}/assets/body-${deployment}.js`)
  ),
  "a new Vinext deploy fills the current hashed generation"
);

console.log(
  "✓ service worker: 15 routes, Vinext assets, offline fallback, write blocking, and deploy eviction verified"
);
