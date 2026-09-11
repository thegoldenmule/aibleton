"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { WORKSPACES } from "../lib/workspace";

/**
 * Where you are in the workspace. The rail sits outside the column it changes,
 * so the header and the bandmate never move when you use it.
 *
 * The song is first because it is where you work; the libraries are places you
 * go to fetch something and come back. The session is not here — it is global
 * state, and it lives in the header.
 *
 * Layouts do not re-render on navigation, but the client components inside them
 * do, so `usePathname` stays current even though the shell above it never
 * remounts.
 */
export function NavRail() {
  const pathname = usePathname();
  return (
    <nav aria-label="workspace" className="flex shrink-0 flex-col gap-1.5">
      {WORKSPACES.map((w) => (
        <RailLink key={w.href} href={w.href} label={w.page} icon={ICONS[w.href]} here={pathname === w.href} />
      ))}
    </nav>
  );
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const ITEM_CLASS: Record<"here" | "there", string> = {
  here: "border-accent/60 bg-accent/15 text-accent",
  there: "border-transparent text-muted hover:border-line hover:text-foreground",
};

function RailLink({ href, label, icon, here }: { href: string; label: string; icon: ReactNode; here: boolean }) {
  return (
    <Link
      href={href}
      title={label}
      aria-current={here ? "page" : undefined}
      className={`flex h-12 w-12 items-center justify-center rounded-md border transition-colors ${ITEM_CLASS[here ? "here" : "there"]}`}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </Link>
  );
}

const STROKE = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const ICONS: Record<string, ReactNode> = {
  "/": (
    <svg {...STROKE}>
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </svg>
  ),
  "/templates": (
    <svg {...STROKE}>
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="8" height="6" rx="1" />
      <rect x="15" y="14" width="6" height="6" rx="1" />
    </svg>
  ),
  "/bands": (
    <svg {...STROKE}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8" />
      <path d="M18 20a6 6 0 0 0-3-5.2" />
    </svg>
  ),
};
