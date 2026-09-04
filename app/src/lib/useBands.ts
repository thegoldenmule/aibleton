"use client";

import { useCallback, useEffect, useState } from "react";
import type { Band, GenerateBandRequest } from "@aibleton/protocol";
import { deleteBand, generateBand, listBands, saveBand } from "./bands";

export interface BandsView {
  bands: Band[];
  /** True until the first list load settles. */
  loading: boolean;
  /** True while a generate/save/delete request is in flight. */
  busy: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  generate: (opts: GenerateBandRequest) => Promise<Band>;
  save: (band: Band) => Promise<Band>;
  remove: (id: string) => Promise<boolean>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Holds the saved-band list plus the generate/save/delete actions.
 * There are no SSE events for bands, so this is plain fetch + local state:
 * the list is refetched after every save and delete.
 */
export function useBands(): BandsView {
  const [bands, setBands] = useState<Band[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Every setState lands after the first await, so the initial load can be kicked
  // off from an effect without a synchronous cascading render.
  const refresh = useCallback(async () => {
    try {
      const next = await listBands();
      setBands(next);
      setLastError(null);
    } catch (err) {
      setLastError(message(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load. Mirrors useTemplates: the async work lives in the effect and
  // stops touching state once the hook is torn down.
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const next = await listBands();
        if (disposed) return;
        setBands(next);
        setLastError(null);
      } catch (err) {
        if (!disposed) setLastError(message(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  const generate = useCallback(async (opts: GenerateBandRequest) => {
    setBusy(true);
    try {
      const band = await generateBand(opts);
      setLastError(null);
      return band;
    } catch (err) {
      setLastError(message(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(
    async (band: Band) => {
      setBusy(true);
      try {
        const saved = await saveBand(band);
        setLastError(null);
        await refresh();
        return saved;
      } catch (err) {
        setLastError(message(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const deleted = await deleteBand(id);
        setLastError(null);
        await refresh();
        return deleted;
      } catch (err) {
        setLastError(message(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { bands, loading, busy, lastError, refresh, generate, save, remove };
}
