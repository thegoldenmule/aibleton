import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BandRecipeSchema, genreKey } from "@aibleton/protocol";
import { BUILTIN_GENRES, BUILTIN_RECIPES, generateBand } from "../src/core/band-generator.ts";
import { RecipeBook, isValidRecipeId } from "../src/core/recipes.ts";
import { recipeLibrary } from "./helpers/library.ts";
import { normalizeRecipe } from "../src/songwriting/recipe-writer/normalize.ts";
import { RECIPE_JSON_SCHEMA } from "../src/songwriting/recipe-writer/schema.ts";
import { ScriptedRecipeWriter, genericRecipe } from "../src/songwriting/recipe-writer/scripted.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-recipes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

describe("genreKey", () => {
  test.each([
    ["Hip-Hop", "hiphop"],
    ["hip hop", "hiphop"],
    ["  Funk ", "funk"],
    ["New Orleans funk", "neworleansfunk"],
    ["!!!", ""],
  ])("%p -> %p", (input, key) => {
    expect(genreKey(input)).toBe(key);
  });

  test("built-in ids are their own keys", () => {
    for (const genre of BUILTIN_GENRES) expect(BUILTIN_RECIPES.get(genre)!.id).toBe(genreKey(genre));
  });
});

describe("ScriptedRecipeWriter", () => {
  test("writes a recipe every built-in role can staff a band from", async () => {
    const writer = new ScriptedRecipeWriter();
    const draft = await writer.write({ genre: "gospel" }, signal());
    const recipe = BandRecipeSchema.parse({ ...draft, id: "gospel", genre: "gospel", source: "generated", createdAt: 1 });
    expect(recipe.core).toEqual(["drums", "bass", "keys"]);
    expect(recipe.names.keys![0]).toContain("gospel");
    const band = generateBand({ seed: 4, genre: "gospel" }, new Map([["gospel", recipe]]));
    expect(band.metadata.genre).toBe("gospel");
    expect(band.parts.length).toBeGreaterThanOrEqual(3);
    expect(writer.calls).toEqual([{ genre: "gospel" }]);
  });

  test("is deterministic and can be told to fail", async () => {
    expect(genericRecipe("Polka")).toEqual(genericRecipe("polka"));
    const writer = new ScriptedRecipeWriter();
    writer.rejectNext(new Error("nope"));
    await expect(writer.write({ genre: "x" }, signal())).rejects.toThrow("nope");
  });
});

describe("isValidRecipeId", () => {
  test.each(["funk", "gospel", "x".repeat(64)])("accepts %p", (id) => expect(isValidRecipeId(id)).toBe(true));
  test.each(["", "../x", "a/b", "x".repeat(65)])("rejects %p", (id) => expect(isValidRecipeId(id)).toBe(false));
});

describe("RecipeBook", () => {
  /**
   * A book over its own library. Calling this twice opens two libraries over
   * one log, which is exactly what a restart is — so long as the first is done
   * writing before the second reads.
   */
  function book(writer = new ScriptedRecipeWriter(), at = 1_000) {
    const library = recipeLibrary(join(dir, "recipes"), { now: () => at });
    return { library, writer, book: new RecipeBook({ library, writer, now: () => at }) };
  }

  test("built-ins resolve synchronously under any spelling and never hit the writer", async () => {
    const h = book();
    expect(h.book.get("Hip-Hop")?.id).toBe("hiphop");
    expect(await h.book.ensure("hip hop", signal())).toBe(BUILTIN_RECIPES.get("hiphop")!);
    expect(h.writer.calls).toEqual([]);
  });

  test("an unknown genre is written once, logged, and replayed by the next open", async () => {
    const h = book();
    const first = await h.book.ensure("Gospel", signal());
    expect(first.id).toBe("gospel");
    expect(first.genre).toBe("Gospel");
    expect(first.source).toBe("generated");
    expect(first.createdAt).toBe(1_000);
    expect(await h.library.get("gospel")).toEqual(first);
    expect(h.book.get("gospel")).toEqual(first);

    // A fresh library over the same log: the recipe comes back off the replay,
    // and the writer is never asked again.
    const again = book();
    await again.library.list();
    expect(again.book.get("GOSPEL")?.id).toBe("gospel");
    expect(await again.book.ensure("gospel", signal())).toEqual(first);
    expect(again.writer.calls).toEqual([]);
  });

  test("the log is the write: a deleted recipe stays deleted across a reopen", async () => {
    const h = book();
    await h.book.ensure("gospel", signal());
    expect(await h.library.delete("gospel")).toBe(true);

    const again = book();
    await again.library.list();
    expect(again.book.get("gospel")).toBeUndefined();
    // And the projection file is gone rather than adopted back in.
    expect((await again.library.list()).map((r) => r.id)).toEqual([]);
  });

  test("concurrent requests for one genre share a single write", async () => {
    const h = book();
    const [a, b, c] = await Promise.all([h.book.ensure("polka", signal()), h.book.ensure("Polka", signal()), h.book.ensure("polka!", signal())]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(h.writer.calls).toHaveLength(1);
  });

  test("a writer failure propagates and leaves nothing behind", async () => {
    const h = book();
    h.writer.rejectNext(new Error("model down"));
    await expect(h.book.ensure("polka", signal())).rejects.toThrow("model down");
    expect(await h.library.list()).toEqual([]);
    expect(h.book.get("polka")).toBeUndefined();
  });

  test("a genre with no letters or digits is rejected", async () => {
    await expect(book().book.ensure("???", signal())).rejects.toThrow("no letters");
  });

  test("genres are sorted, so an omitted genre draws from a stable list", async () => {
    const h = book();
    await h.book.ensure("gospel", signal());
    await h.book.ensure("polka", signal());
    const genres = h.book.genres();
    expect([...genres]).toEqual([...genres].sort());
    expect(genres).toContain("gospel");
    expect(genres).toContain("polka");
  });

  test("list puts built-ins first, then written recipes newest first", async () => {
    const h = book();
    await h.book.ensure("gospel", signal());
    const later = new RecipeBook({ library: h.library, writer: h.writer, now: () => 2_000 });
    await later.ensure("polka", signal());
    const list = await later.list();
    expect(list.slice(0, BUILTIN_GENRES.length).map((r) => r.id)).toEqual([...BUILTIN_GENRES]);
    expect(list.slice(BUILTIN_GENRES.length).map((r) => [r.id, r.source])).toEqual([
      ["polka", "generated"],
      ["gospel", "generated"],
    ]);
    expect(list[0]!.roles).toContain("drums");
  });
});

describe("normalizeRecipe", () => {
  const raw = {
    core: ["Drums", "bass", "Organ", "bass", "ghost"],
    optional: [
      { role: "choir", weight: 1.5 },
      { role: "choir", weight: 0.5 },
      { role: "guitar", weight: -1 },
      { role: "nobody", weight: 1 },
    ],
    roles: [
      { role: "drums", players: [{ name: "gospel kit", brief: "live kit, big room" }, { name: "Gospel Kit", brief: "dupe" }, { name: "", brief: "x" }] },
      { role: "bass", players: [{ name: "fingerstyle", brief: "walking gospel bass" }, { name: "synth bass", brief: "sub" }] },
      { role: "organ", players: [{ name: "a very long hammond b3 organ with leslie", brief: "drawbars" }] },
      { role: "choir", players: [{ name: "full choir", brief: "stacked harmonies" }] },
      { role: "guitar", players: [{ name: "clean strat", brief: "chords" }] },
      { role: "empty", players: [] },
    ],
    anchors: [
      { role: "bass", count: 9 },
      { role: "choir", count: 2 },
    ],
  };

  test("repairs roles, weights, duplicates and lengths, and the result staffs bands", () => {
    const draft = normalizeRecipe(raw);
    expect(draft.core).toEqual(["drums", "bass", "organ", "bass"]);
    expect(draft.optional).toEqual([
      { role: "choir", weight: 1.5 },
      { role: "guitar", weight: 1 },
    ]);
    expect(draft.names.drums).toEqual(["gospel kit"]);
    expect(draft.names.organ![0]!.length).toBeLessThanOrEqual(24);
    expect(draft.names.empty).toBeUndefined();
    expect(draft.anchors).toEqual({ bass: 2 });
    const recipe = BandRecipeSchema.parse({ ...draft, id: "gospel", genre: "gospel", source: "generated", createdAt: 1 });
    for (let seed = 0; seed < 20; seed++) {
      const band = generateBand({ seed, genre: "gospel" }, new Map([["gospel", recipe]]));
      expect(band.parts.length).toBeGreaterThanOrEqual(4);
      expect(new Set(band.parts.map((p) => p.id)).size).toBe(band.parts.length);
    }
  });

  test("rejects a recipe with no usable core", () => {
    expect(() => normalizeRecipe({ core: ["drums"], optional: [], roles: [], anchors: [] })).toThrow("no core role");
    expect(() => normalizeRecipe("nope")).toThrow("not an object");
  });

  test("rejects a core role that repeats more than it has players", () => {
    expect(() => normalizeRecipe({ core: ["bass", "bass"], optional: [], roles: [{ role: "bass", players: [{ name: "one", brief: "b" }] }], anchors: [] })).toThrow(
      "repeats 2 times",
    );
  });
});

describe("RECIPE_JSON_SCHEMA", () => {
  test("every object is closed and lists every property as required", () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== "object" || node === null) return;
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") {
        expect(obj.additionalProperties, path).toBe(false);
        expect((obj.required as string[]).slice().sort(), path).toEqual(Object.keys(obj.properties as object).sort());
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    };
    walk(RECIPE_JSON_SCHEMA, "$");
    const json = JSON.stringify(RECIPE_JSON_SCHEMA);
    for (const word of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) expect(json).not.toContain(`"${word}"`);
  });
});
