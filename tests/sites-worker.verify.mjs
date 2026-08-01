import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROUTES = [
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

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const env = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

test("routes production assets through the security worker first", async () => {
  const configUrl = new URL("../dist/server/wrangler.json", import.meta.url);
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  assert.equal(config.assets?.run_worker_first, true);
  assert.equal(config.assets?.directory, "../client");
  await assert.rejects(
    readFile(new URL("../dist/client/index.html", import.meta.url)),
    (error) => error?.code === "ENOENT",
    "root HTML must remain a worker response so Sites cannot bypass its headers"
  );
});

test("ships and secures the static PWA manifest", async () => {
  const manifestUrl = new URL("../dist/client/manifest.webmanifest", import.meta.url);
  const manifestText = await readFile(manifestUrl, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");

  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://keel.example/manifest.webmanifest"),
    {
      ASSETS: {
        fetch: async () =>
          new Response(manifestText, {
            headers: { "content-type": "application/manifest+json" },
          }),
      },
    },
    ctx
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), manifest);
});

test("ships the pinned self-hosted barcode decoder as WebAssembly", async () => {
  const wasmUrl = new URL("../dist/client/wasm/reader/zxing_reader.wasm", import.meta.url);
  const wasm = await readFile(wasmUrl);
  assert.equal(wasm.byteLength, 1_065_634);
  assert.equal(
    createHash("sha256").update(wasm).digest("hex"),
    "6a858c01e076bab3a1bd413e4f2cf5e5e45f819a0d9441d83c66993bc48ed38f"
  );

  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://keel.example/wasm/reader/zxing_reader.wasm"),
    {
      ASSETS: {
        fetch: async () => new Response(wasm, {
          headers: { "content-type": "application/wasm" },
        }),
      },
    },
    ctx
  );
  assert.equal(response.headers.get("content-type"), "application/wasm");
  assert.equal((await response.arrayBuffer()).byteLength, wasm.byteLength);
});

test("emits the lazy decoder as a build-derived, discoverable offline asset", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../dist/client/.vite/manifest.json", import.meta.url),
    "utf8",
  ));
  const decoderKey = Object.keys(manifest).find((key) => key.includes("barcode-detector") && key.endsWith("ponyfill.js"));
  assert.ok(decoderKey, "the pinned decoder has a Vite manifest entry");
  const decoder = manifest[decoderKey];
  assert.equal(decoder.isDynamicEntry, true);
  const importer = Object.values(manifest).find((entry) => entry.dynamicImports?.includes(decoderKey));
  assert.ok(importer, "a compiled Keel chunk declares the decoder as a dynamic dependency");
  const importerSource = await readFile(new URL(`../dist/client/${importer.file}`, import.meta.url), "utf8");
  const decoderFile = decoder.file.split("/").at(-1);
  assert.match(importerSource, new RegExp(`(?:\\./|/assets/)${decoderFile.replaceAll('.', '\\.')}`));
  const decoderSource = await readFile(new URL(`../dist/client/${decoder.file}`, import.meta.url), "utf8");
  assert.doesNotMatch(decoderSource, /fastly\.jsdelivr\.net/);
});

test("serves every user route through the Sites worker", async () => {
  const worker = await loadWorker();
  for (const path of ROUTES) {
    const response = await worker.fetch(
      new Request(`https://keel.example${path}`, {
        headers: { accept: "text/html" },
      }),
      env,
      ctx
    );
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  }
});

test("adds the production security boundary and absolute social metadata", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://keel.example/", {
      headers: { accept: "text/html" },
    }),
    env,
    ctx
  );

  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /connect-src 'self' https:\/\/world\.openfoodfacts\.org(?:;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /ouraring|strava/i);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const permissions = response.headers.get("permissions-policy") ?? "";
  assert.match(permissions, /publickey-credentials-create=\(self\)/);
  assert.match(permissions, /publickey-credentials-get=\(self\)/);
  assert.match(permissions, /camera=\(self\)/);

  const html = await response.text();
  assert.match(
    html,
    /<link\b[^>]*\brel="manifest"[^>]*\bhref="\/manifest\.webmanifest"/,
    "every rendered route must advertise the install manifest"
  );
  assert.match(html, /content="https:\/\/keel\.example\/og\.png"/);
  assert.match(html, /content="https:\/\/keel\.example\/"/);

  const inlineScripts = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
  ]
    .filter((match) => !/\bsrc\s*=/i.test(match[1] ?? "") && match[2])
    .map((match) => match[2]);
  assert.ok(inlineScripts.length > 0, "expected compiled inline boot scripts");
  for (const script of inlineScripts) {
    const hash = createHash("sha256").update(script).digest("base64");
    assert.match(csp, new RegExp(`'sha256-${escapeRegExp(hash)}'`));
  }
});

test("normalizes prerender-time social URLs if an HTML asset is delegated", async () => {
  const worker = await loadWorker();
  const html = [
    '<!doctype html><html><head>',
    '<meta property="og:url" content="http://127.0.0.1:56789/" data-keel-origin-relative="true">',
    '<meta property="og:image" content="http://localhost:56789/og.png" data-keel-origin-relative="true">',
    '</head><body><script>window.__keel = true;</script></body></html>',
  ].join("");
  const response = await worker.fetch(
    new Request("https://keel.example/"),
    {
      ASSETS: {
        fetch: async () =>
          new Response(html, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      },
    },
    ctx
  );
  const output = await response.text();
  assert.match(output, /content="https:\/\/keel\.example\/"/);
  assert.match(output, /content="https:\/\/keel\.example\/og\.png"/);
  assert.doesNotMatch(output, /127\.0\.0\.1|localhost/);
});

test("exposes no same-origin write endpoint", async () => {
  const worker = await loadWorker();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await worker.fetch(
      new Request("https://keel.example/", {
        method,
        body: method === "GET" || method === "HEAD" ? undefined : "private",
      }),
      env,
      ctx
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
