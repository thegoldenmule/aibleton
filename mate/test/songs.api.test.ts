import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveSongResponseSchema, SongListResponseSchema, SongResponseSchema, StateResponseSchema } from "@aibleton/protocol";
import { createApp } from "../src/api/server.ts";
import { BandStore } from "../src/core/bands.ts";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { SongStore } from "../src/core/songs.ts";
import { StateStore } from "../src/core/state.ts";
import { TemplateStore } from "../src/core/templates.ts";
import { loadConfig } from "../src/config.ts";
import type { Intelligence } from "../src/intelligence/types.ts";
import { silentLogger } from "../src/log.ts";
import { ModelRefusedError } from "../src/core/anthropic.ts";
import { ScriptedBriefer } from "../src/songwriting/briefer/index.ts";
import { defaultBrief } from "../src/songwriting/briefer/scripted.ts";
import { RecipeBook, RecipeStore } from "../src/core/recipes.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-songs-api-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function build(opts: { seedLibrary?: boolean; briefer?: ScriptedBriefer; writer?: ScriptedRecipeWriter; now?: number } = {}) {
  const clock = new ManualClock(opts.now ?? 1_000);
  const events = new EventBus();
  const store = new StateStore(events);
  const templates = new TemplateStore({ dir: join(dir, "templates") });
  const bands = new BandStore({ dir: join(dir, "bands") });
  const songs = new SongStore({ dir: join(dir, "songs") });
  const briefer = opts.briefer ?? new ScriptedBriefer();
  const writer = opts.writer ?? new ScriptedRecipeWriter();
  const recipes = new RecipeBook({ store: new RecipeStore({ dir: join(dir, "recipes") }), writer, now: () => clock.now() });
  if (opts.seedLibrary !== false) {
    await templates.save(fixtureTemplate());
    await bands.save(fixtureBand());
  }
  const app = createApp({
    store,
    templates,
    bands,
    songs,
    recipes,
    briefer,
    intelligence: idleIntelligence,
    config: loadConfig({}),
    log: silentLogger,
    startedAt: 0,
    now: () => clock.now(),
  });
  return { app, store, events, songs, bands, briefer, writer, recipes, clock };
}

type App = Awaited<ReturnType<typeof build>>["app"];

async function post(app: App, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /songs/compose", () => {
  test("composes, persists and activates a song", async () => {
    const h = await build();
    const res = await post(h.app, "/songs/compose", { text: "something funky and upbeat" });
    expect(res.status).toBe(200);
    const { song } = SongResponseSchema.parse(await res.json());

    expect(song.request).toEqual({ text: "something funky and upbeat", seed: 1_000 });
    expect(song.templateId).toBe("tpl-1");
    expect(song.bandId).toBe("band-1");
    expect(song.createdAt).toBe(1_000);
    expect(song.plan.tracks.map((t) => t.partId)).toEqual(["drums-kit", "bass-p", "guitar-strat"]);
    expect(song.plan.timeline).toHaveLength(4);

    // guitar 2x4, bass 1x8 for 8-bar sections
    const guitar = song.plan.placements.find((p) => p.partId === "guitar-strat")!;
    const bass = song.plan.placements.find((p) => p.partId === "bass-p")!;
    expect([guitar.loopBars, guitar.repeats]).toEqual([4, 2]);
    expect([bass.loopBars, bass.repeats]).toEqual([8, 1]);

    expect(await h.songs.get(song.id)).toEqual(song);
    expect(h.store.getSong()).toEqual(song);
    expect(h.events.ofType("song.changed").map((e) => e.song?.id)).toEqual([song.id]);
    expect(h.events.ofType("message").map((e) => e.text)).toEqual([song.brief.summary]);
    expect(h.store.getTranscript().map((t) => [t.role, t.kind, t.text])).toEqual([
      ["user", "compose", "something funky and upbeat"],
      ["mate", "reply", song.brief.summary],
    ]);
    expect(h.events.ofType("transcript.appended")).toHaveLength(2);
    expect(h.briefer.calls[0]!.text).toBe("something funky and upbeat");

    const state = StateResponseSchema.parse(await (await h.app.request("/state")).json());
    expect(state.song?.id).toBe(song.id);
  });

  test("an explicit seed and name are honoured", async () => {
    const h = await build();
    const res = await post(h.app, "/songs/compose", { text: "play", seed: 42, name: "My song" });
    const { song } = SongResponseSchema.parse(await res.json());
    expect(song.request.seed).toBe(42);
    expect(song.name).toBe("My song");
  });

  test("an empty library is a 409 that names the missing library", async () => {
    const h = await build({ seedLibrary: false });
    const res = await post(h.app, "/songs/compose", { text: "funky" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; library: string };
    expect(body.library).toBe("templates");
    expect(body.error).toContain("/templates");
    expect(h.store.getSong()).toBeNull();
    expect(await h.songs.list()).toEqual([]);
  });

  test("a refusal is a 422", async () => {
    const briefer = new ScriptedBriefer();
    briefer.rejectNext(new ModelRefusedError("brief this song", "policy", "not this"));
    const h = await build({ briefer });
    const res = await post(h.app, "/songs/compose", { text: "funky" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { category: string }).category).toBe("policy");
  });

  test("any other briefer failure is a 502 and nothing is saved", async () => {
    const briefer = new ScriptedBriefer();
    briefer.rejectNext(new Error("model down"));
    const h = await build({ briefer });
    const res = await post(h.app, "/songs/compose", { text: "funky" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("model down");
    expect(await h.songs.list()).toEqual([]);
    expect(h.events.ofType("song.changed")).toEqual([]);
  });

  test("bad bodies are 400s", async () => {
    const h = await build();
    expect((await post(h.app, "/songs/compose", { text: "" })).status).toBe(400);
    expect((await post(h.app, "/songs/compose", { seed: 1 })).status).toBe(400);
    const res = await h.app.request("/songs/compose", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(res.status).toBe(400);
  });

  test("the request signal reaches the briefer", async () => {
    const briefer = new ScriptedBriefer();
    const h = await build({ briefer });
    const controller = new AbortController();
    controller.abort();
    const res = await h.app.request(
      new Request("http://mate/songs/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "funky" }),
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(502);
    expect(h.store.getSong()).toBeNull();
  });
});

describe("POST /songs/compose for a genre with no band", () => {
  /** The scripted briefer cannot know "gospel" is a genre; a real brief would say so, so this one is told to. */
  const gospelBriefer = () => new ScriptedBriefer((input) => ({ ...defaultBrief(input), genres: ["gospel", "soul"] }));

  test("writes a recipe, rolls and saves a few bands, picks one and briefs again", async () => {
    const h = await build({ briefer: gospelBriefer() });
    const briefer = h.briefer;
    const res = await post(h.app, "/songs/compose", { text: "a high energy gospel song", seed: 100 });
    expect(res.status).toBe(200);
    const { song } = SongResponseSchema.parse(await res.json());

    expect(h.writer.calls.map((c) => c.genre)).toEqual(["gospel"]);
    const saved = await h.bands.list();
    expect(saved).toHaveLength(4);
    const rolled = saved.filter((b) => b.metadata.genre === "gospel");
    expect(rolled).toHaveLength(3);
    expect(rolled.map((b) => b.id)).toContain(song.bandId);
    expect(song.band.metadata.genre).toBe("gospel");
    expect(briefer.calls).toHaveLength(2);
    expect(briefer.calls[0]!.band.id).toBe("band-1");
    expect(briefer.calls[1]!.band.id).toBe(song.bandId);
    expect(song.plan.tracks.every((t) => song.band.parts.some((p) => p.id === t.partId))).toBe(true);
  });

  test("a request that matched a band by genre never triggers a recipe", async () => {
    const h = await build();
    await post(h.app, "/songs/compose", { text: "something funky" });
    expect(h.writer.calls).toEqual([]);
    expect(h.briefer.calls).toHaveLength(1);
    expect(await h.bands.list()).toHaveLength(1);
  });

  test("the second time around the rolled bands are picked directly", async () => {
    const h = await build({ briefer: gospelBriefer() });
    await post(h.app, "/songs/compose", { text: "a gospel tune", seed: 1 });
    await post(h.app, "/songs/compose", { text: "another gospel tune", seed: 2 });
    expect(h.writer.calls).toHaveLength(1);
    expect(h.briefer.calls).toHaveLength(3);
    expect(await h.bands.list()).toHaveLength(4);
  });
});

describe("song library and active song", () => {
  async function compose(app: App, text: string) {
    return SongResponseSchema.parse(await (await post(app, "/songs/compose", { text })).json()).song;
  }

  test("GET /songs lists newest first and GET /songs/:id fetches one", async () => {
    const h = await build();
    const first = await compose(h.app, "first");
    h.clock.advance(10);
    const second = await compose(h.app, "second");

    const list = SongListResponseSchema.parse(await (await h.app.request("/songs")).json());
    expect(list.songs.map((s) => s.id)).toEqual([second.id, first.id]);

    const one = SongResponseSchema.parse(await (await h.app.request(`/songs/${first.id}`)).json());
    expect(one.song).toEqual(first);
    expect((await h.app.request("/songs/nope")).status).toBe(404);
    expect((await h.app.request("/songs/..%2Fevil")).status).toBe(400);
  });

  test("DELETE /songs/active clears the active song and reports it", async () => {
    const h = await build();
    const song = await compose(h.app, "funky");
    const res = await h.app.request("/songs/active", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(ActiveSongResponseSchema.parse(await res.json()).song?.id).toBe(song.id);
    expect(h.store.getSong()).toBeNull();
    expect(h.events.ofType("song.changed").map((e) => e.song?.id ?? null)).toEqual([song.id, null]);
    expect(await h.songs.get(song.id)).toEqual(song);

    const again = ActiveSongResponseSchema.parse(await (await h.app.request("/songs/active", { method: "DELETE" })).json());
    expect(again.song).toBeNull();
  });

  test("POST /songs/:id/activate makes a saved song active", async () => {
    const h = await build();
    const first = await compose(h.app, "first");
    await compose(h.app, "second");
    const res = await post(h.app, `/songs/${first.id}/activate`);
    expect(res.status).toBe(200);
    expect(h.store.getSong()?.id).toBe(first.id);
    expect((await post(h.app, "/songs/nope/activate")).status).toBe(404);
  });

  test("DELETE /songs/:id removes it and clears it when active", async () => {
    const h = await build();
    const first = await compose(h.app, "first");
    const second = await compose(h.app, "second");
    expect(h.store.getSong()?.id).toBe(second.id);

    expect((await (await h.app.request(`/songs/${first.id}`, { method: "DELETE" })).json()) as unknown).toEqual({ deleted: true });
    expect(h.store.getSong()?.id).toBe(second.id);

    expect((await (await h.app.request(`/songs/${second.id}`, { method: "DELETE" })).json()) as unknown).toEqual({ deleted: true });
    expect(h.store.getSong()).toBeNull();
    expect((await (await h.app.request(`/songs/${second.id}`, { method: "DELETE" })).json()) as unknown).toEqual({ deleted: false });
  });
});

describe("StateStore transcript", () => {
  test("user requests from the api and mate messages land in the transcript; loop follow-ups do not", () => {
    const events = new EventBus();
    const store = new StateStore(events);
    store.recordCommand({ id: "c1", at: 5, source: "api", type: "userRequest", text: "hi" });
    store.recordCommand({ id: "c2", at: 6, source: "loop", type: "userRequest", text: "check in" });
    store.recordCommand({ id: "c3", at: 7, source: "api", type: "goalSet", text: "practice" });
    store.setLastMessage("hello back", 8, "c1");
    expect(store.getTranscript().map((t) => [t.role, t.kind, t.text, t.at])).toEqual([
      ["user", "request", "hi", 5],
      ["mate", "reply", "hello back", 8],
    ]);
    expect(store.snapshot().transcript).toHaveLength(2);
    expect(StateResponseSchema.safeParse(store.snapshot()).success).toBe(true);
    expect(events.ofType("transcript.appended").map((e) => e.entry.text)).toEqual(["hi", "hello back"]);
  });

  test("the transcript is capped, oldest first out", () => {
    const store = new StateStore(new EventBus(), 50, 3);
    for (let i = 0; i < 5; i++) store.appendTranscript({ role: "user", kind: "request", text: `m${i}`, at: i });
    expect(store.getTranscript().map((t) => t.text)).toEqual(["m2", "m3", "m4"]);
  });
});

describe("StateStore.setSong", () => {
  test("emits song.changed and shows in the snapshot", async () => {
    const events = new EventBus();
    const store = new StateStore(events);
    expect(store.snapshot().song).toBeNull();
    const { fixtureSong } = await import("./helpers/song.ts");
    const song = await fixtureSong();
    store.setSong(song);
    expect(store.snapshot().song).toEqual(song);
    expect(events.ofType("song.changed")).toEqual([{ type: "song.changed", song }]);
    store.setSong(null);
    expect(store.snapshot().song).toBeNull();
  });
});
