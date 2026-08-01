/**
 * Privacy audit — node scripts/privacy-audit.mjs
 *
 * The architecture makes one promise: health data never leaves the device.
 * Comments and good intentions do not enforce a promise, so this script reads
 * the *built* output and fails the build if the bundle looks capable of
 * breaking it.
 *
 * It is intentionally blunt. False positives are cheap to resolve with an
 * explicit allowlist entry; a false negative would be a privacy breach.
 *
 * Run after `npm run build`.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const BUILD_DIRS = [
  path.join(process.cwd(), "dist", "client"),
  path.join(process.cwd(), "dist", "server"),
];
const SOURCE_DIRS = [
  path.join(process.cwd(), "src"),
  path.join(process.cwd(), "public"),
  path.join(process.cwd(), "worker"),
];

/** Hosts the app is permitted to contact, and why. */
const ALLOWED_HOSTS = new Map([
  [
    "world.openfoodfacts.org",
    "one user-triggered barcode lookup GET with fixed app/locale labels; no profile, diary, vault, or stable client id; cache checked first",
  ],
  // Exercise demonstration video, accepted explicitly by the user: "I don't
  // care about Google knowing my exercise routine. They already have it. They
  // just can't have my raw health data without my consent."
  //
  // These are `frame-src` and outbound-link hosts, NOT `connect-src` hosts —
  // the check below is deliberately not weakened to accommodate them. An embedded
  // cross-origin iframe cannot read our DOM, our IndexedDB or our keys; the
  // disclosure is an IP, a video id and a timestamp, and only after a tap.
  // Nothing renders an iframe on page load — see src/components/video.
  ["www.youtube.com", "exercise demo embeds + 'Open in YouTube' links; frame-src only, never connect-src"],
  [
    "www.youtube-nocookie.com",
    "stricter embed origin behind a Settings toggle; frame-src only, never connect-src",
  ],
  ["nextjs.org", "inert doc link in a framework error string"],
  ["react.dev", "inert doc link in a framework error string"],
  ["vercel.com", "inert doc link in a framework error string"],
  ["github.com", "inert doc link in a framework error string"],
  // Not a network reference at all: `xmlns="http://www.w3.org/2000/svg"` is an
  // XML namespace identifier and is never fetched.
  ["www.w3.org", "SVG/XML namespace identifier, never dereferenced"],
  // Dexie embeds shortened doc links in two of its error message strings
  // ("IndexedDB API missing" and "Transaction committed too early"). Inert
  // text in a throw path — nothing dereferences them.
  ["tinyurl.com", "inert doc link in a Dexie error string"],
  ["bit.ly", "inert doc link in a Dexie error string"],
  // Vinext's client image helper ships provider adapters even though Keel sets
  // images.unoptimized and the CSP cannot contact these hosts.
  ["images.contentstack.io", "inert Vinext image-provider default; blocked by CSP"],
  ["s7d1.scene7.com", "inert Vinext image-provider default; blocked by CSP"],
  ["wsrv.nl", "inert Vinext image-provider default; blocked by CSP"],
  ["vinext.local", "internal Vinext URL-parsing sentinel, never dereferenced"],
  ["tailwindcss.com", "license URL in Tailwind's generated CSS banner"],
  ["evil.com", "Vinext open-redirect defence examples in compiled comments"],
  ["example.com", "Vinext URL-parsing sentinel and security examples"],
  ["us.i.posthog.com", "Vinext external-rewrite documentation example; no rewrite is configured"],
  ["www.sitemaps.org", "XML namespace emitted by Vinext metadata support, never fetched"],
  ["www.google.com", "sitemap XML namespace emitted by Vinext, never fetched"],
  [
    "fonts.googleapis.com",
    "dormant Vinext next/font URL builder; next/font/google imports are forbidden below",
  ],
]);

/** Patterns that would indicate data exfiltration capability. */
const FORBIDDEN = [
  {
    id: "analytics",
    re: /google-analytics|googletagmanager|segment\.(com|io)|mixpanel|amplitude|posthog|sentry\.io|bugsnag|datadoghq|fullstory|hotjar|clarity\.ms/gi,
    why: "third-party analytics or error reporting",
  },
  {
    id: "beacon",
    re: /navigator\s*\.\s*sendBeacon/g,
    why: "sendBeacon is a fire-and-forget exfiltration primitive",
  },
  {
    id: "external-font",
    re: /fonts\.(googleapis|gstatic)\.com/gi,
    why: "external font fetch leaks an IP and defeats the CSP",
  },
  {
    id: "next-google-font",
    re: /(?:from\s*["']next\/font\/google["']|require\s*\(\s*["']next\/font\/google["']\s*\))/g,
    why: "Google font helpers could activate Vinext's server-side font fetcher; use bundled local fonts",
    sourceOnly: true,
  },
  {
    id: "same-origin-write",
    re: /\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/gi,
    why: "Keel has no server write API; outbound write methods could carry vault data",
    sourceOnly: true,
  },
  {
    id: "relative-fetch",
    re: /\bfetch\s*\(\s*["'`]\/(?!\/)/g,
    why: "literal same-origin fetches must be reviewed; route reads use framework-owned requests",
    sourceOnly: true,
  },
  {
    id: "socket",
    re: /\b(?:WebSocket|EventSource)\s*\(/g,
    why: "persistent outbound connections are outside Keel's local-only architecture",
    sourceOnly: true,
  },
  {
    id: "xhr",
    re: /\bnew\s+XMLHttpRequest\s*\(/g,
    why: "XMLHttpRequest is unnecessary in Keel and could bypass the reviewed request path",
    sourceOnly: true,
  },
];

/** @returns {Promise<string[]>} every file under dir, recursively */
async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const SCANNABLE = new Set([".js", ".mjs", ".html", ".css", ".json", ".webmanifest", ".txt"]);

async function main() {
  for (const directory of BUILD_DIRS) {
    try {
      await stat(directory);
    } catch {
      console.error(
        `✗ No Sites build output at ${directory}. Run \`npm run build\` first.`
      );
      process.exit(1);
    }
  }

  const files = (await Promise.all(BUILD_DIRS.map((directory) => walk(directory))))
    .flat()
    .filter((file) => SCANNABLE.has(path.extname(file)));
  const sourceFiles = (
    await Promise.all(SOURCE_DIRS.map((directory) => walk(directory)))
  )
    .flat()
    .filter((file) =>
      [".js", ".mjs", ".ts", ".tsx"].includes(path.extname(file))
    );
  const findings = [];
  const seenHosts = new Map();

  for (const file of [...files, ...sourceFiles]) {
    const rel = path.relative(process.cwd(), file);
    const text = await readFile(file, "utf8");
    const isSource = sourceFiles.includes(file);
    const isServerBuild = rel.startsWith(`dist${path.sep}server${path.sep}`);

    for (const rule of FORBIDDEN) {
      if (rule.sourceOnly && !isSource) continue;
      // Vinext's compiled server carries dormant framework helpers and
      // documentation examples for analytics rewrites and Google Fonts. App
      // and worker source are scanned separately, and the shipped client still
      // fails on either pattern, so those features cannot be activated here.
      if (
        isServerBuild &&
        (rule.id === "analytics" || rule.id === "external-font")
      ) {
        continue;
      }
      rule.re.lastIndex = 0;
      const matches = text.match(rule.re);
      if (matches) {
        findings.push({
          file: rel,
          rule: rule.id,
          why: rule.why,
          sample: [...new Set(matches)].slice(0, 3).join(", "),
        });
      }
    }

    if (
      rel === "worker/index.ts" &&
      /(?:\bawait|\breturn|=>|=|\[|,|\()\s*fetch\s*\(/g.test(text)
    ) {
      findings.push({
        file: rel,
        rule: "worker-global-fetch",
        why: "the production worker may only delegate to reviewed bound fetchers, never make a global network request",
        sample: "global fetch(",
      });
    }

    // Host inventory describes both shipped bundles. The two trusted worker
    // sources are inventoried too, so a new server/service-worker destination
    // cannot hide behind compilation or tree-shaking. Other source comments
    // and tests contain deliberately inert example URLs.
    if (
      !isSource ||
      rel === "worker/index.ts" ||
      rel === "public/sw.js"
    ) {
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/"'`\s)\\]|$)/gi)) {
        const host = m[1].toLowerCase();
        if (!seenHosts.has(host)) seenHosts.set(host, new Set());
        seenHosts.get(host).add(rel);
      }
    }
  }

  const unexpected = [...seenHosts.keys()]
    .filter((h) => !ALLOWED_HOSTS.has(h))
    .sort();

  console.log(
    `Scanned ${files.length} Sites build files and ${sourceFiles.length} source files.\n`
  );

  console.log("Permitted hosts referenced:");
  for (const [host, why] of ALLOWED_HOSTS) {
    const present = seenHosts.has(host);
    console.log(`  ${present ? "•" : " "} ${host.padEnd(30)} ${why}`);
  }

  let failed = false;

  if (unexpected.length) {
    failed = true;
    console.log("\n✗ Unrecognised hosts in the bundle:");
    for (const host of unexpected) {
      const where = [...seenHosts.get(host)].slice(0, 3).join(", ");
      console.log(`    ${host}  (in ${where})`);
    }
    console.log(
      "\n  Every outbound host must be justified. Add it to ALLOWED_HOSTS with a\n" +
        "  reason, or remove it."
    );
  }

  if (findings.length) {
    failed = true;
    console.log("\n✗ Forbidden patterns:");
    for (const f of findings) {
      console.log(`    [${f.rule}] ${f.file}\n      ${f.why}\n      matched: ${f.sample}`);
    }
  }

  if (failed) {
    console.log("\nPRIVACY AUDIT FAILED");
    process.exit(1);
  }

  console.log("\n✓ Privacy audit passed — no unexpected hosts, no exfiltration primitives.");
}

await main();
