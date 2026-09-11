import type { Band, BriefLineup, Song, Template } from "@aibleton/protocol";
import { parseForm } from "@aibleton/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeBook, RecipeStore } from "../../src/core/recipes.ts";
import { ScriptedBriefer, defaultBrief } from "../../src/songwriting/briefer/scripted.ts";
import type { BriefInput } from "../../src/songwriting/briefer/types.ts";
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

/** Every part in every occurrence, for tests that want the full grid rather than the lineup rule. */
export function denseArrangement(input: BriefInput): BriefLineup[] {
  const parts = input.band.parts.map((p) => p.id);
  return parseForm(input.template.form).map((e) => ({ label: e.label, parts }));
}

/** A scripted briefer whose arrangement is dense, so a test's plan is the full grid. */
export function denseBriefer(): ScriptedBriefer {
  return new ScriptedBriefer((input) => ({ ...defaultBrief(input), arrangement: denseArrangement(input) }));
}

/** A fully composed song via the scripted briefer, for store and state tests. Dense: every part plays everywhere. */
export async function fixtureSong(over: Partial<Song> = {}, briefer: ScriptedBriefer = denseBriefer()): Promise<Song> {
  const song = await composeSong({
    text: "something funky and upbeat",
    seed: 7,
    templates: [fixtureTemplate()],
    bands: [fixtureBand()],
    briefer,
    recipes: new RecipeBook({ store: new RecipeStore({ dir: mkdtempSync(join(tmpdir(), "mate-fixture-recipes-")) }), writer: new ScriptedRecipeWriter(), now: () => 1_000 }),
    saveBands: async (bands) => bands,
    now: () => 1_000,
    signal: new AbortController().signal,
  });
  return { ...song, ...over };
}
