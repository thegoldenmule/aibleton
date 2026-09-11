import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActiveSongResponseSchema,
  ArrangeSongResponseSchema,
  DownloadSongResponseSchema,
  ResolveSongResponseSchema,
  SongListResponseSchema,
  SongResponseSchema,
  StateResponseSchema,
  dawStatus,
  pendingDownloadUuids,
} from "@aibleton/protocol";
import type { Activity, MateEvent, Song } from "@aibleton/protocol";
import { createApp } from "../src/api/server.ts";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { SongStore } from "../src/core/songs.ts";
import { StateStore } from "../src/core/state.ts";
import { loadConfig } from "../src/config.ts";
import type { Intelligence } from "../src/intelligence/types.ts";
import { silentLogger } from "../src/log.ts";
import { InMemoryAbletonAdapter } from "../src/ports/ableton/stub.ts";
import { FixtureSpliceAdapter } from "../src/ports/splice/stub.ts";
import { SongService } from "../src/songwriting/service.ts";
import { ModelRefusedError } from "../src/core/anthropic.ts";
import { ScriptedBriefer } from "../src/songwriting/briefer/index.ts";
import { defaultBrief } from "../src/songwriting/briefer/scripted.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
import { FakeSplice } from "./helpers/fakes.ts";
import { bandLibrary, recipeBook, templateLibrary } from "./helpers/library.ts";
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

async function build(
  opts: { seedLibrary?: boolean; briefer?: ScriptedBriefer; writer?: ScriptedRecipeWriter; now?: number; splice?: FixtureSpliceAdapter | FakeSplice; ableton?: InMemoryAbletonAdapter } = {},
) {
  const clock = new ManualClock(opts.now ?? 1_000);
  const events = new EventBus<MateEvent>();
  const store = new StateStore(events);
  const templates = templateLibrary(join(dir, "templates"), { now: () => clock.now(), log: silentLogger });
  const bands = bandLibrary(join(dir, "bands"), { now: () => clock.now(), log: silentLogger });
  const songs = new SongStore({ dir: join(dir, "songs") });
  const briefer = opts.briefer ?? new ScriptedBriefer();
  const writer = opts.writer ?? new ScriptedRecipeWriter();
  const recipes = recipeBook(dir, { writer, now: () => clock.now() });
  const splice = opts.splice ?? new FixtureSpliceAdapter();
  const ableton = opts.ableton ?? new InMemoryAbletonAdapter({ now: () => clock.now() });
  if (opts.seedLibrary !== false) {
    await templates.save(fixtureTemplate());
    await bands.save(fixtureBand());
  }
  const config = loadConfig({ MATE_DOWNLOADS_DIR: join(dir, "downloads") });
  const service = new SongService({
    songs,
    templates,
    bands,
    briefer,
    recipes,
    store,
    splice,
    ableton,
    downloadsDir: config.downloadsDir,
    log: silentLogger,
    now: () => clock.now(),
  });
  const app = createApp({
    store,
    templates,
    bands,
    songs: service,
    recipes,
    intelligence: idleIntelligence,
    config,
    log: silentLogger,
    startedAt: 0,
    now: () => clock.now(),
  });
  return { app, service, store, events, songs, templates, bands, briefer, writer, recipes, clock, splice, ableton, downloadsDir: config.downloadsDir };
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
    // Composing chains the free Splice search, which publishes the song again as each slot's candidates land.
    expect(new Set(h.events.ofType("song.changed").map((e) => e.song?.id))).toEqual(new Set([song.id]));
    expect(h.events.ofType("song.changed").at(-1)?.song).toEqual(song);
    expect(song.plan.slots.every((s) => s.candidates.length > 0)).toBe(true);
    expect(h.events.ofType("message").map((e) => e.text)).toEqual([song.brief.summary]);
    // The request, then the trail of steps, then the brief's summary as the reply.
    const conversation = h.store.getTranscript().map((t) => [t.role, t.kind, t.text] as const);
    expect(conversation.at(0)).toEqual(["user", "compose", "something funky and upbeat"]);
    expect(conversation.at(-1)).toEqual(["mate", "reply", song.brief.summary]);
    const steps = conversation.slice(1, -1);
    expect(steps.every(([role, kind]) => role === "mate" && kind === "step")).toBe(true);
    // Every line of the trail was the activity's headline while it ran, in the same order.
    const headlines = h.events.ofType("activity.changed").map((e) => e.activity?.message ?? "");
    expect(steps.map(([, , text]) => text)).toEqual(headlines.slice(1, 1 + steps.length));
    expect(h.events.ofType("transcript.appended")).toHaveLength(conversation.length);
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

  test("an empty library is seeded and composed from, not refused", async () => {
    const h = await build({ seedLibrary: false });
    const res = await post(h.app, "/songs/compose", { text: "funky", seed: 7 });
    expect(res.status).toBe(200);
    const { song } = SongResponseSchema.parse(await res.json());

    // Seeded through the libraries, so the next compose finds them saved.
    const templates = await h.templates.list();
    const bands = await h.bands.list();
    expect(templates.map((t) => t.id)).toEqual([song.templateId]);
    // Named for the compose's own seed, which tells it apart from any band the
    // new-genre detour rolled afterwards (those carry seed + 1, + 2, + 3).
    const seeded = bands.filter((b) => b.name.endsWith(" band 7"));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.parts.length).toBeGreaterThan(0);
    // The song embeds what it used, so the seeded form is the one it was built on.
    expect(song.template.form).toBe(templates[0]!.form);

    // And the drummer is told why a form and a band turned up unasked.
    const trail = h.store.getTranscript().filter((t) => t.kind === "step").map((t) => t.text);
    expect(trail[0]).toBe("no saved forms yet, so laid one out to start from");
    expect(trail[1]).toBe("no saved bands yet, so staffed one to start from");
    expect(h.store.getSong()?.id).toBe(song.id);
  });

  test("a second compose reuses the seeded library rather than growing it", async () => {
    const h = await build({ seedLibrary: false });
    expect((await post(h.app, "/songs/compose", { text: "funky", seed: 7 })).status).toBe(200);
    expect((await post(h.app, "/songs/compose", { text: "funky again", seed: 7 })).status).toBe(200);
    expect(await h.templates.list()).toHaveLength(1);
    const second = h.store.getTranscript().filter((t) => t.kind === "step").map((t) => t.text);
    expect(second.filter((t) => t.startsWith("no saved forms yet"))).toHaveLength(1);
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
    const published = h.events.ofType("song.changed").map((e) => e.song?.id ?? null);
    expect(published.at(-1)).toBeNull();
    expect(new Set(published.slice(0, -1))).toEqual(new Set([song.id]));
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
    const events = new EventBus<MateEvent>();
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
    const store = new StateStore(new EventBus<MateEvent>(), 50, 3);
    for (let i = 0; i < 5; i++) store.appendTranscript({ role: "user", kind: "request", text: `m${i}`, at: i });
    expect(store.getTranscript().map((t) => t.text)).toEqual(["m2", "m3", "m4"]);
  });
});

describe("StateStore.setSong", () => {
  test("emits song.changed and shows in the snapshot", async () => {
    const events = new EventBus<MateEvent>();
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

describe("POST /songs/:id/resolve, /pick and /download", () => {
  type H = Awaited<ReturnType<typeof build>>;

  /** Compose one active song and one library song, both unresolved. */
  async function twoSongs(h: H): Promise<{ active: Song; library: Song }> {
    const library = SongResponseSchema.parse(await (await post(h.app, "/songs/compose", { text: "library funk" })).json()).song;
    h.clock.advance(10);
    const active = SongResponseSchema.parse(await (await post(h.app, "/songs/compose", { text: "active funk" })).json()).song;
    expect(h.store.getSong()?.id).toBe(active.id);
    return { active, library };
  }

  test("resolve fills candidates, saves, and publishes only the active song", async () => {
    const h = await build();
    const { active, library } = await twoSongs(h);
    const before = h.events.ofType("song.changed").length;

    const res = await post(h.app, `/songs/${active.id}/resolve`);
    expect(res.status).toBe(200);
    const body = ResolveSongResponseSchema.parse(await res.json());
    expect(body.failedSlotIds).toEqual([]);
    for (const slot of body.song.plan.slots) {
      expect(slot.candidates.length).toBeGreaterThan(0);
      expect(slot.pickedUuid).toBe(slot.candidates[0]!.uuid);
    }
    expect(await h.songs.get(active.id)).toEqual(body.song);
    expect(h.store.getSong()).toEqual(body.song);
    // One publish as each slot lands, plus the final one.
    const afterActive = h.events.ofType("song.changed").length;
    expect(afterActive).toBe(before + active.plan.slots.length + 1);
    expect(StateResponseSchema.safeParse(h.store.snapshot()).success).toBe(true);

    const lib = await post(h.app, `/songs/${library.id}/resolve`);
    expect(lib.status).toBe(200);
    expect((await h.songs.get(library.id))!.plan.slots[0]!.candidates.length).toBeGreaterThan(0);
    expect(h.store.getSong()?.id).toBe(active.id);
    expect(h.events.ofType("song.changed").length).toBe(afterActive);
  });

  test("resolve answers 400, 404 and 502", async () => {
    const dead = new FakeSplice();
    dead.search = () => {
      throw new Error("splice down");
    };
    const h = await build({ splice: dead });
    const { active } = await twoSongs(h);
    expect((await post(h.app, "/songs/../x/resolve")).status).toBe(404);
    expect((await post(h.app, "/songs/a.b/resolve")).status).toBe(400);
    expect((await post(h.app, "/songs/nope/resolve")).status).toBe(404);
    // Every query failing is not a transport error: the song comes back untouched with every slot reported.
    const res = await post(h.app, `/songs/${active.id}/resolve`);
    expect(res.status).toBe(200);
    expect(ResolveSongResponseSchema.parse(await res.json()).failedSlotIds).toHaveLength(active.plan.slots.length);
  });

  test("pick changes the slot's pick and validates slot and uuid", async () => {
    const h = await build();
    const { active } = await twoSongs(h);
    const resolved = ResolveSongResponseSchema.parse(await (await post(h.app, `/songs/${active.id}/resolve`)).json()).song;
    const slot = resolved.plan.slots.find((s) => s.id === "bass-p:a")!;
    const uuid = slot.candidates[1]!.uuid;

    const ok = await post(h.app, `/songs/${active.id}/pick`, { slotId: slot.id, soundUuid: uuid });
    expect(ok.status).toBe(200);
    const song = SongResponseSchema.parse(await ok.json()).song;
    expect(song.plan.slots.find((s) => s.id === slot.id)?.pickedUuid).toBe(uuid);
    expect(h.store.getSong()?.plan.slots.find((s) => s.id === slot.id)?.pickedUuid).toBe(uuid);
    expect((await h.songs.get(active.id))?.plan.slots.find((s) => s.id === slot.id)?.pickedUuid).toBe(uuid);

    expect((await post(h.app, `/songs/${active.id}/pick`, { slotId: "nope:a", soundUuid: uuid })).status).toBe(404);
    expect((await post(h.app, `/songs/${active.id}/pick`, { slotId: slot.id, soundUuid: "not-a-candidate" })).status).toBe(400);
    expect((await post(h.app, `/songs/${active.id}/pick`, { slotId: slot.id })).status).toBe(400);
    expect((await h.app.request(`/songs/${active.id}/pick`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })).status).toBe(400);
  });

  test("download writes every distinct pick to disk and publishes progress", async () => {
    const h = await build();
    const { active } = await twoSongs(h);
    const resolved = ResolveSongResponseSchema.parse(await (await post(h.app, `/songs/${active.id}/resolve`)).json()).song;
    const pending = pendingDownloadUuids(resolved.plan);
    expect(pending.length).toBeGreaterThan(0);
    const before = h.events.ofType("song.changed").length;

    const res = await post(h.app, `/songs/${active.id}/download`);
    expect(res.status).toBe(200);
    const body = DownloadSongResponseSchema.parse(await res.json());
    expect(body.failed).toEqual([]);
    expect(body.downloaded.map((d) => d.uuid)).toEqual(pending);
    expect(h.splice.calls.filter((c) => c.method === "downloadAsset").map((c) => c.args[0])).toEqual(pending);
    for (const slot of body.song.plan.slots) {
      expect(slot.resolved?.soundUuid).toBe(slot.pickedUuid!);
      expect(slot.resolved?.localPath?.startsWith(h.downloadsDir)).toBe(true);
      expect(existsSync(slot.resolved!.localPath!)).toBe(true);
    }
    expect(pendingDownloadUuids(body.song.plan)).toEqual([]);
    // One publish per file, plus one per track the arrange-as-it-lands step created in Live.
    expect(h.events.ofType("song.changed").length).toBe(before + pending.length + body.song.plan.tracks.length);
    expect(await h.songs.get(active.id)).toEqual(body.song);
    expect(h.store.snapshot().lastMessage).toMatch(/^got \d+ sounds? from Splice$/);
    // Everything is on disk now, so there is nothing left to spend on.
    expect((await post(h.app, `/songs/${active.id}/download`)).status).toBe(409);
  });

  test("picking a sound another slot already downloaded reuses the file for free", async () => {
    const h = await build();
    const { active } = await twoSongs(h);
    await post(h.app, `/songs/${active.id}/resolve`);
    const done = DownloadSongResponseSchema.parse(await (await post(h.app, `/songs/${active.id}/download`)).json()).song;
    const drumsA = done.plan.slots.find((s) => s.id === "drums-kit:a")!;
    const drumsB = done.plan.slots.find((s) => s.id === "drums-kit:b")!;
    const other = drumsB.candidates.find((c) => c.uuid !== drumsA.pickedUuid);
    if (!other) return; // the fixture catalog gave both slots one candidate; nothing to swap
    // Make drums:b want something new, then swap it back to what drums:a already has on disk.
    await post(h.app, `/songs/${active.id}/pick`, { slotId: "drums-kit:b", soundUuid: other.uuid });
    const calls = h.splice.calls.filter((c) => c.method === "downloadAsset").length;
    const res = await post(h.app, `/songs/${active.id}/pick`, { slotId: "drums-kit:b", soundUuid: drumsA.pickedUuid! });
    const song = SongResponseSchema.parse(await res.json()).song;
    expect(song.plan.slots.find((s) => s.id === "drums-kit:b")?.resolved).toEqual(drumsA.resolved);
    expect(pendingDownloadUuids(song.plan)).toEqual([]);
    expect(h.splice.calls.filter((c) => c.method === "downloadAsset").length).toBe(calls);
  });

  test("download reports a failed asset and keeps the rest", async () => {
    const catalog = new FixtureSpliceAdapter();
    const flaky = new FakeSplice();
    flaky.search = (q, o) => catalog.searchSounds(q, o);
    const h = await build({ splice: flaky });
    const { active } = await twoSongs(h);
    const resolved = ResolveSongResponseSchema.parse(await (await post(h.app, `/songs/${active.id}/resolve`)).json()).song;
    const pending = pendingDownloadUuids(resolved.plan);
    flaky.failDownloads.add(pending[0]!);

    const body = DownloadSongResponseSchema.parse(await (await post(h.app, `/songs/${active.id}/download`)).json());
    expect(body.failed.map((f) => f.uuid)).toEqual([pending[0]!]);
    expect(body.downloaded.map((d) => d.uuid)).toEqual(pending.slice(1));
    expect(flaky.calls.filter((c) => c.method === "downloadAsset")).toHaveLength(pending.length);
    expect(pendingDownloadUuids(body.song.plan)).toEqual([pending[0]!]);
  });
});

describe("activity", () => {
  test("narrates a compose as it runs, then clears", async () => {
    const h = await build();
    const res = await post(h.app, "/songs/compose", { text: "funk" });
    expect(res.status).toBe(200);
    const seen = h.events.ofType("activity.changed").map((e) => e.activity);
    // Cleared at the end: nothing left spinning in the app once the work is done.
    expect(seen.at(-1)).toBeNull();
    expect(h.store.getActivity()).toBeNull();

    const live = seen.filter((a) => a !== null);
    expect(live.every((a) => a.kind === "compose" && a.request === "funk" && a.message.length > 0)).toBe(true);
    // One activity moving along, not a new one per step; a click is not cancellable from the machine.
    expect(new Set(live.map((a) => a.requestId)).size).toBe(1);
    expect(live.every((a) => a.cancellable === false && a.startedAt === live[0]!.startedAt)).toBe(true);
    expect(live.map((a) => a.fraction)).toEqual([...live.map((a) => a.fraction)].sort((x, y) => (x ?? 0) - (y ?? 0)));
    expect(live[0]!.message).toBe("starting a song");
    // The free Splice search runs on the end of the compose, under the same activity.
    expect(live.at(-1)!.message).toMatch(/^searched Splice for \d+ of \d+ slots$/);

    // Every decision is a labelled field, not a sentence: the pane renders them as a list.
    const value = (i: number, label: string) => live[i]!.fields.find((f) => f.label === label)?.value;
    expect(value(1, "form")).toContain("Tuesday jam");
    expect(value(1, "parts")).toBe("kit (drums), p bass (bass), strat (guitar)");
    expect(value(2, "about")).toContain("“Tuesday jam”");
    expect(value(3, "key")).toMatch(/^[A-G][#b]? \w+$/);
    expect(value(3, "tempo")).toMatch(/^\d+ bpm \(\d+–\d+\)$/);
    expect(value(3, "meter")).toBe("4/4");
    expect(live[4]!.message).toMatch(/^(changed the form and the band|the brief left the form)/);
    expect(value(5, "tracks")).toBe("3");
    expect(value(5, "resting")).toBeDefined();
  });

  test("covers the new-genre detour and clears when the compose fails", async () => {
    const h = await build({ briefer: new ScriptedBriefer((input) => ({ ...defaultBrief(input), genres: ["gospel", "soul"] })) });
    await post(h.app, "/songs/compose", { text: "gospel please" });
    const trail = h.store.getTranscript().filter((t) => t.kind === "step").map((t) => t.text);
    // picking, briefing x2, recipe, bands x3, rebriefing x2, feedback, layout.
    expect(trail).toHaveLength(11);
    expect(trail[3]).toBe("no saved band plays gospel");
    expect(trail.filter((t) => t.startsWith("rolled gospel band"))).toHaveLength(3);
    expect(trail.filter((t) => t.startsWith("briefing again"))).toHaveLength(1);

    h.briefer.rejectNext(new Error("model down"));
    expect((await post(h.app, "/songs/compose", { text: "again" })).status).toBe(502);
    // A failure clears it too, or the app would spin forever on a compose that died.
    expect(h.events.ofType("activity.changed").at(-1)!.activity).toBeNull();
    expect(h.store.getActivity()).toBeNull();
  });

  test("a resolve, a download, an arrange and an edit each get one, and the state carries it", async () => {
    const h = await build();
    const song = SongResponseSchema.parse(await (await post(h.app, "/songs/compose", { text: "funk" })).json()).song;
    // Subscribed rather than read back from the bus: its history is capped, and a compose fills it.
    const seen: (Activity | null)[] = [];
    h.events.subscribe((e) => {
      if (e.type === "activity.changed") seen.push(e.activity);
    });
    const kindsOf = () => {
      const kinds = seen.map((a) => a?.kind ?? null);
      seen.length = 0;
      return kinds;
    };

    await post(h.app, `/songs/${song.id}/resolve`);
    expect(kindsOf()).toEqual(expect.arrayContaining(["resolve", null]));

    await post(h.app, `/songs/${song.id}/download`);
    const download = kindsOf();
    expect(download).toContain("download");
    expect(download.at(-1)).toBeNull();

    await post(h.app, `/songs/${song.id}/arrange`);
    const arrange = kindsOf();
    expect(arrange).toContain("arrange");
    expect(arrange.at(-1)).toBeNull();

    await h.app.request(`/songs/${song.id}/placements`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partId: "bass-p", occurrence: 0, plays: false }),
    });
    expect(kindsOf()).toEqual(["edit", null]);

    // At rest the state says so, and nothing is waiting.
    const state = StateResponseSchema.parse(await (await h.app.request("/state")).json());
    expect(state.activity).toBeNull();
    expect(state.queued).toEqual([]);
  });
});

describe("DELETE /songs/:id/tracks/:partId", () => {
  test("removes the part everywhere, saves, and publishes the active song", async () => {
    const h = await build();
    const song = SongResponseSchema.parse(await (await post(h.app, "/songs/compose", { text: "funk" })).json()).song;
    const res = await h.app.request(`/songs/${song.id}/tracks/drums-kit`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const out = SongResponseSchema.parse(await res.json()).song;
    expect(out.plan.tracks.map((t) => t.partId)).toEqual(["bass-p", "guitar-strat"]);
    expect(out.plan.slots.some((s) => s.partId === "drums-kit")).toBe(false);
    expect(await h.songs.get(song.id)).toEqual(out);
    expect(h.store.getSong()).toEqual(out);
    expect((await h.app.request(`/songs/${song.id}/tracks/nope`, { method: "DELETE" })).status).toBe(404);
    expect((await h.app.request(`/songs/nope/tracks/bass-p`, { method: "DELETE" })).status).toBe(404);
    await h.app.request(`/songs/${song.id}/tracks/bass-p`, { method: "DELETE" });
    expect((await h.app.request(`/songs/${song.id}/tracks/guitar-strat`, { method: "DELETE" })).status).toBe(409);
  });
});

describe("PUT /songs/:id/placements", () => {
  test("rests and brings back a part for one occurrence, saving and publishing", async () => {
    const h = await build();
    const song = SongResponseSchema.parse(await (await post(h.app, "/songs/compose", { text: "funk" })).json()).song;
    const put = (body: unknown) => h.app.request(`/songs/${song.id}/placements`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const drumsIn = (s: Song) => s.plan.placements.filter((p) => p.partId === "drums-kit").map((p) => p.occurrence);
    const before = drumsIn(song);
    expect(before).toContain(0);

    const rested = SongResponseSchema.parse(await (await put({ partId: "drums-kit", occurrence: 0, plays: false })).json()).song;
    expect(drumsIn(rested)).toEqual(before.filter((o) => o !== 0));
    expect(await h.songs.get(song.id)).toEqual(rested);
    expect(h.store.getSong()).toEqual(rested);

    const back = SongResponseSchema.parse(await (await put({ partId: "drums-kit", occurrence: 0, plays: true })).json()).song;
    expect(drumsIn(back)).toEqual(before);

    expect((await put({ partId: "drums-kit", occurrence: 0 })).status).toBe(400);
    expect((await put({ partId: "nope", occurrence: 0, plays: true })).status).toBe(404);
    expect((await put({ partId: "drums-kit", occurrence: 99, plays: true })).status).toBe(404);
  });
});

describe("POST /songs/:id/arrange", () => {
  type H = Awaited<ReturnType<typeof build>>;
  async function downloaded(h: H): Promise<Song> {
    const composed = SongResponseSchema.parse(await (await post(h.app, "/songs/compose", { text: "active funk" })).json()).song;
    await post(h.app, `/songs/${composed.id}/resolve`);
    return DownloadSongResponseSchema.parse(await (await post(h.app, `/songs/${composed.id}/download`)).json()).song;
  }

  test("download puts each file into Live as it lands; arrange afterwards has nothing left to do", async () => {
    const h = await build();
    const song = await downloaded(h);
    expect(song.plan.tracks.map((t) => t.liveName)).toEqual(["kit [mate]", "p bass [mate]", "strat [mate]"]);
    const session = h.store.getDaw()!;
    expect(session.transport.tempo).toBe(song.plan.bpm);
    expect(session.tracks.slice(4).map((t) => t.name)).toEqual(["kit [mate]", "p bass [mate]", "strat [mate]"]);
    const status = dawStatus(song, session);
    expect(status.steps).toEqual([]);
    expect(status.slots.every((s) => s.state === "in-live")).toBe(true);
    expect(h.events.ofType("state.changed").length).toBeGreaterThan(0);

    const res = await post(h.app, `/songs/${song.id}/arrange`);
    expect(res.status).toBe(200);
    const body = ArrangeSongResponseSchema.parse(await res.json());
    expect(body.applied).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(body.song).toEqual(song);
  });

  test("arrange builds a song whose files are on disk but not yet in Live, and names the tracks on the song", async () => {
    const h = await build();
    const song = await downloaded(h);
    // A fresh set: the drummer opened another Live project.
    const fresh = new InMemoryAbletonAdapter();
    const h2 = await build({ ableton: fresh });
    await h2.songs.save(song);
    const res = await post(h2.app, `/songs/${song.id}/arrange`);
    const body = ArrangeSongResponseSchema.parse(await res.json());
    expect(body.failed).toEqual([]);
    expect(body.applied.filter((s) => s.startsWith("create track"))).toHaveLength(3);
    expect((await h2.songs.get(song.id))?.plan.tracks.every((t) => t.liveName)).toBe(true);
    expect(h2.store.snapshot().lastMessage).toMatch(/steps in Live/);
    expect((await h2.app.request(`/songs/nope/arrange`, { method: "POST" })).status).toBe(404);
  });
});
