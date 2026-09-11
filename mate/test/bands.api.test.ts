import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BandListResponseSchema,
  BandResponseSchema,
  RecipeListResponseSchema,
  type Band,
  type BandLogEntry,
  type MateEvent,
} from "@aibleton/protocol";
import { createApp } from "../src/api/server.ts";
import { EventBus } from "../src/core/events.ts";
import { StateStore } from "../src/core/state.ts";
import { BUILTIN_GENRES } from "../src/core/band-generator.ts";
import { RecipeBook, RecipeStore } from "../src/core/recipes.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
import { ManualClock } from "../src/core/clock.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import type { Intelligence } from "../src/intelligence/types.ts";
import { bandLibrary, logPathFor } from "./helpers/library.ts";
import { songServiceHarness } from "./helpers/song-service.ts";

const idleIntelligence: Intelligence = {
  start() {},
  async stop() {},
  submit: () => "noop",
  post() {},
  phase: () => "idle",
  async settle() {},
};

let dir: string;

function build(now = 1_000) {
  const clock = new ManualClock(now);
  const writer = new ScriptedRecipeWriter();
  const recipes = new RecipeBook({ store: new RecipeStore({ dir: join(dir, "recipes") }), writer, now: () => clock.now() });
  // The harness first, and its stores handed straight to the app. Two
  // libraries over one log keep separate folds and separate seq counters and
  // diverge on the first write, so there is exactly one instance per log.
  const harness = songServiceHarness({ dir, now });
  const app = createApp({
    store: new StateStore(new EventBus<MateEvent>()),
    templates: harness.templates,
    bands: harness.bands,
    songs: harness.service,
    recipes,
    intelligence: idleIntelligence,
    config: loadConfig({}),
    log: silentLogger,
    startedAt: 0,
    now: () => clock.now(),
  });
  return { app, recipes, writer, bands: harness.bands };
}

function band(over: Partial<Band> = {}): Band {
  return {
    id: "quartet-1",
    name: "House quartet",
    parts: [
      { id: "drums", role: "drums", name: "808", brief: "tight four-on-the-floor" },
      { id: "bass-sub", role: "bass", name: "sub bass", brief: "round sine sub, long notes" },
    ],
    metadata: { genre: "house" },
    createdAt: 10,
    ...over,
  };
}

async function post(app: ReturnType<typeof build>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-bands-api-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("bands api", () => {
  test("GET /bands is empty to start", async () => {
    const { app } = build();
    const body = BandListResponseSchema.parse(await (await app.request("/bands")).json());
    expect(body.bands).toEqual([]);
  });

  test("POST /bands then GET /bands/:id round-trips", async () => {
    const { app } = build();
    const saved = await post(app, "/bands", { band: band() });
    expect(saved.status).toBe(200);
    expect(BandResponseSchema.parse(await saved.json()).band).toEqual(band());

    const got = await app.request("/bands/quartet-1");
    expect(got.status).toBe(200);
    expect(BandResponseSchema.parse(await got.json()).band).toEqual(band());
  });

  test("metadata defaults to an empty object when omitted", async () => {
    const { app } = build();
    const { metadata: _dropped, ...withoutMetadata } = band({ id: "untagged" });
    const res = await post(app, "/bands", { band: withoutMetadata });
    expect(res.status).toBe(200);
    expect(BandResponseSchema.parse(await res.json()).band.metadata).toEqual({});
  });

  test("GET /bands lists newest first", async () => {
    const { app } = build();
    await post(app, "/bands", { band: band({ id: "old", createdAt: 1 }) });
    await post(app, "/bands", { band: band({ id: "new", createdAt: 99 }) });
    const body = BandListResponseSchema.parse(await (await app.request("/bands")).json());
    expect(body.bands.map((b) => b.id)).toEqual(["new", "old"]);
  });

  test("GET /bands/:id is 404 when missing", async () => {
    const { app } = build();
    expect((await app.request("/bands/nope")).status).toBe(404);
  });

  test("DELETE /bands/:id reports whether it removed anything", async () => {
    const { app } = build();
    await post(app, "/bands", { band: band() });
    expect(await (await app.request("/bands/quartet-1", { method: "DELETE" })).json()).toEqual({ deleted: true });
    expect(await (await app.request("/bands/quartet-1", { method: "DELETE" })).json()).toEqual({ deleted: false });
  });

  test("POST /bands lands in the log, and a fresh library over it replays the save", async () => {
    const { app, bands } = build();
    expect((await post(app, "/bands", { band: band() })).status).toBe(200);
    await bands.close();

    const path = logPathFor(join(dir, "bands"), "bands");
    const lines = (await Bun.file(path).text()).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as BandLogEntry).toMatchObject({
      seq: 1,
      event: { type: "band.saved", band: { id: "quartet-1", name: "House quartet" } },
    });

    // A second library over the same log, after the first is closed: the route
    // wrote the truth, not just a record file.
    const replayed = bandLibrary(join(dir, "bands"), { path });
    expect((await replayed.list()).map((b) => b.id)).toEqual(["quartet-1"]);
    await replayed.close();
  });

  test("POST /bands is a 500, not a 200 with nothing written, when the append fails", async () => {
    // A directory where the log file belongs: every append fails with EISDIR,
    // the cheapest honest stand-in for a full disk.
    await mkdir(logPathFor(join(dir, "bands"), "bands"), { recursive: true });
    const { app } = build();
    expect((await post(app, "/bands", { band: band() })).status).toBe(500);
    // The projection is written after the append, so nothing reached the disk.
    expect(existsSync(join(dir, "bands", "quartet-1.json"))).toBe(false);
  });

  test("POST /bands rejects duplicate part ids", async () => {
    const { app } = build();
    const res = await post(app, "/bands", {
      band: band({
        parts: [
          { id: "drums", role: "drums", name: "kit", brief: "a" },
          { id: "drums", role: "percussion", name: "congas", brief: "b" },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /bands rejects a band with no parts", async () => {
    const { app } = build();
    expect((await post(app, "/bands", { band: band({ parts: [] }) })).status).toBe(400);
  });

  test("POST /bands rejects a traversal id", async () => {
    const { app } = build();
    expect((await post(app, "/bands", { band: band({ id: "../evil" }) })).status).toBe(400);
  });

  test("POST /bands/generate returns an unsaved, valid band", async () => {
    const { app } = build();
    const res = await post(app, "/bands/generate", { seed: 7, genre: "funk" });
    expect(res.status).toBe(200);
    const { band: made } = BandResponseSchema.parse(await res.json());
    expect(made.parts.length).toBeGreaterThan(0);
    expect(made.metadata.genre).toBe("funk");
    expect(made.createdAt).toBe(1_000);
    expect(new Set(made.parts.map((p) => p.id)).size).toBe(made.parts.length);

    const list = BandListResponseSchema.parse(await (await app.request("/bands")).json());
    expect(list.bands).toEqual([]);
  });

  test("POST /bands/generate is deterministic for a seed", async () => {
    const { app } = build();
    const one = BandResponseSchema.parse(await (await post(app, "/bands/generate", { seed: 42, genre: "jazz" })).json());
    const two = BandResponseSchema.parse(await (await post(app, "/bands/generate", { seed: 42, genre: "jazz" })).json());
    expect(one.band.parts).toEqual(two.band.parts);
  });

  test("POST /bands/generate accepts an empty body and picks a genre from the seed", async () => {
    const { app } = build(555);
    const res = await post(app, "/bands/generate", {});
    expect(res.status).toBe(200);
    const { band: made } = BandResponseSchema.parse(await res.json());
    expect(BUILTIN_GENRES as readonly string[]).toContain(made.metadata.genre!);
    expect(made.name).toContain("555");
  });

  test("POST /bands/generate writes a recipe for an unknown genre, once, and staffs from it", async () => {
    const { app, recipes, writer } = build();
    const res = await post(app, "/bands/generate", { seed: 9, genre: "Polka" });
    expect(res.status).toBe(200);
    const { band: made } = BandResponseSchema.parse(await res.json());
    expect(made.metadata.genre).toBe("Polka");
    expect(made.parts.length).toBeGreaterThanOrEqual(3);
    expect(made.parts[0]!.name).toContain("polka");
    expect(writer.calls).toEqual([{ genre: "Polka" }]);
    expect(recipes.get("polka")?.source).toBe("generated");

    const again = BandResponseSchema.parse(await (await post(app, "/bands/generate", { seed: 9, genre: "polka" })).json());
    expect(again.band.parts).toEqual(made.parts);
    expect(writer.calls).toHaveLength(1);
  });

  test("POST /bands/generate reports a writer failure as a 502 and a blank genre as a 400", async () => {
    const { app, writer } = build();
    writer.rejectNext(new Error("model down"));
    const res = await post(app, "/bands/generate", { genre: "polka" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("model down");
    expect((await post(app, "/bands/generate", { genre: "   " })).status).toBe(400);
  });

  test("GET /recipes lists built-ins then generated recipes", async () => {
    const { app } = build();
    await post(app, "/bands/generate", { genre: "gospel" });
    const list = RecipeListResponseSchema.parse(await (await app.request("/recipes")).json());
    expect(list.recipes.slice(0, BUILTIN_GENRES.length).map((r) => r.id)).toEqual([...BUILTIN_GENRES]);
    expect(list.recipes.at(-1)).toMatchObject({ id: "gospel", genre: "gospel", source: "generated" });
  });

  test("a generated band can be saved straight back", async () => {
    const { app } = build();
    const { band: made } = BandResponseSchema.parse(
      await (await post(app, "/bands/generate", { seed: 3, genre: "metal" })).json(),
    );
    expect((await post(app, "/bands", { band: made })).status).toBe(200);
    const list = BandListResponseSchema.parse(await (await app.request("/bands")).json());
    expect(list.bands.map((b) => b.id)).toEqual([made.id]);
  });
});
