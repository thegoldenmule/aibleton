"use client";

import { useSyncExternalStore } from "react";

/** Coarse wall clock for relative timestamps; 0 on the server so SSR and hydration agree. */
export function useNow(intervalMs: number): number {
  return useSyncExternalStore(
    (onChange) => {
      const t = setInterval(onChange, intervalMs);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => 0,
  );
}
