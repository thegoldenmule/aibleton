"use client";

import { useCallback, useState } from "react";
import type { BandRecipe } from "@aibleton/protocol";
import { deleteRecipe, listRecipes } from "./recipes";
import { errorMessage } from "./errors";
import { useMate } from "./useMate";

export interface RecipesView {
  recipes: BandRecipe[];
  /** True until the opening snapshot lands. */
  loading: boolean;
  /** True while a delete is in flight. */
  busy: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<boolean>;
}

/** One empty list, so a library that has not arrived yet does not re-render the page every time. */
const NO_RECIPES: BandRecipe[] = [];

/**
 * Holds the recipe list plus the one thing that can be done to it.
 *
 * The list is not this hook's state: recipes are an event-sourced aggregate riding the one
 * `/events` stream, so `useMate()` holds the fold. That matters more here than for the other two
 * libraries, because nothing on this page writes a recipe — they appear when a band is staffed
 * for a genre mate has none for, wherever that was asked from.
 *
 * There is no `generate` or `save`: mate ships no recipes and nothing hand-authors one.
 */
export function useRecipes(): RecipesView {
  const { recipes, patchRecipes, replaceRecipes } = useMate();
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  /** Manual re-fetch. Nothing calls it on a schedule — the stream is the loader. */
  const refresh = useCallback(async () => {
    try {
      replaceRecipes(await listRecipes());
      setLastError(null);
    } catch (err) {
      setLastError(errorMessage(err));
    }
  }, [replaceRecipes]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const deleted = await deleteRecipe(id);
        setLastError(null);
        // Only a real delete is an event; mate appends nothing for an id it never held.
        if (deleted) patchRecipes({ type: "recipe.deleted", id });
        return deleted;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [patchRecipes],
  );

  return { recipes: recipes ?? NO_RECIPES, loading: recipes === null, busy, lastError, refresh, remove };
}
