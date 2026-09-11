import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBandEvent, fromJournaledBand, type Band, type BandDraft, type BandEvent, type BandLogEntry } from "@aibleton/protocol";
import { EventBus } from "../src/core/events.ts";
import type { BandLibrary } from "../src/core/bands.ts";
import { bandLibrary } from "./helpers/library.ts";

function band(over: Partial<BandDraft> = {}): BandDraft {
  return {
    id: "b1",
    name: "The Pocket",
    parts: [{ id: "drums", role: "drums", name: "Kit", brief: "tight funk groove" }],
    createdAt: 1,
    ...over,
  };
}

let root: string;
let dir: string;
let path: string;
let events: EventBus<BandEvent>;
let lib: BandLibrary;

/** Every readable line of the log, oldest first. Parsed as JSON, not through the schema: a test asserts the bytes. */
async function entries(): Promise<BandLogEntry[]> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BandLogEntry);
}

/** The projection directory as a set of id → document, which is how it must be compared. */
async function projection(): Promise<Map<string, Band>> {
  const out = new Map<string, Band>();
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const doc = (await Bun.file(join(dir, name)).json()) as Band;
    out.set(doc.id, doc);
  }
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mate-library-"));
  dir = join(root, "bands");
  path = join(root, "library", "bands.jsonl");
  events = new EventBus<BandEvent>();
  lib = bandLibrary(dir, { path, events });
});

afterEach(async () => {
  await lib.close();
  await rm(root, { recursive: true, force: true });
});

describe("LibraryStore reads and writes", () => {
  test("a save lands in the fold, the log and the projection, normalised once", async () => {
    // No `metadata`: the single `.parse` in `save` is what has to make it `{}`
    // everywhere at once, and "everywhere" is these four places.
    const saved = await lib.save(band() as Band);
    expect(saved.metadata).toEqual({});
    expect(await lib.get("b1")).toEqual(saved);
    expect(await lib.list()).toEqual([saved]);

    const log = await entries();
    expect(log).toHaveLength(1);
    expect(log[0]!.seq).toBe(1);
    expect(log[0]!.event).toEqual({ type: "band.saved", band: saved });
    expect((await projection()).get("b1")).toEqual(saved);
  });

  test("list is newest first, with the id breaking a shared millisecond", async () => {
    await lib.save(band({ id: "old", createdAt: 1 }) as Band);
    await lib.save(band({ id: "bbb", createdAt: 9 }) as Band);
    await lib.save(band({ id: "aaa", createdAt: 9 }) as Band);
    expect((await lib.list()).map((b) => b.id)).toEqual(["aaa", "bbb", "old"]);
  });

  test("has answers off the fold, get asserts the id", async () => {
    await lib.save(band() as Band);
    expect(lib.has("b1")).toBe(true);
    expect(lib.has("nope")).toBe(false);
    expect(await lib.get("nope")).toBeNull();
    await expect(lib.get("../evil")).rejects.toThrow(/invalid band id/);
  });

  test("the event is emitted after the fold, so a subscriber sees the state it describes", async () => {
    const seen: boolean[] = [];
    events.subscribe((event) => {
      if (event.type === "band.saved") seen.push(lib.has(event.band.id));
    });
    await lib.save(band() as Band);
    expect(seen).toEqual([true]);
  });

  test("delete removes the record, its file and appends one entry", async () => {
    await lib.save(band() as Band);
    expect(await lib.delete("b1")).toBe(true);
    expect(await lib.list()).toEqual([]);
    expect(existsSync(join(dir, "b1.json"))).toBe(false);
    const log = await entries();
    expect(log.map((e) => e.event.type)).toEqual(["band.saved", "band.deleted"]);
  });

  test("a no-op delete appends nothing", async () => {
    await lib.save(band() as Band);
    expect(await entries()).toHaveLength(1);
    expect(await lib.delete("never-existed")).toBe(false);
    // An event that folds to nothing is a line a replay pays for and learns
    // nothing from — and it would put the id in `mentioned`, which is how
    // reconcile tells a leftover file from one the log never heard of.
    expect(await entries()).toHaveLength(1);
    await expect(lib.delete("../evil")).rejects.toThrow(/invalid band id/);
    expect(await entries()).toHaveLength(1);
  });

  test("an invalid document throws before anything happens", async () => {
    await expect(lib.save({ ...band(), parts: [] } as unknown as Band)).rejects.toThrow();
    expect(await entries()).toEqual([]);
    expect(await lib.list()).toEqual([]);
    expect(existsSync(join(dir, "b1.json"))).toBe(false);
  });

  test("a bad id throws before anything happens", async () => {
    await expect(lib.save(band({ id: "../evil" }) as Band)).rejects.toThrow(/invalid band id/);
    expect(await entries()).toEqual([]);
    expect(await lib.list()).toEqual([]);
  });

  test("reads park until the open finishes", async () => {
    await lib.save(band({ id: "b1" }) as Band);
    await lib.close();
    // Constructed synchronously, read immediately: the first `list()` still
    // sees the replayed log, because it waits for the open rather than racing it.
    const second = bandLibrary(dir, { path });
    expect((await second.list()).map((b) => b.id)).toEqual(["b1"]);
    await second.close();
  });
});

describe("LibraryStore batched saves", () => {
  test("a batch is one commit: another writer cannot land a line inside it", async () => {
    const batch = lib.saveAll([band({ id: "b1" }), band({ id: "b2" }), band({ id: "b3" })] as Band[]);
    // Started while the batch's append is in flight. One line per save and this
    // would sit between two of the three; one append and it cannot.
    const solo = lib.save(band({ id: "z9" }) as Band);
    const [saved] = await Promise.all([batch, solo]);

    // The batch is parsed like any save: `metadata` defaults once, for all three.
    expect(saved.map((b) => b.metadata)).toEqual([{}, {}, {}]);
    const log = await entries();
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const ids = log.map((e) => (e.event.type === "band.saved" ? e.event.band.id : null));
    expect(ids.slice(ids.indexOf("b1"), ids.indexOf("b1") + 3)).toEqual(["b1", "b2", "b3"]);
    expect((await lib.list()).map((b) => b.id).sort()).toEqual(["b1", "b2", "b3", "z9"]);
    expect([...(await projection()).keys()].sort()).toEqual(["b1", "b2", "b3", "z9"]);
  });

  test("a batch with an invalid document writes nothing at all", async () => {
    await lib.save(band({ id: "keep" }) as Band);
    const emitted: BandEvent[] = [];
    events.subscribe((event) => emitted.push(event));

    await expect(lib.saveAll([band({ id: "b1" }), { ...band({ id: "b2" }), parts: [] }] as Band[])).rejects.toThrow();
    await expect(lib.saveAll([band({ id: "b1" }), band({ id: "../evil" })] as Band[])).rejects.toThrow(/invalid band id/);

    // Every document is parsed and id-asserted before the first fold, so a bad
    // one anywhere in the batch costs no event, no line and no record file.
    expect(emitted).toEqual([]);
    expect((await lib.list()).map((b) => b.id)).toEqual(["keep"]);
    expect(await entries()).toHaveLength(1);
    expect(existsSync(join(dir, "b1.json"))).toBe(false);
  });

  test("an empty batch is a no-op", async () => {
    expect(await lib.saveAll([])).toEqual([]);
    expect(await entries()).toEqual([]);
  });
});

describe("LibraryStore failure handling", () => {
  test("a failed append rejects out of save", async () => {
    // A directory where the log file belongs: every append fails with EISDIR,
    // which is the cheapest honest stand-in for a full disk.
    const broken = join(root, "library", "broken.jsonl");
    await mkdir(broken, { recursive: true });
    const stuck = bandLibrary(dir, { path: broken });
    await expect(stuck.save(band() as Band)).rejects.toThrow();
    // The projection is written *after* the append, so nothing reached the disk
    // and the route answers 500 rather than 200-with-nothing-written.
    expect(existsSync(join(dir, "b1.json"))).toBe(false);
    await stuck.close();
  });
});

describe("round-trip equality", () => {
  test("the log, the fold and the projection agree after a scripted run", async () => {
    await lib.save(band({ id: "one", createdAt: 10 }) as Band);
    await lib.save(band({ id: "two", createdAt: 20, metadata: { genre: "funk" } }) as Band);
    await lib.save(band({ id: "three", createdAt: 20 }) as Band);
    await lib.save(band({ id: "one", createdAt: 10, name: "Renamed" }) as Band);
    await lib.delete("three");
    await lib.save(band({ id: "four", createdAt: 5 }) as Band);
    await lib.delete("nobody");

    const folded = (await entries()).reduce<readonly Band[]>(
      (state, entry) => applyBandEvent(state, fromJournaledBand(entry.event)),
      [],
    );
    const listed = await lib.list();
    expect(folded).toEqual(listed);

    // The projection is compared as a set of id → document, never as a list.
    // `DocumentStore.list()` leaves `createdAt` ties in `readdir` order while
    // the fold breaks them by id; that difference is deliberate and harmless.
    const files = await projection();
    expect(files.size).toBe(listed.length);
    for (const doc of listed) expect(files.get(doc.id)).toEqual(doc);
  });
});
