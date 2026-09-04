import { describe, expect, test } from "bun:test";
import type { Band, Template } from "@aibleton/protocol";
import { EmptyLibraryError, bpmHint, genreKeysIn, matchesGenre, pickBand, pickTemplate, rolesIn, tokenize } from "../src/songwriting/pick.ts";

function band(id: string, genre: string | null, roles: string[]): Band {
  return {
    id,
    name: id,
    parts: roles.map((role, i) => ({ id: `${role}-${i}`, role, name: role, brief: `${role} brief` })),
    metadata: genre ? { genre } : {},
    createdAt: 0,
  };
}

function template(id: string, form: string, bpm?: number): Template {
  const labels = [...new Set(form.split(" ").map((t) => t[0]!))];
  return {
    id,
    name: id,
    form,
    sections: Object.fromEntries(labels.map((label) => [label, { label, brief: `${label} brief` }])),
    ...(bpm !== undefined ? { bpm } : {}),
    createdAt: 0,
  };
}

const funk = band("funk", "funk", ["drums", "bass", "guitar", "keys"]);
const jazz = band("jazz", "jazz", ["drums", "bass", "keys", "horns"]);
const rock = band("rock", "rock", ["drums", "bass", "guitar", "vocals"]);
const untagged = band("untagged", null, ["drums", "bass", "horns"]);

describe("tokenize and hints", () => {
  test("splits on non-alphanumerics and lowercases", () => {
    expect(tokenize("Hip-Hop, at 92BPM!")).toEqual(["hip", "hop", "at", "92bpm"]);
  });

  test("genre keys come from words, word pairs and synonyms; roles from whole words", () => {
    const tokens = tokenize("something funky with horns and a little swing");
    const keys = genreKeysIn(tokens);
    expect(keys.has("funk")).toBe(true);
    expect(keys.has("jazz")).toBe(true);
    expect(keys.has("funky")).toBe(true);
    expect(rolesIn(tokens)).toEqual(["horns"]);
    expect(genreKeysIn(tokenize("some hip hop please")).has("hiphop")).toBe(true);
  });

  test("any free-text genre tag matches its own word, and multi-word tags match on each word", () => {
    const gospel = band("gospel", "gospel", ["keys"]);
    expect(matchesGenre(gospel, genreKeysIn(tokenize("a high energy gospel song")))).toBe(true);
    expect(matchesGenre(gospel, genreKeysIn(tokenize("something funky")))).toBe(false);
    const nola = band("nola", "New Orleans funk", ["drums"]);
    expect(matchesGenre(nola, genreKeysIn(tokenize("funky stuff")))).toBe(true);
    expect(matchesGenre(nola, genreKeysIn(tokenize("new orleans")))).toBe(true);
    expect(matchesGenre(band("hh", "Hip-Hop", ["drums"]), genreKeysIn(tokenize("hip hop beat")))).toBe(true);
  });

  test("bpm hint prefers an explicit number in range", () => {
    expect(bpmHint(tokenize("upbeat at 112"))).toBe(112);
    expect(bpmHint(tokenize("upbeat and bright"))).toBe(130);
    expect(bpmHint(tokenize("slow burner"))).toBe(80);
    expect(bpmHint(tokenize("year 2024 vibes"))).toBeNull();
    expect(bpmHint(tokenize("no tempo here"))).toBeNull();
  });
});

describe("pickBand", () => {
  test("a genre word picks the band tagged with that genre", () => {
    expect(pickBand([jazz, rock, funk], "I want to play something funky and upbeat", 1).id).toBe("funk");
    expect(pickBand([jazz, rock, funk], "some punk riffs please", 1).id).toBe("rock");
    const gospel = band("gospel", "gospel", ["keys", "vocals"]);
    expect(pickBand([jazz, rock, funk, gospel], "a high energy gospel song", 1).id).toBe("gospel");
  });

  test("a role mention breaks a tie between otherwise equal bands", () => {
    expect(pickBand([funk, jazz, rock], "something with horns", 3).id).toBe("jazz");
    expect(pickBand([funk, untagged], "something with horns", 3).id).toBe("untagged");
  });

  test("genre outranks roles", () => {
    expect(pickBand([jazz, funk], "funky with horns", 5).id).toBe("funk");
  });

  test("no signal at all falls back to a seeded pick that reproduces", () => {
    const a = pickBand([funk, jazz, rock], "play something", 99);
    const b = pickBand([funk, jazz, rock], "play something", 99);
    expect(a.id).toBe(b.id);
    const ids = new Set([7, 8, 9, 10, 11, 12].map((seed) => pickBand([funk, jazz, rock], "play something", seed).id));
    expect(ids.size).toBeGreaterThan(1);
  });

  test("an empty library throws EmptyLibraryError", () => {
    expect(() => pickBand([], "funky", 1)).toThrow(EmptyLibraryError);
    try {
      pickBand([], "funky", 1);
    } catch (err) {
      expect((err as EmptyLibraryError).library).toBe("bands");
    }
  });
});

describe("pickTemplate", () => {
  const slow = template("slow", "a8 b8 a8 b8", 78);
  const mid = template("mid", "a8 b8 c8 b8", 108);
  const fast = template("fast", "a8 b8 a8 b8 c8 b8", 132);
  const noBpm = template("nobpm", "a8 b8");

  test("tempo words pick the closest bpm", () => {
    expect(pickTemplate([slow, mid, fast], "something funky and upbeat", 1).id).toBe("fast");
    expect(pickTemplate([slow, mid, fast], "a slow ballad", 1).id).toBe("slow");
    expect(pickTemplate([slow, mid, fast], "groove at 110", 1).id).toBe("mid");
  });

  test("length words score total bars", () => {
    const short = template("short", "a8 b8 a8 b8");
    const long = template("long", "a8 b8 a8 b8 c8 b8 a8 b8 c8 b8 a8 b8");
    expect(pickTemplate([long, short], "a short jam", 1).id).toBe("short");
    expect(pickTemplate([short, long], "a long one", 1).id).toBe("long");
  });

  test("templates without a bpm are neutral, not excluded", () => {
    expect(pickTemplate([noBpm], "fast", 1).id).toBe("nobpm");
  });

  test("same seed reproduces, different seeds vary when nothing discriminates", () => {
    expect(pickTemplate([slow, mid, fast], "play", 4).id).toBe(pickTemplate([slow, mid, fast], "play", 4).id);
    const ids = new Set([1, 2, 3, 4, 5, 6].map((seed) => pickTemplate([slow, mid, fast], "play", seed).id));
    expect(ids.size).toBeGreaterThan(1);
  });

  test("an empty library throws EmptyLibraryError", () => {
    expect(() => pickTemplate([], "funky", 1)).toThrow(EmptyLibraryError);
  });
});
