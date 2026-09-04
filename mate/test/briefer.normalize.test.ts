import { describe, expect, test } from "bun:test";
import { SongBriefSchema } from "@aibleton/protocol";
import type { Band, Template } from "@aibleton/protocol";
import { normalizeBrief } from "../src/songwriting/briefer/normalize.ts";

const template: Template = {
  id: "tpl",
  name: "tpl",
  form: "a8 b8",
  sections: { a: { label: "a", brief: "groove" }, b: { label: "b", brief: "lift" } },
  createdAt: 0,
};

const band: Band = {
  id: "band",
  name: "band",
  parts: [
    { id: "drums-kit", role: "drums", name: "kit", brief: "dry kit" },
    { id: "bass-p", role: "bass", name: "p bass", brief: "round bass" },
  ],
  metadata: {},
  createdAt: 0,
};

/** A model answer that is right in spirit and wrong in every detail the schema cares about. */
const sloppy = {
  summary: "  Funky and upbeat  ",
  genres: ["Funk", "funk", "soul", "jazz funk", "disco", "boogie", "rare groove"],
  descriptors: ["upbeat", " upbeat", "", "tight"],
  key: { root: "eb", mode: "Minor" },
  bpm: { min: 118, max: 102, target: 300 },
  timeSignature: { numerator: 4, denominator: 5 },
  swing: 1.4,
  parts: [
    { partId: "drums-kit", keep: true, brief: "", soundHints: ["breaks", "breaks", "dry", "live", "vintage", "punchy", "extra"], loopBars: 3 },
    { partId: "nope", keep: false, brief: null, soundHints: [], loopBars: 4 },
    { partId: "bass-p", brief: null, soundHints: [], loopBars: 100 },
  ],
  sections: [
    { label: "a", brief: null, descriptors: [], intensity: -2 },
    { label: "z", brief: "ghost", descriptors: [], intensity: 0.5 },
  ],
  arrangement: [{ label: "a", parts: ["drums-kit", "nope", 3] }, { label: "b" }, "junk", { parts: ["bass-p"] }],
  templateFeedback: { form: "  ", notes: "keep" },
  bandFeedback: { addParts: [{ role: "keys", name: "Rhodes", brief: "tines" }, { role: "fx", name: "riser", brief: "noise" }, { role: "x", name: "y", brief: "z" }], notes: "" },
};

describe("normalizeBrief", () => {
  const out = normalizeBrief(sloppy, template, band);
  const parsed = SongBriefSchema.safeParse(out);

  test("the repaired brief passes the strict schema", () => {
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  test("bpm is clamped and reordered so min <= target <= max", () => {
    if (!parsed.success) return;
    expect(parsed.data.bpm).toEqual({ min: 102, max: 220, target: 220 });
  });

  test("arrays are trimmed, deduplicated case-insensitively and truncated", () => {
    if (!parsed.success) return;
    expect(parsed.data.genres).toEqual(["Funk", "soul", "jazz funk", "disco", "boogie"]);
    expect(parsed.data.descriptors).toEqual(["upbeat", "tight"]);
    expect(parsed.data.parts[0]!.soundHints).toEqual(["breaks", "dry", "live", "vintage", "punchy"]);
  });

  test("key spellings are canonicalised", () => {
    if (!parsed.success) return;
    expect(parsed.data.key).toEqual({ root: "D#", mode: "minor" });
    expect((normalizeBrief({ ...sloppy, key: { root: "Bb", mode: "maj" } }, template, band) as { key: unknown }).key).toEqual({ root: "A#", mode: "major" });
    expect((normalizeBrief({ ...sloppy, key: { root: "F#", mode: "dorian" } }, template, band) as { key: unknown }).key).toEqual({ root: "F#", mode: "dorian" });
  });

  test("unknown part ids and section labels are dropped; keep defaults to true", () => {
    if (!parsed.success) return;
    expect(parsed.data.parts.map((p) => [p.partId, p.keep])).toEqual([
      ["drums-kit", true],
      ["bass-p", true],
    ]);
    expect(parsed.data.sections.map((s) => s.label)).toEqual(["a"]);
  });

  test("loop bars snap to the nearest allowed value and unit values clamp", () => {
    if (!parsed.success) return;
    expect(parsed.data.parts.map((p) => p.loopBars)).toEqual([2, 16]);
    expect(parsed.data.swing).toBe(1);
    expect(parsed.data.sections[0]!.intensity).toBe(0);
    expect(parsed.data.timeSignature).toEqual({ numerator: 4, denominator: 4 });
  });

  test("blank text becomes null and added parts are capped", () => {
    if (!parsed.success) return;
    expect(parsed.data.parts[0]!.brief).toBeNull();
    expect(parsed.data.templateFeedback.form).toBeNull();
    expect(parsed.data.bandFeedback.addParts).toHaveLength(2);
    expect(parsed.data.summary).toBe("Funky and upbeat");
  });

  test("arrangement entries keep known part ids only; entries without a label are dropped", () => {
    if (!parsed.success) return;
    expect(parsed.data.arrangement).toEqual([
      { label: "a", parts: ["drums-kit"] },
      { label: "b", parts: [] },
    ]);
  });

  test("missing feedback blocks, arrangement and time signature get defaults", () => {
    const { templateFeedback: _t, bandFeedback: _b, timeSignature: _s, arrangement: _a, ...rest } = sloppy;
    const result = SongBriefSchema.safeParse(normalizeBrief(rest, template, band));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.arrangement).toEqual([]);
      expect(result.data.templateFeedback).toEqual({ form: null, notes: "" });
      expect(result.data.bandFeedback).toEqual({ addParts: [], notes: "" });
      expect(result.data.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    }
  });

  test("shape errors still fail the schema", () => {
    expect(SongBriefSchema.safeParse(normalizeBrief({ ...sloppy, key: "E minor" }, template, band)).success).toBe(false);
    expect(SongBriefSchema.safeParse(normalizeBrief("nonsense", template, band)).success).toBe(false);
  });
});
