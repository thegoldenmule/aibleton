import { describe, expect, test } from "bun:test";
import type { DawState, Song } from "@aibleton/protocol";
import { dawStatus, fullyArranged, isMateTrack, liveClipName, locatorName, mateTrackName, ownedTrackIndexes, sceneIndexOf, uniqueTrackName } from "@aibleton/protocol";
import { InMemoryAbletonAdapter } from "../src/ports/ableton/stub.ts";
import { fixtureSong } from "./helpers/song.ts";

/** The fixture song with every slot of `partIds` "downloaded" to /dl/<slotId>.wav. */
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

const withLiveNames = (song: Song, names: Record<string, string>): Song => ({
  ...song,
  plan: { ...song.plan, tracks: song.plan.tracks.map((t) => ({ ...t, liveName: names[t.partId] ?? t.liveName })) },
});

describe("track names", () => {
  test("mark and find mate's tracks", () => {
    expect(mateTrackName("Bass")).toBe("Bass [mate]");
    expect(mateTrackName("Bass [mate]")).toBe("Bass [mate]");
    expect(isMateTrack({ name: "Bass [mate]" })).toBe(true);
    expect(isMateTrack({ name: "Bass" })).toBe(false);
    expect(uniqueTrackName("Bass", new Set(["Bass [mate]", "Bass 2 [mate]"]))).toBe("Bass 3 [mate]");
    expect(uniqueTrackName("kit [mate]", new Set())).toBe("kit [mate]");
    const s: Pick<DawState, "tracks"> = { tracks: [{ index: 0, name: "1-MIDI" }, { index: 3, name: "kit [mate]" }] as DawState["tracks"] };
    expect([...ownedTrackIndexes(s)]).toEqual([3]);
  });

  test("scene, clip and locator names come from the form", async () => {
    const song = await songOnDisk();
    expect(sceneIndexOf(song, "a")).toBe(0);
    expect(sceneIndexOf(song, "b")).toBe(1);
    expect(sceneIndexOf(song, "z")).toBe(-1);
    expect(liveClipName(song.plan.slots.find((s) => s.id === "bass-p:a")!)).toBe("a · bass-p:a");
    expect(song.plan.timeline.map((o) => locatorName(song.plan.timeline, o))).toEqual(["a1", "b1", "a2", "b2"]);
  });
});

describe("dawStatus", () => {
  test("without a snapshot nothing can be planned", async () => {
    const song = await songOnDisk();
    const st = dawStatus(song, null);
    expect(st.steps).toEqual([]);
    expect(st.slots.every((s) => s.state === "pending")).toBe(true);
    expect(st.notes).toEqual(["no Ableton snapshot yet"]);
  });

  test("first run: tempo once, then one track per part, nothing else until the tracks exist", async () => {
    const song = await songOnDisk();
    const session = await new InMemoryAbletonAdapter().getSnapshot();
    const st = dawStatus(song, session);
    expect(st.steps.filter((s) => s.type !== "createLocator")).toEqual([
      { type: "setTempo", bpm: song.plan.bpm },
      { type: "createTrack", partId: "drums-kit", name: "kit [mate]" },
      { type: "createTrack", partId: "bass-p", name: "p bass [mate]" },
      { type: "createTrack", partId: "guitar-strat", name: "strat [mate]" },
    ]);
    expect(st.tracks.map((t) => t.index)).toEqual([null, null, null]);
    expect(st.slots.every((s) => s.state === "pending")).toBe(true);
    expect(st.placements.every((p) => !p.placed)).toBe(true);
  });

  test("a slot that is not on disk waits; a track only gets steps for downloaded slots", async () => {
    const song = withLiveNames(await songOnDisk(["bass-p"]), { "drums-kit": "kit [mate]", "bass-p": "p bass [mate]", "guitar-strat": "strat [mate]" });
    const live = new InMemoryAbletonAdapter();
    for (const n of ["kit [mate]", "p bass [mate]", "strat [mate]"]) await live.createAudioTrack(n);
    const st = dawStatus(song, await live.getSnapshot());
    expect(st.steps.filter((s) => s.type !== "createLocator")).toEqual([
      { type: "importClip", partId: "bass-p", slotId: "bass-p:a", track: 5, scene: 0, path: "/dl/bass-p:a.wav", name: "a · bass-p:a" },
      { type: "importClip", partId: "bass-p", slotId: "bass-p:b", track: 5, scene: 1, path: "/dl/bass-p:b.wav", name: "b · bass-p:b" },
    ]);
    expect(st.slots.find((s) => s.slotId === "drums-kit:a")?.state).toBe("waiting");
    expect(st.steps.filter((s) => s.type === "createLocator").map((s) => (s.type === "createLocator" ? [s.name, s.atBeat] : null))).toEqual([
      ["a1", 0],
      ["b1", 32],
      ["a2", 64],
      ["b2", 96],
    ]);
    // Tempo is only set on the first run; here every track already has a name.
    expect(st.steps.some((s) => s.type === "setTempo")).toBe(false);
  });

  test("a renamed or deleted track is created again, with a note", async () => {
    const song = withLiveNames(await songOnDisk(["bass-p"]), { "bass-p": "p bass [mate]" });
    const st = dawStatus(song, await new InMemoryAbletonAdapter().getSnapshot());
    expect(st.steps).toContainEqual({ type: "createTrack", partId: "bass-p", name: "p bass [mate]" });
    expect(st.notes[0]).toMatch(/no longer in the set/);
  });

  test("imported clips are placed once per copy at Live's own length; stale ones are replaced", async () => {
    const song = withLiveNames(await songOnDisk(["bass-p"]), { "drums-kit": "kit [mate]", "bass-p": "p bass [mate]", "guitar-strat": "strat [mate]" });
    // The bass wanted 8-bar loops; Live made 16-beat clips, which still fill the 32-beat sections twice. The b-scene holds an old pick.
    const live = new InMemoryAbletonAdapter({ clipBeats: () => 16 });
    await live.createAudioTrack("kit [mate]");
    const t = await live.createAudioTrack("p bass [mate]");
    await live.createAudioTrack("strat [mate]");
    await live.createAudioClip(t, 0, "/dl/bass-p:a.wav");
    await live.createAudioClip(t, 1, "/dl/old-pick.wav");
    await live.duplicateToArrangement(t, 0, 0);
    let st = dawStatus(song, await live.getSnapshot());
    expect(st.slots.find((s) => s.slotId === "bass-p:a")).toMatchObject({ state: "in-live", lengthBeats: 16, expectedBeats: 32 });
    expect(st.slots.find((s) => s.slotId === "bass-p:b")?.state).toBe("stale");
    expect(st.steps.filter((s) => s.type !== "createLocator")).toEqual([
      { type: "replaceClip", partId: "bass-p", slotId: "bass-p:b", track: t, scene: 1, path: "/dl/bass-p:b.wav", name: "b · bass-p:b" },
      { type: "placeClip", partId: "bass-p", slotId: "bass-p:a", track: t, scene: 0, atBeat: 16 },
      { type: "placeClip", partId: "bass-p", slotId: "bass-p:a", track: t, scene: 0, atBeat: 64 },
      { type: "placeClip", partId: "bass-p", slotId: "bass-p:a", track: t, scene: 0, atBeat: 80 },
    ]);
    const a = st.placements.filter((p) => p.slotId === "bass-p:a");
    expect(a.map((p) => [p.occurrence, p.repeat, p.atBeat, p.placed])).toEqual([
      [0, 0, 0, true],
      [0, 1, 16, false],
      [2, 0, 64, false],
      [2, 1, 80, false],
    ]);
    expect(fullyArranged(st)).toBe(false);
  });

  test("a clip Live made longer than planned gets fewer copies and a note", async () => {
    const song = withLiveNames(await songOnDisk(["bass-p"]), { "bass-p": "p bass [mate]" });
    const live = new InMemoryAbletonAdapter({ clipBeats: () => 24 });
    const t = await live.createAudioTrack("p bass [mate]");
    await live.createAudioClip(t, 0, "/dl/bass-p:a.wav");
    const st = dawStatus(song, await live.getSnapshot());
    expect(st.steps.filter((s) => s.type === "placeClip").map((s) => (s.type === "placeClip" ? s.atBeat : null))).toEqual([0, 64]);
    expect(st.notes.some((n) => /24 beats, the plan wanted 32/.test(n))).toBe(true);
  });

  test("a form with more sections than scenes is reported, not attempted", async () => {
    const base = await songOnDisk(["bass-p"]);
    const song = withLiveNames(base, { "bass-p": "p bass [mate]" });
    const live = new InMemoryAbletonAdapter({ session: { ...(await new InMemoryAbletonAdapter().getSnapshot()), tracks: [] } });
    // A one-scene set.
    const snap = await live.getSnapshot();
    snap.tracks = [{ index: 0, name: "p bass [mate]", kind: "audio", mute: false, solo: false, arm: false, volume: 0.85, clipSlots: [{ index: 0, clip: null }], arrangementClips: [] }];
    const st = dawStatus(song, snap);
    expect(st.slots.find((s) => s.slotId === "bass-p:b")?.state).toBe("no-scene");
    expect(st.notes[0]).toMatch(/add a scene in Live/);
    expect(st.steps.filter((s) => s.type === "importClip")).toHaveLength(1);
  });
});
