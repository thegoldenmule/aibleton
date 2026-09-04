import { describe, expect, test } from "bun:test";
import { BandSchema, TemplateSchema } from "@aibleton/protocol";
import type { Band, SongBrief, Template } from "@aibleton/protocol";
import { applyFeedback } from "../src/songwriting/feedback.ts";

const template: Template = {
  id: "tpl",
  name: "tpl",
  form: "a8 b8 a8 b8",
  sections: {
    a: { label: "a", brief: "groove" },
    b: { label: "b", brief: "lift" },
  },
  createdAt: 0,
};

const band: Band = {
  id: "band",
  name: "band",
  parts: [
    { id: "drums-kit", role: "drums", name: "kit", brief: "dry kit" },
    { id: "bass-p", role: "bass", name: "p bass", brief: "round bass" },
    { id: "guitar-strat", role: "guitar", name: "strat", brief: "clean chords" },
  ],
  metadata: { genre: "funk" },
  createdAt: 0,
};

/** A brief that changes nothing, to be overridden per test. */
function brief(overrides: Partial<SongBrief> = {}): SongBrief {
  return {
    summary: "a funky jam",
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
    ...overrides,
  };
}

describe("applyFeedback", () => {
  test("an empty brief leaves both documents unchanged", () => {
    const out = applyFeedback(template, band, brief());
    expect(out.template).toEqual(template);
    expect(out.band).toEqual(band);
  });

  test("results always pass the protocol schemas", () => {
    const out = applyFeedback(template, band, brief());
    expect(TemplateSchema.safeParse(out.template).success).toBe(true);
    expect(BandSchema.safeParse(out.band).success).toBe(true);
  });

  test("section notes override brief and intensity; unknown labels are ignored", () => {
    const out = applyFeedback(
      template,
      band,
      brief({
        sections: [
          { label: "a", brief: "tighter groove", descriptors: [], intensity: 0.4 },
          { label: "z", brief: "ghost", descriptors: [], intensity: 1 },
        ],
      }),
    );
    expect(out.template.sections.a).toEqual({ label: "a", brief: "tighter groove", intensity: 0.4 });
    expect(out.template.sections.b).toEqual({ label: "b", brief: "lift" });
    expect(out.template.sections.z).toBeUndefined();
  });

  test("a null or blank section brief keeps the original", () => {
    const out = applyFeedback(template, band, brief({ sections: [{ label: "a", brief: "  ", descriptors: [], intensity: null }] }));
    expect(out.template.sections.a!.brief).toBe("groove");
  });

  test("a revised form is accepted when it uses known labels", () => {
    const out = applyFeedback(template, band, brief({ templateFeedback: { form: "a8 a8 b4 b4, a8", notes: "" } }));
    expect(out.template.form).toBe("a8 a8 b4 b4 a8");
  });

  test("a revised form with an unknown label or bad syntax is dropped", () => {
    expect(applyFeedback(template, band, brief({ templateFeedback: { form: "a8 c8", notes: "" } })).template.form).toBe(template.form);
    expect(applyFeedback(template, band, brief({ templateFeedback: { form: "8a b", notes: "" } })).template.form).toBe(template.form);
    expect(applyFeedback(template, band, brief({ templateFeedback: { form: "   ", notes: "" } })).template.form).toBe(template.form);
  });

  test("keep:false drops a part; unknown part ids are ignored", () => {
    const out = applyFeedback(
      template,
      band,
      brief({
        parts: [
          { partId: "guitar-strat", keep: false, brief: null, soundHints: [], loopBars: 4 },
          { partId: "nope", keep: false, brief: null, soundHints: [], loopBars: 4 },
        ],
      }),
    );
    expect(out.band.parts.map((p) => p.id)).toEqual(["drums-kit", "bass-p"]);
  });

  test("a part brief override replaces the Splice brief", () => {
    const out = applyFeedback(
      template,
      band,
      brief({ parts: [{ partId: "bass-p", keep: true, brief: "slap bass with dead notes", soundHints: [], loopBars: 8 }] }),
    );
    expect(out.band.parts[1]!.brief).toBe("slap bass with dead notes");
  });

  test("dropping every part keeps the original line-up", () => {
    const out = applyFeedback(
      template,
      band,
      brief({ parts: band.parts.map((p) => ({ partId: p.id, keep: false, brief: null, soundHints: [], loopBars: 4 as const })) }),
    );
    expect(out.band.parts.map((p) => p.id)).toEqual(band.parts.map((p) => p.id));
  });

  test("added parts get unique slug ids and are appended in order", () => {
    const out = applyFeedback(
      template,
      band,
      brief({
        bandFeedback: {
          addParts: [
            { role: "keys", name: "Rhodes", brief: "warm tines" },
            { role: "guitar", name: "strat", brief: "a second strat" },
          ],
          notes: "",
        },
      }),
    );
    const ids = out.band.parts.map((p) => p.id);
    expect(ids).toEqual(["drums-kit", "bass-p", "guitar-strat", "keys-rhodes", "guitar-strat-2"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BandSchema.safeParse(out.band).success).toBe(true);
  });

  test("blank added parts are skipped", () => {
    const out = applyFeedback(
      template,
      band,
      brief({ bandFeedback: { addParts: [{ role: " ", name: "x", brief: "y" }], notes: "" } }),
    );
    expect(out.band.parts).toHaveLength(3);
  });

  test("inputs are not mutated", () => {
    const before = JSON.stringify({ template, band });
    applyFeedback(
      template,
      band,
      brief({
        sections: [{ label: "a", brief: "changed", descriptors: [], intensity: 1 }],
        parts: [{ partId: "drums-kit", keep: false, brief: null, soundHints: [], loopBars: 4 }],
        bandFeedback: { addParts: [{ role: "fx", name: "riser", brief: "noise" }], notes: "" },
      }),
    );
    expect(JSON.stringify({ template, band })).toBe(before);
  });
});
