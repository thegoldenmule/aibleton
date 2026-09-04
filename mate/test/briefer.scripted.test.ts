import { describe, expect, test } from "bun:test";
import { SongBriefSchema } from "@aibleton/protocol";
import type { Band, Template } from "@aibleton/protocol";
import { ScriptedBriefer, defaultBrief } from "../src/songwriting/briefer/scripted.ts";

const template: Template = {
  id: "tpl",
  name: "tpl",
  form: "a8 b8 a8",
  sections: { a: { label: "a", brief: "groove" }, b: { label: "b", brief: "lift" } },
  createdAt: 0,
};

const band: Band = {
  id: "band",
  name: "band",
  parts: [
    { id: "drums-kit", role: "drums", name: "kit", brief: "dry kit" },
    { id: "bass-p", role: "bass", name: "p bass", brief: "round bass" },
    { id: "horns-stabs", role: "horns", name: "stabs", brief: "tight stabs" },
  ],
  metadata: { genre: "funk" },
  createdAt: 0,
};

const input = { text: "something funky and upbeat", template, band };

describe("ScriptedBriefer", () => {
  test("writes a valid brief that mentions every part and section", async () => {
    const briefer = new ScriptedBriefer();
    const brief = await briefer.brief(input, new AbortController().signal);
    expect(SongBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.parts.map((p) => p.partId)).toEqual(["drums-kit", "bass-p", "horns-stabs"]);
    expect(brief.sections.map((s) => s.label).sort()).toEqual(["a", "b"]);
    expect(briefer.calls).toHaveLength(1);
  });

  test("is deterministic for the same input", async () => {
    const a = await new ScriptedBriefer().brief(input, new AbortController().signal);
    const b = await new ScriptedBriefer().brief(input, new AbortController().signal);
    expect(a).toEqual(b);
  });

  test("reads the band genre for tempo and genres, and the request for mood", () => {
    const brief = defaultBrief({ ...input, text: "something funky and dirty" });
    expect(brief.genres).toEqual(["funk", "soul"]);
    expect(brief.descriptors).toEqual(["dirty"]);
    expect(brief.bpm).toEqual({ min: 96, max: 116, target: 106 });
  });

  test("a tempo word in the request overrides the genre default", () => {
    const brief = defaultBrief(input);
    expect(brief.descriptors).toEqual(["upbeat"]);
    expect(brief.bpm.target).toBe(130);
  });

  test("an explicit tempo in the request overrides the genre default", () => {
    const brief = defaultBrief({ ...input, text: "funky at 92" });
    expect(brief.bpm).toEqual({ min: 84, max: 100, target: 92 });
  });

  test("loop lengths follow the role", () => {
    const brief = defaultBrief(input);
    expect(brief.parts.map((p) => p.loopBars)).toEqual([4, 8, 2]);
  });

  test("an untagged band without genre words falls back sanely", () => {
    const brief = defaultBrief({ ...input, text: "play", band: { ...band, metadata: {} } });
    expect(SongBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.genres).toEqual(["groove"]);
  });

  test("a script replaces the default brief", async () => {
    const custom = { ...defaultBrief(input), summary: "scripted" };
    const briefer = new ScriptedBriefer(() => custom);
    expect((await briefer.brief(input, new AbortController().signal)).summary).toBe("scripted");
  });

  test("rejectNext fails once, then recovers", async () => {
    const briefer = new ScriptedBriefer();
    briefer.rejectNext(new Error("boom"));
    await expect(briefer.brief(input, new AbortController().signal)).rejects.toThrow("boom");
    await expect(briefer.brief(input, new AbortController().signal)).resolves.toBeDefined();
  });

  test("honours an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new ScriptedBriefer().brief(input, controller.signal)).rejects.toThrow("aborted");
  });
});
