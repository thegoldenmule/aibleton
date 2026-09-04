import { describe, expect, test } from "bun:test";
import type { Song, SampleSlot } from "@aibleton/protocol";
import { silentLogger } from "../src/log.ts";
import { FixtureSpliceAdapter } from "../src/ports/splice/stub.ts";
import type { Sound } from "../src/ports/splice/types.ts";
import { ScriptedBriefer, defaultBrief } from "../src/songwriting/briefer/scripted.ts";
import {
  MAX_CANDIDATES,
  MAX_QUERIES_PER_SLOT,
  NotACandidateError,
  SlotNotFoundError,
  composeQueries,
  keyScore,
  pickCandidate,
  rankCandidates,
  resolveSong,
  scoreSound,
  slotContext,
  soundBars,
} from "../src/songwriting/resolve.ts";
import { FakeSplice } from "./helpers/fakes.ts";
import { fixtureSong } from "./helpers/song.ts";

/** The fixture song briefed to C minor around 110 bpm, so scores are predictable. */
const cMinorSong = () =>
  fixtureSong(
    {},
    new ScriptedBriefer((input) => ({
      ...defaultBrief(input),
      key: { root: "C", mode: "minor" },
      bpm: { min: 100, max: 120, target: 110 },
      descriptors: ["upbeat", "tight"],
      sections: Object.values(input.template.sections).map((s) => ({ label: s.label, brief: null, descriptors: s.label === "b" ? ["big"] : [], intensity: null })),
    })),
  );

const slotOf = (song: Song, id: string): SampleSlot => {
  const slot = song.plan.slots.find((s) => s.id === id);
  if (!slot) throw new Error(`no slot ${id}`);
  return slot;
};

const sound = (over: Partial<Sound>): Sound => ({
  uuid: over.uuid ?? "00000000-0000-4000-8000-000000000000",
  fileName: "x.wav",
  bpm: 110,
  key: null,
  durationSec: 8.727,
  type: "loop",
  pack: "",
  tags: [],
  url: "https://splice.com/sounds/sample/x",
  ...over,
});

describe("composeQueries", () => {
  test("instrument first, few words, genre last, no key or bar count", async () => {
    const song = await cMinorSong();
    for (const slot of song.plan.slots) {
      const ctx = slotContext(song, slot);
      const queries = composeQueries(ctx);
      expect(queries.length).toBeGreaterThanOrEqual(1);
      expect(queries.length).toBeLessThanOrEqual(MAX_QUERIES_PER_SLOT);
      for (const q of queries) {
        expect(q).not.toMatch(/c minor/i);
        expect(q).not.toMatch(/\d+\s*bars?/i);
        expect(q.split(",").length).toBeLessThanOrEqual(5);
      }
      expect(new Set(queries.map((q) => q.toLowerCase())).size).toBe(queries.length);
    }
    const drums = composeQueries(slotContext(song, slotOf(song, "drums-kit:a")));
    expect(drums[0]).toBe("drum grooves, upbeat, tight, funk");
    expect(drums.every((q) => /grooves/.test(q))).toBe(true);
    const bass = composeQueries(slotContext(song, slotOf(song, "bass-p:b")));
    expect(bass[0]).toBe("bass loop, big, upbeat, funk");
    expect(bass).toContain("round fingerstyle bass, funk");
  });

  test("the part brief query gets the role word when the brief lacks it", async () => {
    const song = await cMinorSong();
    const ctx = { ...slotContext(song, slotOf(song, "guitar-strat:a")), partBrief: "clean ninth chords" };
    expect(composeQueries(ctx)).toContain("clean ninth chords guitar, funk");
  });
});

describe("keyScore", () => {
  test.each([
    ["same root, parallel mode", { root: "C", mode: "minor" } as const, { root: "C", mode: "minor" } as const, 25],
    ["dorian brief wants the parallel minor", { root: "C", mode: "dorian" } as const, { root: "C", mode: "minor" } as const, 25],
    ["relative key", { root: "C", mode: "major" } as const, { root: "A", mode: "minor" } as const, 18],
    ["bare root, same", { root: "C", mode: "minor" } as const, { root: "C", mode: null } as const, 20],
    ["bare root, in scale", { root: "C", mode: "minor" } as const, { root: "G", mode: null } as const, 8],
    ["bare root, out of scale", { root: "C", mode: "minor" } as const, { root: "E", mode: null } as const, 0],
    ["same root, other mode", { root: "C", mode: "minor" } as const, { root: "C", mode: "major" } as const, 10],
    ["unrelated", { root: "C", mode: "minor" } as const, { root: "F#", mode: "major" } as const, 0],
  ])("%s", (_name, slotKey, soundKey, expected) => {
    expect(keyScore(slotKey, soundKey)).toBe(expected);
  });

  test("unknown key scores a little", () => {
    expect(keyScore({ root: "C", mode: "minor" }, null)).toBe(5);
  });
});

describe("soundBars", () => {
  const sig = { numerator: 4, denominator: 4 as const };
  test.each([
    [7.7, 124, 4],
    [17.5, 110, 8],
    [8.7, 110, 4],
    [26.2, 110, 12],
    [5.0, 110, null],
    [null, 110, null],
    [8, null, null],
  ])("%p s at %p bpm -> %p bars", (durationSec, bpm, expected) => {
    expect(soundBars({ durationSec, bpm }, sig)).toBe(expected);
  });

  test("respects the time signature", () => {
    expect(soundBars({ durationSec: 8.18, bpm: 110 }, { numerator: 3, denominator: 4 })).toBe(5);
    expect(soundBars({ durationSec: 6.545, bpm: 110 }, { numerator: 6, denominator: 8 })).toBe(4);
  });
});

describe("scoreSound", () => {
  test("drums ignore key and dislike fills", async () => {
    const song = await cMinorSong();
    const ctx = slotContext(song, slotOf(song, "drums-kit:a"));
    const groove = sound({ uuid: "a", fileName: "drum_loop_groove.wav", tags: ["drums", "grooves"], key: { root: "F#", mode: "major" } });
    const fill = sound({ uuid: "b", fileName: "drum_loop_fill.wav", tags: ["drums", "fills"] });
    expect(scoreSound(ctx, groove)).toBe(scoreSound(ctx, { ...groove, key: null }));
    expect(scoreSound(ctx, groove)).toBeGreaterThan(scoreSound(ctx, fill));
  });

  test("bass prefers the key and the loop length", async () => {
    const song = await cMinorSong();
    const ctx = slotContext(song, slotOf(song, "bass-p:a"));
    expect(ctx.slot.loopBars).toBe(8);
    const right = sound({ uuid: "a", fileName: "bass_Cmin.wav", tags: ["bass"], key: { root: "C", mode: "minor" }, durationSec: 17.45 });
    const wrongKey = { ...right, key: { root: "F#" as const, mode: "major" as const } };
    const halfLength = { ...right, durationSec: 8.727 };
    const offTempo = { ...right, bpm: 119 };
    expect(scoreSound(ctx, right)).toBeGreaterThan(scoreSound(ctx, wrongKey));
    expect(scoreSound(ctx, right)).toBeGreaterThan(scoreSound(ctx, halfLength));
    expect(scoreSound(ctx, right)).toBeGreaterThan(scoreSound(ctx, offTempo));
    expect(scoreSound(ctx, right, 3)).toBe(scoreSound(ctx, right) + 6);
  });
});

describe("rankCandidates", () => {
  test("dedupes across queries, drops one-shots, caps the list", async () => {
    const song = await cMinorSong();
    const ctx = slotContext(song, slotOf(song, "bass-p:a"));
    const shared = sound({ uuid: "shared", fileName: "bass_a.wav", tags: ["bass"], key: { root: "C", mode: "minor" }, durationSec: 17.45 });
    const many = Array.from({ length: 8 }, (_, i) => sound({ uuid: `m${i}`, fileName: `bass_${i}.wav`, tags: ["bass"], bpm: 110 + i }));
    const oneShot = sound({ uuid: "hit", type: "oneshot", tags: ["bass"] });
    const ranked = rankCandidates(ctx, [[shared, oneShot, ...many.slice(0, 4)], [shared, ...many.slice(4)]]);
    expect(ranked).toHaveLength(MAX_CANDIDATES);
    expect(ranked[0]?.uuid).toBe("shared");
    expect(ranked[0]?.bars).toBe(8);
    expect(ranked.some((c) => c.uuid === "hit")).toBe(false);
    expect(new Set(ranked.map((c) => c.uuid)).size).toBe(ranked.length);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
  });
});

describe("resolveSong", () => {
  const deps = (splice: FixtureSpliceAdapter | FakeSplice, signal = new AbortController().signal) => ({ splice, log: silentLogger, signal });

  test("fills every slot from the fixture catalog and picks the top candidate", async () => {
    const song = await cMinorSong();
    const splice = new FixtureSpliceAdapter();
    const { song: resolved, failedSlotIds } = await resolveSong(song, deps(splice));
    expect(failedSlotIds).toEqual([]);
    for (const slot of resolved.plan.slots) {
      expect(slot.candidates.length).toBeGreaterThan(0);
      expect(slot.pickedUuid).toBe(slot.candidates[0]!.uuid);
      expect(slot.resolved).toBeNull();
    }
    const bass = slotOf(resolved, "bass-p:a");
    expect(bass.candidates[0]).toMatchObject({ uuid: "c3c6bb92-a2df-4199-a437-70351aac246e", bpm: 110, key: { root: "C", mode: "minor" }, bars: 8 });
    const drums = slotOf(resolved, "drums-kit:a");
    expect(drums.candidates[0]?.key).toBeNull();
    expect(drums.candidates[0]?.fileName.toLowerCase()).not.toContain("fill");
    for (const call of splice.calls) {
      expect(call.method).toBe("searchSounds");
      expect(call.args[1]).toEqual({ bpmMin: 100, bpmMax: 120, type: "loop" });
    }
    // Untouched fields survive the round trip through the schema.
    expect({ ...resolved, plan: { ...resolved.plan, slots: [] } }).toEqual({ ...song, plan: { ...song.plan, slots: [] } });
  });

  test("keeps an existing pick and never touches resolved", async () => {
    const song = await cMinorSong();
    const first = (await resolveSong(song, deps(new FixtureSpliceAdapter()))).song;
    const bass = slotOf(first, "bass-p:a");
    const second = bass.candidates[1]!.uuid;
    const picked = pickCandidate(first, "bass-p:a", second);
    const onDisk: Song = {
      ...picked,
      plan: { ...picked.plan, slots: picked.plan.slots.map((s) => (s.id === "bass-p:a" ? { ...s, resolved: { soundUuid: second, fileName: "x.wav", localPath: "/tmp/x.wav" } } : s)) },
    };
    const again = (await resolveSong(onDisk, deps(new FixtureSpliceAdapter()))).song;
    expect(slotOf(again, "bass-p:a").pickedUuid).toBe(second);
    expect(slotOf(again, "bass-p:a").resolved?.localPath).toBe("/tmp/x.wav");
  });

  test("publishes each slot as its candidates land", async () => {
    const song = await cMinorSong();
    const seen: number[] = [];
    const { song: resolved } = await resolveSong(song, { ...deps(new FixtureSpliceAdapter()), onSlot: async (s) => void seen.push(s.plan.slots.filter((x) => x.candidates.length > 0).length) });
    expect(seen).toHaveLength(song.plan.slots.length);
    expect(seen.at(-1)).toBe(song.plan.slots.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
    expect(resolved.plan.slots.every((s) => s.candidates.length > 0)).toBe(true);
  });

  test("an aborted signal stops before any search", async () => {
    const song = await cMinorSong();
    const splice = new FakeSplice();
    const controller = new AbortController();
    controller.abort();
    await expect(resolveSong(song, deps(splice, controller.signal))).rejects.toThrow(/aborted/);
    expect(splice.calls).toHaveLength(0);
  });

  test("runs at most four searches at once", async () => {
    const song = await cMinorSong();
    const splice = new FakeSplice();
    let inFlight = 0;
    let peak = 0;
    splice.search = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return [];
    };
    await resolveSong(song, deps(splice));
    expect(splice.calls.length).toBeGreaterThan(4);
    expect(peak).toBe(4);
  });

  test("one failing query still yields candidates; all failing keeps the slot and reports it", async () => {
    const song = await cMinorSong();
    const catalog = new FixtureSpliceAdapter();
    const flaky = new FakeSplice();
    let n = 0;
    flaky.search = (query, opts) => {
      if (n++ % 3 === 0) throw new Error("splice hiccup");
      return catalog.searchSounds(query, opts);
    };
    const partial = await resolveSong(song, deps(flaky));
    expect(partial.failedSlotIds).toEqual([]);
    for (const slot of partial.song.plan.slots) expect(slot.candidates.length).toBeGreaterThan(0);

    const dead = new FakeSplice();
    dead.search = () => {
      throw new Error("splice down");
    };
    const failed = await resolveSong(partial.song, deps(dead));
    expect(failed.failedSlotIds).toEqual(song.plan.slots.map((s) => s.id));
    expect(failed.song).toEqual(partial.song);
  });
});

describe("pickCandidate", () => {
  test("sets the pick and rejects unknown slots and uuids", async () => {
    const song = (await resolveSong(await cMinorSong(), { splice: new FixtureSpliceAdapter(), log: silentLogger, signal: new AbortController().signal })).song;
    const slot = slotOf(song, "guitar-strat:b");
    const uuid = slot.candidates.at(-1)!.uuid;
    expect(slotOf(pickCandidate(song, slot.id, uuid), slot.id).pickedUuid).toBe(uuid);
    expect(() => pickCandidate(song, "nope:a", uuid)).toThrow(SlotNotFoundError);
    expect(() => pickCandidate(song, slot.id, "not-a-candidate")).toThrow(NotACandidateError);
  });
});
