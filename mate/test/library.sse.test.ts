import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  BandLibrarySchema,
  BandSchema,
  TemplateLibrarySchema,
  type Band,
  type BandEvent,
  type MateEvent,
} from "@aibleton/protocol";
import { createApp } from "../src/api/server.ts";
import { eventRoutes } from "../src/api/routes/events.ts";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { recipeBook } from "./helpers/library.ts";
import { StateStore } from "../src/core/state.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import type { Intelligence } from "../src/intelligence/types.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
import { seedLibrary, songServiceHarness } from "./helpers/song-service.ts";
import { fixtureBand, fixtureTemplate } from "./helpers/song.ts";

const idleIntelligence: Intelligence = {
  start() {},
  async stop() {},
  submit: () => "noop",
  post() {},
  phase: () => "idle",
  async settle() {},
};

let dir: string;

async function build() {
  const clock = new ManualClock(1_000);
  const harness = songServiceHarness({ dir, now: 1_000 });
  await seedLibrary(harness);
  const recipes = recipeBook(dir, { now: () => clock.now() });
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
  return { app, bands: harness.bands, templates: harness.templates };
}

interface Frame {
  event: string;
  data: string;
}

/** Reads `/events` frame by frame, keeping everything it has seen so a test can assert an absence. */
function sse(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: Frame[] = [];

  const drain = () => {
    let at: number;
    while ((at = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event:"));
      const data = lines.find((l) => l.startsWith("data:"));
      // A keepalive is a bare comment line: no event, nothing to keep.
      if (event && data) seen.push({ event: event.slice("event:".length).trim(), data: data.slice("data:".length).trim() });
    }
  };

  return {
    seen,
    /** Everything read so far, oldest first. */
    names: () => seen.map((f) => f.event),
    /** Reads until a frame named `event` shows up, and returns its parsed data. */
    async until(event: string): Promise<unknown> {
      for (;;) {
        const hit = seen.find((f) => f.event === event);
        if (hit) return JSON.parse(hit.data);
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${event}; saw ${seen.map((f) => f.event).join(", ")}`);
        buffer += decoder.decode(value, { stream: true });
        drain();
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

function band(over: Partial<Band> = {}): Band {
  return BandSchema.parse({ ...fixtureBand({ id: "trio-2", name: "The Trio", createdAt: 20 }), ...over });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-library-sse-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("library sse", () => {
  test("the opening frames carry each aggregate's library", async () => {
    const { app } = await build();
    const controller = new AbortController();
    const stream = sse(await app.request("/events", { signal: controller.signal }));

    const bands = BandLibrarySchema.parse(await stream.until("bands.snapshot"));
    expect(bands.bands).toEqual([fixtureBand()]);
    const templates = TemplateLibrarySchema.parse(await stream.until("templates.snapshot"));
    expect(templates.templates).toEqual([fixtureTemplate()]);

    // The session snapshot still comes first: it is the stream every client
    // has read since there was only one aggregate.
    expect(stream.names()[0]).toBe("snapshot");

    controller.abort();
    await stream.close();
  });

  test("POST /bands and DELETE /bands/:id reach the stream", async () => {
    const { app } = await build();
    const controller = new AbortController();
    const stream = sse(await app.request("/events", { signal: controller.signal }));
    await stream.until("templates.snapshot");

    const saved = await app.request("/bands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ band: band() }),
    });
    expect(saved.status).toBe(200);
    expect(await stream.until("band.saved")).toEqual({ type: "band.saved", band: band() });

    const deleted = await app.request("/bands/trio-2", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await stream.until("band.deleted")).toEqual({ type: "band.deleted", id: "trio-2" });

    controller.abort();
    await stream.close();
  });

  test("deleting a band that is not there produces no frame at all", async () => {
    const { app } = await build();
    const controller = new AbortController();
    const stream = sse(await app.request("/events", { signal: controller.signal }));
    await stream.until("templates.snapshot");

    const missing = await app.request("/bands/never-existed", { method: "DELETE" });
    expect(missing.status).toBe(200);

    // A no-op delete appends nothing, so it must emit nothing. Nothing arrives
    // to wait for, so the next real write is the ruler: if the delete had
    // emitted, its frame would be sitting ahead of this one.
    await app.request("/bands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ band: band() }),
    });
    await stream.until("band.saved");
    expect(stream.names()).not.toContain("band.deleted");

    controller.abort();
    await stream.close();
  });

  test("an event emitted while a snapshot is still being read is not lost", async () => {
    // The ordering rule, exercised directly: `state()` is held open, an event
    // lands while it is pending, and it must arrive *after* its own snapshot
    // rather than ahead of it or not at all.
    const events = new EventBus<BandEvent>();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const app = new Hono();
    app.route(
      "/",
      eventRoutes(
        [
          {
            snapshot: "bands.snapshot",
            state: async () => {
              await gate;
              return { bands: [] };
            },
            subscribe: (send) => events.subscribe(send),
          },
        ],
        silentLogger,
      ),
    );

    const controller = new AbortController();
    const stream = sse(await app.request("/events", { signal: controller.signal }));
    // The handler runs up to its first await before the response resolves, so
    // by here every stream is subscribed and nothing after this can be missed.
    events.emit({ type: "band.saved", band: band() });
    release();

    expect(await stream.until("band.saved")).toEqual({ type: "band.saved", band: band() });
    expect(stream.names()).toEqual(["bands.snapshot", "band.saved"]);

    controller.abort();
    await stream.close();
  });
});
