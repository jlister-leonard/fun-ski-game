"use client";

import { useRouter } from "next/navigation";

/**
 * The back-and-title header every settings sub-screen wears.
 *
 * A real `<button>` rather than a link so it uses the router's history. The
 * visible label says "Back" because a screen can also be reached directly from
 * Today; claiming the destination is always Settings would be misleading.
 */
export function SettingsHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  const router = useRouter();

  return (
    <header className="pt-2 pb-5">
      <button
        type="button"
        onClick={() => router.back()}
        className="-ml-1 mb-2 inline-flex items-center gap-1 text-sm text-accent tap active:opacity-60"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        Back
      </button>
      <h1 className="text-2xl font-semibold text-ink tracking-[-0.02em]">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1 text-sm text-ink-2 leading-relaxed">{subtitle}</p>
      )}
    </header>
  );
}
