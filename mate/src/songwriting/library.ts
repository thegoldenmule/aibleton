import {
  BandSchema,
  TemplateSchema,
  formLabels,
  parseForm,
  type Band,
  type GenerateBandRequest,
  type GenerateTemplateRequest,
  type Template,
} from "@aibleton/protocol";
import type { ZodIssue } from "zod";
import { ModelRefusedError } from "../core/anthropic.ts";
import { generateBand } from "../core/band-generator.ts";
import { newId } from "../core/commands.ts";
import { bandName, templateName } from "../core/naming.ts";
import { defaultSections, generateForm } from "../core/generator.ts";
import type { RecipeBook } from "../core/recipes.ts";

/**
 * Staffing a band and laying out a form, once each. The generators beside them
 * (`core/band-generator.ts`, `core/generator.ts`) decide what the roster and
 * the form look like; this is the only place that sequence is run — ensure a
 * recipe, roll, mint an id, name it, record the seed, validate it.
 *
 * Two functions rather than a class: unlike a song, a band and a template have
 * no activity, no narration and no single-flight queue, so there is nothing for
 * an instance to hold.
 *
 * **They hand the record back unsaved.** Durability is the caller's: the routes
 * return a draft the app edits and POSTs back, `composeSong` persists a whole
 * genre's worth in one `saveAll`, and `SongService` saves the one it seeds an
 * empty library with. One staffing, three durabilities.
 *
 * The errors are typed so the routes can keep their status codes without this
 * module knowing what HTTP is.
 */

/**
 * The genre an empty library falls back to. Mate ships no recipes, so the very
 * first band — `POST /bands/generate {}` on a fresh install, or the one
 * `SongService` seeds an empty library with — has nothing for the seed to draw
 * from. Rather than refuse, one genre's recipe is written and the seed draws
 * from a library of one. It is a genre *name*, not a recipe: the model still
 * decides who plays in it.
 */
export const DEFAULT_GENRE = "funk";

/** A recipe could not be written for the genre. The route logs and maps it to a 502. */
export class RecipeUnavailableError extends Error {
  constructor(
    readonly genre: string,
    /** The underlying failure, for the log line; `message` is what the caller is told. */
    readonly reason: string,
  ) {
    super(`could not write a recipe for ${JSON.stringify(genre)}: ${reason}`);
    this.name = "RecipeUnavailableError";
  }
}

/** The generator rejected the options it was handed. The route maps it to a 400. */
export class GenerateOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateOptionsError";
  }
}

/**
 * The generator produced something the schema refuses — a bug here, not bad
 * input, which is why the route maps it to a 500 rather than a 400.
 */
export class GeneratedInvalidError extends Error {
  constructor(
    readonly kind: "band" | "template",
    readonly issues: ZodIssue[],
  ) {
    super(`generator produced an invalid ${kind}`);
    this.name = "GeneratedInvalidError";
  }
}

export interface StaffBandDeps {
  /** Consulted for the genre's recipe, and asked to write one when it has none. */
  recipes: RecipeBook;
  /** The only clock; `createdAt` and the default seed both come from it. */
  now: () => number;
  /** Abandons the recipe write, which is the slow half. */
  signal: AbortSignal;
}

export interface LayTemplateDeps {
  /** The only clock; `createdAt` and the default seed both come from it. */
  now: () => number;
}

/**
 * Staff a band from a genre's recipe. Slow when the genre is new: the model
 * writes the recipe first, once, however many bands are rolled from it after.
 * An omitted genre is drawn from the recipes already held, so it is free —
 * except on a fresh install, where the library is empty and `DEFAULT_GENRE` is
 * written to give the draw something to land on.
 * @throws ModelRefusedError, RecipeUnavailableError, GenerateOptionsError, GeneratedInvalidError
 */
export async function staffBand(opts: GenerateBandRequest, deps: StaffBandDeps): Promise<Band> {
  const at = deps.now();
  const seed = opts.seed ?? at;

  // A named genre is ensured; an omitted one is drawn from what the library
  // already holds, and only needs writing when the library is empty.
  const needed = opts.genre ?? (deps.recipes.genres().length === 0 ? DEFAULT_GENRE : undefined);
  if (needed !== undefined) {
    try {
      await deps.recipes.ensure(needed, deps.signal);
    } catch (err) {
      // A refusal is the model's answer, not a failure of ours: it travels as itself.
      if (err instanceof ModelRefusedError) throw err;
      throw new RecipeUnavailableError(needed, messageOf(err));
    }
  }

  let staffed: ReturnType<typeof generateBand>;
  try {
    staffed = generateBand(
      {
        seed,
        ...(opts.genre !== undefined ? { genre: opts.genre } : {}),
        ...(opts.size !== undefined ? { size: opts.size } : {}),
      },
      deps.recipes,
    );
  } catch (err) {
    throw new GenerateOptionsError(messageOf(err));
  }

  const draft: Band = {
    id: newId("band"),
    name: opts.name ?? bandName(seed),
    parts: staffed.parts,
    metadata: staffed.metadata,
    seed,
    createdAt: at,
  };
  const checked = BandSchema.safeParse(draft);
  if (!checked.success) throw new GeneratedInvalidError("band", checked.error.issues);
  return checked.data;
}

/**
 * Lay out a form and give every letter in it a starting brief. Pure and
 * synchronous — no model is in the loop, so there is no recipe to wait on.
 * @throws GenerateOptionsError, GeneratedInvalidError
 */
export function layTemplate(opts: GenerateTemplateRequest, deps: LayTemplateDeps): Template {
  const at = deps.now();
  const seed = opts.seed ?? at;

  let form: string;
  try {
    form = generateForm({
      seed,
      ...(opts.alphabet !== undefined ? { alphabet: opts.alphabet } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.maxRun !== undefined ? { maxRun: opts.maxRun } : {}),
      ...(opts.bars !== undefined ? { bars: opts.bars } : {}),
    });
  } catch (err) {
    throw new GenerateOptionsError(messageOf(err));
  }

  const draft: Template = {
    id: newId("tpl"),
    name: opts.name ?? templateName(seed),
    form,
    sections: defaultSections(formLabels(parseForm(form))),
    ...(opts.bpm !== undefined ? { bpm: opts.bpm } : {}),
    seed,
    createdAt: at,
  };
  const checked = TemplateSchema.safeParse(draft);
  if (!checked.success) throw new GeneratedInvalidError("template", checked.error.issues);
  return checked.data;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
