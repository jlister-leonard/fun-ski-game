"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ListRow } from "@/components/ui/ListRow";

/**
 * A list row that navigates.
 *
 * ## Why not `<ListRow onPress={() => router.push(href)} />`
 *
 * Because a full page load boots the app from scratch. The vault session lives
 * in memory and is deliberately non-persistable, so a reload re-locks it —
 * every tap into a settings screen would drop the user onto the lock screen.
 *
 * `next/link` navigates in-place, which keeps the session alive. So navigation
 * here is always an anchor.
 */
export function LinkRow({
  href,
  title,
  subtitle,
  value,
  muted,
}: {
  href: string;
  title: ReactNode;
  subtitle?: ReactNode;
  value?: ReactNode;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      className="block tap transition-colors duration-[var(--duration-fast)] active:bg-surface-2"
    >
      <ListRow
        title={title}
        subtitle={subtitle}
        value={value}
        muted={muted}
        trailing={<Chevron />}
      />
    </Link>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-4 w-4 shrink-0 text-ink-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
