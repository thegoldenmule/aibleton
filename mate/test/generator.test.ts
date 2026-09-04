import { describe, expect, test } from "bun:test";
import { SectionSchema, formLabels, parseForm, stringifyForm } from "@aibleton/protocol";
import { defaultSections, generateForm } from "../src/core/generator.ts";
import type { GenerateFormOptions } from "../src/core/generator.ts";

const LETTERS = "abcdef";
const SEEDS = 200;

type Options = Omit<GenerateFormOptions, "seed">;

/** Everything the generator promises, checked on one form. */
function assertInvariants(form: string, opts: Options): void {
  const alphabet = opts.alphabet ?? 3;
  const count = opts.count ?? 9;
  const maxRun = opts.maxRun ?? 2;
  const bars = opts.bars ?? 8;

  // round-trips through the protocol parser unchanged
  const entries = parseForm(form);
  expect(stringifyForm(entries)).toBe(form);

  expect(entries).toHaveLength(count);
  expect(entries[0]?.label).toBe("a");
  for (const entry of entries) expect(entry.bars).toBe(bars);

  // letters introduced strictly in order, one at a time
  let introduced = 0;
  let run = 0;
  let previous = "";
  for (const entry of entries) {
    const index = LETTERS.indexOf(entry.label);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(alphabet);
    expect(index).toBeLessThanOrEqual(introduced);
    if (index === introduced) introduced++;

    run = entry.label === previous ? run + 1 : 1;
    expect(run).toBeLessThanOrEqual(maxRun);
    previous = entry.label;
  }

  // every letter used, when there is room for them all
  if (count >= alphabet) {
    expect(formLabels(entries)).toHaveLength(alphabet);
    expect(introduced).toBe(alphabet);
  }
}

const OPTION_SETS: { name: string; opts: Options }[] = [
  { name: "defaults", opts: {} },
  { name: "wide, no repeats", opts: { alphabet: 6, count: 12, maxRun: 1 } },
  { name: "two letters, short", opts: { alphabet: 2, count: 4 } },
  { name: "more letters than slots", opts: { alphabet: 5, count: 3 } },
  { name: "single occurrence", opts: { alphabet: 4, count: 1, bars: 16 } },
  { name: "long runs, custom home", opts: { alphabet: 4, count: 16, maxRun: 3, home: "c", bars: 4 } },
];

describe("generateForm determinism", () => {
  test("same seed and options give a byte-identical string", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(generateForm({ seed })).toBe(generateForm({ seed }));
      expect(generateForm({ seed, alphabet: 4, count: 11 })).toBe(generateForm({ seed, alphabet: 4, count: 11 }));
    }
  });

  test("different seeds generally differ", () => {
    const forms = new Set<string>();
    for (let seed = 0; seed < SEEDS; seed++) forms.add(generateForm({ seed }));
    expect(forms.size).toBeGreaterThan(100);
  });

  test("handles negative and large seeds", () => {
    for (const seed of [-1, -987654321, 2 ** 31, 2 ** 40 + 7]) {
      const form = generateForm({ seed });
      expect(generateForm({ seed })).toBe(form);
      assertInvariants(form, {});
    }
  });

  test("options change the output", () => {
    expect(generateForm({ seed: 1 })).not.toBe(generateForm({ seed: 1, alphabet: 5 }));
    expect(generateForm({ seed: 1, bars: 4 })).not.toBe(generateForm({ seed: 1, bars: 8 }));
  });
});

describe("generateForm invariants", () => {
  for (const { name, opts } of OPTION_SETS) {
    test(`hold for ${SEEDS} seeds: ${name}`, () => {
      for (let seed = 0; seed < SEEDS; seed++) assertInvariants(generateForm({ ...opts, seed }), opts);
    });
  }
});

describe("generateForm shape", () => {
  test("home is the most frequent label across many seeds", () => {
    const tally = new Map<string, number>();
    for (let seed = 0; seed < SEEDS; seed++) {
      for (const entry of parseForm(generateForm({ seed }))) {
        tally.set(entry.label, (tally.get(entry.label) ?? 0) + 1);
      }
    }
    const ranked = [...tally.entries()].sort((x, y) => y[1] - x[1]);
    expect(ranked[0]?.[0]).toBe("b");
  });

  test("an explicit home wins too", () => {
    const tally = new Map<string, number>();
    for (let seed = 0; seed < SEEDS; seed++) {
      for (const entry of parseForm(generateForm({ seed, alphabet: 4, count: 12, home: "c" }))) {
        tally.set(entry.label, (tally.get(entry.label) ?? 0) + 1);
      }
    }
    const ranked = [...tally.entries()].sort((x, y) => y[1] - x[1]);
    expect(ranked[0]?.[0]).toBe("c");
  });

  test("bars carry through to every occurrence", () => {
    expect(generateForm({ seed: 3, count: 4, bars: 16 })).toMatch(/^([a-f]16 ){3}[a-f]16$/);
  });

  test("a single occurrence is just the opening groove", () => {
    expect(generateForm({ seed: 42, count: 1 })).toBe("a8");
  });
});

describe("generateForm validation", () => {
  test.each([
    ["alphabet too small", { alphabet: 1 }, /alphabet/],
    ["alphabet too large", { alphabet: 7 }, /alphabet/],
    ["fractional alphabet", { alphabet: 2.5 }, /alphabet/],
    ["count below one", { count: 0 }, /count/],
    ["fractional count", { count: 4.5 }, /count/],
    ["maxRun below one", { maxRun: 0 }, /maxRun/],
    ["bars below one", { bars: 0 }, /bars/],
    ["fractional bars", { bars: 1.5 }, /bars/],
    ["home outside the alphabet", { alphabet: 3, home: "e" }, /home/],
    ["home not a letter at all", { home: "z" }, /home/],
    ["fractional seed", { seed: 1.5 }, /seed/],
  ])("throws on %s", (_name, over, message) => {
    expect(() => generateForm({ seed: 1, ...over })).toThrow(message);
  });

  test("accepts every legal alphabet size", () => {
    for (let alphabet = 2; alphabet <= 6; alphabet++) {
      expect(() => generateForm({ seed: 5, alphabet })).not.toThrow();
    }
  });
});

describe("defaultSections", () => {
  test("one section per label, keyed by its own letter", () => {
    const labels = ["a", "b", "c", "d"];
    const sections = defaultSections(labels);
    expect(Object.keys(sections)).toEqual(labels);
    for (const [key, section] of Object.entries(sections)) {
      expect(SectionSchema.safeParse(section).success).toBe(true);
      expect(section.label).toBe(key);
      expect(section.brief.length).toBeGreaterThan(0);
      expect("intensity" in section).toBe(false);
    }
  });

  test("briefs differ by role", () => {
    const sections = defaultSections(["a", "b", "c", "d", "e"]);
    const briefs = Object.values(sections).map((s) => s.brief);
    expect(new Set(briefs).size).toBe(5);
  });

  test("covers a generated form", () => {
    const form = generateForm({ seed: 11, alphabet: 5, count: 14 });
    const labels = formLabels(parseForm(form));
    const sections = defaultSections(labels);
    for (const label of labels) expect(sections[label]).toBeDefined();
  });

  test("duplicate labels collapse to one section", () => {
    expect(Object.keys(defaultSections(["a", "b", "a"]))).toEqual(["a", "b"]);
  });

  test("no labels gives no sections", () => {
    expect(defaultSections([])).toEqual({});
  });
});
