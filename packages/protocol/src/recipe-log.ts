import { z } from "zod";
import { BandRecipeSchema, type BandRecipe } from "./bands.ts";
import { eventTypesOf, logEntrySchema, removeById, upsertById, type DocumentKeys, type LogEntry } from "./log.ts";

/**
 * What can happen to the recipe library. Coarse for the same reason bands are:
 * a recipe is only ever written whole, by the model, so a `saved` event
 * carrying the document is the honest record of the write.
 *
 * Mate ships no recipes. The library starts empty and a genre's recipe is
 * written the first time a band is staffed for it, which is why `recipe.saved`
 * is usually the trailing edge of someone asking for music, not of an edit.
 */
export const RecipeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipe.saved"), recipe: BandRecipeSchema }),
  z.object({ type: z.literal("recipe.deleted"), id: z.string() }),
]);
export type RecipeEvent = z.infer<typeof RecipeEventSchema>;

/**
 * Every `RecipeEvent` type, derived from the union so it cannot fall behind it.
 * The app subscribes one SSE listener per name.
 */
export const RECIPE_EVENT_TYPES: readonly RecipeEvent["type"][] = eventTypesOf(RecipeEventSchema);

/**
 * Events that survive a restart. Both of them: the library *is* the log, and a
 * model-written recipe is not reproducible — rolling it again gives a
 * different one — so losing a line loses that recipe for good.
 */
export const DURABLE_RECIPE_EVENT_TYPES = ["recipe.saved", "recipe.deleted"] as const;

/** Events that describe *now* and are never written down. Empty, as for bands. */
export const VOLATILE_RECIPE_EVENT_TYPES = [] as const;

export type DurableRecipeEventType = (typeof DURABLE_RECIPE_EVENT_TYPES)[number];
export type VolatileRecipeEventType = (typeof VOLATILE_RECIPE_EVENT_TYPES)[number];

/**
 * Compile-time guard: a new `RecipeEvent` variant leaves `Unclassified`
 * non-empty, so this line stops typechecking until the variant is added to one
 * of the two lists above.
 */
type Unclassified = Exclude<RecipeEvent["type"], DurableRecipeEventType | VolatileRecipeEventType>;
const _exhaustive: Unclassified extends never ? true : never = true;
void _exhaustive;

/**
 * The on-disk form of a durable recipe event, identical to the live form
 * today. A recipe is a few KB of prose and has nothing worth paging out to
 * another store, so there is nothing to strip.
 *
 * The schema and the two functions below are the seam anyway: the day one arm
 * needs a different shape on disk, that is an edit in this file and nowhere
 * else.
 */
export const JournaledRecipeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipe.saved"), recipe: BandRecipeSchema }),
  z.object({ type: z.literal("recipe.deleted"), id: z.string() }),
]);
export type JournaledRecipeEvent = z.infer<typeof JournaledRecipeEventSchema>;

/** One line of `recipes.jsonl`. `seq` is dense per log and only ever grows. */
export const RecipeLogEntrySchema = logEntrySchema(JournaledRecipeEventSchema);
export type RecipeLogEntry = LogEntry<JournaledRecipeEvent>;

/** The durable projection of a recipe event. */
export function toJournaledRecipe(event: RecipeEvent): JournaledRecipeEvent {
  switch (event.type) {
    case "recipe.saved":
      return { type: "recipe.saved", recipe: event.recipe };
    case "recipe.deleted":
      return { type: "recipe.deleted", id: event.id };
    default: {
      const never: never = event;
      return never;
    }
  }
}

/** The event a recipe log line stands for. */
export function fromJournaledRecipe(event: JournaledRecipeEvent): RecipeEvent {
  switch (event.type) {
    case "recipe.saved":
      return { type: "recipe.saved", recipe: event.recipe };
    case "recipe.deleted":
      return { type: "recipe.deleted", id: event.id };
    default: {
      const never: never = event;
      return never;
    }
  }
}

/** Newest recipe first, with the genre key breaking a shared millisecond. */
const RECIPE_KEYS: DocumentKeys<BandRecipe> = { idOf: (recipe) => recipe.id, sortKey: (recipe) => recipe.createdAt };

/**
 * The one fold of `RecipeEvent` into the library. Mate's store folds it, a
 * replay of `recipes.jsonl` folds it and the app folds the SSE stream through
 * it — all three run this function, so the three pictures cannot drift.
 *
 * Like the band fold it returns the **same reference** when an event changes
 * nothing, which is what `LibraryStore.reconcile` reads as "this record file
 * agrees with the log" and what lets the app patch its own write in without it
 * landing twice.
 */
export function applyRecipeEvent(recipes: readonly BandRecipe[], event: RecipeEvent): readonly BandRecipe[] {
  switch (event.type) {
    case "recipe.saved":
      return upsertById(recipes, event.recipe, RECIPE_KEYS);
    case "recipe.deleted":
      return removeById(recipes, event.id, RECIPE_KEYS.idOf);
    default: {
      const never: never = event;
      void never;
      return recipes;
    }
  }
}

/**
 * The whole library in one frame: the payload of the SSE `recipes.snapshot`
 * that opens a stream, and — via `RecipeListResponseSchema` — the body of
 * `GET /recipes`. One schema, so the snapshot and the REST list cannot
 * disagree.
 */
export const RecipeLibrarySchema = z.object({ recipes: z.array(BandRecipeSchema) });
export type RecipeLibrary = z.infer<typeof RecipeLibrarySchema>;
