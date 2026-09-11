import { describe, expect, test } from "bun:test";
import { StateResponseSchema, HealthResponseSchema, AdapterStatusSchema, type MateEvent } from "@aibleton/protocol";
import { createApp } from "../src/api/server.ts";
import { EventBus } from "../src/core/events.ts";
import { StateStore } from "../src/core/state.ts";
import { recipeBook } from "./helpers/library.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
import { envelope, type Command, type CommandBody, type CommandSource } from "../src/core/commands.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import type { Intelligence } from "../src/intelligence/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { songServiceHarness } from "./helpers/song-service.ts";

function fakeIntelligence() {
  const submitted: { body: CommandBody; source: CommandSource }[] = [];
  const posted: Command[] = [];
  let n = 0;
  const intelligence: Intelligence = {
    start() {},
    async stop() {},
    submit(body, source) {
      submitted.push({ body, source });
      return `fake_${++n}`;
    },
    post(cmd) {
      posted.push(cmd);
    },
    phase: () => "idle",
    async settle() {},
  };
  return { intelligence, submitted, posted };
}

function build() {
  const events = new EventBus<MateEvent>();
  const store = new StateStore(events);
  const fake = fakeIntelligence();
  // The harness owns the stores, so the app and the service share one library
  // instance per log rather than two folds over the same file.
  const harness = songServiceHarness();
  const recipes = recipeBook(mkdtempSync(join(tmpdir(), "mate-api-recipes-")), { now: () => Date.now() });
  const app = createApp({
    store,
    templates: harness.templates,
    bands: harness.bands,
    songs: harness.service,
    recipes,
    intelligence: fake.intelligence,
    config: loadConfig({}),
    log: silentLogger,
    startedAt: Date.now() - 1000,
    mailboxSize: () => 3,
  });
  return { app, store, events, ...fake };
}

describe("api", () => {
  test("GET /health", async () => {
    const { app } = build();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(1000);
  });

  test("GET /state validates against StateResponseSchema", async () => {
    const { app, store } = build();
    store.setGoal("keep time at 120");
    const res = await app.request("/state");
    expect(res.status).toBe(200);
    const body = StateResponseSchema.parse(await res.json());
    expect(body.phase).toBe("idle");
    expect(body.goal).toBe("keep time at 120");
    expect(body.daw).toBeNull();
  });

  test("POST /commands accepts a userRequest and forwards it", async () => {
    const { app, submitted } = build();
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: { type: "userRequest", text: "give me a shuffle at 100" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; queued: number };
    expect(body.id).toBe("fake_1");
    expect(body.queued).toBe(3);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.source).toBe("api");
    expect(submitted[0]?.body).toEqual({ type: "userRequest", text: "give me a shuffle at 100" });
  });

  test("POST /commands rejects an invalid body with 400", async () => {
    const { app, submitted } = build();
    const bad = await app.request("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: { type: "userRequest" } }),
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("invalid command");
    expect(body.issues.length).toBeGreaterThan(0);

    const internal = await app.request("/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: { type: "tick" } }),
    });
    expect(internal.status).toBe(400);

    const notJson = await app.request("/commands", { method: "POST", body: "nope" });
    expect(notJson.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  test("GET /commands/recent returns newest first", async () => {
    const { app, store } = build();
    store.recordCommand(envelope({ type: "userRequest", text: "first" }, "api", 1));
    store.recordCommand(envelope({ type: "userRequest", text: "second" }, "api", 2));
    const res = await app.request("/commands/recent");
    const body = (await res.json()) as { commands: { summary: string }[] };
    expect(body.commands.map((c) => c.summary)).toEqual(["second", "first"]);
  });

  test("GET /adapters", async () => {
    const { app, store } = build();
    store.setAdapters({ ableton: "mcp", splice: "stub", brain: "anthropic" });
    const res = await app.request("/adapters");
    expect(res.status).toBe(200);
    expect(AdapterStatusSchema.parse(await res.json())).toEqual({ ableton: "mcp", splice: "stub", brain: "anthropic" });
  });

  test("GET /events sends the snapshot first, then forwards bus events", async () => {
    const { app, store } = build();
    const controller = new AbortController();
    const res = await app.request("/events", { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil("event: snapshot");
    const snapshotLine = buffer.split("\n").find((l) => l.startsWith("data:"))!;
    const snapshot = StateResponseSchema.parse(JSON.parse(snapshotLine.slice("data:".length).trim()));
    expect(snapshot.phase).toBe("idle");

    store.setPhase("observing");
    await readUntil("event: phase.changed");
    expect(buffer).toContain('"phase":"observing"');

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
