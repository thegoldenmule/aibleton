import { describe, expect, test } from "bun:test";
import { applyFeedback } from "../src/songwriting/feedback.ts";
import { briefFields, editFields, layoutFields, pickedFields } from "../src/songwriting/narrate.ts";
import { defaultBrief } from "../src/songwriting/briefer/scripted.ts";
import { layoutSong } from "../src/songwriting/layout.ts";
import { fixtureBand, fixtureTemplate } from "./helpers/song.ts";

const value = (fields: { label: string; value: string }[], label: string) => fields.find((f) => f.label === label)?.value;

describe("pickedFields", () => {
  test("names the form, its length, every section and the line-up", () => {
    const fields = pickedFields(fixtureTemplate(), fixtureBand());
    expect(value(fields, "form")).toBe("Tuesday jam — A8 B8 A8 B8");
    expect(value(fields, "length")).toBe("4 sections, 32 bars");
    expect(value(fields, "section A")).toBe("main groove");
    expect(value(fields, "band")).toBe("The Pocket");
    expect(value(fields, "parts")).toContain("kit (drums)");
  });
});

describe("briefFields", () => {
  test("splits the model's answer into the numbers and the words", () => {
    const brief = defaultBrief({ text: "dark funk at 96", template: fixtureTemplate(), band: fixtureBand() });
    const fields = briefFields({ ...brief, swing: 0.6, descriptors: ["dark", "dry"] });
    expect(value(fields, "tempo")).toBe("96 bpm (88–104)");
    expect(value(fields, "meter")).toBe("4/4 · swing 60%");
    expect(value(fields, "genres")).toBe("funk, soul");
    expect(value(fields, "feel")).toBe("dark, dry");
    expect(value(fields, "summary")).toBe(brief.summary);
  });
});

describe("editFields", () => {
  const template = fixtureTemplate();
  const band = fixtureBand();
  const base = defaultBrief({ text: "funk", template, band });

  test("is empty when the brief changes nothing", () => {
    const revised = applyFeedback(template, band, base);
    expect(editFields(template, band, revised.template, revised.band)).toEqual([]);
  });

  test("spells out the form, the sections and the parts that changed", () => {
    const brief = {
      ...base,
      parts: base.parts.map((p) => (p.partId === "guitar-strat" ? { ...p, keep: false } : p.partId === "bass-p" ? { ...p, brief: "muted octaves" } : p)),
      sections: [{ label: "b", brief: "big lift", descriptors: [], intensity: 0.9 }],
      templateFeedback: { form: "a8 b8 b8 a8", notes: "" },
      bandFeedback: { addParts: [{ role: "keys", name: "clav", brief: "wah clav stabs" }], notes: "" },
    };
    const revised = applyFeedback(template, band, brief);
    const fields = editFields(template, band, revised.template, revised.band);
    expect(value(fields, "form")).toBe("A8 B8 A8 B8 → A8 B8 B8 A8");
    expect(value(fields, "section B")).toBe("intensity unset → 0.9 · “big lift”");
    expect(value(fields, "dropped")).toBe("strat (guitar)");
    expect(value(fields, "added")).toBe("clav (keys)");
    expect(value(fields, "p bass")).toBe("“muted octaves”");
  });
});

describe("layoutFields", () => {
  test("counts the plan and names who sits out", () => {
    const brief = defaultBrief({ text: "funk", template: fixtureTemplate(), band: fixtureBand() });
    const plan = layoutSong(fixtureTemplate(), fixtureBand(), brief);
    expect(value(layoutFields(plan), "tracks")).toBe("3");
    expect(value(layoutFields(plan), "timeline")).toBe(`4 sections at ${plan.bpm} bpm`);
    expect(value(layoutFields(plan), "resting")).toBeDefined();
  });
});
