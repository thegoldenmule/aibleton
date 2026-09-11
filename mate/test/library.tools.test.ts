import { describe, expect, test } from "bun:test";
import type { Band, RecipeSummary, Template } from "@aibleton/protocol";
import { MAX_LIMIT, isLibraryTool, runLibraryTool, type LibraryReader, type LibraryToolDeps } from "../src/intelligence/tools/library.tools.ts";
import { DEFAULT_LIMIT } from "../src/songwriting/search.ts";

function band(id: string, name: string, genre: string | null, parts: [string, string][], createdAt: number): Band {
  return {
    id,
    name,
    parts: parts.map(([role, brief], i) => ({ id: `${role}-${i}`, role, name: `${role} ${i}`, brief })),
    metadata: genre ? { genre } : {},
    createdAt,
  };
}

function template(id: string, name: string, form: string, bpm: number | undefined, createdAt: number): Template {
  const labels = [...new Set(form.split(" ").map((t) => t[0]!))];
  return {
    id,
    name,
    form,
    sections: Object.fromEntries(labels.map((label) => [label, { label, brief: `the ${label} section, written out at length` }])),
    ...(bpm !== undefined ? { bpm } : {}),
    createdAt,
  };
}

/** The two methods a library read needs, over an array. An id the store would refuse throws, as `LibraryStore.get` does. */
function reader<T extends { id: string; createdAt: number }>(docs: readonly T[]): LibraryReader<T> {
  return {
    list: async () => [...docs].sort((a, b) => b.createdAt - a.createdAt),
    get: async (id) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}`);
      return docs.find((d) => d.id === id) ?? null;
    },
  };
}

const BANDS = [
  band("meters", "The Meters", "funk", [["drums", "tight pocket"], ["bass", "sixteenth line"], ["keys", "clav stabs"]], 10),
  band("blue", "Blue Note Trio", "jazz", [["drums", "brushed ghost notes"], ["bass", "walking line"], ["horns", "muted trumpet"]], 20),
  band("garage", "Garage Four", "rock", [["drums", "loud backbeat"], ["guitar", "fuzzy chords"]], 30),
  band("tuesday", "Tuesday", "gospel", [["keys", "organ swells"], ["vocals", "choir"]], 40),
];

const TEMPLATES = [
  template("pop", "Pop Standard", "a8 b8 a8 b8 c8 b8", 120, 10),
  template("loop", "Two Bar Loop", "a2", undefined, 20),
];

const GENRES: RecipeSummary[] = [
  { id: "funk", genre: "funk", roles: ["drums", "bass", "keys"] },
  { id: "shoegaze", genre: "Shoegaze", roles: ["drums", "bass", "guitar"] },
];

const deps: LibraryToolDeps = { bands: reader(BANDS), templates: reader(TEMPLATES), recipes: { list: async () => GENRES } };

const run = async (name: string, args: Record<string, unknown> = {}) => runLibraryTool(name, args, deps);
const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await run(name, args));

describe("find_bands", () => {
  test("no query is a browse: the newest first, and the whole library's size beside them", async () => {
    const result = await json("find_bands");
    expect(result.total).toBe(4);
    expect(result.shown).toBe(4);
    expect(result.matches.map((m: { id: string }) => m.id)).toEqual(["tuesday", "garage", "blue", "meters"]);
    // Nothing matched anything, so there is no `why` to print.
    expect(result.matches[0].why).toBeUndefined();
  });

  test("a query ranks, and every hit says what it matched on", async () => {
    const result = await json("find_bands", { query: "who has horns" });
    expect(result.total).toBe(4);
    expect(result.matches[0].id).toBe("blue");
    expect(result.matches[0].why).toContain("plays horns");
    // A slice, and it says so.
    expect(result.shown).toBeLessThan(result.total);
  });

  test("a summary is a stage plot, not a band: no briefs anywhere in it", async () => {
    const result = await json("find_bands", { query: "funk" });
    const hit = result.matches[0];
    expect(hit).toMatchObject({ id: "meters", name: "The Meters", genre: "funk" });
    expect(hit.parts).toEqual([
      { role: "drums", name: "drums 0" },
      { role: "bass", name: "bass 1" },
      { role: "keys", name: "keys 2" },
    ]);
    expect(await run("find_bands", { query: "funk" })).not.toContain("tight pocket");
  });

  test("the limit is the model's to ask for, up to a ceiling", async () => {
    expect((await json("find_bands", { limit: 2 })).shown).toBe(2);
    // Nonsense is not an error: it means the model did not ask.
    expect((await json("find_bands", { limit: "lots" })).shown).toBe(4);
    const many = { bands: reader(bigLibrary(30)), templates: deps.templates, recipes: deps.recipes };
    const capped = JSON.parse(await runLibraryTool("find_bands", { limit: 500 }, many));
    expect(capped.total).toBe(30);
    expect(capped.shown).toBe(MAX_LIMIT);
  });

  test("a thirty-band library costs about two kilobytes to browse, not fifty", async () => {
    const many = { bands: reader(bigLibrary(30)), templates: deps.templates, recipes: deps.recipes };
    const answer = await runLibraryTool("find_bands", {}, many);
    expect(JSON.parse(answer).shown).toBe(DEFAULT_LIMIT);
    expect(answer.length).toBeLessThan(3_000);
    // The same library handed over whole is the thing this is avoiding.
    expect(JSON.stringify(await many.bands.list()).length).toBeGreaterThan(10_000);
  });
});

function bigLibrary(n: number): Band[] {
  return Array.from({ length: n }, (_, i) =>
    band(`band-${i}`, `Session Band ${i}`, "funk", [
      ["drums", "a long brief about the drum part, its feel and the room it was recorded in"],
      ["bass", "a long brief about the bass part, its tone and the line it walks"],
      ["keys", "a long brief about the keys part, the instrument and the voicings"],
      ["guitar", "a long brief about the guitar part, the amp and the chords"],
    ], i),
  );
}

describe("get_band", () => {
  test("this is where the briefs live", async () => {
    const band = await json("get_band", { band_id: "blue" });
    expect(band.id).toBe("blue");
    expect(band.parts[0].brief).toBe("brushed ghost notes");
  });

  test("an id that names nothing is an answer, not an error, and points back at the search", async () => {
    // A bad id is usually a guess: a sentence gets the model to find_bands in one turn,
    // where an error result reads as a fault and draws an apology to the drummer.
    expect(await run("get_band", { band_id: "nope" })).toBe('no band "nope" — find one with find_bands.');
    // An id the store will not even look up is the same miss.
    expect(await run("get_band", { band_id: "../etc/passwd" })).toContain("find one with find_bands");
    expect(await run("get_band", {})).toBe('no band "" — find one with find_bands.');
  });
});

describe("templates", () => {
  test("a summary carries the form and what it adds up to, never the section briefs", async () => {
    const result = await json("find_templates");
    expect(result.total).toBe(2);
    expect(result.matches).toEqual([
      { id: "loop", name: "Two Bar Loop", form: "a2", totalBars: 2 },
      { id: "pop", name: "Pop Standard", form: "a8 b8 a8 b8 c8 b8", totalBars: 48, bpm: 120 },
    ]);
  });

  test("get_template is the full record, and a miss reads the same way", async () => {
    const full = await json("get_template", { template_id: "pop" });
    expect(full.sections.a.brief).toContain("written out at length");
    expect(await run("get_template", { template_id: "nope" })).toBe('no template "nope" — find one with find_templates.');
  });
});

describe("get_genres", () => {
  test("lists every genre that can be staffed right now, and who plays in each", async () => {
    const genres = await json("get_genres");
    expect(genres).toEqual(GENRES);
    expect(genres.map((g: RecipeSummary) => g.id)).toEqual(["funk", "shoegaze"]);
    expect(genres[0].roles).toContain("drums");
  });
});

describe("runLibraryTool", () => {
  test("knows its own five and refuses anything else", async () => {
    for (const name of ["find_bands", "get_band", "find_templates", "get_template", "get_genres"]) {
      expect(isLibraryTool(name)).toBe(true);
    }
    expect(isLibraryTool("compose_song")).toBe(false);
    expect(run("compose_song", {})).rejects.toThrow("not a library tool");
  });
});
