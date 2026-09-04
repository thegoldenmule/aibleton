import { describe, expect, test } from "bun:test";
import type { Band, SongBrief, Template } from "@aibleton/protocol";
import { fallbackLineup, foundationOrder, sectionIntensity, songLineup } from "../src/songwriting/lineup.ts";
import { layoutSong } from "../src/songwriting/layout.ts";
import { fixtureBand, fixtureTemplate } from "./helpers/song.ts";

const template: Template = fixtureTemplate({ form: "a8 b8 a8 b8 c4 b8" });
const band: Band = fixtureBand({
  parts: [
    { id: "horns-sec", role: "horns", name: "section", brief: "stabs" },
    { id: "guitar-strat", role: "guitar", name: "strat", brief: "chords" },
    { id: "drums-kit", role: "drums", name: "kit", brief: "breaks" },
    { id: "bass-p", role: "bass", name: "p bass", brief: "round" },
    { id: "theremin", role: "theremin", name: "wobble", brief: "eerie" },
  ],
});

function brief(over: Partial<SongBrief> = {}): SongBrief {
  return {
    summary: "s",
    genres: ["funk"],
    descriptors: [],
    key: { root: "E", mode: "minor" },
    bpm: { min: 100, max: 120, target: 110 },
    timeSignature: { numerator: 4, denominator: 4 },
    swing: null,
    parts: band.parts.map((p) => ({ partId: p.id, keep: true, brief: null, soundHints: [], loopBars: 4 as const })),
    sections: [],
    arrangement: [],
    templateFeedback: { form: null, notes: "" },
    bandFeedback: { addParts: [], notes: "" },
    ...over,
  };
}

const ids = (sets: Set<string>[]) => sets.map((s) => [...s].sort());

describe("foundationOrder", () => {
  test("rhythm section first, colour last, unknown roles with harmony, band order breaking ties", () => {
    expect(foundationOrder(band.parts).map((p) => p.id)).toEqual(["drums-kit", "bass-p", "guitar-strat", "theremin", "horns-sec"]);
  });
});

describe("sectionIntensity", () => {
  test("saved intensity wins; otherwise groove, lift, breakdown, variation by form order", () => {
    expect(sectionIntensity(template, "a")).toBe(0.6);
    expect(sectionIntensity(template, "b")).toBe(0.9);
    expect(sectionIntensity(template, "c")).toBe(0.35);
    expect(sectionIntensity({ ...template, form: "a4 b4 c4 d4" }, "d")).toBe(0.7);
    const saved = { ...template, sections: { ...template.sections, a: { label: "a", brief: "x", intensity: 1 } } };
    expect(sectionIntensity(saved, "a")).toBe(1);
  });
});

describe("fallbackLineup", () => {
  test("builds across the form: thin first passes, the full band on a later lift, a breakdown stripped back", () => {
    expect(ids(fallbackLineup(template, band))).toEqual([
      ["bass-p", "drums-kit", "guitar-strat"], // a first: ceil(5 * 0.6 * 0.7) = 3
      ["bass-p", "drums-kit", "guitar-strat", "theremin"], // b first: ceil(5 * 0.9 * 0.7) = 4
      ["bass-p", "drums-kit", "guitar-strat"], // a: ceil(5 * 0.6) = 3
      ["bass-p", "drums-kit", "guitar-strat", "horns-sec", "theremin"], // b: ceil(4.5) = 5
      ["bass-p", "drums-kit"], // c first: ceil(5 * 0.35 * 0.7) = 2
      ["bass-p", "drums-kit", "guitar-strat", "horns-sec", "theremin"],
    ]);
  });

  test("never leaves an occurrence empty, even at intensity 0", () => {
    const silent = { ...template, form: "a8", sections: { a: { label: "a", brief: "x", intensity: 0 } } };
    expect(ids(fallbackLineup(silent, band))).toEqual([["drums-kit"]]);
  });

  test("a one-part band plays everywhere", () => {
    const solo = { ...band, parts: [band.parts[0]!] };
    expect(fallbackLineup(template, solo).every((s) => s.size === 1)).toBe(true);
  });
});

describe("songLineup", () => {
  test("an aligned arrangement is taken as written, unknown ids dropped", () => {
    const arrangement = ["a", "b", "a", "b", "c", "b"].map((label, i) => ({ label, parts: i % 2 ? ["drums-kit", "bass-p", "ghost"] : ["drums-kit"] }));
    expect(ids(songLineup(template, band, brief({ arrangement })))).toEqual([
      ["drums-kit"],
      ["bass-p", "drums-kit"],
      ["drums-kit"],
      ["bass-p", "drums-kit"],
      ["drums-kit"],
      ["bass-p", "drums-kit"],
    ]);
  });

  test("a part the brief was never shown (added by its feedback) plays where the rule would put it", () => {
    const arrangement = ["a", "b", "a", "b", "c", "b"].map((label) => ({ label, parts: ["horns-sec"] }));
    const shown = brief().parts.filter((p) => p.partId !== "bass-p" && p.partId !== "guitar-strat");
    const out = ids(songLineup(template, band, brief({ arrangement, parts: shown })));
    // horns as written, plus bass and guitar where the rule plays them; drums and theremin were shown and left out, so they rest.
    expect(out[0]).toEqual(["bass-p", "guitar-strat", "horns-sec"]);
    expect(out[4]).toEqual(["bass-p", "horns-sec"]);
  });

  test("wrong length or wrong letters fall back to the rule", () => {
    const fallback = ids(fallbackLineup(template, band));
    expect(ids(songLineup(template, band, brief({ arrangement: [{ label: "a", parts: ["drums-kit"] }] })))).toEqual(fallback);
    const wrongLetters = ["a", "a", "a", "a", "a", "a"].map((label) => ({ label, parts: ["drums-kit"] }));
    expect(ids(songLineup(template, band, brief({ arrangement: wrongLetters })))).toEqual(fallback);
  });

  test("an occurrence left empty falls back for that occurrence only", () => {
    const arrangement = ["a", "b", "a", "b", "c", "b"].map((label, i) => ({ label, parts: i === 4 ? [] : ["horns-sec", "drums-kit", "bass-p", "guitar-strat", "theremin"] }));
    const out = ids(songLineup(template, band, brief({ arrangement })));
    expect(out[4]).toEqual(["bass-p", "drums-kit"]);
    expect(out[0]).toHaveLength(5);
  });
});

describe("layoutSong with a lineup", () => {
  test("rests have no placement, and a slot exists only for a part x label that is played", () => {
    const arrangement = [
      { label: "a", parts: ["drums-kit"] },
      { label: "b", parts: ["drums-kit", "bass-p"] },
      { label: "a", parts: ["drums-kit", "bass-p"] },
      { label: "b", parts: ["drums-kit", "bass-p", "guitar-strat"] },
      { label: "c", parts: ["drums-kit"] },
      { label: "b", parts: ["drums-kit", "bass-p", "guitar-strat"] },
    ];
    const plan = layoutSong(template, band, brief({ arrangement }));
    expect(plan.tracks).toHaveLength(5);
    expect(plan.slots.map((s) => s.id).sort()).toEqual(["bass-p:a", "bass-p:b", "drums-kit:a", "drums-kit:b", "drums-kit:c", "guitar-strat:b"]);
    expect(plan.placements.filter((p) => p.partId === "bass-p").map((p) => p.occurrence)).toEqual([1, 2, 3, 5]);
    expect(plan.placements.filter((p) => p.partId === "horns-sec")).toEqual([]);
    expect(plan.placements.filter((p) => p.partId === "theremin")).toEqual([]);
  });
});
