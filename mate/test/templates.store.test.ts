import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Template } from "@aibleton/protocol";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateStore, isValidTemplateId } from "../src/core/templates.ts";

function template(over: Partial<Template> = {}): Template {
  return {
    id: "t1",
    name: "Jam",
    form: "a8 b8",
    sections: {
      a: { label: "a", brief: "groove" },
      b: { label: "b", brief: "lift" },
    },
    createdAt: 1,
    ...over,
  };
}

let dir: string;
let store: TemplateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-templates-"));
  store = new TemplateStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isValidTemplateId", () => {
  test.each(["t1", "A-b_9", "x".repeat(64)])("accepts %p", (id) => {
    expect(isValidTemplateId(id)).toBe(true);
  });

  test.each(["", "..", "../evil", "a/b", "/etc/passwd", "a.json", "x".repeat(65)])("rejects %p", (id) => {
    expect(isValidTemplateId(id)).toBe(false);
  });
});

describe("TemplateStore", () => {
  test("save then get round-trips the template", async () => {
    const t = template({ bpm: 96 });
    expect(await store.save(t)).toEqual(t);
    expect(await store.get("t1")).toEqual(t);
    expect(await readdir(dir)).toEqual(["t1.json"]);
  });

  test("get returns null for an unknown id", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  test("list is newest-first and ignores non-json files", async () => {
    await store.save(template({ id: "one", createdAt: 1 }));
    await store.save(template({ id: "three", createdAt: 3 }));
    await store.save(template({ id: "two", createdAt: 2 }));
    await Bun.write(join(dir, "notes.txt"), "not a template");
    await Bun.write(join(dir, "README"), "also not a template");

    expect((await store.list()).map((t) => t.id)).toEqual(["three", "two", "one"]);
  });

  test("list skips corrupt and non-template json files", async () => {
    await store.save(template({ id: "good" }));
    await Bun.write(join(dir, "bad.json"), "{nope");
    await Bun.write(join(dir, "wrong.json"), JSON.stringify({ hello: 1 }));
    await Bun.write(join(dir, "invalid.json"), JSON.stringify(template({ id: "invalid", form: "a8 c8" })));

    expect((await store.list()).map((t) => t.id)).toEqual(["good"]);
  });

  test("get returns null for a corrupt file", async () => {
    await Bun.write(join(dir, "broken.json"), "{nope");
    expect(await store.get("broken")).toBeNull();

    await Bun.write(join(dir, "wrong.json"), JSON.stringify({ hello: 1 }));
    expect(await store.get("wrong")).toBeNull();
  });

  test("delete returns true then false", async () => {
    await store.save(template());
    expect(await store.delete("t1")).toBe(true);
    expect(await store.delete("t1")).toBe(false);
    expect(await store.get("t1")).toBeNull();
  });

  test("save rejects a template that fails TemplateSchema", async () => {
    await expect(store.save(template({ form: "a8 b8 c8" }))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  test("overwriting an existing id replaces it", async () => {
    await store.save(template({ name: "First", createdAt: 1 }));
    await store.save(template({ name: "Second", createdAt: 2 }));

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("Second");
    expect(all[0]!.createdAt).toBe(2);
  });

  test.each(["../evil", "a/b", "/etc/passwd", "..", ""])("rejects the traversal id %p", async (bad) => {
    await expect(store.get(bad)).rejects.toThrow(/invalid template id/);
    await expect(store.save(template({ id: bad }))).rejects.toThrow(/invalid template id/);
    await expect(store.delete(bad)).rejects.toThrow(/invalid template id/);
    expect(existsSync(join(dir, "..", "evil.json"))).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
