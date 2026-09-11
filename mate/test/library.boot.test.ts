import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Band, BandDraft, BandLogEntry, JournaledBandEvent, Template } from "@aibleton/protocol";
import type { Logger } from "../src/log.ts";
import { openBandLibrary, openTemplateLibrary } from "./helpers/library.ts";

function band(over: Partial<BandDraft> = {}): Band {
  return {
    id: "b1",
    name: "The Pocket",
    parts: [{ id: "drums", role: "drums", name: "Kit", brief: "tight funk groove" }],
    metadata: {},
    createdAt: 1,
    ...over,
  } as Band;
}

let root: string;
let dir: string;
let path: string;
let messages: string[];
let log: Logger;

/** Write a record file the way a drummer's `.mate/bands` already holds one: no log, just JSON. */
async function record(doc: Band, name = `${doc.id}.json`): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

async function entries(): Promise<BandLogEntry[]> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return [];
  }
  const out: BandLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    // A deliberately torn line stays in the file forever; it is not an entry.
    try {
      out.push(JSON.parse(line) as BandLogEntry);
    } catch {
      continue;
    }
  }
  return out;
}

async function writeLog(lines: { seq: number; at: number; event: JournaledBandEvent }[], tail = ""): Promise<void> {
  await mkdir(join(root, "library"), { recursive: true });
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join("") + tail, "utf8");
}

function open() {
  return openBandLibrary(dir, { path, log });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mate-library-boot-"));
  dir = join(root, "bands");
  path = join(root, "library", "bands.jsonl");
  messages = [];
  log = {
    debug() {},
    info: (msg) => void messages.push(`info ${msg}`),
    warn: (msg) => void messages.push(`warn ${msg}`),
    error: (msg) => void messages.push(`error ${msg}`),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("adoption", () => {
  test("records with no log become the log, oldest first", async () => {
    await record(band({ id: "middle", createdAt: 2 }));
    await record(band({ id: "newest", createdAt: 3 }));
    await record(band({ id: "oldest", createdAt: 1 }));

    const lib = await open();
    expect(lib.adopted).toBe(3);
    expect(lib.replayed).toBe(0);

    const log = await entries();
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Ascending `createdAt`, each entry stamped with the record's own, so the
    // log tells the truth about what it inherited rather than about boot time.
    expect(log.map((e) => (e.event.type === "band.saved" ? e.event.band.id : null))).toEqual(["oldest", "middle", "newest"]);
    expect(log.map((e) => e.at)).toEqual([1, 2, 3]);
    expect((await lib.store.list()).map((b) => b.id)).toEqual(["newest", "middle", "oldest"]);
    expect(messages).toContain("info band: adopted 3 of 3 record file(s)");
    await lib.close();
  });

  test("a second open adopts nothing and leaves the log alone", async () => {
    await record(band({ id: "b1", createdAt: 1 }));
    await record(band({ id: "b2", createdAt: 2 }));
    const first = await open();
    expect(first.adopted).toBe(2);
    await first.close();
    const before = await Bun.file(path).text();

    const second = await open();
    expect(second.adopted).toBe(0);
    expect(second.repaired).toBe(0);
    expect(second.replayed).toBe(2);
    expect(await Bun.file(path).text()).toBe(before);
    const log = await entries();
    expect(new Set(log.map((e) => e.seq)).size).toBe(log.length);
    await second.close();
  });

  test("a hand-edited file wins and becomes a log entry", async () => {
    await record(band({ id: "b1", createdAt: 1 }));
    const first = await open();
    await first.close();

    await record(band({ id: "b1", createdAt: 1, name: "Renamed by hand" }));
    const second = await open();
    expect(second.adopted).toBe(1);
    const log = await entries();
    expect(log).toHaveLength(2);
    const last = log.at(-1)!.event;
    expect(last.type === "band.saved" && last.band.name).toBe("Renamed by hand");
    expect((await second.store.get("b1"))?.name).toBe("Renamed by hand");
    await second.close();
  });

  test("a record whose whitespace changed is not adopted again", async () => {
    await record(band({ id: "b1", createdAt: 1 }));
    const first = await open();
    await first.close();
    // Same document, different bytes. Comparison is over zod-parsed documents,
    // so key order and whitespace can never cause a spurious adoption.
    await writeFile(join(dir, "b1.json"), JSON.stringify({ createdAt: 1, metadata: {}, parts: band().parts, name: band().name, id: "b1" }), "utf8");

    const second = await open();
    expect(second.adopted).toBe(0);
    expect(await entries()).toHaveLength(1);
    await second.close();
  });

  test("a corrupt record file is named, counted, and does not stop the open", async () => {
    await record(band({ id: "good", createdAt: 1 }));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "torn.json"), "{ not json", "utf8");
    await writeFile(join(dir, "wrong.json"), JSON.stringify({ id: "wrong" }), "utf8");

    const lib = await open();
    expect(lib.adopted).toBe(1);
    expect(messages).toContain("error band record torn.json could not be read and was not adopted; the log is unchanged");
    expect(messages).toContain("error band record wrong.json could not be read and was not adopted; the log is unchanged");
    expect(messages).toContain("info band: adopted 1 of 3 record file(s)");
    // Never deleted, only refused: an unadopted file is still the drummer's.
    expect(existsSync(join(dir, "torn.json"))).toBe(true);
    await lib.close();
  });
});

describe("reconcile", () => {
  test("a delete survives a reopen and takes the file with it", async () => {
    await record(band({ id: "b1", createdAt: 1 }));
    await record(band({ id: "b2", createdAt: 2 }));
    const first = await open();
    expect(await first.store.delete("b1")).toBe(true);
    await first.close();

    const second = await open();
    expect(await second.store.get("b1")).toBeNull();
    expect((await second.store.list()).map((b) => b.id)).toEqual(["b2"]);
    expect(existsSync(join(dir, "b1.json"))).toBe(false);
    await second.close();
  });

  test("a deleted id's file put back by hand is removed again", async () => {
    await record(band({ id: "b1", createdAt: 1 }));
    await record(band({ id: "b2", createdAt: 2 }));
    const first = await open();
    await first.store.delete("b1");
    await first.close();
    const lines = (await entries()).length;

    // The id is still *mentioned* by the log, which is the only thing that
    // makes this a leftover rather than a stranger.
    await record(band({ id: "b1", createdAt: 1 }));
    const second = await open();
    expect(existsSync(join(dir, "b1.json"))).toBe(false);
    expect((await second.store.list()).map((b) => b.id)).toEqual(["b2"]);
    expect(second.adopted).toBe(0);
    expect(second.repaired).toBe(1);
    expect(await entries()).toHaveLength(lines);
    await second.close();
  });

  test("a folded record whose file was deleted is rewritten", async () => {
    await record(band({ id: "b1", createdAt: 1 }));
    const first = await open();
    await first.close();
    const lines = (await entries()).length;
    await rm(join(dir, "b1.json"));

    const second = await open();
    expect(second.repaired).toBe(1);
    expect(second.adopted).toBe(0);
    expect(existsSync(join(dir, "b1.json"))).toBe(true);
    expect((await second.store.list()).map((b) => b.id)).toEqual(["b1"]);
    expect(await entries()).toHaveLength(lines);
    await second.close();
  });

  test("a lost log never deletes a record file", async () => {
    await record(band({ id: "b1", createdAt: 1 }));
    await record(band({ id: "b2", createdAt: 2 }));
    const first = await open();
    await first.close();
    // The worst case this design has to survive: the log is gone and the 11
    // bands are not. Only an explicitly recorded delete removes a file.
    await rm(path);

    const second = await open();
    expect(second.adopted).toBe(2);
    expect((await second.store.list()).map((b) => b.id)).toEqual(["b2", "b1"]);
    expect((await readdir(dir)).sort()).toEqual(["b1.json", "b2.json"]);
    await second.close();
  });
});

describe("a damaged log", () => {
  test("a torn last line is reported, and the next append continues past it", async () => {
    await writeLog(
      [
        { seq: 1, at: 1, event: { type: "band.saved", band: band({ id: "b1", createdAt: 1 }) } },
        { seq: 2, at: 2, event: { type: "band.saved", band: band({ id: "b2", createdAt: 2 }) } },
      ],
      '{"seq":3,"at":3,"even',
    );

    const lib = await open();
    expect(lib.truncated).toBe(true);
    expect(lib.skipped).toBe(0);
    expect(lib.replayed).toBe(2);
    expect(messages).toContain("warn band log: the log ends mid-line; the last event was lost");

    await lib.store.save(band({ id: "b3", createdAt: 3 }));
    // The torn line claimed no readable `seq`, so the next append takes 3 —
    // and lands on its own line, because the open terminated the wreckage
    // first. Glued onto it, this save would have been lost with it.
    expect((await entries()).at(-1)!.seq).toBe(3);
    const reopened = await open();
    expect(reopened.skipped).toBe(1);
    expect((await reopened.store.list()).map((b) => b.id)).toEqual(["b3", "b2", "b1"]);
    await reopened.close();
    await lib.close();
  });

  test("an unreadable line is skipped and counted", async () => {
    await writeLog([{ seq: 1, at: 1, event: { type: "band.saved", band: band({ id: "b1", createdAt: 1 }) } }]);
    await writeFile(path, `${await Bun.file(path).text()}{"seq":2,"at":2,"event":{"type":"band.exploded"}}\n`, "utf8");

    const lib = await open();
    expect(lib.skipped).toBe(1);
    expect(lib.replayed).toBe(1);
    expect(messages).toContain("warn band log: skipped 1 unreadable line(s)");
    // The skipped line still owns its number: the next append must not reuse it.
    await lib.store.save(band({ id: "b2", createdAt: 2 }));
    expect((await entries()).at(-1)!.seq).toBe(3);
    await lib.close();
  });
});

describe("the template mirror", () => {
  test("templates adopt and reopen the same way", async () => {
    const template: Template = {
      id: "tpl-1",
      name: "Tuesday jam",
      form: "a8 b8",
      sections: { a: { label: "a", brief: "main groove" }, b: { label: "b", brief: "lift" } },
      createdAt: 4,
    };
    const templatesDir = join(root, "templates");
    const templatesPath = join(root, "library", "templates.jsonl");
    await mkdir(templatesDir, { recursive: true });
    await writeFile(join(templatesDir, "tpl-1.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");

    const first = await openTemplateLibrary(templatesDir, { path: templatesPath, log });
    expect(first.adopted).toBe(1);
    await first.close();

    const second = await openTemplateLibrary(templatesDir, { path: templatesPath, log });
    expect(second.adopted).toBe(0);
    expect(await second.store.list()).toEqual([template]);
    await second.close();
  });
});
