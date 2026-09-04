import { describe, expect, test } from "bun:test";
import { SongPlanSchema, songTracks } from "@aibleton/protocol";
import type { Band, SongBrief, Template } from "@aibleton/protocol";
import { fitLoop, layoutSong } from "../src/songwriting/layout.ts";

const template: Template = {
  id: "tpl",
  name: "tpl",
  form: "a8 b8 a8",
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
    { id: "guitar-strat", role: "guitar", name: "strat", brief: "clean chords" },
    { id: "bass-p", role: "bass", name: "p bass", brief: "round bass" },
  ],
  metadata: { genre: "funk" },
  createdAt: 0,
};

const brief: SongBrief = {
  summary: "a funky jam",
  genres: ["funk", "soul"],
  descriptors: ["upbeat"],
  key: { root: "E", mode: "minor" },
  bpm: { min: 100, max: 120, target: 110 },
  timeSignature: { numerator: 4, denominator: 4 },
  swing: null,
  parts: [
    { partId: "guitar-strat", keep: true, brief: null, soundHints: ["wah"], loopBars: 4 },
    { partId: "bass-p", keep: true, brief: null, soundHints: [], loopBars: 8 },
  ],
  sections: [{ label: "b", brief: null, descriptors: ["busy"], intensity: 0.8 }],
  // Everyone everywhere, so the loop arithmetic below is not tangled with the lineup rule.
  arrangement: [
    { label: "a", parts: ["guitar-strat", "bass-p"] },
    { label: "b", parts: ["guitar-strat", "bass-p"] },
    { label: "a", parts: ["guitar-strat", "bass-p"] },
  ],
  templateFeedback: { form: null, notes: "" },
  bandFeedback: { addParts: [], notes: "" },
};

describe("fitLoop", () => {
  test.each([
    [8, 4, 4],
    [8, 8, 8],
    [8, 16, 8],
    [6, 4, 2],
    [5, 8, 1],
    [16, 8, 8],
    [4, 1, 1],
    [12, 8, 4],
  ] as const)("bars %i preferred %i -> %i", (bars, preferred, expected) => {
    expect(fitLoop(bars, preferred)).toBe(expected);
  });
});

describe("layoutSong", () => {
  const plan = layoutSong(template, band, brief);

  test("passes the plan schema", () => {
    expect(SongPlanSchema.safeParse(plan).success).toBe(true);
  });

  test("tracks follow band order and are audio", () => {
    expect(plan.tracks).toEqual([
      { index: 0, partId: "guitar-strat", name: "strat", role: "guitar", kind: "audio", liveName: null },
      { index: 1, partId: "bass-p", name: "p bass", role: "bass", kind: "audio", liveName: null },
    ]);
  });

  test("timeline accumulates bars and beats in 4/4", () => {
    expect(plan.timeline).toEqual([
      { index: 0, label: "a", bars: 8, startBar: 0, startBeat: 0, lengthBeats: 32 },
      { index: 1, label: "b", bars: 8, startBar: 8, startBeat: 32, lengthBeats: 32 },
      { index: 2, label: "a", bars: 8, startBar: 16, startBeat: 64, lengthBeats: 32 },
    ]);
  });

  test("guitar loops a 4-bar sample twice while bass plays one 8-bar sample", () => {
    const guitar = plan.placements.filter((p) => p.partId === "guitar-strat");
    const bass = plan.placements.filter((p) => p.partId === "bass-p");
    expect(guitar.map((p) => [p.loopBars, p.repeats])).toEqual([[4, 2], [4, 2], [4, 2]]);
    expect(bass.map((p) => [p.loopBars, p.repeats])).toEqual([[8, 1], [8, 1], [8, 1]]);
  });

  test("slots dedupe by part x label so repeated sections reuse one sample", () => {
    expect(plan.slots.map((s) => s.id).sort()).toEqual(["bass-p:a", "bass-p:b", "guitar-strat:a", "guitar-strat:b"]);
    const guitarA = plan.placements.filter((p) => p.partId === "guitar-strat" && p.label === "a");
    expect(guitarA.map((p) => p.slotId)).toEqual(["guitar-strat:a", "guitar-strat:a"]);
    expect(plan.slots.every((s) => s.resolved === null)).toBe(true);
  });

  test("slot queries compose part brief, section brief, hints, genres, descriptors and key", () => {
    const slot = plan.slots.find((s) => s.id === "guitar-strat:b")!;
    expect(slot.query).toBe("clean chords, lift, wah, busy, funk, soul, upbeat, E minor");
    expect(slot.tags).toEqual(["wah", "busy", "funk", "soul", "upbeat"]);
    expect(slot.bpm).toEqual(brief.bpm);
    expect(slot.loopBars).toBe(4);
  });

  test("a shorter occurrence of the same section loops the same slot fewer times", () => {
    const shorter = { ...template, form: "b8 b4" };
    const both = ["guitar-strat", "bass-p"];
    const out = layoutSong(shorter, band, { ...brief, arrangement: [{ label: "b", parts: both }, { label: "b", parts: both }] });
    const guitar = out.placements.filter((p) => p.partId === "guitar-strat");
    expect(guitar.map((p) => [p.slotId, p.loopBars, p.repeats])).toEqual([
      ["guitar-strat:b", 4, 2],
      ["guitar-strat:b", 4, 1],
    ]);
  });

  test("a part the brief does not mention gets the default loop length", () => {
    const out = layoutSong(template, band, { ...brief, parts: [] });
    expect(out.slots.every((s) => s.loopBars === 4)).toBe(true);
  });

  test("time signature drives beats per bar", () => {
    const out = layoutSong(template, band, { ...brief, timeSignature: { numerator: 6, denominator: 8 } });
    expect(out.timeline[0]!.lengthBeats).toBe(24);
    expect(out.timeline[1]!.startBeat).toBe(24);
  });

  test("is deterministic", () => {
    expect(layoutSong(template, band, brief)).toEqual(plan);
  });
});

describe("songTracks", () => {
  const song = { template, plan: layoutSong(template, band, brief) };
  const tracks = songTracks(song);

  test("one clip slot per section label in form order", () => {
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.clipSlots.map((s) => s.clip?.name)).toEqual(["a · 4 bars", "b · 4 bars"]);
    expect(tracks[1]!.clipSlots.map((s) => s.clip?.length)).toEqual([32, 32]);
  });

  test("one arrangement clip per placement with loop x repeats in the name", () => {
    expect(tracks[0]!.arrangementClips.map((c) => c.name)).toEqual(["a · 4×2", "b · 4×2", "a · 4×2"]);
    expect(tracks[1]!.arrangementClips.map((c) => [c.startTime, c.endTime])).toEqual([[0, 32], [32, 64], [64, 96]]);
  });
});
