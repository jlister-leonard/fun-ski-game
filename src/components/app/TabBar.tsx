"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface Tab {
  href: string;
  label: string;
  icon: ReactNode;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const TABS: Tab[] = [
  {
    href: "/",
    label: "Today",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M3 12l9-8 9 8" />
        <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
      </svg>
    ),
  },
  {
    href: "/nutrition/",
    label: "Food",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M6 3v8a3 3 0 0 0 6 0V3M9 11v10" />
        <path d="M18 3c-1.7 1.4-2.5 3.4-2.5 5.5S16.3 12 18 13v8" />
      </svg>
    ),
  },
  {
    href: "/train/",
    label: "Train",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M4 9v6M20 9v6M7 6v12M17 6v12M7 12h10" />
      </svg>
    ),
  },
  {
    href: "/body/",
    label: "Body",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M3 17l5-6 4 3 4-6 5 5" />
        <path d="M3 21h18" />
      </svg>
    ),
  },
  {
    href: "/recovery/",
    label: "Recovery",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M3 12h4l2-5 3 10 2.5-6 1.5 3h5" />
      </svg>
    ),
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href);
}

/**
 * Bottom tab bar.
 *
 * Sits above the home indicator via safe-area padding, and uses a translucent
 * blurred background so content scrolling underneath reads as depth rather
 * than clutter.
 */
export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 safe-b",
        "border-t border-line",
        "bg-[color-mix(in_srgb,var(--c-surface)_88%,transparent)]",
        "backdrop-blur-xl"
      )}
    >
      <ul className="flex items-stretch justify-around px-1 pt-1.5">
        {TABS.map((tab) => {
          const active = isActive(pathname, tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 py-1 tap",
                  "transition-colors duration-[var(--duration-fast)]",
                  active ? "text-accent" : "text-ink-3 active:text-ink-2"
                )}
              >
                <span className="h-6 w-6">{tab.icon}</span>
                <span className="text-2xs font-medium tracking-[0.01em]">
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Spacer so page content is never hidden behind the fixed tab bar. */
export function TabBarSpacer() {
  return <div aria-hidden className="h-[64px] safe-b" />;
}
