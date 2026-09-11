import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DURABLE_EVENT_TYPES,
  JournaledEventSchema,
  MATE_EVENT_TYPES,
  VOLATILE_EVENT_TYPES,
  fromJournaled,
  toJournaled,
  type JournaledEvent,
  type MateEvent,
} from "@aibleton/protocol";
import { EventBus } from "../src/core/events.ts";
import { EventJournal, attachJournal, readJournal, type SessionJournal } from "../src/core/journal.ts";
import type { Logger } from "../src/log.ts";
import { fixtureSong } from "./helpers/song.ts";

let dir: string;
let path: string;
let errors: string[];
let log: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-journal-"));
  path = join(dir, "journal.jsonl");
  errors = [];
  log = { debug() {}, info() {}, warn() {}, error: (msg) => void errors.push(msg) };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function open(startSeq = 1): SessionJournal {
  return new EventJournal<JournaledEvent>({ path, startSeq, log });
}

function goal(text: string | null): JournaledEvent {
  return { type: "goal.changed", goal: text };
}

describe("event classification", () => {
  test("every MateEvent type is classified exactly once", () => {
    const all = [...DURABLE_EVENT_TYPES, ...VOLATILE_EVENT_TYPES];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...MATE_EVENT_TYPES].sort());
  });

  test("volatile events are never journaled", () => {
    const volatile: MateEvent[] = [
      { type: "phase.changed", phase: "acting" },
      { type: "activity.changed", activity: null },
      { type: "queue.changed", queued: [] },
      { type: "adapters", status: { ableton: "stub", splice: "stub", brain: "scripted" } },
      { type: "cancelled", requestId: "r1" },
    ];
    for (const event of volatile) expect(toJournaled(event)).toBeNull();
  });

  test("a song is journaled by id and resolved on the way back", async () => {
    const song = await fixtureSong({ id: "s1" });
    const journaled = toJournaled({ type: "song.changed", song });
    expect(journaled).toEqual({ type: "song.changed", songId: "s1" });
    expect(fromJournaled(journaled!, () => song)).toEqual({ type: "song.changed", song });
    // A song that is no longer on disk restores as null rather than throwing.
    expect(fromJournaled(journaled!, () => null)).toEqual({ type: "song.changed", song: null });
    expect(toJournaled({ type: "song.changed", song: null })).toEqual({ type: "song.changed", songId: null });
  });

  test("durable events round-trip unchanged", () => {
    const events: MateEvent[] = [
      { type: "message", text: "hi", requestId: "r1" },
      { type: "goal.changed", goal: "keep time at 120" },
      { type: "action.applied", action: "setTempo", ok: true, requestId: "r1" },
      { type: "transcript.appended", entry: { id: "tx1", at: 5, role: "mate", kind: "reply", text: "sure", fields: [] } },
      { type: "command.received", command: { id: "c1", at: 4, source: "api", type: "userRequest", summary: "go" } },
    ];
    for (const event of events) {
      const journaled = toJournaled(event);
      expect(journaled).not.toBeNull();
      expect(fromJournaled(journaled!, () => null)).toEqual(event);
    }
  });
});

describe("SessionJournal", () => {
  test("append then read round-trips, oldest first", async () => {
    const journal = open();
    journal.append(goal("one"), 100);
    journal.append(goal("two"), 200);
    await journal.flush();

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.entries).toEqual([
      { seq: 1, at: 100, event: goal("one") },
      { seq: 2, at: 200, event: goal("two") },
    ]);
    expect(read).toMatchObject({ skipped: 0, truncated: false, lastSeq: 2 });
    expect(journal.seq()).toBe(3);
    expect(journal.bytesWritten()).toBe(read.bytes);
  });

  test("twenty rapid appends come back in order after one flush", async () => {
    const journal = open();
    for (let i = 0; i < 20; i++) journal.append(goal(`g${i}`), i);
    await journal.flush();

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(read.entries.map((e) => (e.event as { goal: string }).goal)).toEqual(
      Array.from({ length: 20 }, (_, i) => `g${i}`),
    );
  });

  test("appends that land mid-drain still arrive in order", async () => {
    const journal = open();
    journal.append(goal("first"), 1);
    const flushing = journal.flush();
    journal.append(goal("second"), 2);
    await flushing;
    await journal.flush();

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.entries.map((e) => (e.event as { goal: string }).goal)).toEqual(["first", "second"]);
  });

  // What `process.on("exit")` has to work with: the tail must reach disk
  // without ever yielding, because no promise will resolve again.
  test("flushSync writes the tail with no await at all", async () => {
    const journal = open();
    journal.append(goal("one"), 1);
    journal.append(goal("two"), 2);
    journal.flushSync();

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.entries.map((e) => (e.event as { goal: string }).goal)).toEqual(["one", "two"]);
    expect(read.truncated).toBe(false);
    expect(journal.bytesWritten()).toBe(read.bytes);
    // Nothing is written twice when the async drain that was kicked catches up.
    await journal.flush();
    expect((await readJournal(path, JournaledEventSchema)).entries).toHaveLength(2);
  });

  test("flushSync on an empty buffer touches nothing, and a broken journal stays broken", async () => {
    const journal = open();
    journal.flushSync();
    expect(await readJournal(path, JournaledEventSchema)).toMatchObject({ entries: [], bytes: 0 });

    const missing = new EventJournal<JournaledEvent>({ path: join(dir, "missing", "journal.jsonl"), startSeq: 1, log });
    missing.append(goal("one"), 1);
    missing.flushSync();
    missing.append(goal("two"), 2);
    missing.flushSync();
    expect(errors).toHaveLength(1);
  });

  test("reopening at lastSeq + 1 continues without a collision", async () => {
    const first = open();
    first.append(goal("one"), 1);
    first.append(goal("two"), 2);
    await first.flush();

    const before = await readJournal(path, JournaledEventSchema);
    const second = new EventJournal<JournaledEvent>({ path, startSeq: before.lastSeq + 1, startBytes: before.bytes, log });
    second.append(goal("three"), 3);
    await second.flush();

    const after = await readJournal(path, JournaledEventSchema);
    expect(after.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(second.bytesWritten()).toBe(after.bytes);
  });

  test("a write error is logged once and the journal degrades to a no-op", async () => {
    const journal = new EventJournal<JournaledEvent>({ path: join(dir, "missing", "journal.jsonl"), startSeq: 1, log });
    journal.append(goal("one"), 1);
    await journal.flush();
    journal.append(goal("two"), 2);
    journal.append(goal("three"), 3);
    await journal.flush();
    expect(errors).toHaveLength(1);
  });
});

describe("readJournal", () => {
  test("a missing file is empty, not an error", async () => {
    expect(await readJournal(join(dir, "nope.jsonl"), JournaledEventSchema)).toEqual({
      entries: [],
      skipped: 0,
      lastSeq: 0,
      truncated: false,
      bytes: 0,
    });
  });

  test("a torn final line is truncated, not corruption", async () => {
    const journal = open();
    journal.append(goal("one"), 1);
    journal.append(goal("two"), 2);
    await journal.flush();
    const whole = await Bun.file(path).text();
    await Bun.write(path, whole.slice(0, whole.length - 12));

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.truncated).toBe(true);
    expect(read.skipped).toBe(0);
    expect(read.entries.map((e) => e.seq)).toEqual([1]);
    // The torn line's number is gone with it, so the next append reuses it.
    expect(read.lastSeq).toBe(1);
  });

  test("a corrupt middle line is skipped and the rest survives", async () => {
    const journal = open();
    journal.append(goal("one"), 1);
    await journal.flush();
    await appendFile(path, "{not json\n");
    const later = open(3);
    later.append(goal("three"), 3);
    await later.flush();

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.skipped).toBe(1);
    expect(read.truncated).toBe(false);
    expect(read.entries.map((e) => e.seq)).toEqual([1, 3]);
  });

  test("valid JSON that fails the schema is skipped, but keeps its seq", async () => {
    const journal = open();
    journal.append(goal("one"), 1);
    await journal.flush();
    await appendFile(path, `${JSON.stringify({ seq: 7, at: 2, event: { type: "nonsense" } })}\n`);
    await appendFile(path, `${JSON.stringify({ seq: 8, at: 3, event: { type: "goal.changed" } })}\n`);

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.skipped).toBe(2);
    expect(read.entries.map((e) => e.seq)).toEqual([1]);
    // Max seq *seen*, so reopening cannot hand out 8 a second time.
    expect(read.lastSeq).toBe(8);

    const reopened = new EventJournal<JournaledEvent>({ path, startSeq: read.lastSeq + 1, log });
    reopened.append(goal("nine"), 4);
    await reopened.flush();
    expect((await readJournal(path, JournaledEventSchema)).entries.map((e) => e.seq)).toEqual([1, 9]);
  });
});

describe("attachJournal", () => {
  test("writes durable bus events, ignores volatile ones, and detaches", async () => {
    const events = new EventBus<MateEvent>();
    const journal = open();
    let clock = 10;
    const detach = attachJournal(events, journal, toJournaled, () => (clock += 1));

    events.emit({ type: "goal.changed", goal: "swing it" });
    events.emit({ type: "phase.changed", phase: "acting" });
    events.emit({ type: "action.applied", action: "setTempo", ok: true, requestId: "r1" });
    detach();
    events.emit({ type: "goal.changed", goal: "after the detach" });
    await journal.flush();

    const read = await readJournal(path, JournaledEventSchema);
    expect(read.entries.map((e) => e.event.type)).toEqual(["goal.changed", "action.applied"]);
    expect(read.entries.map((e) => e.at)).toEqual([11, 12]);
  });
});
