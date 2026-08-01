import type { NextConfig } from "next";

/**
 * The Sites worker renders only Keel's public app shell.
 *
 * HTML deliberately remains a worker response rather than a directly served
 * asset so the production CSP and other security headers are authoritative.
 * There is still no account, application API, D1 database or R2 bucket: every
 * personalized read happens from encrypted IndexedDB in the browser, and the
 * service worker caches these public shell responses for offline use.
 */
const nextConfig: NextConfig = {
  // There is no server to optimise images on.
  images: { unoptimized: true },

  // Keep one canonical route shape across the worker and offline cache.
  trailingSlash: true,

  reactStrictMode: true,
};

export default nextConfig;
