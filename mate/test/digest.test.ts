import { describe, expect, test } from "bun:test";
import type { Song } from "@aibleton/protocol";
import { silentLogger } from "../src/log.ts";
import { FixtureSpliceAdapter } from "../src/ports/splice/stub.ts";
import { songDigest } from "../src/songwriting/digest.ts";
import { resolveSong } from "../src/songwriting/resolve.ts";
import { setPlacement } from "../src/songwriting/edit.ts";
import { fixtureSong } from "./helpers/song.ts";

/** The fixture song with every slot searched, so candidates and picks are real. */
async function resolved(): Promise<Song> {
  const song = await fixtureSong();
  const out = await resolveSong(song, { splice: new FixtureSpliceAdapter(), log: silentLogger, signal: new AbortController().signal });
  return out.song;
}

describe("songDigest", () => {
  test("carries the song's shape and the identifiers the tools take", async () => {
    const song = await fixtureSong();
    const d = songDigest(song);

    expect(d.id).toBe(song.id);
    expect(d.name).toBe(song.name);
    expect(d.request).toBe("something funky and upbeat");
    expect(d.form).toBe("a8 b8 a8 b8");
    expect(d.bpm).toBe(song.plan.bpm);
    expect(d.key).toMatch(/^[A-G][#b]? \w+$/);
    expect(d.meter).toBe("4/4");

    // Sections in form order, first appearance wins, with the occurrences a placement addresses.
    expect(d.sections.map((s) => s.label)).toEqual(["a", "b"]);
    expect(d.sections.map((s) => s.occurrences)).toEqual([
      [0, 2],
      [1, 3],
    ]);
    expect(d.sections[0]!.bars).toBe(8);
    expect(d.sections[0]!.brief).toBe("main groove");

    expect(d.tracks.map((t) => t.partId)).toEqual(["drums-kit", "bass-p", "guitar-strat"]);
    expect(d.tracks[0]).toMatchObject({ name: "kit", role: "drums", brief: "dry breakbeat", liveName: null });
    expect(d.slots.map((s) => s.id)).toEqual(song.plan.slots.map((s) => s.id));
    expect(d.slots[0]).toMatchObject({ partId: "drums-kit", label: "a", loopBars: song.plan.slots[0]!.loopBars });
  });

  test("plays collapses the occurrences a part is in, and a rest drops out of it", async () => {
    const song = await fixtureSong();
    expect(songDigest(song).tracks.map((t) => t.plays)).toEqual(["0-3", "0-3", "0-3"]);

    const rested = setPlacement(song, "bass-p", 1, false);
    expect(songDigest(rested).tracks.find((t) => t.partId === "bass-p")!.plays).toBe("0, 2-3");
  });

  test("counts candidates instead of carrying them, and names the pick", async () => {
    const song = await resolved();
    const d = songDigest(song);
    const slot = song.plan.slots[0]!;

    expect(slot.candidates.length).toBeGreaterThan(0);
    expect(d.slots[0]!.candidates).toBe(slot.candidates.length);
    expect(d.slots[0]!.picked).toBe(slot.candidates.find((c) => c.uuid === slot.pickedUuid)!.fileName);
    expect(d.slots[0]!.downloaded).toBe(false);
    // The arrays themselves are read with a tool; nothing here should hold one.
    expect(JSON.stringify(d)).not.toContain(slot.candidates[0]!.uuid);

    expect(d.counts).toEqual({
      sections: 2,
      tracks: 3,
      slots: song.plan.slots.length,
      resolved: song.plan.slots.length,
      picked: song.plan.slots.length,
      downloaded: 0,
    });
  });

  test("an unresolved slot reads as empty rather than missing", async () => {
    const d = songDigest(await fixtureSong());
    expect(d.slots.every((s) => s.candidates === 0 && s.picked === null && !s.downloaded)).toBe(true);
    expect(d.counts.resolved).toBe(0);
  });

  /**
   * The whole point: a `Song` is tens of KB, mostly `slot.candidates`, against
   * a ~2k-token prompt. If this ever fails someone put a payload back in.
   */
  test("stays small next to the song it describes", async () => {
    const song = await resolved();
    expect(JSON.stringify(songDigest(song)).length).toBeLessThan(6000);
    expect(JSON.stringify(songDigest(song)).length * 5).toBeLessThan(JSON.stringify(song).length);
  });
});
