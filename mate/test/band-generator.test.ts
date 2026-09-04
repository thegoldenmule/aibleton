import { describe, expect, test } from "bun:test";
import { BandPartSchema, BandSchema, ROLES, bandGenre, bandRoles } from "@aibleton/protocol";
import type { Role } from "@aibleton/protocol";
import { BUILTIN_GENRES, BUILTIN_RECIPES, generateBand } from "../src/core/band-generator.ts";

const SEEDS = 100;
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Every role the recipe can ever staff, with how many times it can appear. */
function multiplicities(genre: string): Map<string, number> {
  const recipe = BUILTIN_RECIPES.get(genre)!;
  const counts = new Map<string, number>();
  for (const role of [...recipe.core, ...recipe.optional.map((o) => o.role)]) {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return counts;
}

/** Everything the generator promises, checked on one band. */
function assertInvariants(genre: string, band: ReturnType<typeof generateBand>): void {
  const recipe = BUILTIN_RECIPES.get(genre)!;
  const { parts, metadata } = band;

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
    for (const genre of BUILTIN_GENRES) {
      for (let seed = 0; seed < 25; seed++) {
        expect(generateBand({ seed, genre })).toEqual(generateBand({ seed, genre }));
        expect(generateBand({ seed, genre, size: 5 })).toEqual(generateBand({ seed, genre, size: 5 }));
      }
    }
    for (let seed = 0; seed < 25; seed++) expect(generateBand({ seed })).toEqual(generateBand({ seed }));
  });

  test("different seeds generally differ", () => {
    const bands = new Set<string>();
    for (let seed = 0; seed < SEEDS; seed++) bands.add(JSON.stringify(generateBand({ seed, genre: "funk" })));
    expect(bands.size).toBeGreaterThan(20);
  });

  test("handles negative and large seeds", () => {
    for (const seed of [-1, -987654321, 2 ** 31, 2 ** 40 + 7]) {
      const band = generateBand({ seed, genre: "jazz" });
      expect(generateBand({ seed, genre: "jazz" })).toEqual(band);
      assertInvariants("jazz", band);
    }
  });

  test("an explicit size matching the seeded size changes nothing", () => {
    for (const genre of BUILTIN_GENRES) {
      for (let seed = 0; seed < 25; seed++) {
        const band = generateBand({ seed, genre });
        expect(generateBand({ seed, genre, size: band.parts.length })).toEqual(band);
      }
    }
  });

  test("an explicit genre matching the seeded genre changes nothing", () => {
    for (let seed = 0; seed < 50; seed++) {
      const band = generateBand({ seed });
      expect(generateBand({ seed, genre: band.metadata.genre as string })).toEqual(band);
    }
  });
});

describe("generateBand invariants", () => {
  for (const genre of BUILTIN_GENRES) {
    test(`hold for ${SEEDS} seeds: ${genre}`, () => {
      for (let seed = 0; seed < SEEDS; seed++) assertInvariants(genre, generateBand({ seed, genre }));
    });

    test(`hold at every legal size: ${genre}`, () => {
      const recipe = BUILTIN_RECIPES.get(genre)!;
      for (let size = 1; size <= recipe.core.length + recipe.optional.length + 3; size++) {
        for (let seed = 0; seed < 12; seed++) assertInvariants(genre, generateBand({ seed, genre, size }));
      }
    });
  }
});

describe("generateBand core naming", () => {
  test("core slots only ever take an archetype from the head of the pool", () => {
    for (const genre of BUILTIN_GENRES) {
      const recipe = BUILTIN_RECIPES.get(genre)!;
      const coreCounts = new Map<string, number>();
      for (const role of recipe.core) coreCounts.set(role, (coreCounts.get(role) ?? 0) + 1);

      for (let seed = 0; seed < SEEDS; seed++) {
        const { parts } = generateBand({ seed, genre });
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
      // one rock guitar is a rhythm guitar; the lead only shows up alongside it
      expect(generateBand({ seed, genre: "rock", size: 3 }).parts[2]!.name).toBe("rhythm guitar");
      // reggae's core guitar plays the skank, full stop
      expect(generateBand({ seed, genre: "reggae" }).parts[2]!.name).toBe("skank guitar");
      // metal's two core guitars are the doubled rhythm pair, in that order, never two leads
      const metal = generateBand({ seed, genre: "metal" }).parts.slice(2, 4).map((p) => p.name);
      expect(metal).toEqual(["down-tuned rhythm guitar", "doubled rhythm guitar"]);
      // the jazz bass is never a bowed one when it is the only bass
      expect(generateBand({ seed, genre: "jazz" }).parts[1]!.name).not.toBe("arco upright");
    }
  });

  test("supplementary names still reach the band as extra parts", () => {
    const guitars = new Set<string>();
    for (let seed = 0; seed < SEEDS; seed++) {
      for (const part of generateBand({ seed, genre: "rock", size: 6 }).parts) {
        if (part.role === "guitar") guitars.add(part.name);
      }
    }
    expect(guitars.has("lead guitar")).toBe(true);
    expect(guitars.size).toBeGreaterThan(2);
  });
});

describe("generateBand size", () => {
  test("is honoured inside the recipe's range", () => {
    for (const genre of BUILTIN_GENRES) {
      const recipe = BUILTIN_RECIPES.get(genre)!;
      for (let size = recipe.core.length; size <= recipe.core.length + recipe.optional.length; size++) {
        for (let seed = 0; seed < 10; seed++) {
          expect(generateBand({ seed, genre, size }).parts).toHaveLength(size);
        }
      }
    }
  });

  test("clamps below the core and above the full roster", () => {
    for (const genre of BUILTIN_GENRES) {
      const recipe = BUILTIN_RECIPES.get(genre)!;
      const min = recipe.core.length;
      const max = min + recipe.optional.length;
      expect(generateBand({ seed: 7, genre, size: 1 }).parts).toHaveLength(min);
      expect(generateBand({ seed: 7, genre, size: max + 50 }).parts).toHaveLength(max);
    }
  });

  test("an omitted size varies and is not always the full roster", () => {
    for (const genre of BUILTIN_GENRES) {
      const recipe = BUILTIN_RECIPES.get(genre)!;
      const max = recipe.core.length + recipe.optional.length;
      const sizes = new Set<number>();
      for (let seed = 0; seed < SEEDS; seed++) sizes.add(generateBand({ seed, genre }).parts.length);
      expect(sizes.size).toBeGreaterThan(1);
      expect([...sizes].some((n) => n < max)).toBe(true);
    }
  });
});

describe("generateBand genre", () => {
  test("an omitted genre is picked from BUILTIN_GENRES and reported in metadata", () => {
    const picked = new Set<string>();
    for (let seed = 0; seed < SEEDS * 2; seed++) {
      const band = generateBand({ seed });
      const genre = band.metadata.genre!;
      expect(BUILTIN_GENRES as readonly string[]).toContain(genre);
      picked.add(genre);
      assertInvariants(genre as string, band);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  test("metadata.genre always matches the requested genre", () => {
    for (const genre of BUILTIN_GENRES) {
      for (let seed = 0; seed < 20; seed++) {
        expect(generateBand({ seed, genre }).metadata.genre).toBe(genre);
      }
    }
  });
});

describe("generateBand assembles a valid Band", () => {
  test("a band built from the output passes BandSchema", () => {
    for (const genre of BUILTIN_GENRES) {
      for (let seed = 0; seed < 20; seed++) {
        const { parts, metadata } = generateBand({ seed, genre });
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
    expect(() => generateBand(opts as Parameters<typeof generateBand>[0])).toThrow(message);
  });

  test("accepts every genre", () => {
    for (const genre of BUILTIN_GENRES) expect(() => generateBand({ seed: 3, genre })).not.toThrow();
  });
});

describe("RECIPES", () => {
  test("covers exactly BUILTIN_GENRES", () => {
    expect([...BUILTIN_RECIPES.keys()].sort()).toEqual([...BUILTIN_GENRES].sort());
  });

  for (const genre of BUILTIN_GENRES) {
    test(`${genre} is well formed`, () => {
      const recipe = BUILTIN_RECIPES.get(genre)!;
      expect(recipe.core.length).toBeGreaterThan(0);
      for (const role of recipe.core) expect(ROLES as readonly string[]).toContain(role);
      for (const entry of recipe.optional) {
        expect(ROLES as readonly string[]).toContain(entry.role);
        expect(entry.weight).toBeGreaterThan(0);
      }

      for (const [role, count] of multiplicities(genre)) {
        const names = recipe.names[role];
        const briefs = recipe.briefs[role];
        expect(names).toBeDefined();
        expect(briefs).toBeDefined();
        // pools are parallel, so a name never gets another instrument's brief
        expect(names!.length).toBe(briefs!.length);
        // deep enough that the numeric fallback never fires in normal generation
        expect(names!.length).toBeGreaterThanOrEqual(count);
        expect(new Set(names).size).toBe(names!.length);
        // ids are never truncated mid-word: role + name always slugs inside 32 chars
        for (const name of names!) {
          const slug = `${role}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          expect(slug.length).toBeLessThanOrEqual(32);
        }
        // an anchor window is wide enough for the core and no wider than the pool
        const anchor = recipe.anchors[role];
        if (anchor !== undefined) {
          expect(anchor).toBeLessThanOrEqual(names!.length);
          expect(anchor).toBeGreaterThanOrEqual(recipe.core.filter((r) => r === role).length);
        }
        for (const name of names!) expect(name.length).toBeGreaterThan(0);
        for (const brief of briefs!) expect(brief.length).toBeGreaterThan(0);
      }
    });
  }

  test("briefs are genre-distinct: no brief is shared between two genres", () => {
    const seen = new Map<string, string>();
    for (const genre of BUILTIN_GENRES) {
      for (const briefs of Object.values(BUILTIN_RECIPES.get(genre)!.briefs)) {
        for (const brief of briefs ?? []) {
          expect(seen.get(brief)).toBeUndefined();
          seen.set(brief, genre);
        }
      }
    }
  });

  test("metal keeps two guitars in its core and ambient needs no drums", () => {
    expect(BUILTIN_RECIPES.get("metal")!.core.filter((role) => role === "guitar")).toHaveLength(2);
    expect(BUILTIN_RECIPES.get("ambient")!.core).not.toContain("drums");
    expect(BUILTIN_RECIPES.get("jazz")!.core).toEqual(["drums", "bass", "keys"]);
    expect(BUILTIN_RECIPES.get("house")!.core).toEqual(["drums", "bass", "synth"]);
  });
});
