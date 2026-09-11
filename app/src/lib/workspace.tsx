"use client";

import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  { href: "/recipes", page: "recipes" },
] as const;

/** The song is the fallback: it is the root, and an unknown route is not worth a lie. */
export function pageFor(pathname: string): string {
  return WORKSPACES.find((w) => w.href === pathname)?.page ?? "song";
}

/** Everything in the context except the page, which the route already knows. */
type Selection = Omit<RequestContext, "page">;

interface SelectionApi {
  selection: Selection;
  publish: (next: Selection) => void;
}

const SelectionContext = createContext<SelectionApi | null>(null);

/**
 * Holds what the workspace has selected, for the composer that sits beside it.
 *
 * It is here rather than in `useMate` because this is not mate's picture of
 * anything: it is where the drummer is looking, which only the page knows and
 * only the message they type next cares about.
 */
export function WorkspaceSelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<Selection>({});
  const publish = useCallback((next: Selection) => setSelection(next), []);
  const value = useMemo(() => ({ selection, publish }), [selection, publish]);
  return <SelectionContext value={value}>{children}</SelectionContext>;
}

/**
 * A page says what it has selected. Cleared when the page unmounts, so a
 * selection never outlives the view it belongs to — navigate away from recipes
 * and the chip goes with you.
 *
 * The effect keys on the serialised selection rather than the object, which is
 * a fresh literal on every render: that keeps this hook general, so the band or
 * template or open slot that joins `recipe` later needs no change here.
 */
export function usePublishSelection(selection: Selection): void {
  const api = use(SelectionContext);
  const publish = api?.publish;
  const key = JSON.stringify(selection);
  useEffect(() => {
    if (!publish) return;
    publish(JSON.parse(key) as Selection);
    return () => publish({});
  }, [publish, key]);
}

/**
 * What the bandmate is told about where the drummer was standing when they
 * typed — sent with every message, and shown as chips above the box so it is
 * never a secret.
 *
 * The page comes from the route; everything else comes from the page itself
 * through `usePublishSelection`. **This is the one place the rest of it
 * grows**: which slot is open, what the arrangement is scrolled to. Everything
 * added here shows up as a chip on its own, and as a line in the brain's
 * prompt, because both ends render whatever fields this returns.
 */
export function useRequestContext(): RequestContext {
  const api = use(SelectionContext);
  const page = pageFor(usePathname());
  const selection = api?.selection;
  return useMemo(() => ({ page, ...selection }), [page, selection]);
}
