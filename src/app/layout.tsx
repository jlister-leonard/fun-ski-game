import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/system/ServiceWorkerRegistrar";
import { ThemeScript } from "@/components/system/ThemeScript";
import { VaultGate } from "@/components/app/VaultGate";
import { META_CONTENT_SECURITY_POLICY } from "@/lib/security/policy";

/**
 * Content Security Policy.
 *
 * Static previews cannot set HTTP headers, so a fallback policy is delivered
 * as a meta tag. In production the Sites worker adds the stronger HTTP policy
 * and hashes each compiled inline boot script, so arbitrary inline code is not
 * authorized. `connect-src 'self'` separately prevents client code from
 * phoning a third-party endpoint.
 *
 * `unsafe-inline` on style-src is required by React's inline style attributes.
 * The meta fallback permits inline hydration because it cannot know build-time
 * hashes; the production header does not. Open Food Facts is the one explicit
 * cross-origin connection and receives only a user-submitted barcode.
 */
export const metadata: Metadata = {
  title: "Keel",
  description:
    "Training, nutrition and recovery in one place. Everything stays on your phone.",
  applicationName: "Keel",
  manifest: "/manifest.webmanifest",
  // Tells iOS to run in standalone chrome-less mode when launched from the
  // Home Screen — which is also what exempts our IndexedDB from eviction.
  appleWebApp: {
    capable: true,
    title: "Keel",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false, date: false, address: false, email: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // This is a private tool, not a website.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // `cover` lets the layout extend under the notch and home indicator; the
  // design system pays that back with env(safe-area-inset-*) padding.
  viewportFit: "cover",
  // Pinch-zoom stays enabled — disabling it is an accessibility regression.
  // Accidental double-tap zoom is handled with `touch-action` in CSS instead.
  userScalable: true,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e13" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content={META_CONTENT_SECURITY_POLICY}
        />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Keel" />
        <meta
          property="og:description"
          content="Your health data stays on your phone."
        />
        <meta
          property="og:url"
          content="/"
          data-keel-origin-relative="true"
        />
        <meta
          property="og:image"
          content="/og.png"
          data-keel-origin-relative="true"
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Keel" />
        <meta
          name="twitter:description"
          content="Your health data stays on your phone."
        />
        <meta
          name="twitter:image"
          content="/og.png"
          data-keel-origin-relative="true"
        />
        {/* Applies the stored theme before first paint, so there is no flash. */}
        <ThemeScript />
      </head>
      <body className="min-h-full">
        {/* Every route renders inside the gate, so no screen can show vault
            data without passing through onboarding and unlock first. */}
        <VaultGate>{children}</VaultGate>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
