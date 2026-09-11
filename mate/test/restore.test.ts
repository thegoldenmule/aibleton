import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJournaled, type MateEvent, type Song } from "@aibleton/protocol";
import { EventBus } from "../src/core/events.ts";
import { attachJournal } from "../src/core/journal.ts";
import { restoreStore } from "../src/core/restore.ts";
import { SessionStore, type OpenSession } from "../src/core/sessions.ts";
import { SongStore } from "../src/core/songs.ts";
import { StateStore } from "../src/core/state.ts";
import { silentLogger } from "../src/log.ts";
import { makeSession } from "./helpers/fakes.ts";
import { fixtureSong } from "./helpers/song.ts";

let dir: string;
let sessions: SessionStore;
let songs: SongStore;
let time: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-restore-"));
  time = 1_000;
  sessions = new SessionStore({ dir: join(dir, "sessions"), now: () => (time += 1) });
  songs = new SongStore({ dir: join(dir, "songs") });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store with the session's journal attached, exactly as boot wires it. */
function live(session: OpenSession) {
  const events = new EventBus<MateEvent>();
  const store = new StateStore(events);
  const detach = attachJournal(events, session.journal, toJournaled, () => (time += 1));
  return { events, store, detach };
}

/** How many lines the journal file holds. */
async function lineCount(path: string): Promise<number> {
  const text = await Bun.file(path).text().catch(() => "");
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

/** A practice session worth resuming: a conversation, a goal and an active song. */
async function record(song: Song | null): Promise<{ id: string; path: string; snapshot: ReturnType<StateStore["snapshot"]> }> {
  const session = await sessions.openCurrent();
  const { store, detach } = live(session);

  store.setAdapters({ ableton: "mcp", splice: "mcp", brain: "anthropic" });
  store.recordCommand({ id: "c1", at: 10, source: "api", type: "userRequest", text: "write me something funky" });
  store.setGoal("keep time at 120");
  store.setLastMessage("On it.", 11, "req_1");
  if (song) {
    await songs.save(song);
    store.setSong(song);
  }
  // Volatile: written down nowhere, and the restored store must not have them.
  store.setDaw(makeSession());
  store.setPhase("acting");
  store.setActivity({ requestId: "req_1", kind: "compose", request: "write me something funky", message: "writing", fields: [], fraction: null, startedAt: 12, at: 12, cancellable: true });
  store.setQueued([{ id: "c2", at: 13, source: "api", type: "userRequest", summary: "and a bridge" }]);

  detach();
  await session.journal.flush();
  return { id: session.meta.id, path: sessions.journalPath(session.meta.id), snapshot: store.snapshot() };
}

describe("restoreStore", () => {
  test("a restored session is the one that was left behind, minus what describes only now", async () => {
    const song = await fixtureSong();
    const before = await record(song);

    const session = await sessions.open(before.id);
    const { store } = live(session);
    const result = await restoreStore({ store, entries: session.entries, songs, log: silentLogger });

    expect(result.missingSongId).toBeNull();
    expect(result.song?.id).toBe(song.id);
    // Written out longhand on purpose: a new volatile event has to be added
    // here by hand, which is the moment to decide it really is volatile.
    expect(store.snapshot()).toEqual({
      ...before.snapshot,
      daw: null,
      phase: "idle",
      error: null,
      activity: null,
      queued: [],
      adapters: { ableton: "stub", splice: "stub", brain: "scripted" },
    });
    // The durable half really is there, ids and all.
    expect(store.getGoal()).toBe("keep time at 120");
    expect(store.getSong()?.id).toBe(song.id);
    expect(store.snapshot().lastMessage).toBe("On it.");
    expect(store.getTranscript().map((t) => t.text)).toEqual(["write me something funky", "On it."]);
    expect(store.getTranscript().map((t) => t.id)).toEqual(before.snapshot.transcript.map((t) => t.id));
  });

  test("a song that is no longer on disk restores as null instead of throwing", async () => {
    const song = await fixtureSong();
    const before = await record(song);
    await songs.delete(song.id);

    const session = await sessions.open(before.id);
    const { store } = live(session);
    const result = await restoreStore({ store, entries: session.entries, songs, log: silentLogger });

    expect(result.song).toBeNull();
    expect(result.missingSongId).toBe(song.id);
    expect(store.getSong()).toBeNull();
    // The conversation still tells the story, which is the point of not throwing.
    expect(store.getTranscript()).toHaveLength(2);
  });

  test("restoring does not write the session down again, however many times mate restarts", async () => {
    const before = await record(await fixtureSong());
    const written = await lineCount(before.path);
    expect(written).toBeGreaterThan(0);

    for (let restart = 0; restart < 2; restart++) {
      const session = await sessions.open(before.id);
      // Attached the way boot attaches it: *after* the replay. Nothing else
      // stops the replay re-journaling itself — there is no flag to forget.
      const events = new EventBus<MateEvent>();
      const store = new StateStore(events);
      await restoreStore({ store, entries: session.entries, songs, log: silentLogger });
      const detach = attachJournal(events, session.journal, toJournaled, () => (time += 1));
      detach();
      await session.journal.flush();
      expect(await lineCount(before.path)).toBe(written);
    }
  });
});
