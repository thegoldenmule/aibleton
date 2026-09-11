"use client";

import { useCallback, useEffect, useState } from "react";
import type { Band, GenerateBandRequest, RecipeSummary } from "@aibleton/protocol";
import { deleteBand, generateBand, listBands, listRecipes, saveBand } from "./bands";
import { errorMessage } from "./errors";
import { useMate } from "./useMate";

export interface BandsView {
  bands: Band[];
  /** Genres the generator can staff; grows when a new genre is generated. */
  recipes: RecipeSummary[];
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

/**
 * Holds the saved-band list plus the generate/save/delete actions.
 *
 * The list itself is not this hook's state: bands are an event-sourced aggregate riding the one
 * `/events` stream, so `useMate()` holds the fold and every open tab sees a save the moment it
 * happens. What is left here is the mutators, each of which patches its own result in through the
 * same reducer for the case where the stream is down.
 */
export function useBands(): BandsView {
  const { bands, patchBands, replaceBands } = useMate();
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
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

  // Recipes are not an aggregate yet — no events, so still a plain fetch. They only feed a
  // datalist, so a failure is not worth an error line.
  useEffect(() => {
    listRecipes().then(setRecipes, () => {
      /* the list is a convenience; a failed load is not an error */
    });
  }, []);

  const generate = useCallback(async (opts: GenerateBandRequest) => {
    setBusy(true);
    try {
      const band = await generateBand(opts);
      setLastError(null);
      // Nothing to fold: generating does not save, so the library is untouched until the
      // drummer posts this band back.
      // A new genre means a new recipe; refresh the datalist so it shows up.
      if (opts.genre) {
        listRecipes().then(setRecipes, () => {
          /* the list is a convenience; a failed refresh is not an error */
        });
      }
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

  return { bands: bands ?? NO_BANDS, recipes, loading: bands === null, busy, lastError, refresh, generate, save, remove };
}
