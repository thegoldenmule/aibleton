import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournaledEventSchema } from "@aibleton/protocol";
import { readJournal } from "../src/core/journal.ts";
import { SessionStore, isValidSessionId } from "../src/core/sessions.ts";

let dir: string;
let store: SessionStore;
let time: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-sessions-"));
  time = 1_000;
  store = new SessionStore({ dir, now: () => (time += 1) });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isValidSessionId", () => {
  test.each(["ses_1", "A-b_9", "x".repeat(64)])("accepts %p", (id) => {
    expect(isValidSessionId(id)).toBe(true);
  });

  // Ids become path segments, so this is the table that matters.
  test.each(["", "..", "../evil", "a/b", "/etc/passwd", "a.json", "x".repeat(65)])("rejects %p", (id) => {
    expect(isValidSessionId(id)).toBe(false);
  });
});

describe("SessionStore", () => {
  test("create then get round-trips, with timestamps from the injected clock", async () => {
    const meta = await store.create({ name: "monday" });
    expect(meta).toMatchObject({ name: "monday", createdAt: 1001, updatedAt: 1001, lastSeq: 0, model: null });
    expect(await store.get(meta.id)).toEqual(meta);
    expect(await readdir(store.dirFor(meta.id))).toEqual(["session.json"]);
  });

  test("a session with no name is named after the moment it was made", async () => {
    const meta = await store.create();
    expect(meta.name).toBe(new Date(1001).toISOString().replace("T", " ").slice(0, 16));
  });

  test("openCurrent twice returns the same session", async () => {
    const first = await store.openCurrent();
    const second = await store.openCurrent();
    expect(second.meta.id).toBe(first.meta.id);
    expect(await store.currentId()).toBe(first.meta.id);
    expect((await store.list()).map((s) => s.id)).toEqual([first.meta.id]);
  });

  test("openCurrent mints a new session when current.json names one that is gone", async () => {
    const first = await store.openCurrent();
    await store.delete(first.meta.id);
    await store.setCurrent(first.meta.id);
    const second = await store.openCurrent();
    expect(second.meta.id).not.toBe(first.meta.id);
    expect(await store.currentId()).toBe(second.meta.id);
  });

  test("what the journal wrote comes back on the next open, and the seq continues", async () => {
    const opened = await store.openCurrent();
    opened.journal.append({ type: "goal.changed", goal: "keep time at 120" }, 5);
    opened.journal.append({ type: "message", text: "on it" }, 6);
    await opened.journal.flush();
    await store.save({ ...opened.meta, lastSeq: opened.journal.seq() - 1, updatedAt: 2_000 });

    const again = await store.openCurrent();
    expect(again.meta.id).toBe(opened.meta.id);
    expect(again.entries.map((e) => e.event.type)).toEqual(["goal.changed", "message"]);
    expect(again.skipped).toBe(0);
    expect(again.truncated).toBe(false);
    expect(again.journal.seq()).toBe(3);
    expect(again.journal.bytesWritten()).toBeGreaterThan(0);
  });

  test("a torn journal opens anyway, and never reuses the lost line's number", async () => {
    const opened = await store.openCurrent();
    opened.journal.append({ type: "goal.changed", goal: "one" }, 1);
    opened.journal.append({ type: "goal.changed", goal: "two" }, 2);
    await opened.journal.flush();
    await store.save({ ...opened.meta, lastSeq: 2 });
    const whole = await Bun.file(store.journalPath(opened.meta.id)).text();
    await Bun.write(store.journalPath(opened.meta.id), whole.slice(0, whole.length - 10));

    const again = await store.openCurrent();
    expect(again.truncated).toBe(true);
    expect(again.entries.map((e) => e.seq)).toEqual([1]);
    // The metadata remembers what the torn line took with it.
    expect(again.journal.seq()).toBe(3);
  });

  test("list is most-recently-updated first and ignores current.json", async () => {
    await store.save({ ...(await store.create({ id: "old", name: "old" })), updatedAt: 10 });
    await store.save({ ...(await store.create({ id: "new", name: "new" })), updatedAt: 30 });
    await store.save({ ...(await store.create({ id: "mid", name: "mid" })), updatedAt: 20 });
    await store.setCurrent("new");

    expect((await store.list()).map((s) => s.id)).toEqual(["new", "mid", "old"]);
    expect(existsSync(join(dir, "current.json"))).toBe(true);
  });

  test("list skips corrupt and schema-invalid sessions", async () => {
    await store.create({ id: "good" });
    await Bun.write(join(dir, "broken", "session.json"), "{nope");
    await Bun.write(join(dir, "invalid", "session.json"), JSON.stringify({ id: "invalid", name: 7 }));

    expect((await store.list()).map((s) => s.id)).toEqual(["good"]);
    expect(await store.get("invalid")).toBeNull();
  });

  test("delete removes the whole subtree, and forgets a current pointer to it", async () => {
    const opened = await store.openCurrent();
    opened.journal.append({ type: "goal.changed", goal: "one" }, 1);
    await opened.journal.flush();
    expect(existsSync(store.journalPath(opened.meta.id))).toBe(true);

    expect(await store.delete(opened.meta.id)).toBe(true);
    expect(existsSync(store.dirFor(opened.meta.id))).toBe(false);
    expect(await store.currentId()).toBeNull();
    expect(await store.delete(opened.meta.id)).toBe(false);
  });

  test("opening an unknown session throws, so a route can tell 404 from 400", async () => {
    await expect(store.open("nosuch")).rejects.toThrow(/unknown session/);
  });

  test("traversal ids never touch the filesystem", async () => {
    await expect(store.get("../evil")).rejects.toThrow();
    await expect(store.open("../evil")).rejects.toThrow();
    await expect(store.delete("../evil")).rejects.toThrow();
    await expect(store.setCurrent("a/b")).rejects.toThrow();
    expect(existsSync(join(dir, "..", "evil"))).toBe(false);
  });

  // `bun run --cwd mate dev` runs `--watch`, so a reload overlaps the outgoing
  // process and two boots read a missing `current.json` at the same moment.
  // Read-then-write let both mint and orphaned the loser's journal.
  test("two concurrent openCurrent calls mint exactly one session", async () => {
    const [a, b] = await Promise.all([store.openCurrent(), store.openCurrent()]);

    expect(a.meta.id).toBe(b.meta.id);
    expect(await store.currentId()).toBe(a.meta.id);
    // The loser took its directory back with it, and left no `.tmp` behind.
    expect((await readdir(dir)).filter((name) => name !== "current.json")).toEqual([a.meta.id]);
  });

  // The shape a watch reload actually takes: two stores, one directory.
  test("two instances booting on one directory agree on one session", async () => {
    const other = new SessionStore({ dir, now: () => (time += 1) });
    const [a, b] = await Promise.all([store.openCurrent(), other.openCurrent()]);

    expect(a.meta.id).toBe(b.meta.id);
    expect((await store.list()).map((s) => s.id)).toEqual([a.meta.id]);
    // Both journals are the same file, so the loser's events are not orphaned.
    a.journal.append({ type: "goal.changed", goal: "one" }, 1);
    b.journal.append({ type: "goal.changed", goal: "two" }, 2);
    await Promise.all([a.journal.flush(), b.journal.flush()]);
    expect((await readJournal(store.journalPath(a.meta.id), JournaledEventSchema)).entries).toHaveLength(2);
  });

  test("a current.json naming a traversal id is ignored", async () => {
    await Bun.write(join(dir, "current.json"), JSON.stringify({ id: "../evil", at: 1 }));
    expect(await store.currentId()).toBeNull();
    const opened = await store.openCurrent();
    expect(isValidSessionId(opened.meta.id)).toBe(true);
  });
});
