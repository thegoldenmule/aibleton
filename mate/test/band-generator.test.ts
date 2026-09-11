import { describe, expect, test } from "bun:test";
import { BandPartSchema, BandRecipeSchema, BandSchema, ROLES, bandGenre, bandRoles } from "@aibleton/protocol";
import type { BandRecipe, Role } from "@aibleton/protocol";
import { generateBand, type RecipeLookup } from "../src/core/band-generator.ts";
import { genericRecipe } from "../src/songwriting/recipe-writer/scripted.ts";

const SEEDS = 100;
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Mate ships no recipes, so the generator's tests bring their own. These are
 * fixtures, not data under test: each one is shaped to exercise one rule —
 * `funk` a wide anchor window and a pool it can exhaust, `metal` a core role
 * that repeats, `ambient` a core with no drums and a single-name archetype.
 */
const FIXTURES: BandRecipe[] = [
  BandRecipeSchema.parse({
    id: "funk",
    genre: "funk",
    core: ["drums", "bass"],
    anchors: { drums: 3 },
    optional: [
      { role: "guitar", weight: 4 },
      { role: "keys", weight: 3 },
      { role: "percussion", weight: 2 },
      { role: "percussion", weight: 1 },
    ],
    names: {
      drums: ["breakbeat kit", "tight studio kit", "loose live kit"],
      bass: ["p bass", "clav bass"],
      guitar: ["clean ninth guitar", "wah guitar"],
      keys: ["clavinet", "rhodes"],
      percussion: ["shaker"],
    },
    briefs: {
      drums: ["dry breakbeat", "tight studio groove", "loose room groove"],
      bass: ["round fingerstyle bass", "clav-doubled bass"],
      guitar: ["clean ninth chords", "wah rhythm figure"],
      keys: ["percussive clav stabs", "warm rhodes comping"],
      percussion: ["shaker sixteenths"],
    },
    createdAt: 1,
  }),
  BandRecipeSchema.parse({
    id: "metal",
    genre: "metal",
    core: ["drums", "bass", "guitar", "guitar"],
    anchors: { guitar: 2 },
    optional: [
      { role: "vocals", weight: 3 },
      { role: "keys", weight: 1 },
    ],
    names: {
      drums: ["double kick kit"],
      bass: ["picked bass"],
      guitar: ["down-tuned rhythm guitar", "doubled rhythm guitar", "lead guitar", "harmony guitar"],
      vocals: ["screamed vocal"],
      keys: ["orchestral pad"],
    },
    briefs: {
      drums: ["double kick and blast fills"],
      bass: ["picked and distorted"],
      guitar: ["down-tuned palm-muted riff", "the same riff doubled", "wide lead line", "harmonised lead"],
      vocals: ["screamed lead vocal"],
      keys: ["orchestral pad underneath"],
    },
    createdAt: 2,
  }),
  BandRecipeSchema.parse({
    id: "ambient",
    genre: "ambient",
    core: ["synth", "strings"],
    anchors: { synth: 1 },
    optional: [
      { role: "fx", weight: 2 },
      { role: "keys", weight: 1 },
    ],
    names: {
      synth: ["drifting pad", "detuned lead"],
      strings: ["bowed cello", "string swell"],
      fx: ["tape hiss"],
      keys: ["felt piano"],
    },
    briefs: {
      synth: ["slow drifting pad", "detuned lead over the pad"],
      strings: ["bowed cello counterline", "long string swell"],
      fx: ["tape hiss and crackle"],
      keys: ["felt piano, sparse"],
    },
    createdAt: 3,
  }),
];

const BY_ID = new Map(FIXTURES.map((recipe) => [recipe.id, recipe]));
const GENRES = [...BY_ID.keys()].sort();

/** What `RecipeBook` is to production: a synchronous lookup with a stable genre list. */
function lookup(recipes: readonly BandRecipe[] = FIXTURES): RecipeLookup {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  return {
    get: (genre) => byId.get(genre),
    genres: () => [...byId.keys()].sort(),
  };
}

const LOOKUP = lookup();

/** Staff a band from the fixtures. Every test goes through this rather than the raw call. */
function band(opts: Parameters<typeof generateBand>[0], recipes: RecipeLookup = LOOKUP) {
  return generateBand(opts, recipes);
}

/** Every role the recipe can ever staff, with how many times it can appear. */
function multiplicities(genre: string): Map<string, number> {
  const recipe = BY_ID.get(genre)!;
  const counts = new Map<string, number>();
  for (const role of [...recipe.core, ...recipe.optional.map((o) => o.role)]) {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return counts;
}

/** Everything the generator promises, checked on one band. */
function assertInvariants(genre: string, staffed: ReturnType<typeof generateBand>): void {
  const recipe = BY_ID.get(genre)!;
  const { parts, metadata } = staffed;

  expect(metadata.genre).toBe(genre);
  expect(parts.length).toBeGreaterThan(0);
  expect(parts.length).toBeGreaterThanOrEqual(recipe.core.length);
  expect(parts.length).toBeLessThanOrEqual(recipe.core.length + recipe.optional.length);

  // core roles come first, in recipe order, with their multiplicity
  expect(parts.slice(0, recipe.core.length).map((p) => p.role)).toEqual(recipe.core);

  const ids = new Set<string>();
  const namesByRole = new Map<string, Set<string>>();
  for (const part of parts) {
    expect(part.id).toMatch(SLUG);
    expect(part.id.length).toBeLessThanOrEqual(32);
    expect(ids.has(part.id)).toBe(false);
    ids.add(part.id);

    expect(BandPartSchema.safeParse(part).success).toBe(true);
    expect("emphasis" in part).toBe(false);
    expect(part.brief.length).toBeGreaterThan(0);
    expect(ROLES).toContain(part.role as Role);

    // duplicate roles never share a name
    const seen = namesByRole.get(part.role) ?? new Set<string>();
    expect(seen.has(part.name)).toBe(false);
    seen.add(part.name);
    namesByRole.set(part.role, seen);
  }

  // every optional part is a role the recipe actually offers
  const allowed = multiplicities(genre);
  const used = new Map<string, number>();
  for (const part of parts) {
    const role = part.role as Role;
    used.set(role, (used.get(role) ?? 0) + 1);
  }
  for (const [role, count] of used) expect(count).toBeLessThanOrEqual(allowed.get(role) ?? 0);
}

describe("generateBand determinism", () => {
  test("same seed and options give a deep-equal band", () => {
    for (const genre of GENRES) {
      for (let seed = 0; seed < 25; seed++) {
        expect(band({ seed, genre })).toEqual(band({ seed, genre }));
        expect(band({ seed, genre, size: 5 })).toEqual(band({ seed, genre, size: 5 }));
      }
    }
    for (let seed = 0; seed < 25; seed++) expect(band({ seed })).toEqual(band({ seed }));
  });

  test("different seeds generally differ", () => {
    const bands = new Set<string>();
    for (let seed = 0; seed < SEEDS; seed++) bands.add(JSON.stringify(band({ seed, genre: "funk" })));
    expect(bands.size).toBeGreaterThan(20);
  });

  test("handles negative and large seeds", () => {
    for (const seed of [-1, -987654321, 2 ** 31, 2 ** 40 + 7]) {
      const staffed = band({ seed, genre: "metal" });
      expect(band({ seed, genre: "metal" })).toEqual(staffed);
      assertInvariants("metal", staffed);
    }
  });

  test("an explicit size matching the seeded size changes nothing", () => {
    for (const genre of GENRES) {
      for (let seed = 0; seed < 25; seed++) {
        const staffed = band({ seed, genre });
        expect(band({ seed, genre, size: staffed.parts.length })).toEqual(staffed);
      }
    }
  });

  test("an explicit genre matching the seeded genre changes nothing", () => {
    for (let seed = 0; seed < 50; seed++) {
      const staffed = band({ seed });
      expect(band({ seed, genre: staffed.metadata.genre as string })).toEqual(staffed);
    }
  });

  /**
   * The seeded draw burns one rng call whether or not a genre was given, so a
   * library that grows re-points an omitted genre but leaves everything after
   * the draw alone.
   */
  test("the genre draw costs one roll, so a named genre is unaffected by the library's size", () => {
    const narrow = lookup([BY_ID.get("funk")!]);
    for (let seed = 0; seed < 25; seed++) {
      expect(band({ seed, genre: "funk" }, narrow)).toEqual(band({ seed, genre: "funk" }));
    }
  });
});

describe("generateBand invariants", () => {
  for (const genre of GENRES) {
    test(`hold for ${SEEDS} seeds: ${genre}`, () => {
      for (let seed = 0; seed < SEEDS; seed++) assertInvariants(genre, band({ seed, genre }));
    });

    test(`hold at every legal size: ${genre}`, () => {
      const recipe = BY_ID.get(genre)!;
      for (let size = 1; size <= recipe.core.length + recipe.optional.length + 3; size++) {
        for (let seed = 0; seed < 12; seed++) assertInvariants(genre, band({ seed, genre, size }));
      }
    });
  }

  test("hold for a recipe the scripted writer produced", () => {
    const written = BandRecipeSchema.parse({ ...genericRecipe("Gospel"), id: "gospel", genre: "Gospel", createdAt: 4 });
    const book = lookup([written]);
    for (let seed = 0; seed < SEEDS; seed++) {
      const { parts, metadata } = band({ seed, genre: "gospel" }, book);
      expect(metadata.genre).toBe("Gospel");
      const ids = new Set(parts.map((p) => p.id));
      expect(ids.size).toBe(parts.length);
      for (const part of parts) expect(part.id).toMatch(SLUG);
    }
  });
});

describe("generateBand core naming", () => {
  test("core slots only ever take an archetype from the head of the pool", () => {
    for (const genre of GENRES) {
      const recipe = BY_ID.get(genre)!;
      const coreCounts = new Map<string, number>();
      for (const role of recipe.core) coreCounts.set(role, (coreCounts.get(role) ?? 0) + 1);

      for (let seed = 0; seed < SEEDS; seed++) {
        const { parts } = band({ seed, genre });
        parts.slice(0, recipe.core.length).forEach((part, i) => {
          const role = recipe.core[i]!;
          const pool = recipe.names[role]!;
          const window = Math.max(recipe.anchors?.[role] ?? 0, coreCounts.get(role) ?? 0);
          expect(pool.slice(0, window)).toContain(part.name);
        });
      }
    }
  });

  test("the archetypes hold for the bands that only have one of a thing", () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      // a one-deep anchor window pins the core name whatever the seed does
      expect(band({ seed, genre: "ambient" }).parts[0]!.name).toBe("drifting pad");
      // a repeated core role takes the head of the pool in order, never two leads
      const guitars = band({ seed, genre: "metal" }).parts.slice(2, 4).map((p) => p.name);
      expect(guitars).toEqual(["down-tuned rhythm guitar", "doubled rhythm guitar"]);
    }
  });

  test("supplementary names still reach the band as extra parts", () => {
    const guitars = new Set<string>();
    for (let seed = 0; seed < SEEDS; seed++) {
      for (const part of band({ seed, genre: "metal", size: 6 }).parts) {
        if (part.role === "guitar") guitars.add(part.name);
      }
    }
    // the core pair only; the optionals metal offers are not guitars
    expect(guitars).toEqual(new Set(["down-tuned rhythm guitar", "doubled rhythm guitar"]));
  });

  test("a pool too shallow for its role cycles with a numeric suffix", () => {
    // funk offers percussion twice but names one shaker
    const full = band({ seed: 3, genre: "funk", size: 6 }).parts.filter((p) => p.role === "percussion");
    expect(full.map((p) => p.name)).toEqual(["shaker", "shaker 2"]);
    expect(new Set(full.map((p) => p.id)).size).toBe(full.length);
  });

  test("the brief always belongs to the name beside it", () => {
    for (const genre of GENRES) {
      const recipe = BY_ID.get(genre)!;
      for (let seed = 0; seed < 30; seed++) {
        for (const part of band({ seed, genre }).parts) {
          const names = recipe.names[part.role]!;
          const briefs = recipe.briefs[part.role]!;
          const index = names.indexOf(part.name);
          if (index === -1) continue; // a cycled "name 2", checked above
          expect(part.brief).toBe(briefs[index % briefs.length]!);
        }
      }
    }
  });
});

describe("generateBand size", () => {
  test("is honoured inside the recipe's range", () => {
    for (const genre of GENRES) {
      const recipe = BY_ID.get(genre)!;
      for (let size = recipe.core.length; size <= recipe.core.length + recipe.optional.length; size++) {
        for (let seed = 0; seed < 10; seed++) {
          expect(band({ seed, genre, size }).parts).toHaveLength(size);
        }
      }
    }
  });

  test("clamps below the core and above the full roster", () => {
    for (const genre of GENRES) {
      const recipe = BY_ID.get(genre)!;
      const min = recipe.core.length;
      const max = min + recipe.optional.length;
      expect(band({ seed: 7, genre, size: 1 }).parts).toHaveLength(min);
      expect(band({ seed: 7, genre, size: max + 50 }).parts).toHaveLength(max);
    }
  });

  test("an omitted size varies and is not always the full roster", () => {
    for (const genre of GENRES) {
      const recipe = BY_ID.get(genre)!;
      const max = recipe.core.length + recipe.optional.length;
      const sizes = new Set<number>();
      for (let seed = 0; seed < SEEDS; seed++) sizes.add(band({ seed, genre }).parts.length);
      expect(sizes.size).toBeGreaterThan(1);
      expect([...sizes].some((n) => n < max)).toBe(true);
    }
  });
});

describe("generateBand genre", () => {
  test("an omitted genre is drawn from what the lookup holds and reported in metadata", () => {
    const picked = new Set<string>();
    for (let seed = 0; seed < SEEDS * 2; seed++) {
      const staffed = band({ seed });
      const genre = staffed.metadata.genre!;
      expect(GENRES).toContain(genre);
      picked.add(genre);
      assertInvariants(genre as string, staffed);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  test("a one-recipe library always draws that one", () => {
    const narrow = lookup([BY_ID.get("ambient")!]);
    for (let seed = 0; seed < 25; seed++) expect(band({ seed }, narrow).metadata.genre!).toBe("ambient");
  });

  test("metadata.genre always matches the requested genre", () => {
    for (const genre of GENRES) {
      for (let seed = 0; seed < 20; seed++) {
        expect(band({ seed, genre }).metadata.genre!).toBe(genre);
      }
    }
  });

  /** The genre as written wins over the key it is filed under. */
  test("metadata carries the recipe's genre, not the id it was looked up by", () => {
    const written = BandRecipeSchema.parse({ ...genericRecipe("Hip-Hop"), id: "hiphop", genre: "Hip-Hop", createdAt: 5 });
    expect(band({ seed: 1, genre: "hiphop" }, lookup([written])).metadata.genre!).toBe("Hip-Hop");
  });
});

describe("generateBand assembles a valid Band", () => {
  test("a band built from the output passes BandSchema", () => {
    for (const genre of GENRES) {
      for (let seed = 0; seed < 20; seed++) {
        const { parts, metadata } = band({ seed, genre });
        const parsed = BandSchema.safeParse({
          id: `band-${genre}-${seed}`,
          name: `${genre} band`,
          parts,
          metadata,
          createdAt: 1_700_000_000_000,
        });
        expect(parsed.success).toBe(true);
        if (!parsed.success) continue;
        expect(bandGenre(parsed.data)).toBe(genre);
        expect(bandRoles(parsed.data).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("generateBand validation", () => {
  test.each([
    ["a fractional seed", { seed: 1.5 }, /seed/],
    ["a NaN seed", { seed: Number.NaN }, /seed/],
    ["size zero", { seed: 1, size: 0 }, /size/],
    ["a negative size", { seed: 1, size: -3 }, /size/],
    ["a fractional size", { seed: 1, size: 2.5 }, /size/],
    ["an unknown genre", { seed: 1, genre: "polka" as string }, /genre/],
  ])("throws on %s", (_name, opts, message) => {
    expect(() => band(opts as Parameters<typeof generateBand>[0])).toThrow(message);
  });

  /**
   * A fresh install. `staffBand` writes `DEFAULT_GENRE` before it gets here, so
   * this message is the last line of defence rather than something the drummer
   * normally sees.
   */
  test("an empty library is refused by name rather than by a missing-genre error", () => {
    expect(() => band({ seed: 1 }, lookup([]))).toThrow(/no recipes yet/);
    expect(() => band({ seed: 1, genre: "funk" }, lookup([]))).toThrow(/no recipes yet/);
  });

  test("accepts every genre it holds", () => {
    for (const genre of GENRES) expect(() => band({ seed: 3, genre })).not.toThrow();
  });
});
