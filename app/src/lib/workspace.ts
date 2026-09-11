"use client";

import { usePathname } from "next/navigation";
import type { RequestContext } from "@aibleton/protocol";

/**
 * The workspaces the rail moves between, in rail order. One list, so the rail
 * and what the bandmate is told can never drift apart.
 */
export const WORKSPACES = [
  { href: "/", page: "song" },
  { href: "/templates", page: "templates" },
  { href: "/bands", page: "bands" },
] as const;

/** The song is the fallback: it is the root, and an unknown route is not worth a lie. */
export function pageFor(pathname: string): string {
  return WORKSPACES.find((w) => w.href === pathname)?.page ?? "song";
}

/**
 * What the bandmate is told about where the drummer was standing when they
 * typed — sent with every message, and shown as chips above the box so it is
 * never a secret.
 *
 * The view is all it carries today. **This is the one place the rest of it
 * grows**: what is selected, which slot is open, what the arrangement is
 * scrolled to. Everything added here shows up as a chip on its own, because
 * the composer renders whatever fields this returns.
 */
export function useRequestContext(): RequestContext {
  return { page: pageFor(usePathname()) };
}
