import {
  BandRecipeSchema,
  JournaledRecipeEventSchema,
  applyRecipeEvent,
  fromJournaledRecipe,
  genreKey,
  recipeRoles,
  toJournaledRecipe,
  type BandRecipe,
  type JournaledRecipeEvent,
  type RecipeEvent,
  type RecipeSummary,
  type RecipeLookup,
} from "@aibleton/protocol";
import type { Logger } from "../log.ts";
import type { RecipeWriter } from "../songwriting/recipe-writer/types.ts";
import { DocumentStore } from "./document-store.ts";
import type { EventBus } from "./events.ts";
import { isValidDocumentId } from "./ids.ts";
import { LibraryStore, openLibrary, type LibraryOptions, type OpenLibrary } from "./library.ts";

/** True when `id` is safe to use as a recipe filename. */
export function isValidRecipeId(id: string): boolean {
  return isValidDocumentId(id);
}

export interface RecipeStoreOptions {
  /** Directory holding one `<genreKey>.json` per recipe. Created lazily. */
  dir: string;
}

/**
 * File-backed recipe storage: one JSON file per recipe — **the projection**,
 * not the truth. `recipes.jsonl` is the truth, and `openLibrary` rebuilds every
 * missing record file from it at each open.
 */
export class RecipeStore extends DocumentStore<BandRecipe> {
  constructor(opts: RecipeStoreOptions) {
    super({
      dir: opts.dir,
      schema: BandRecipeSchema,
      idOf: (recipe) => recipe.id,
      kind: "recipe",
      sortKey: (recipe) => recipe.createdAt,
    });
  }
}

/** The recipe library: the fold of `recipes.jsonl`, with the record files behind it. */
export type RecipeLibrary = LibraryStore<BandRecipe, RecipeEvent, JournaledRecipeEvent>;

export interface RecipeLibraryOptions {
  /** Directory holding one `<genreKey>.json` per recipe: the projection. */
  dir: string;
  /** The recipe log, `<config.libraryDir>/recipes.jsonl`. Deliberately outside `dir`. */
  path: string;
  events: EventBus<RecipeEvent>;
  /** The only clock the library has; it never reads the system one. */
  now: () => number;
  log?: Logger;
}

/** Everything `LibraryStore` needs to be a recipe library, in one place. */
export function recipeLibraryOptions(opts: RecipeLibraryOptions): LibraryOptions<BandRecipe, RecipeEvent, JournaledRecipeEvent> {
  return {
    events: opts.events,
    docs: new RecipeStore({ dir: opts.dir }),
    path: opts.path,
    fold: applyRecipeEvent,
    saved: (recipe) => ({ type: "recipe.saved", recipe }),
    deleted: (id) => ({ type: "recipe.deleted", id }),
    toJournaled: toJournaledRecipe,
    fromJournaled: fromJournaledRecipe,
    eventSchema: JournaledRecipeEventSchema,
    mentions: (event) => (event.type === "recipe.saved" ? event.recipe.id : event.id),
    idOf: (recipe) => recipe.id,
    createdAt: (recipe) => recipe.createdAt,
    schema: BandRecipeSchema,
    kind: "recipe",
    now: opts.now,
    ...(opts.log ? { log: opts.log } : {}),
  };
}

/** Open the recipe library: replay `recipes.jsonl`, then reconcile `dir` against it. */
export function createRecipeLibrary(opts: RecipeLibraryOptions): Promise<OpenLibrary<BandRecipe, RecipeEvent, JournaledRecipeEvent>> {
  return openLibrary(recipeLibraryOptions(opts));
}

export interface RecipeBookOptions {
  library: RecipeLibrary;
  writer: RecipeWriter;
  now: () => number;
}

/**
 * Every recipe mate can staff a band from, and the one place a missing one is
 * written. Mate ships none: the library starts empty and every genre is
 * written by the model the first time a band is staffed for it. The library is
 * the storage; this is the read-through in front of it, and `ensure` fills a
 * gap by asking the writer once, even under concurrent requests for the same
 * genre, then saves what it gets.
 *
 * There is no cache here. The library's fold *is* the cache — it is in memory
 * from the moment the log is replayed, so `get` and `genres` stay synchronous.
 * Both are only meaningful once that open has finished, which is why
 * `index.ts` awaits `createRecipeLibrary` before building the book.
 */
export class RecipeBook implements RecipeLookup {
  private readonly inFlight = new Map<string, Promise<BandRecipe>>();

  constructor(private readonly opts: RecipeBookOptions) {}

  /**
   * The library underneath. The routes that read or remove a whole recipe go
   * straight to it, the way the band routes take a `BandLibrary`; the book is
   * only in the way when a missing recipe has to be written.
   */
  get library(): RecipeLibrary {
    return this.opts.library;
  }

  /** Synchronous lookup, off the library's fold. */
  get(genre: string): BandRecipe | undefined {
    const key = genreKey(genre);
    return this.opts.library.all().find((recipe) => recipe.id === key);
  }

  /**
   * Every genre a band can be staffed from right now, sorted so the same
   * library always answers the same way. This is what an omitted genre is
   * drawn from, so its order has to be stable for a given library state.
   */
  genres(): readonly string[] {
    return this.opts.library
      .all()
      .map((recipe) => recipe.id)
      .sort();
  }

  /** The recipe for a genre, from what is held or from the writer (saved on the way through). */
  async ensure(genre: string, signal: AbortSignal): Promise<BandRecipe> {
    const key = genreKey(genre);
    if (!key) throw new Error(`genre ${JSON.stringify(genre)} has no letters or digits to key on`);
    const known = this.get(key);
    if (known) return known;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.write(genre.trim(), key, signal).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async write(genre: string, key: string, signal: AbortSignal): Promise<BandRecipe> {
    const draft = await this.opts.writer.write({ genre }, signal);
    const recipe = BandRecipeSchema.parse({ ...draft, id: key, genre, createdAt: this.opts.now() });
    // The library append is awaited and rejects on failure: a recipe the log
    // did not take is one the next boot would not have, so it is not one the
    // caller may staff a band from.
    return this.opts.library.save(recipe);
  }

  /** Every recipe as a summary, newest first. */
  async list(): Promise<RecipeSummary[]> {
    const written = await this.opts.library.list();
    return written.map((r) => ({ id: r.id, genre: r.genre, roles: recipeRoles(r) }));
  }
}
