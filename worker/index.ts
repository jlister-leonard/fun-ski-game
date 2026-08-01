import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  contentSecurityPolicyForInlineScripts,
  SECURITY_RESPONSE_HEADERS,
} from "../src/lib/security/policy";

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Keel has no application API and no server-side health-data route. This
 * worker serves only the compiled application shell and its static assets.
 */
const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return withSecurityHeaders(
        request,
        new Response("Keel has no server-side write API.", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        })
      );
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [
        ...DEFAULT_DEVICE_SIZES,
        ...DEFAULT_IMAGE_SIZES,
      ];
      const response = await handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths
      );
      return withSecurityHeaders(request, response);
    }

    // `assets.run_worker_first` makes this worker the security boundary for
    // every request. Delegate to the immutable asset binding from inside that
    // boundary, then fall back to Vinext only when the requested file is not
    // part of the compiled shell.
    if (env?.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return withSecurityHeaders(request, assetResponse);
      }
    }

    return withSecurityHeaders(request, await handler.fetch(request, env, ctx));
  },
};

async function withSecurityHeaders(
  request: Request,
  response: Response
): Promise<Response> {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }

  let body: BodyInit | null = response.body;
  if (
    request.method === "GET" &&
    headers.get("content-type")?.toLowerCase().startsWith("text/html")
  ) {
    const origin = new URL(request.url).origin;
    const html = (await response.text()).replace(
      /content="(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?(\/(?:og\.png)?)" data-keel-origin-relative="true"/g,
      (_match, path: string) =>
        `content="${origin}${path}" data-keel-origin-relative="true"`
    );
    body = html;
    headers.set(
      "Content-Security-Policy",
      contentSecurityPolicyForInlineScripts(await inlineScriptHashes(html))
    );
    headers.delete("content-length");
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Hash the inline bootstrap scripts exactly as the browser receives them.
 *
 * Vinext emits a small, deterministic set of inline scripts for hydration.
 * Hash sources let those exact bytes run without granting `unsafe-inline` to
 * later DOM injections.
 */
async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes = new Set<string>();
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = script.exec(html)) !== null) {
    const attributes = match[1] ?? "";
    const content = match[2] ?? "";
    if (/\bsrc\s*=/i.test(attributes) || content.length === 0) continue;

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(content)
    );
    hashes.add(bytesToBase64(new Uint8Array(digest)));
  }

  return [...hashes].sort();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default worker;
