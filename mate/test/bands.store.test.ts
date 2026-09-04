import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Band } from "@aibleton/protocol";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BandStore, isValidBandId } from "../src/core/bands.ts";

function band(over: Partial<Band> = {}): Band {
  return {
    id: "b1",
    name: "The Pocket",
    parts: [
      { id: "drums", role: "drums", name: "Kit", brief: "tight funk groove" },
      { id: "bass", role: "bass", name: "P-Bass", brief: "syncopated sixteenths" },
    ],
    metadata: { genre: "funk" },
    createdAt: 1,
    ...over,
  };
}

let dir: string;
let store: BandStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-bands-"));
  store = new BandStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isValidBandId", () => {
  test.each(["b1", "A-b_9", "x".repeat(64)])("accepts %p", (id) => {
    expect(isValidBandId(id)).toBe(true);
  });

  test.each(["", "..", "../evil", "a/b", "/etc/passwd", "a.json", "x".repeat(65)])("rejects %p", (id) => {
    expect(isValidBandId(id)).toBe(false);
  });
});

describe("BandStore", () => {
  test("save then get round-trips the band", async () => {
    const b = band({ metadata: { genre: "jazz", mood: "loose" } });
    expect(await store.save(b)).toEqual(b);
    expect(await store.get("b1")).toEqual(b);
    expect(await readdir(dir)).toEqual(["b1.json"]);
  });

  test("get returns null for an unknown id", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  test("list is newest-first and ignores non-json files", async () => {
    await store.save(band({ id: "one", createdAt: 1 }));
    await store.save(band({ id: "three", createdAt: 3 }));
    await store.save(band({ id: "two", createdAt: 2 }));
    await Bun.write(join(dir, "notes.txt"), "not a band");
    await Bun.write(join(dir, "README"), "also not a band");

    expect((await store.list()).map((b) => b.id)).toEqual(["three", "two", "one"]);
  });

  test("list skips corrupt and non-band json files", async () => {
    await store.save(band({ id: "good" }));
    await Bun.write(join(dir, "bad.json"), "{nope");
    await Bun.write(join(dir, "wrong.json"), JSON.stringify({ hello: 1 }));
    await Bun.write(
      join(dir, "invalid.json"),
      JSON.stringify({
        ...band({ id: "invalid" }),
        parts: [
          { id: "drums", role: "drums", name: "Kit", brief: "one" },
          { id: "drums", role: "percussion", name: "Congas", brief: "two" },
        ],
      }),
    );

    expect((await store.list()).map((b) => b.id)).toEqual(["good"]);
  });

  test("get returns null for a corrupt file", async () => {
    await Bun.write(join(dir, "broken.json"), "{nope");
    expect(await store.get("broken")).toBeNull();

    await Bun.write(join(dir, "wrong.json"), JSON.stringify({ hello: 1 }));
    expect(await store.get("wrong")).toBeNull();
  });

  test("delete returns true then false", async () => {
    await store.save(band());
    expect(await store.delete("b1")).toBe(true);
    expect(await store.delete("b1")).toBe(false);
    expect(await store.get("b1")).toBeNull();
  });

  test("save rejects a band that fails BandSchema", async () => {
    const duplicate = band({
      parts: [
        { id: "keys", role: "keys", name: "Rhodes", brief: "comp" },
        { id: "keys", role: "synth", name: "Juno", brief: "pad" },
      ],
    });
    await expect(store.save(duplicate)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  test("overwriting an existing id replaces it", async () => {
    await store.save(band({ name: "First", createdAt: 1 }));
    await store.save(band({ name: "Second", createdAt: 2 }));

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("Second");
    expect(all[0]!.createdAt).toBe(2);
  });

  test.each(["../evil", "a/b", "/etc/passwd", "..", ""])("rejects the traversal id %p", async (bad) => {
    await expect(store.get(bad)).rejects.toThrow(/invalid band id/);
    await expect(store.save(band({ id: bad }))).rejects.toThrow(/invalid band id/);
    await expect(store.delete(bad)).rejects.toThrow(/invalid band id/);
    expect(existsSync(join(dir, "..", "evil.json"))).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
