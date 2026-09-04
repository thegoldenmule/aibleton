import { describe, expect, test } from "bun:test";
import type { Song } from "@aibleton/protocol";
import { pendingDownloadUuids } from "@aibleton/protocol";
import { silentLogger } from "../src/log.ts";
import { FixtureSpliceAdapter } from "../src/ports/splice/stub.ts";
import { downloadPicks, downloadPlan, reuseDownloaded } from "../src/songwriting/download.ts";
import { pickCandidate, resolveSong } from "../src/songwriting/resolve.ts";
import { FakeSplice } from "./helpers/fakes.ts";
import { fixtureSong } from "./helpers/song.ts";

/** A resolved fixture song where two slots share a pick and one slot has nothing picked. */
async function prepared(): Promise<{ song: Song; shared: string; unpicked: string }> {
  const base = await fixtureSong();
  const { song } = await resolveSong(base, { splice: new FixtureSpliceAdapter(), log: silentLogger, signal: new AbortController().signal });
  const shared = song.plan.slots.find((s) => s.id === "drums-kit:a")!.candidates[0]!.uuid;
  // The b-section drums slot may already share it; force it so the test is deterministic.
  const drumsB = song.plan.slots.find((s) => s.id === "drums-kit:b")!;
  const withShared = drumsB.candidates.some((c) => c.uuid === shared)
    ? pickCandidate(song, "drums-kit:b", shared)
    : { ...song, plan: { ...song.plan, slots: song.plan.slots.map((s) => (s.id === "drums-kit:b" ? { ...s, candidates: [...s.candidates, drumsA(song, shared)], pickedUuid: shared } : s)) } };
  const unpicked = "guitar-strat:b";
  const final: Song = { ...withShared, plan: { ...withShared.plan, slots: withShared.plan.slots.map((s) => (s.id === unpicked ? { ...s, pickedUuid: null } : s)) } };
  return { song: final, shared, unpicked };
}

function drumsA(song: Song, uuid: string) {
  return song.plan.slots.find((s) => s.id === "drums-kit:a")!.candidates.find((c) => c.uuid === uuid)!;
}

const deps = (splice: FakeSplice | FixtureSpliceAdapter, over: Partial<Parameters<typeof downloadPicks>[1]> = {}) => {
  const progress: Song[] = [];
  return {
    deps: { splice, dir: "/tmp/mate-test-downloads", log: silentLogger, signal: new AbortController().signal, onProgress: async (s: Song) => void progress.push(s), ...over },
    progress,
  };
};

describe("downloadPlan", () => {
  test("one entry per distinct pending uuid, with every slot that wants it", async () => {
    const { song, shared, unpicked } = await prepared();
    const plan = downloadPlan(song);
    expect(plan.map((p) => p.uuid)).toEqual(pendingDownloadUuids(song.plan));
    expect(plan.find((p) => p.uuid === shared)?.slotIds).toEqual(["drums-kit:a", "drums-kit:b"]);
    expect(plan.flatMap((p) => p.slotIds)).not.toContain(unpicked);
  });

  test("ignores a pick that is not among the slot's candidates", async () => {
    const { song } = await prepared();
    const tampered: Song = { ...song, plan: { ...song.plan, slots: song.plan.slots.map((s) => (s.id === "bass-p:a" ? { ...s, pickedUuid: "ffffffff-ffff-4fff-8fff-ffffffffffff" } : s)) } };
    expect(downloadPlan(tampered).some((p) => p.uuid.startsWith("ffffffff"))).toBe(false);
  });
});

describe("reuseDownloaded", () => {
  test("copies resolved onto slots sharing a downloaded pick and returns the same object otherwise", async () => {
    const { song, shared } = await prepared();
    expect(reuseDownloaded(song)).toBe(song);
    const onDisk: Song = {
      ...song,
      plan: { ...song.plan, slots: song.plan.slots.map((s) => (s.id === "drums-kit:a" ? { ...s, resolved: { soundUuid: shared, fileName: "a.wav", localPath: "/x/a.wav" } } : s)) },
    };
    const reused = reuseDownloaded(onDisk);
    expect(reused.plan.slots.find((s) => s.id === "drums-kit:b")?.resolved).toEqual({ soundUuid: shared, fileName: "a.wav", localPath: "/x/a.wav" });
    expect(downloadPlan(reused).some((p) => p.uuid === shared)).toBe(false);
  });
});

describe("downloadPicks", () => {
  test("downloads each distinct uuid once, resolves every slot sharing it, reports progress per success", async () => {
    const { song, shared, unpicked } = await prepared();
    const splice = new FakeSplice();
    const { deps: d, progress } = deps(splice);
    const out = await downloadPicks(song, d);
    const distinct = pendingDownloadUuids(song.plan);
    expect(splice.calls.map((c) => c.args[0])).toEqual(distinct);
    expect(splice.calls.every((c) => c.args[1] === "/tmp/mate-test-downloads")).toBe(true);
    expect(out.failed).toEqual([]);
    expect(out.downloaded.map((x) => x.uuid)).toEqual(distinct);
    expect(progress).toHaveLength(distinct.length);
    for (const id of ["drums-kit:a", "drums-kit:b"]) {
      expect(out.song.plan.slots.find((s) => s.id === id)?.resolved).toEqual({ soundUuid: shared, fileName: "fake.wav", localPath: `/tmp/mate-test-downloads/${shared}.wav` });
    }
    expect(out.song.plan.slots.find((s) => s.id === unpicked)?.resolved).toBeNull();
    expect(pendingDownloadUuids(out.song.plan)).toEqual([]);
  });

  test("a failing asset is reported once, never retried, and the rest still land", async () => {
    const { song } = await prepared();
    const splice = new FakeSplice();
    const bad = pendingDownloadUuids(song.plan)[1]!;
    splice.failDownloads.add(bad);
    const { deps: d, progress } = deps(splice);
    const out = await downloadPicks(song, d);
    expect(splice.calls.filter((c) => c.args[0] === bad)).toHaveLength(1);
    expect(out.failed).toEqual([{ uuid: bad, slotIds: expect.any(Array), error: expect.stringContaining(bad) }]);
    expect(out.downloaded.map((x) => x.uuid)).not.toContain(bad);
    expect(progress).toHaveLength(out.downloaded.length);
    expect(pendingDownloadUuids(out.song.plan)).toEqual([bad]);
  });

  test("an aborted request stops before the first paid call", async () => {
    const { song } = await prepared();
    const splice = new FakeSplice();
    const controller = new AbortController();
    controller.abort();
    const { deps: d } = deps(splice, { signal: controller.signal });
    const out = await downloadPicks(song, d);
    expect(splice.calls).toHaveLength(0);
    expect(out.downloaded).toEqual([]);
    expect(out.song).toEqual(song);
  });
});
