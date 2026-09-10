import { describe, expect, test } from "bun:test";
import type { Song } from "@aibleton/protocol";
import { NoActiveSongError, SongAlreadyActiveError } from "../src/songwriting/service.ts";
import { FakeSplice } from "./helpers/fakes.ts";
import { FakeSongwriting, seedLibrary, songServiceHarness } from "./helpers/song-service.ts";

/** Lets anything already scheduled run before we assert on it. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const never = new AbortController().signal;

async function ready(opts: Parameters<typeof songServiceHarness>[0] = {}) {
  const h = songServiceHarness(opts);
  await seedLibrary(h);
  return h;
}

describe("SongService.compose", () => {
  test("saves the song, makes it active and searches Splice for every slot", async () => {
    const h = await ready();
    const { song, resolveError } = await h.service.compose({ text: "something funky", signal: never });

    expect(resolveError).toBeUndefined();
    expect(song.plan.slots.every((s) => s.candidates.length > 0 && s.pickedUuid !== null)).toBe(true);
    // Same song everywhere: what the caller got, what is on disk, and what the app renders.
    expect(await h.songs.get(song.id)).toEqual(song);
    expect(h.store.getSong()).toEqual(song);
    expect(h.service.current()).toEqual(song);
  });

  test("a search that finds nothing costs candidates, not the song", async () => {
    const h = await ready({ splice: new FakeSplice() });
    const { song, resolveError } = await h.service.compose({ text: "something funky", signal: never });

    expect(resolveError).toBeUndefined();
    expect(song.plan.slots.every((s) => s.candidates.length === 0)).toBe(true);
    expect(h.store.getSong()?.id).toBe(song.id);
  });

  test("an abort part way through the search leaves the song saved and active", async () => {
    const fake = new FakeSongwriting();
    const h = await ready({ splice: fake.splice, ableton: fake.ableton });
    const controller = new AbortController();

    fake.hold();
    const composing = h.service.compose({ text: "something funky", signal: controller.signal });
    await fake.waitForHold();
    // The brief is done and the song is already active; only the search is in flight.
    const active = h.store.getSong();
    expect(active).not.toBeNull();
    controller.abort();
    fake.release();

    const { song, resolveError } = await composing;
    expect(resolveError).toBe("aborted");
    expect(song.id).toBe(active!.id);
    expect(await h.songs.get(song.id)).not.toBeNull();
    expect(h.store.getSong()?.id).toBe(song.id);
  });

  test("a second compose is refused while a song is active, unless it says to replace it", async () => {
    const h = await ready();
    const first = (await h.service.compose({ text: "first", signal: never })).song;

    await expect(h.service.compose({ text: "second", signal: never })).rejects.toBeInstanceOf(SongAlreadyActiveError);
    expect(h.store.getSong()?.id).toBe(first.id);
    // Nothing half-written: the refused compose never reached the briefer.
    expect(h.briefer.calls).toHaveLength(1);

    const second = (await h.service.compose({ text: "second", signal: never, replaceActive: true })).song;
    expect(second.id).not.toBe(first.id);
    expect(h.store.getSong()?.id).toBe(second.id);
    expect(await h.songs.get(first.id)).not.toBeNull();
  });
});

describe("SongService active song", () => {
  test("requireActive throws until there is one, and clearActive gives it back", async () => {
    const h = await ready();
    expect(h.service.current()).toBeNull();
    expect(() => h.service.requireActive()).toThrow(NoActiveSongError);

    const song = (await h.service.compose({ text: "funky", signal: never })).song;
    expect(h.service.requireActive().id).toBe(song.id);

    expect(h.service.clearActive()?.id).toBe(song.id);
    expect(h.service.clearActive()).toBeNull();
    expect(() => h.service.requireActive()).toThrow(NoActiveSongError);
    // Cleared, not deleted.
    expect(await h.service.get(song.id)).not.toBeNull();
  });

  test("delete drops the song and clears it when it was the active one", async () => {
    const h = await ready();
    const song = (await h.service.compose({ text: "funky", signal: never })).song;
    expect(await h.service.delete(song.id)).toBe(true);
    expect(h.service.current()).toBeNull();
    expect(await h.service.delete(song.id)).toBe(false);
  });
});

describe("SongService single-flight", () => {
  /** Two arranges of one song into a DAW with no delete would lay every clip twice. */
  test("a second operation on the same song waits for the first", async () => {
    const fake = new FakeSongwriting();
    const h = await ready({ splice: fake.splice, ableton: fake.ableton });
    const song: Song = (await h.service.compose({ text: "funky", signal: never })).song;

    fake.hold();
    const first = h.service.arrange(song, never);
    await fake.waitForHold();
    const mark = fake.started.length;

    const second = h.service.arrange(song, never);
    await tick();
    expect(fake.startedSince(mark)).toEqual([]);
    expect(fake.pendingCount()).toBe(1);

    fake.release();
    await Promise.all([first, second]);
    // It did run, once the first was done: nothing was dropped, only queued.
    expect(fake.startedSince(mark).length).toBeGreaterThan(0);
    // Adds only, and the second run found nothing left to add.
    expect((await second).applied).toEqual([]);
  });

  test("different songs are not held up by each other", async () => {
    const fake = new FakeSongwriting();
    const h = await ready({ splice: fake.splice, ableton: fake.ableton });
    const first = (await h.service.compose({ text: "funky", signal: never })).song;
    const second = (await h.service.compose({ text: "dusty", signal: never, replaceActive: true })).song;

    fake.hold();
    void h.service.arrange(first, never).catch(() => {});
    void h.service.arrange(second, never).catch(() => {});
    await fake.waitForHold(2);
    expect(fake.pendingCount()).toBe(2);
    fake.release();
  });
});
