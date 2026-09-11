import { join } from "node:path";
import type {
  BandEvent,
  BandRecipe,
  JournaledBandEvent,
  JournaledRecipeEvent,
  JournaledTemplateEvent,
  RecipeEvent,
  TemplateEvent,
} from "@aibleton/protocol";
import { bandLibraryOptions, createBandLibrary, type BandLibrary } from "../../src/core/bands.ts";
import { EventBus } from "../../src/core/events.ts";
import { LibraryStore, type OpenLibrary } from "../../src/core/library.ts";
import { RecipeBook, createRecipeLibrary, recipeLibraryOptions, type RecipeLibrary } from "../../src/core/recipes.ts";
import { ScriptedRecipeWriter } from "../../src/songwriting/recipe-writer/scripted.ts";
import type { RecipeWriter } from "../../src/songwriting/recipe-writer/types.ts";
import { templateLibraryOptions, createTemplateLibrary, type TemplateLibrary } from "../../src/core/templates.ts";
import { silentLogger, type Logger } from "../../src/log.ts";
import type { Band, Template } from "@aibleton/protocol";

export interface LibraryHarnessOptions {
  /** Shared with other libraries in the same harness when a test wants one bus; a fresh one by default. */
  events?: EventBus<BandEvent>;
  now?: () => number;
  log?: Logger;
  /** Where the log goes. Defaults to `<dir>/../library/bands.jsonl`, i.e. outside the record directory. */
  path?: string;
}

export interface TemplateLibraryHarnessOptions extends Omit<LibraryHarnessOptions, "events"> {
  events?: EventBus<TemplateEvent>;
}

export interface RecipeLibraryHarnessOptions extends Omit<LibraryHarnessOptions, "events"> {
  events?: EventBus<RecipeEvent>;
}

/**
 * A band library over `dir`, built **synchronously** so a synchronous harness
 * (`songServiceHarness`) can hold one. The open runs in the background and
 * every read parks behind it; `lib.opened` is what it found.
 */
export function bandLibrary(dir: string, opts: LibraryHarnessOptions = {}): BandLibrary {
  return new LibraryStore(bandLibraryOptions(bandArgs(dir, opts)));
}

/** The same library, awaited, with the counts the boot reported. */
export function openBandLibrary(dir: string, opts: LibraryHarnessOptions = {}): Promise<OpenLibrary<Band, BandEvent, JournaledBandEvent>> {
  return createBandLibrary(bandArgs(dir, opts));
}

/** The template mirror, synchronous for the same reason. */
export function templateLibrary(dir: string, opts: TemplateLibraryHarnessOptions = {}): TemplateLibrary {
  return new LibraryStore(templateLibraryOptions(templateArgs(dir, opts)));
}

/** The template mirror, awaited. */
export function openTemplateLibrary(
  dir: string,
  opts: TemplateLibraryHarnessOptions = {},
): Promise<OpenLibrary<Template, TemplateEvent, JournaledTemplateEvent>> {
  return createTemplateLibrary(templateArgs(dir, opts));
}

/** The recipe mirror, synchronous for the same reason. */
export function recipeLibrary(dir: string, opts: RecipeLibraryHarnessOptions = {}): RecipeLibrary {
  return new LibraryStore(recipeLibraryOptions(recipeArgs(dir, opts)));
}

/** The recipe mirror, awaited. */
export function openRecipeLibrary(
  dir: string,
  opts: RecipeLibraryHarnessOptions = {},
): Promise<OpenLibrary<BandRecipe, RecipeEvent, JournaledRecipeEvent>> {
  return createRecipeLibrary(recipeArgs(dir, opts));
}

export interface RecipeBookHarnessOptions extends RecipeLibraryHarnessOptions {
  /** Defaults to a fresh `ScriptedRecipeWriter`, so a book is offline unless a test says otherwise. */
  writer?: RecipeWriter;
  /** Pass an empty map to test a mate that ships no recipes. */
  builtins?: ReadonlyMap<string, BandRecipe>;
}

/**
 * A recipe book over its own library in `<dir>/recipes`. The book is what
 * everything downstream of the generator takes, so this is the shape almost
 * every test wants rather than the bare library.
 */
export function recipeBook(dir: string, opts: RecipeBookHarnessOptions = {}): RecipeBook {
  const library = recipeLibrary(join(dir, "recipes"), opts);
  return new RecipeBook({
    library,
    writer: opts.writer ?? new ScriptedRecipeWriter(),
    now: opts.now ?? (() => 1_000),
    ...(opts.builtins ? { builtins: opts.builtins } : {}),
  });
}

/** Where a library's log lives when a test does not say: beside the record directory, never inside it. */
export function logPathFor(dir: string, name: string): string {
  return join(dir, "..", "library", `${name}.jsonl`);
}

function bandArgs(dir: string, opts: LibraryHarnessOptions) {
  return {
    dir,
    path: opts.path ?? logPathFor(dir, "bands"),
    events: opts.events ?? new EventBus<BandEvent>(),
    now: opts.now ?? (() => 1_000),
    log: opts.log ?? silentLogger,
  };
}

function recipeArgs(dir: string, opts: RecipeLibraryHarnessOptions) {
  return {
    dir,
    path: opts.path ?? logPathFor(dir, "recipes"),
    events: opts.events ?? new EventBus<RecipeEvent>(),
    now: opts.now ?? (() => 1_000),
    log: opts.log ?? silentLogger,
  };
}

function templateArgs(dir: string, opts: TemplateLibraryHarnessOptions) {
  return {
    dir,
    path: opts.path ?? logPathFor(dir, "templates"),
    events: opts.events ?? new EventBus<TemplateEvent>(),
    now: opts.now ?? (() => 1_000),
    log: opts.log ?? silentLogger,
  };
}
