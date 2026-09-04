import { describe, expect, test } from "bun:test";
import type { Band, Template } from "@aibleton/protocol";
import { BRIEF_SYSTEM_PROMPT, renderBriefPrompt } from "../src/songwriting/briefer/prompt.ts";
import { SONG_BRIEF_JSON_SCHEMA } from "../src/songwriting/briefer/schema.ts";

const template: Template = {
  id: "tpl",
  name: "Tuesday jam",
  form: "a8 b8 a8 c4",
  sections: {
    a: { label: "a", brief: "main groove" },
    b: { label: "b", brief: "lift", intensity: 0.8 },
    c: { label: "c", brief: "breakdown" },
  },
  bpm: 112,
  createdAt: 0,
};

const band: Band = {
  id: "band",
  name: "The Meters-ish",
  parts: [
    { id: "drums-breakbeat-kit", role: "drums", name: "breakbeat kit", brief: "dry breakbeat" },
    { id: "bass-slap-bass", role: "bass", name: "slap bass", brief: "slap and pop" },
    { id: "keys-rhodes", role: "keys", name: "Rhodes", brief: "warm tines" },
  ],
  metadata: { genre: "funk" },
  createdAt: 0,
};

describe("renderBriefPrompt", () => {
  const text = renderBriefPrompt({ text: "something funky and upbeat", template, band });

  test("carries the request, every part id and every section label", () => {
    expect(text).toContain('"something funky and upbeat"');
    for (const part of band.parts) expect(text).toContain(`id=${part.id}`);
    for (const label of ["a", "b", "c"]) expect(text).toContain(`section ${label}:`);
  });

  test("carries the form, saved tempo, genre and part order", () => {
    expect(text).toContain("form a8 b8 a8 c4");
    expect(text).toContain("112 bpm");
    expect(text).toContain("genre: funk");
    expect(text.indexOf("drums-breakbeat-kit")).toBeLessThan(text.indexOf("bass-slap-bass"));
    expect(text).toContain("(intensity 0.8)");
  });

  test("the system prompt is frozen text that names the contract", () => {
    expect(BRIEF_SYSTEM_PROMPT).toContain("loopBars");
    expect(BRIEF_SYSTEM_PROMPT).toContain("templateFeedback");
    expect(BRIEF_SYSTEM_PROMPT).toContain("bandFeedback");
    expect(BRIEF_SYSTEM_PROMPT).toContain("1, 2, 4, 8, 16");
  });
});

describe("SONG_BRIEF_JSON_SCHEMA", () => {
  /** Every object in the schema must be closed and fully required, the structured-output subset. */
  function walk(node: unknown, path: string, visit: (obj: Record<string, unknown>, path: string) => void): void {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`, visit));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "object") visit(obj, path);
    for (const [key, value] of Object.entries(obj)) walk(value, `${path}.${key}`, visit);
  }

  test("every object is closed and lists every property as required", () => {
    let objects = 0;
    walk(SONG_BRIEF_JSON_SCHEMA, "$", (obj, path) => {
      objects++;
      expect(obj.additionalProperties, path).toBe(false);
      const props = Object.keys(obj.properties as Record<string, unknown>);
      expect((obj.required as string[]).slice().sort(), path).toEqual(props.slice().sort());
    });
    expect(objects).toBeGreaterThanOrEqual(8);
  });

  test("uses no constraints the API rejects", () => {
    const banned = ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern"];
    const json = JSON.stringify(SONG_BRIEF_JSON_SCHEMA);
    for (const word of banned) expect(json, word).not.toContain(`"${word}"`);
  });

  test("top-level properties mirror SongBriefSchema", () => {
    expect(Object.keys(SONG_BRIEF_JSON_SCHEMA.properties as object).sort()).toEqual(
      ["summary", "genres", "descriptors", "key", "bpm", "timeSignature", "swing", "parts", "sections", "templateFeedback", "bandFeedback"].sort(),
    );
  });
});
