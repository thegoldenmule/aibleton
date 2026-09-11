import { BandRecipeSchema, genreKey, type BandRecipe, type RecipeSummary } from "@aibleton/protocol";
import type { RecipeWriter } from "../songwriting/recipe-writer/types.ts";
import { BUILTIN_RECIPES, type RecipeLookup } from "./band-generator.ts";
import { DocumentStore } from "./document-store.ts";
import { isValidDocumentId } from "./ids.ts";

/** True when `id` is safe to use as a recipe filename. */
export function isValidRecipeId(id: string): boolean {
  return isValidDocumentId(id);
}

export interface RecipeStoreOptions {
  /** Directory holding one `<genreKey>.json` per generated recipe. Created lazily. */
  dir: string;
}

/** File-backed storage for recipes the model wrote. Built-ins never land here. */
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

export interface RecipeBookOptions {
  store: RecipeStore;
  writer: RecipeWriter;
  now: () => number;
  builtins?: ReadonlyMap<string, BandRecipe>;
}

/**
 * Every recipe mate can staff a band from: the built-ins, then whatever the
 * model has written and the store kept. `ensure` fills a gap by asking the
 * writer once, even under concurrent requests for the same genre.
 */
export class RecipeBook implements RecipeLookup {
  private readonly builtins: ReadonlyMap<string, BandRecipe>;
  private readonly cache = new Map<string, BandRecipe>();
  private readonly inFlight = new Map<string, Promise<BandRecipe>>();

  constructor(private readonly opts: RecipeBookOptions) {
    this.builtins = opts.builtins ?? BUILTIN_RECIPES;
  }

  /** Synchronous lookup: built-ins and recipes already loaded from the store. */
  get(genre: string): BandRecipe | undefined {
    const key = genreKey(genre);
    return this.builtins.get(key) ?? this.cache.get(key);
  }

  /** Loads everything the store holds so `get` sees it. Called at startup and before a lookup. */
  async load(): Promise<void> {
    for (const recipe of await this.opts.store.list()) this.cache.set(recipe.id, recipe);
  }

  /** The recipe for a genre, from the built-ins, the store, or the writer (saved on the way through). */
  async ensure(genre: string, signal: AbortSignal): Promise<BandRecipe> {
    const key = genreKey(genre);
    if (!key) throw new Error(`genre ${JSON.stringify(genre)} has no letters or digits to key on`);
    const known = this.get(key);
    if (known) return known;
    const stored = await this.opts.store.get(key);
    if (stored) {
      this.cache.set(key, stored);
      return stored;
    }
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.write(genre.trim(), key, signal).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async write(genre: string, key: string, signal: AbortSignal): Promise<BandRecipe> {
    const draft = await this.opts.writer.write({ genre }, signal);
    const recipe = BandRecipeSchema.parse({ ...draft, id: key, genre, source: "generated", createdAt: this.opts.now() });
    await this.opts.store.save(recipe);
    this.cache.set(key, recipe);
    return recipe;
  }

  /** Built-ins first in their order, then generated recipes newest first. */
  async list(): Promise<RecipeSummary[]> {
    await this.load();
    const generated = [...this.cache.values()].sort((a, b) => b.createdAt - a.createdAt);
    return [...this.builtins.values(), ...generated].map((r) => ({
      id: r.id,
      genre: r.genre,
      source: r.source,
      roles: [...new Set([...r.core, ...r.optional.map((o) => o.role)])],
    }));
  }
}
