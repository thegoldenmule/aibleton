import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SongStore, isValidSongId } from "../src/core/songs.ts";
import { fixtureSong } from "./helpers/song.ts";

let dir: string;
let store: SongStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-songs-"));
  store = new SongStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isValidSongId", () => {
  test.each(["song_1", "A-b_9", "x".repeat(64)])("accepts %p", (id) => {
    expect(isValidSongId(id)).toBe(true);
  });

  test.each(["", "..", "../evil", "a/b", "/etc/passwd", "a.json", "x".repeat(65)])("rejects %p", (id) => {
    expect(isValidSongId(id)).toBe(false);
  });
});

describe("SongStore", () => {
  test("save then get round-trips the song", async () => {
    const song = await fixtureSong({ id: "s1" });
    expect(await store.save(song)).toEqual(song);
    expect(await store.get("s1")).toEqual(song);
    expect(await readdir(dir)).toEqual(["s1.json"]);
  });

  test("list is newest-first", async () => {
    await store.save(await fixtureSong({ id: "one", createdAt: 1 }));
    await store.save(await fixtureSong({ id: "three", createdAt: 3 }));
    await store.save(await fixtureSong({ id: "two", createdAt: 2 }));
    expect((await store.list()).map((s) => s.id)).toEqual(["three", "two", "one"]);
  });

  test("list skips corrupt and schema-invalid files", async () => {
    await store.save(await fixtureSong({ id: "good" }));
    await Bun.write(join(dir, "bad.json"), "{nope");
    const song = await fixtureSong({ id: "invalid" });
    const broken = { ...song, plan: { ...song.plan, placements: [{ ...song.plan.placements[0]!, repeats: 99 }] } };
    await Bun.write(join(dir, "invalid.json"), JSON.stringify(broken));
    expect((await store.list()).map((s) => s.id)).toEqual(["good"]);
    expect(await store.get("invalid")).toBeNull();
  });

  test("delete returns true then false", async () => {
    await store.save(await fixtureSong({ id: "s1" }));
    expect(await store.delete("s1")).toBe(true);
    expect(await store.delete("s1")).toBe(false);
  });

  test("traversal ids never touch the filesystem", async () => {
    const song = await fixtureSong({ id: "../evil" });
    await expect(store.save(song)).rejects.toThrow();
    await expect(store.get("../evil")).rejects.toThrow();
    expect(existsSync(join(dir, "..", "evil.json"))).toBe(false);
  });
});
