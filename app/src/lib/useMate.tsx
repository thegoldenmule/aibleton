"use client";

import { createContext, use } from "react";
import type { ReactNode } from "react";
import { useMateState } from "./useMateState";
import type { MateView } from "./useMateState";

const MateContext = createContext<MateView | null>(null);

/**
 * The one subscription to mate for the whole app.
 *
 * `useMateState` opens an EventSource, so it must be instantiated exactly once;
 * the shell mounts this above the router's children, and an app-router layout is
 * not re-rendered on navigation, so the stream survives every trip between the
 * song and a library.
 *
 * The threading rule: **context is read at the column container, everything below
 * it takes props.** `AppShell` reads it for the header and the two bandmate
 * panes; the song page reads it for `SongView`. Leaf components stay prop-driven
 * so they can still be reasoned about — and tested — on their own.
 */
export function MateProvider({ children }: { children: ReactNode }) {
  return <MateContext value={useMateState()}>{children}</MateContext>;
}

export function useMate(): MateView {
  const view = use(MateContext);
  if (!view) throw new Error("useMate called outside MateProvider");
  return view;
}
