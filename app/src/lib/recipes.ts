import {
  DeleteRecipeResponseSchema,
  RecipeListResponseSchema,
  RecipeResponseSchema,
  type BandRecipe,
} from "@aibleton/protocol";
import { request } from "./mate";

/**
 * How each genre staffs a band. Mate ships none: every one of these was written
 * by the model the first time a band was staffed for that genre.
 *
 * Reads only, plus a delete. Nothing here creates a recipe — that happens on
 * the way to a band — which is why there is no `saveRecipe` beside these.
 */

/** Every recipe mate holds, newest first. */
export async function listRecipes(): Promise<BandRecipe[]> {
  const { recipes } = await request("/recipes", RecipeListResponseSchema);
  return recipes;
}

/** One recipe by its genre key. */
export async function getRecipe(id: string): Promise<BandRecipe> {
  const { recipe } = await request(`/recipes/${encodeURIComponent(id)}`, RecipeResponseSchema);
  return recipe;
}

/**
 * Forgets a recipe. True when one was there to forget. The next band asked for
 * that genre has a new one written, which costs a model call — so the caller
 * confirms first.
 */
export async function deleteRecipe(id: string): Promise<boolean> {
  const { deleted } = await request(`/recipes/${encodeURIComponent(id)}`, DeleteRecipeResponseSchema, {
    method: "DELETE",
  });
  return deleted;
}
