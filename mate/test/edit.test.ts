import { describe, expect, test } from "bun:test";
import { LastTrackError, OccurrenceNotFoundError, TrackNotFoundError, removeTrack, setPlacement } from "../src/songwriting/edit.ts";
import { fixtureSong } from "./helpers/song.ts";

describe("removeTrack", () => {
  test("drops the part's track, slots, placements and band entry, and re-indexes", async () => {
    const song = await fixtureSong();
    expect(song.plan.tracks.map((t) => t.partId)).toEqual(["drums-kit", "bass-p", "guitar-strat"]);
    const out = removeTrack(song, "drums-kit");
    expect(out.plan.tracks.map((t) => [t.partId, t.index])).toEqual([
      ["bass-p", 0],
      ["guitar-strat", 1],
    ]);
    expect(out.plan.slots.some((s) => s.partId === "drums-kit")).toBe(false);
    expect(out.plan.placements.some((p) => p.partId === "drums-kit")).toBe(false);
    expect(out.plan.slots).toHaveLength(song.plan.slots.length - 2);
    expect(out.plan.placements).toHaveLength(song.plan.placements.length - 4);
    expect(out.band.parts.map((p) => p.id)).toEqual(["bass-p", "guitar-strat"]);
    expect(out.brief).toEqual(song.brief);
    expect(out.plan.timeline).toEqual(song.plan.timeline);
  });

  test("refuses unknown parts and the last track", async () => {
    const song = await fixtureSong();
    expect(() => removeTrack(song, "nope")).toThrow(TrackNotFoundError);
    const one = removeTrack(removeTrack(song, "drums-kit"), "bass-p");
    expect(one.plan.tracks).toHaveLength(1);
    expect(() => removeTrack(one, "guitar-strat")).toThrow(LastTrackError);
  });
});

describe("setPlacement", () => {
  test("resting a part drops its placement, and its slot once no occurrence plays it", async () => {
    const song = await fixtureSong(); // dense: a8 b8 a8 b8, three parts
    const one = setPlacement(song, "guitar-strat", 0, false);
    expect(one.plan.placements.filter((p) => p.partId === "guitar-strat").map((p) => p.occurrence)).toEqual([1, 2, 3]);
    expect(one.plan.slots.some((s) => s.id === "guitar-strat:a")).toBe(true);
    const both = setPlacement(one, "guitar-strat", 2, false);
    expect(both.plan.slots.some((s) => s.id === "guitar-strat:a")).toBe(false);
    expect(both.plan.slots).toHaveLength(song.plan.slots.length - 1);
    expect(both.plan.tracks).toEqual(song.plan.tracks);
  });

  test("bringing a part in reuses the section's slot, or makes a fresh one", async () => {
    const song = await fixtureSong();
    const rested = setPlacement(song, "bass-p", 1, false);
    const back = setPlacement(rested, "bass-p", 1, true);
    expect(back.plan.placements.filter((p) => p.partId === "bass-p").map((p) => p.occurrence)).toEqual([0, 1, 2, 3]);
    expect(back.plan.slots.find((s) => s.id === "bass-p:b")).toEqual(song.plan.slots.find((s) => s.id === "bass-p:b"));

    const gone = setPlacement(rested, "bass-p", 3, false);
    expect(gone.plan.slots.some((s) => s.id === "bass-p:b")).toBe(false);
    const fresh = setPlacement(gone, "bass-p", 3, true);
    const slot = fresh.plan.slots.find((s) => s.id === "bass-p:b")!;
    expect(slot.candidates).toEqual([]);
    expect(slot.query).toBe(song.plan.slots.find((s) => s.id === "bass-p:b")!.query);
    const placement = fresh.plan.placements.find((p) => p.partId === "bass-p" && p.occurrence === 3)!;
    expect(placement).toEqual(song.plan.placements.find((p) => p.partId === "bass-p" && p.occurrence === 3)!);
  });

  test("is a no-op when the cell is already as asked, and refuses unknown parts and occurrences", async () => {
    const song = await fixtureSong();
    expect(setPlacement(song, "bass-p", 1, true)).toBe(song);
    expect(() => setPlacement(song, "nope", 0, true)).toThrow(TrackNotFoundError);
    expect(() => setPlacement(song, "bass-p", 9, true)).toThrow(OccurrenceNotFoundError);
  });
});
