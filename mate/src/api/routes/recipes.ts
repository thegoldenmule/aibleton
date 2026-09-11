import { Hono } from "hono";
import type { DeleteRecipeResponse, RecipeListResponse, RecipeResponse } from "@aibleton/protocol";
import { isValidRecipeId, type RecipeBook } from "../../core/recipes.ts";

export interface RecipeRouteDeps {
  recipes: RecipeBook;
}

/**
 * Reading is free; the only write is a removal.
 *
 * There is no `POST`: mate ships no recipes and nothing hand-authors one — a
 * recipe appears because the model wrote it on the way to staffing a band, and
 * the only gesture the drummer has over it is to throw it away so the next
 * band for that genre gets a fresh one. That is a model call they are spending,
 * so it sits behind the app's two-click confirm and is not a brain tool.
 */
export function recipeRoutes(deps: RecipeRouteDeps): Hono {
  const r = new Hono();

  r.get("/recipes", async (c) => {
    const body: RecipeListResponse = { recipes: await deps.recipes.library.list() };
    return c.json(body);
  });

  r.get("/recipes/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidRecipeId(id)) return c.json({ error: `invalid recipe id ${JSON.stringify(id)}` }, 400);
    const recipe = await deps.recipes.library.get(id);
    if (!recipe) return c.json({ error: `no recipe ${id}` }, 404);
    const body: RecipeResponse = { recipe };
    return c.json(body);
  });

  r.delete("/recipes/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidRecipeId(id)) return c.json({ error: `invalid recipe id ${JSON.stringify(id)}` }, 400);
    const body: DeleteRecipeResponse = { deleted: await deps.recipes.library.delete(id) };
    return c.json(body);
  });

  return r;
}
