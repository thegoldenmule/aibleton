import { describe, expect, test } from "bun:test";
import { LastTrackError, TrackNotFoundError, removeTrack } from "../src/songwriting/edit.ts";
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
