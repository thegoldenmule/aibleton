import { Hono } from "hono";
import type { RecipeListResponse } from "@aibleton/protocol";
import type { RecipeBook } from "../../core/recipes.ts";

export interface RecipeRouteDeps {
  recipes: RecipeBook;
}

/** Read-only: recipes are written on demand by the band generator and the song flow. */
export function recipeRoutes(deps: RecipeRouteDeps): Hono {
  const r = new Hono();

  r.get("/recipes", async (c) => {
    const body: RecipeListResponse = { recipes: await deps.recipes.list() };
    return c.json(body);
  });

  return r;
}
