"use client";

import { useCallback, useState } from "react";
import type { Band, BandRecipe, GenerateBandRequest } from "@aibleton/protocol";
import { deleteBand, generateBand, listBands, saveBand } from "./bands";
import { errorMessage } from "./errors";
import { useMate } from "./useMate";

export interface BandsView {
  bands: Band[];
  /**
   * Genres that can be staffed right now. Off the stream, so it grows the
   * moment *anything* writes a recipe — this browser, another tab, or the
   * bandmate staffing a band on its own.
   */
  recipes: BandRecipe[];
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

/** One empty list, so a library that has not arrived yet does not re-render the page every time. */
const NO_BANDS: Band[] = [];
const NO_RECIPES: BandRecipe[] = [];

/**
 * Holds the saved-band list plus the generate/save/delete actions.
 *
 * Neither list is this hook's state: bands and recipes are both event-sourced aggregates riding
 * the one `/events` stream, so `useMate()` holds the folds and every open tab sees a write the
 * moment it happens. What is left here is the mutators, each of which patches its own result in
 * through the same reducer for the case where the stream is down.
 */
export function useBands(): BandsView {
  const { bands, recipes, patchBands, replaceBands } = useMate();
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  /** Manual re-fetch. Nothing calls it on a schedule — the stream is the loader. */
  const refresh = useCallback(async () => {
    try {
      replaceBands(await listBands());
      setLastError(null);
    } catch (err) {
      setLastError(errorMessage(err));
    }
  }, [replaceBands]);

  const generate = useCallback(async (opts: GenerateBandRequest) => {
    setBusy(true);
    try {
      const band = await generateBand(opts);
      setLastError(null);
      // Nothing to fold: generating does not save, so the band library is untouched until the
      // drummer posts this band back. A recipe written on the way *is* a write, and it arrives
      // on the stream by itself — there is nothing to refetch.
      return band;
    } catch (err) {
      setLastError(errorMessage(err));
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
        // From the response, not the argument: that copy is the one mate normalised.
        // The SSE event normally lands first, this covers a dropped stream.
        patchBands({ type: "band.saved", band: saved });
        return saved;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [patchBands],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const deleted = await deleteBand(id);
        setLastError(null);
        // Only a real delete is an event; mate appends nothing for an id it never held.
        if (deleted) patchBands({ type: "band.deleted", id });
        return deleted;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [patchBands],
  );

  return { bands: bands ?? NO_BANDS, recipes: recipes ?? NO_RECIPES, loading: bands === null, busy, lastError, refresh, generate, save, remove };
}
