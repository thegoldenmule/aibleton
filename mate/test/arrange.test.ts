import { describe, expect, test } from "bun:test";
import type { Song } from "@aibleton/protocol";
import { dawStatus, fullyArranged } from "@aibleton/protocol";
import { silentLogger } from "../src/log.ts";
import { InMemoryAbletonAdapter } from "../src/ports/ableton/stub.ts";
import { arrangeSong, describeStep } from "../src/songwriting/arrange.ts";
import { fixtureSong } from "./helpers/song.ts";

async function songOnDisk(partIds: string[] = ["drums-kit", "bass-p", "guitar-strat"]): Promise<Song> {
  const song = await fixtureSong();
  return {
    ...song,
    plan: {
      ...song.plan,
      slots: song.plan.slots.map((s) =>
        partIds.includes(s.partId)
          ? { ...s, pickedUuid: `uuid-${s.id}`, resolved: { soundUuid: `uuid-${s.id}`, fileName: `${s.id}.wav`, localPath: `/dl/${s.id}.wav` } }
          : s,
      ),
    },
  };
}

function deps(live: InMemoryAbletonAdapter, over: Partial<Parameters<typeof arrangeSong>[1]> = {}) {
  const progress: Song[] = [];
  const snapshots: number[] = [];
  return {
    deps: {
      ableton: live,
      log: silentLogger,
      signal: new AbortController().signal,
      onProgress: async (s: Song) => void progress.push(s),
      onSnapshot: () => void snapshots.push(1),
      userPrompt: "play something funky",
      ...over,
    },
    progress,
    snapshots,
  };
}

describe("arrangeSong", () => {
  test("first run: tempo, tracks, clips, copies and locators, then nothing is left", async () => {
    const song = await songOnDisk();
    const live = new InMemoryAbletonAdapter({ clipBeats: (p) => (p.includes("bass") ? 32 : 16) });
    const { deps: d, progress } = deps(live);
    const out = await arrangeSong(song, d);
    const calls = live.calls.slice();

    expect(out.failed).toEqual([]);
    expect(fullyArranged(out.status)).toBe(true);
    expect(out.song.plan.tracks.map((t) => t.liveName)).toEqual(["kit [mate]", "p bass [mate]", "strat [mate]"]);
    // Track names land on the song as they are created, so a crash mid-way loses nothing.
    expect(progress.map((s) => s.plan.tracks.filter((t) => t.liveName).length)).toEqual([1, 2, 3]);

    const snap = await live.getSnapshot();
    expect(snap.transport.tempo).toBe(song.plan.bpm);
    expect(snap.tracks.slice(4).map((t) => [t.name, t.kind])).toEqual([
      ["kit [mate]", "audio"],
      ["p bass [mate]", "audio"],
      ["strat [mate]", "audio"],
    ]);
    const bass = snap.tracks[5]!;
    expect(bass.clipSlots.slice(0, 2).map((s) => [s.clip?.name, s.clip?.filePath])).toEqual([
      ["a · bass-p:a", "/dl/bass-p:a.wav"],
      ["b · bass-p:b", "/dl/bass-p:b.wav"],
    ]);
    // 32-beat bass clips: one per 32-beat section. 16-beat guitar clips: two.
    expect(bass.arrangementClips.map((c) => [c.name, c.startTime])).toEqual([
      ["a · bass-p:a", 0],
      ["b · bass-p:b", 32],
      ["a · bass-p:a", 64],
      ["b · bass-p:b", 96],
    ]);
    expect(snap.tracks[6]!.arrangementClips.map((c) => c.startTime)).toEqual([0, 16, 32, 48, 64, 80, 96, 112]);
    expect(snap.locators).toEqual([
      { name: "a1", time: 0 },
      { name: "b1", time: 32 },
      { name: "a2", time: 64 },
      { name: "b2", time: 96 },
    ]);
    // Every call carried the request text for the server's telemetry field.
    expect(calls.every((c) => c.ctx?.userPrompt === "play something funky")).toBe(true);
    // The drummer's own tracks were never touched.
    expect(calls.filter((c) => typeof c.args[0] === "number" && (c.args[0] as number) < 4)).toEqual([]);

    // A second run is a no-op.
    const again = await arrangeSong(out.song, deps(live).deps);
    expect(again.applied).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  test("only what is on disk goes in; a later run adds the rest without touching what is there", async () => {
    const live = new InMemoryAbletonAdapter();
    const first = await arrangeSong(await songOnDisk(["bass-p"]), deps(live).deps);
    expect(first.status.slots.filter((s) => s.state === "in-live").map((s) => s.slotId)).toEqual(["bass-p:a", "bass-p:b"]);
    expect(first.status.slots.filter((s) => s.state === "waiting")).toHaveLength(4);
    const callsAfterFirst = live.calls.length;

    // The guitar lands: same song, its tracks already named.
    const later = await songOnDisk(["bass-p", "guitar-strat"]);
    const merged: Song = { ...later, plan: { ...later.plan, tracks: first.song.plan.tracks } };
    const second = await arrangeSong(merged, deps(live).deps);
    expect(second.failed).toEqual([]);
    expect(second.applied.map(describeStep).filter((s) => s.startsWith("import"))).toEqual([
      "import guitar-strat:a into track 6 scene 0",
      "import guitar-strat:b into track 6 scene 1",
    ]);
    expect(second.applied.some((s) => s.type === "createTrack" || s.type === "setTempo")).toBe(false);
    expect(live.calls.slice(callsAfterFirst).filter((c) => c.method !== "getSnapshot").every((c) => c.args[0] === 6)).toBe(true);
  });

  test("a re-pick replaces the scene's clip; the old arrangement copies are cut by the new ones", async () => {
    const live = new InMemoryAbletonAdapter();
    const song = await songOnDisk(["bass-p"]);
    const first = await arrangeSong(song, deps(live).deps);
    const repicked: Song = {
      ...first.song,
      plan: {
        ...first.song.plan,
        slots: first.song.plan.slots.map((s) => (s.id === "bass-p:a" ? { ...s, pickedUuid: "uuid-new", resolved: { soundUuid: "uuid-new", fileName: "new.wav", localPath: "/dl/new.wav" } } : s)),
      },
    };
    const second = await arrangeSong(repicked, deps(live).deps);
    expect(second.applied.map((s) => s.type)).toEqual(["replaceClip", "placeClip", "placeClip", "placeClip", "placeClip"]);
    const bass = (await live.getSnapshot()).tracks[5]!;
    expect(bass.clipSlots[0]!.clip?.filePath).toBe("/dl/new.wav");
    expect(bass.arrangementClips.filter((c) => c.filePath === "/dl/new.wav").map((c) => c.startTime)).toEqual([0, 16, 64, 80]);
    expect(bass.arrangementClips.some((c) => c.filePath === "/dl/bass-p:a.wav")).toBe(false);
  });

  test("a failing step is reported and stops further rounds; the next run resumes", async () => {
    const live = new InMemoryAbletonAdapter();
    const song = await songOnDisk(["bass-p"]);
    const original = live.createAudioClip.bind(live);
    let fail = true;
    live.createAudioClip = async (track, slot, path, ctx) => {
      if (fail && path.endsWith("bass-p:b.wav")) throw new Error("Error creating audio clip: Live said no");
      return original(track, slot, path, ctx);
    };
    const first = await arrangeSong(song, deps(live).deps);
    expect(first.failed.map((f) => [describeStep(f.step), f.error])).toEqual([["import bass-p:b into track 5 scene 1", "Error creating audio clip: Live said no"]]);
    // The round finished (the a-clip went in) but placements waited for the next look.
    expect(first.status.slots.map((s) => s.state)).toEqual(["waiting", "waiting", "in-live", "pending", "waiting", "waiting"]);
    expect(first.status.steps.some((s) => s.type === "placeClip")).toBe(true);

    fail = false;
    const second = await arrangeSong(first.song, deps(live).deps);
    expect(second.failed).toEqual([]);
    expect(fullyArranged(second.status)).toBe(true);
  });

  test("an aborted request stops before the next step", async () => {
    const live = new InMemoryAbletonAdapter();
    const controller = new AbortController();
    controller.abort();
    const out = await arrangeSong(await songOnDisk(), deps(live, { signal: controller.signal }).deps);
    expect(out.applied).toEqual([]);
    expect(live.calls.filter((c) => c.method !== "getSnapshot")).toEqual([]);
    expect(dawStatus(out.song, await live.getSnapshot()).steps.length).toBeGreaterThan(0);
  });
});
