import { describe, expect, test } from "bun:test";
import type { Band, Template } from "@aibleton/protocol";
import { scoreBand, tokenize } from "../src/songwriting/pick.ts";
import { DEFAULT_LIMIT, searchBands, searchTemplates } from "../src/songwriting/search.ts";

function band(id: string, name: string, genre: string | null, parts: [string, string][], createdAt = 0): Band {
  return {
    id,
    name,
    parts: parts.map(([role, brief], i) => ({ id: `${role}-${i}`, role, name: role, brief })),
    metadata: genre ? { genre } : {},
    createdAt,
  };
}

function template(id: string, name: string, form: string, briefs: Record<string, string>, bpm?: number, createdAt = 0): Template {
  const labels = [...new Set(form.split(" ").map((t) => t[0]!))];
  return {
    id,
    name,
    form,
    sections: Object.fromEntries(labels.map((label) => [label, { label, brief: briefs[label] ?? `${label} brief` }])),
    ...(bpm !== undefined ? { bpm } : {}),
    createdAt,
  };
}

const meters = band("meters", "The Meters", "funk", [["drums", "tight pocket"], ["bass", "sixteenth line"], ["keys", "clav stabs"]], 10);
const blue = band("blue", "Blue Note Trio", "jazz", [["drums", "brushed ghost notes on the snare"], ["bass", "walking line"], ["horns", "muted trumpet"]], 20);
const garage = band("garage", "Garage Four", "rock", [["drums", "loud backbeat"], ["guitar", "fuzzy chords"], ["vocals", "shouted"]], 30);
const tuesday = band("tuesday", "Tuesday", "gospel", [["keys", "organ swells"], ["vocals", "choir"]], 40);
const library = [meters, blue, garage, tuesday];

describe("searchBands", () => {
  test("a genre word finds the band that plays it, and says so", () => {
    const hits = searchBands(library, "something funky");
    expect(hits[0]!.document.id).toBe("meters");
    expect(hits[0]!.why).toContain("genre funk");
  });

  test("a role word finds the band that fields it", () => {
    const hits = searchBands(library, "who has horns");
    expect(hits[0]!.document.id).toBe("blue");
    expect(hits[0]!.why).toContain("plays horns");
  });

  test("a name-only query finds a band the composer's scorer cannot", () => {
    const tokens = tokenize("the one called tuesday");
    // The gap being closed: nothing structural to go on, so compose would pick at random.
    expect(library.every((b) => scoreBand(b, tokens) === 0)).toBe(true);
    const hits = searchBands(library, "the one called tuesday");
    expect(hits.map((h) => h.document.id)).toEqual(["tuesday"]);
    expect(hits[0]!.why).toContain("name: tuesday");
  });

  test("a brief word hits", () => {
    const hits = searchBands(library, "brushed ghost");
    expect(hits[0]!.document.id).toBe("blue");
    expect(hits[0]!.why).toContain("brief: brushed, ghost");
  });

  test("a genre match outranks a pile of incidental brief words", () => {
    const wordy = band("wordy", "Wordy", "gospel", [
      ["keys", "syncopated sixteenth shuffle"],
      ["vocals", "ghost notes over a swung pocket"],
    ], 50);
    const hits = searchBands([wordy, meters], "funky syncopated sixteenth ghost notes shuffle pocket");
    expect(hits.map((h) => h.document.id)[0]).toBe("meters");
  });

  test("an empty or whitespace query returns the newest bands", () => {
    expect(searchBands(library, "   ").map((h) => h.document.id)).toEqual(["tuesday", "garage", "blue", "meters"]);
    expect(searchBands(library, "").every((h) => h.score === 0)).toBe(true);
  });

  test("limit is honoured, and defaults to a model-sized handful", () => {
    expect(searchBands(library, "", 2).map((h) => h.document.id)).toEqual(["tuesday", "garage"]);
    expect(searchBands(library, "drums", 1)).toHaveLength(1);
    expect(DEFAULT_LIMIT).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_LIMIT).toBeLessThanOrEqual(10);
  });

  test("ties break on newest then id, and reproduce across runs", () => {
    const same: [string, string][] = [["drums", "steady pocket"], ["bass", "steady line"]];
    const tied = [band("x", "Ex", "funk", same, 2), band("y", "Why", "funk", same, 2), band("z", "Zed", "funk", same, 5)];
    const order = ["z", "x", "y"];
    for (let i = 0; i < 5; i++) {
      expect(searchBands(tied, "funky").map((h) => h.document.id)).toEqual(order);
    }
    expect(searchBands([...tied].reverse(), "funky").map((h) => h.document.id)).toEqual(order);
  });

  test("a query that matches nothing returns nothing, not the whole library at zero", () => {
    expect(searchBands(library, "xylophone polka")).toEqual([]);
  });

  test("an empty library is an empty result, never a throw", () => {
    expect(searchBands([], "funky")).toEqual([]);
    expect(searchBands([], "")).toEqual([]);
  });
});

const ballad = template("ballad", "Slow Burner", "a8 b8 a8 b8", { a: "sparse verse", b: "lifted chorus" }, 78, 10);
const shuffle = template("shuffle", "Tuesday Shuffle", "a8 b8 c8 b8", { a: "swung verse", b: "chorus", c: "halftime bridge" }, 108, 20);
const runner = template("runner", "Runner", "a8 b8 a8 b8 c8 b8", { a: "driving verse", b: "chorus", c: "breakdown" }, 132, 30);
const roadmaps = [ballad, shuffle, runner];

describe("searchTemplates", () => {
  test("a tempo word ranks on bpm proximity and says which", () => {
    const hits = searchTemplates(roadmaps, "something upbeat");
    expect(hits[0]!.document.id).toBe("runner");
    expect(hits[0]!.why[0]).toBe("132 bpm, asked around 130");
  });

  test("a name-only query finds a template no tempo or length word points at", () => {
    const hits = searchTemplates(roadmaps, "the one called tuesday");
    expect(hits.map((h) => h.document.id)).toEqual(["shuffle"]);
    expect(hits[0]!.why).toContain("name: tuesday");
  });

  test("a section brief word hits", () => {
    const hits = searchTemplates(roadmaps, "with a breakdown");
    expect(hits[0]!.document.id).toBe("runner");
    expect(hits[0]!.why).toContain("brief: breakdown");
  });

  test("an empty query returns the newest, limit honoured", () => {
    expect(searchTemplates(roadmaps, " ").map((h) => h.document.id)).toEqual(["runner", "shuffle", "ballad"]);
    expect(searchTemplates(roadmaps, "\n\t", 2).map((h) => h.document.id)).toEqual(["runner", "shuffle"]);
  });

  test("ties break deterministically", () => {
    const a = template("a", "One", "a8 b8", { a: "verse", b: "chorus" }, 120, 5);
    const b = template("b", "Two", "a8 b8", { a: "verse", b: "chorus" }, 120, 5);
    for (let i = 0; i < 3; i++) {
      expect(searchTemplates([b, a], "at 120").map((h) => h.document.id)).toEqual(["a", "b"]);
    }
  });

  test("a query that matches nothing returns nothing", () => {
    expect(searchTemplates(roadmaps, "polka xylophone")).toEqual([]);
  });
});
