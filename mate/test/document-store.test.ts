import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DocumentStore, isValidDocumentId } from "../src/core/document-store.ts";

/**
 * A throwaway document with neither an `id` nor a `createdAt` field, so the
 * generic cannot be leaning on the shape of a template or a band. Refined with
 * `.superRefine` on purpose: real schemas are `ZodEffects`, not `ZodObject`.
 */
const WidgetSchema = z
  .object({ key: z.string().min(1), rank: z.number(), teeth: z.number().int() })
  .superRefine((widget, ctx) => {
    if (widget.teeth < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["teeth"], message: "teeth cannot be negative" });
    }
  });
type Widget = z.infer<typeof WidgetSchema>;

function widget(over: Partial<Widget> = {}): Widget {
  return { key: "w1", rank: 1, teeth: 8, ...over };
}

let dir: string;
let store: DocumentStore<Widget>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-widgets-"));
  store = new DocumentStore<Widget>({
    dir,
    schema: WidgetSchema,
    idOf: (w) => w.key,
    kind: "widget",
    sortKey: (w) => w.rank,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isValidDocumentId", () => {
  test.each(["w1", "A-b_9", "x".repeat(64)])("accepts %p", (id) => {
    expect(isValidDocumentId(id)).toBe(true);
  });

  test.each(["", "..", "../evil", "a/b", "/etc/passwd", "a.json", "x".repeat(65)])("rejects %p", (id) => {
    expect(isValidDocumentId(id)).toBe(false);
  });
});

describe("DocumentStore", () => {
  test("save then get round-trips a document keyed by idOf", async () => {
    const w = widget();
    expect(await store.save(w)).toEqual(w);
    expect(await store.get("w1")).toEqual(w);
    expect(await readdir(dir)).toEqual(["w1.json"]);
  });

  test("get returns null for an unknown id", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  test("list sorts by the supplied sortKey, descending, and ignores non-json files", async () => {
    await store.save(widget({ key: "low", rank: 1 }));
    await store.save(widget({ key: "high", rank: 3 }));
    await store.save(widget({ key: "mid", rank: 2 }));
    await Bun.write(join(dir, "notes.txt"), "not a widget");

    expect((await store.list()).map((w) => w.key)).toEqual(["high", "mid", "low"]);
  });

  test("list skips corrupt and non-conforming json files", async () => {
    await store.save(widget({ key: "good" }));
    await Bun.write(join(dir, "bad.json"), "{nope");
    await Bun.write(join(dir, "wrong.json"), JSON.stringify({ hello: 1 }));
    await Bun.write(join(dir, "refined.json"), JSON.stringify(widget({ key: "refined", teeth: -1 })));

    expect((await store.list()).map((w) => w.key)).toEqual(["good"]);
  });

  test("get returns null for a corrupt file", async () => {
    await Bun.write(join(dir, "broken.json"), "{nope");
    expect(await store.get("broken")).toBeNull();
  });

  test("save rejects a document the schema refuses", async () => {
    await expect(store.save(widget({ teeth: -1 }))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  test("delete returns true then false", async () => {
    await store.save(widget());
    expect(await store.delete("w1")).toBe(true);
    expect(await store.delete("w1")).toBe(false);
  });

  test("overwriting an existing id replaces it", async () => {
    await store.save(widget({ rank: 1 }));
    await store.save(widget({ rank: 9 }));

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.rank).toBe(9);
  });

  test.each(["../evil", "a/b", "/etc/passwd", "..", ""])("rejects the traversal id %p", async (bad) => {
    await expect(store.get(bad)).rejects.toThrow(/invalid widget id/);
    await expect(store.save(widget({ key: bad }))).rejects.toThrow(/invalid widget id/);
    await expect(store.delete(bad)).rejects.toThrow(/invalid widget id/);
    expect(await store.list()).toEqual([]);
  });

  test("kind defaults to \"document\" in id errors", async () => {
    const plain = new DocumentStore<Widget>({
      dir,
      schema: WidgetSchema,
      idOf: (w) => w.key,
    });
    await expect(plain.get("../evil")).rejects.toThrow(/invalid document id/);
  });

  test("sortKey defaults to createdAt, newest first", async () => {
    const StampedSchema = z.object({ id: z.string().min(1), createdAt: z.number() });
    type Stamped = z.infer<typeof StampedSchema>;
    const stamps = new DocumentStore<Stamped>({
      dir,
      schema: StampedSchema,
      idOf: (s) => s.id,
      kind: "stamp",
    });

    await stamps.save({ id: "old", createdAt: 1 });
    await stamps.save({ id: "new", createdAt: 5 });
    await stamps.save({ id: "middle", createdAt: 3 });

    expect((await stamps.list()).map((s) => s.id)).toEqual(["new", "middle", "old"]);
  });
});
