/**
 * One network policy for both the HTML fallback and the Sites worker.
 *
 * `connect-src 'self'` is required for Vinext's read-only route payloads. The
 * one third-party connection is a user-triggered barcode read from Open Food
 * Facts with fixed app/locale labels; no stable id, diary or vault data is
 * present in that request. Keel
 * exposes no application API and the service worker rejects same-origin write
 * methods before they reach the network. YouTube remains tap-to-load and
 * isolated in a cross-origin frame; it never receives vault data.
 */
const NON_SCRIPT_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://world.openfoodfacts.org",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "upgrade-insecure-requests",
] as const;

/** Fallback for static previews where response headers are unavailable. */
export const META_CONTENT_SECURITY_POLICY = [
  NON_SCRIPT_DIRECTIVES[0],
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  ...NON_SCRIPT_DIRECTIVES.slice(1),
].join("; ");

/**
 * Production policy, authorizing only the exact inline boot scripts in one
 * compiled HTML response.
 *
 * @param hashes base64 SHA-256 digests, without the `sha256-` prefix
 */
export function contentSecurityPolicyForInlineScripts(
  hashes: readonly string[] = []
): string {
  const scriptSources = [
    "'self'",
    "'wasm-unsafe-eval'",
    ...hashes.map((hash) => `'sha256-${hash}'`),
  ];
  return [
    NON_SCRIPT_DIRECTIVES[0],
    `script-src ${scriptSources.join(" ")}`,
    ...NON_SCRIPT_DIRECTIVES.slice(1),
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Full policy used by the Sites worker; frame-ancestors only works as a header. */
export const HTTP_CONTENT_SECURITY_POLICY =
  contentSecurityPolicyForInlineScripts();

/** Headers applied to every Sites worker response, including the HTML shell. */
export const SECURITY_RESPONSE_HEADERS = {
  "Content-Security-Policy": HTTP_CONTENT_SECURITY_POLICY,
  "Permissions-Policy":
    "browsing-topics=(), camera=(self), geolocation=(), microphone=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;
