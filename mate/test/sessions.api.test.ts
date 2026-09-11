import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteSessionResponseSchema,
  ResumeSessionResponseSchema,
  SessionListResponseSchema,
  SessionResponseSchema,
  type Phase,
} from "@aibleton/protocol";
import { createApp } from "../src/api/server.ts";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { attachJournal } from "../src/core/journal.ts";
import { restoreStore } from "../src/core/restore.ts";
import { SessionManager, SessionStore } from "../src/core/sessions.ts";
import { SongStore } from "../src/core/songs.ts";
import { StateStore } from "../src/core/state.ts";
import { TemplateStore } from "../src/core/templates.ts";
import { BandStore } from "../src/core/bands.ts";
import { RecipeBook, RecipeStore } from "../src/core/recipes.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import type { CommandBody, CommandSource } from "../src/core/commands.ts";
import type { Intelligence } from "../src/intelligence/types.ts";
import { FakeAbleton, FakeSplice } from "./helpers/fakes.ts";
import { songServiceHarness } from "./helpers/song-service.ts";

let dir: string;

/** Idle unless a test says otherwise; records what a switch reseeds the machine with. */
function fakeIntelligence() {
  const submitted: { body: CommandBody; source: CommandSource }[] = [];
  let phase: Phase = "idle";
  const intelligence: Intelligence = {
    start() {},
    async stop() {},
    submit(body, source) {
      submitted.push({ body, source });
      return "fake_1";
    },
    post() {},
    phase: () => phase,
    async settle() {},
  };
  return { intelligence, submitted, setPhase: (p: Phase) => (phase = p) };
}

/** Mate as `index.ts` boots it: a session opened, restored, journaling, behind the app. */
async function build() {
  const clock = new ManualClock(1_000);
  const now = () => (clock as ManualClock).now();
  const events = new EventBus();
  const store = new StateStore(events);
  const songs = new SongStore({ dir: join(dir, "songs") });
  const sessionStore = new SessionStore({ dir: join(dir, "sessions"), now, log: silentLogger });
  const session = await sessionStore.openCurrent();
  await restoreStore({ store, entries: session.entries, songs, log: silentLogger });
  const detach = attachJournal(events, session.journal, now);
  const fake = fakeIntelligence();
  const sessions = new SessionManager({
    sessions: sessionStore,
    store,
    events,
    songs,
    intelligence: fake.intelligence,
    session,
    detach,
    now,
    log: silentLogger,
  });

  // Recording ports, so a test can assert a resume said nothing to either.
  const ableton = new FakeAbleton();
  const splice = new FakeSplice();
  const app = createApp({
    store,
    templates: new TemplateStore({ dir: join(dir, "templates") }),
    bands: new BandStore({ dir: join(dir, "bands") }),
    songs: songServiceHarness({ dir, ableton, splice }).service,
    recipes: new RecipeBook({ store: new RecipeStore({ dir: join(dir, "recipes") }), writer: new ScriptedRecipeWriter(), now }),
    sessions,
    intelligence: fake.intelligence,
    config: loadConfig({}),
    log: silentLogger,
    startedAt: 0,
    now,
  });
  return { app, store, events, sessions, ableton, splice, ...fake };
}

async function post(app: Awaited<ReturnType<typeof build>>["app"], path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-sessions-api-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sessions api", () => {
  test("GET /sessions lists the one mate booted into", async () => {
    const { app, sessions } = await build();
    const res = await app.request("/sessions");
    expect(res.status).toBe(200);
    const body = SessionListResponseSchema.parse(await res.json());
    expect(body.currentId).toBe(sessions.currentId());
    expect(body.sessions.map((s) => s.id)).toEqual([sessions.currentId()]);
    expect(body.sessions[0]!.events).toBe(0);
    expect(body.sessions[0]!.preview).toBeNull();
  });

  test("a session's row previews what the drummer said and names its song", async () => {
    const { app, store, sessions } = await build();
    store.recordCommand({ id: "c1", at: 10, source: "api", type: "userRequest", text: "write me something funky" });
    store.recordCommand({ id: "c2", at: 11, source: "api", type: "userRequest", text: "and a bridge" });

    const res = await app.request(`/sessions/${sessions.currentId()}`);
    expect(res.status).toBe(200);
    const body = SessionResponseSchema.parse(await res.json());
    // The *first* thing said, so the row says what the session was for.
    expect(body.session.preview).toBe("write me something funky");
    expect(body.session.events).toBeGreaterThan(0);
    expect(body.session.songId).toBeNull();
  });

  test("POST /sessions creates, switches and hands back the empty state", async () => {
    const { app, store, sessions, submitted } = await build();
    const first = sessions.currentId();
    store.setGoal("keep time at 120");

    const res = await post(app, "/sessions", { name: "tuesday" });
    expect(res.status).toBe(200);
    const body = ResumeSessionResponseSchema.parse(await res.json());
    expect(body.session.name).toBe("tuesday");
    expect(body.session.id).not.toBe(first);
    expect(body.state.goal).toBeNull();
    expect(sessions.currentId()).toBe(body.session.id);
    expect(store.getGoal()).toBeNull();

    // The machine is reseeded in one command, clearing what the old session had.
    const seed = submitted.find((s) => s.body.type === "contextRestored");
    expect(seed?.source).toBe("loop");
    expect(seed?.body).toEqual({ type: "contextRestored", goal: null, userText: null, song: null });

    // And the reseed happens inside a pause/resume bracket, so a tick arriving mid-switch cannot
    // start a brain call against a store that is halfway between two sessions.
    expect(submitted.map((s) => s.body.type)).toEqual(["pause", "contextRestored", "resume"]);

    const list = SessionListResponseSchema.parse(await (await app.request("/sessions")).json());
    expect(list.sessions).toHaveLength(2);
    expect(list.currentId).toBe(body.session.id);
  });

  test("POST /sessions with no body names the session after its start time", async () => {
    const { app } = await build();
    const res = await post(app, "/sessions");
    expect(res.status).toBe(200);
    const body = ResumeSessionResponseSchema.parse(await res.json());
    expect(body.session.name.length).toBeGreaterThan(0);
  });

  test("resuming brings back the goal, the conversation and the song pointer", async () => {
    const { app, store, sessions, events } = await build();
    const first = sessions.currentId();
    store.recordCommand({ id: "c1", at: 10, source: "api", type: "userRequest", text: "write me something funky" });
    store.setGoal("keep time at 120");

    const created = ResumeSessionResponseSchema.parse(await (await post(app, "/sessions")).json());
    expect(store.getTranscript()).toHaveLength(0);

    const res = await post(app, `/sessions/${first}/resume`);
    expect(res.status).toBe(200);
    const body = ResumeSessionResponseSchema.parse(await res.json());
    expect(body.session.id).toBe(first);
    expect(body.state.goal).toBe("keep time at 120");
    expect(body.state.transcript.map((t) => t.text)).toEqual(["write me something funky"]);
    expect(store.getGoal()).toBe("keep time at 120");
    expect(sessions.currentId()).toBe(first);
    expect(created.session.id).not.toBe(first);

    // Every other client is told, through the one fold they already run.
    const replaced = events.ofType("state.replaced");
    expect(replaced.at(-1)?.state.goal).toBe("keep time at 120");
  });

  test("a resume touches neither port", async () => {
    const { app, sessions, ableton, splice } = await build();
    const first = sessions.currentId();
    await post(app, "/sessions");
    ableton.calls.length = 0;
    splice.calls.length = 0;

    expect((await post(app, `/sessions/${first}/resume`)).status).toBe(200);
    // Restoring mate's picture of a session says nothing to Live and spends no
    // Splice search: the manager has no reference to either port.
    expect(ableton.calls).toEqual([]);
    expect(splice.calls).toEqual([]);
  });

  test("switching sessions does not re-journal the session it replayed", async () => {
    const { app, store, sessions } = await build();
    const first = sessions.currentId();
    store.recordCommand({ id: "c1", at: 10, source: "api", type: "userRequest", text: "write me something funky" });

    const before = SessionResponseSchema.parse(await (await app.request(`/sessions/${first}`)).json()).session.events;
    await post(app, "/sessions");
    await post(app, `/sessions/${first}/resume`);
    const after = SessionResponseSchema.parse(await (await app.request(`/sessions/${first}`)).json()).session.events;
    // The journal is attached *after* the replay, so the replay writes nothing.
    expect(after).toBe(before);
  });

  test("resuming the session mate is already in is a 200 no-op", async () => {
    const { app, store, sessions, events, submitted } = await build();
    store.setGoal("keep time at 120");
    const seeds = submitted.length;
    const replaced = events.ofType("state.replaced").length;

    const res = await post(app, `/sessions/${sessions.currentId()}/resume`);
    expect(res.status).toBe(200);
    const body = ResumeSessionResponseSchema.parse(await res.json());
    expect(body.state.goal).toBe("keep time at 120");
    // Nothing happened: the app may double-fire this.
    expect(submitted).toHaveLength(seeds);
    expect(events.ofType("state.replaced")).toHaveLength(replaced);
  });

  test("a bad session id is a 400 and an unknown one a 404", async () => {
    const { app } = await build();
    for (const id of ["a.b", "..%2Fevil", "a%2Fb", "x".repeat(65)]) {
      expect((await app.request(`/sessions/${id}`)).status).toBe(400);
      expect((await post(app, `/sessions/${id}/resume`)).status).toBe(400);
      expect((await app.request(`/sessions/${id}`, { method: "DELETE" })).status).toBe(400);
    }
    expect((await app.request("/sessions/ses_nope")).status).toBe(404);
    expect((await post(app, "/sessions/ses_nope/resume")).status).toBe(404);
  });

  test("switching sessions is never blocked by what the loop is thinking", async () => {
    // Mate is thinking most of the time: a real brain and a five-second tick leave the loop in
    // `deciding` more often than not. Refusing a switch for that made "new session" a button the
    // drummer could almost never press — and what mate is chewing on is not their business.
    const { app, sessions, setPhase, submitted } = await build();
    const first = sessions.currentId();
    await post(app, "/sessions");
    setPhase("deciding");

    const res = await post(app, `/sessions/${first}/resume`);
    expect(res.status).toBe(200);
    expect(sessions.currentId()).toBe(first);
    // The in-flight thought is not ignored, it is stopped: `pause` aborts the brain call so its
    // result cannot land in the session that just arrived.
    expect(submitted.map((s) => s.body.type)).toContain("pause");

    setPhase("acting");
    expect((await post(app, "/sessions")).status).toBe(200);
  });

  test("a resume is refused under a route-driven compose the loop knows nothing about", async () => {
    const { app, store, sessions, setPhase } = await build();
    const first = sessions.currentId();
    await post(app, "/sessions");
    // The case a single check misses: the loop is idle, but `POST
    // /songs/compose` is three minutes into writing the store this would reset.
    setPhase("idle");
    store.setActivity({
      requestId: "route_1",
      kind: "compose",
      request: "something funky",
      message: "briefing",
      fields: [],
      fraction: null,
      startedAt: 1_000,
      at: 1_000,
      cancellable: false,
    });

    const res = await post(app, `/sessions/${first}/resume`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("compose");
    expect(sessions.currentId()).not.toBe(first);
  });

  test("DELETE removes a session mate has left, never the one it is in", async () => {
    const { app, sessions } = await build();
    const first = sessions.currentId();

    const current = await app.request(`/sessions/${first}`, { method: "DELETE" });
    expect(current.status).toBe(409);

    await post(app, "/sessions");
    const res = await app.request(`/sessions/${first}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(DeleteSessionResponseSchema.parse(await res.json()).deleted).toBe(true);
    expect((await app.request(`/sessions/${first}`)).status).toBe(404);

    // Deleting something that was never there is a `false`, not an error.
    const gone = await app.request("/sessions/ses_nope", { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(DeleteSessionResponseSchema.parse(await gone.json()).deleted).toBe(false);
  });
});
