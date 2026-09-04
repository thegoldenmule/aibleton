import type { Band, Song, Template } from "@aibleton/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeBook, RecipeStore } from "../../src/core/recipes.ts";
import { ScriptedBriefer } from "../../src/songwriting/briefer/scripted.ts";
import { ScriptedRecipeWriter } from "../../src/songwriting/recipe-writer/scripted.ts";
import { composeSong } from "../../src/songwriting/compose.ts";

/** A small funk library, enough for the pickers to have something to choose. */
export function fixtureTemplate(over: Partial<Template> = {}): Template {
  return {
    id: "tpl-1",
    name: "Tuesday jam",
    form: "a8 b8 a8 b8",
    sections: {
      a: { label: "a", brief: "main groove" },
      b: { label: "b", brief: "lift" },
    },
    bpm: 108,
    createdAt: 1,
    ...over,
  };
}

export function fixtureBand(over: Partial<Band> = {}): Band {
  return {
    id: "band-1",
    name: "The Pocket",
    parts: [
      { id: "drums-kit", role: "drums", name: "kit", brief: "dry breakbeat" },
      { id: "bass-p", role: "bass", name: "p bass", brief: "round fingerstyle bass" },
      { id: "guitar-strat", role: "guitar", name: "strat", brief: "clean ninth chords" },
    ],
    metadata: { genre: "funk" },
    createdAt: 1,
    ...over,
  };
}

/** A fully composed song via the scripted briefer, for store and state tests. */
export async function fixtureSong(over: Partial<Song> = {}): Promise<Song> {
  const song = await composeSong({
    text: "something funky and upbeat",
    seed: 7,
    templates: [fixtureTemplate()],
    bands: [fixtureBand()],
    briefer: new ScriptedBriefer(),
    recipes: new RecipeBook({ store: new RecipeStore({ dir: mkdtempSync(join(tmpdir(), "mate-fixture-recipes-")) }), writer: new ScriptedRecipeWriter(), now: () => 1_000 }),
    saveBand: async (band) => band,
    now: () => 1_000,
    signal: new AbortController().signal,
  });
  return { ...song, ...over };
}
