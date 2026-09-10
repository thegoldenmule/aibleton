import { describe, expect, test } from "bun:test";
import type { Activity } from "@aibleton/protocol";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { StateStore } from "../src/core/state.ts";
import { silentLogger } from "../src/log.ts";
import { ScriptedBrain } from "../src/intelligence/brain/scripted.ts";
import type { Decision } from "../src/intelligence/brain/types.ts";
import { AgentLoop } from "../src/intelligence/loop.ts";
import { FakeAbleton, FakeSplice } from "./helpers/fakes.ts";
import { denseBriefer, fixtureSong } from "./helpers/song.ts";
import { seedLibrary, songServiceHarness } from "./helpers/song-service.ts";

function harness(script: Decision[] | ScriptedBrain = [], tickMs = 0) {
  const clock = new ManualClock(1_000);
  const events = new EventBus();
  const store = new StateStore(events);
  const mailbox = new Mailbox();
  const ableton = new FakeAbleton();
  const splice = new FakeSplice();
  const brain = script instanceof ScriptedBrain ? script : new ScriptedBrain(script);
  const loop = new AgentLoop({ clock, mailbox, store, brain, ableton, splice, log: silentLogger, options: { tickMs, retryBaseMs: 100 } });
  loop.start();
  return { clock, events, store, mailbox, ableton, splice, brain, loop };
}

describe("AgentLoop", () => {
  test("round trip: userRequest -> snapshot -> brain -> setTempo applied -> idle", async () => {
    const h = harness([{ message: "Setting 120.", actions: [{ type: "setTempo", bpm: 120 }] }]);
    h.loop.submit({ type: "userRequest", text: "120 bpm" }, "api");
    await h.loop.settle();

    expect(h.loop.phase()).toBe("idle");
    expect(h.ableton.callsOf("setTempo")).toEqual([{ method: "setTempo", args: [120], ctx: { userPrompt: "120 bpm" } }]);
    expect(h.brain.calls).toHaveLength(1);
    expect(h.brain.calls[0]?.userText).toBe("120 bpm");
    expect(h.events.ofType("message").map((e) => e.text)).toEqual(["Setting 120."]);
    const applied = h.events.ofType("action.applied");
    expect(applied).toMatchObject([{ action: "setTempo", ok: true, detail: "120 bpm" }]);
    // Tied to the turn that decided on it, so the app can match it to the activity it is watching.
    expect(applied[0]!.requestId).toBe(h.events.ofType("activity.changed")[0]!.activity!.requestId);
    expect(h.store.snapshot().lastMessage).toBe("Setting 120.");
    // After acting, the loop refreshed the snapshot again so the store sees the new tempo.
    expect(h.store.getSession()?.transport.tempo).toBe(120);
    expect(h.ableton.callsOf("getSnapshot").length).toBeGreaterThanOrEqual(2);
    const phases = h.events.ofType("phase.changed").map((e) => e.phase);
    expect(phases).toEqual(["observing", "deciding", "acting", "idle", "observing", "idle"]);
  });

  test("cancel while the brain hangs applies no actions", async () => {
    const brain = new ScriptedBrain([{ message: "late", actions: [{ type: "setTempo", bpm: 200 }] }]);
    brain.hold();
    const h = harness(brain);
    h.loop.submit({ type: "userRequest", text: "go" }, "api");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.loop.phase()).toBe("deciding");
    expect(brain.pendingCount()).toBe(1);

    h.loop.submit({ type: "cancel" }, "api");
    expect(h.loop.phase()).toBe("idle");
    brain.release();
    await h.loop.settle();

    expect(h.ableton.callsOf("setTempo")).toEqual([]);
    expect(h.loop.phase()).toBe("idle");
    expect(h.events.ofType("cancelled")).toHaveLength(1);
  });

  test("a second request while the brain is busy is answered after the first, not spun on the stack", async () => {
    const brain = new ScriptedBrain([
      { message: "first", actions: [] },
      { message: "second", actions: [] },
    ]);
    brain.hold();
    const h = harness(brain);
    h.loop.submit({ type: "userRequest", text: "one" }, "api");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.loop.phase()).toBe("deciding");

    // Before the deferral this re-enqueued itself inside the synchronous drain and hung the runner.
    h.loop.submit({ type: "userRequest", text: "two" }, "api");
    expect(h.brain.calls).toHaveLength(1);
    expect(h.mailbox.size()).toBe(0);
    expect(h.loop.machineState().ctx.deferred).toHaveLength(1);

    brain.release();
    await h.loop.settle();

    expect(h.brain.calls.map((c) => c.userText)).toEqual(["one", "two"]);
    expect(h.events.ofType("message").map((e) => e.text)).toEqual(["first", "second"]);
    // The replayed envelope keeps its id, so the request is recorded once.
    expect(h.store.recentCommands().filter((c) => c.type === "userRequest")).toHaveLength(2);
    expect(h.loop.phase()).toBe("idle");
    expect(h.loop.machineState().ctx.deferred).toEqual([]);
  });

  test("the brain thinking is an activity, and it is gone by the time the turn ends", async () => {
    const brain = new ScriptedBrain([{ message: "ok", actions: [] }]);
    brain.hold();
    const h = harness(brain);
    h.loop.submit({ type: "userRequest", text: "120 bpm" }, "api");
    await new Promise((r) => setTimeout(r, 0));

    // The brain can take half a minute; this is what the app shows in the meantime.
    expect(h.store.getActivity()).toMatchObject({ kind: "think", request: "120 bpm", cancellable: true, fraction: null });
    expect(h.store.snapshot().activity?.message).toBe("thinking it over");

    brain.release();
    await h.loop.settle();
    expect(h.store.getActivity()).toBeNull();
    expect(h.events.ofType("activity.changed").at(-1)?.activity).toBeNull();
  });

  test("what is waiting is published, and empties as each one is answered", async () => {
    const brain = new ScriptedBrain([
      { message: "first", actions: [] },
      { message: "second", actions: [] },
    ]);
    brain.hold();
    const h = harness(brain);
    h.loop.submit({ type: "userRequest", text: "one" }, "api");
    await new Promise((r) => setTimeout(r, 0));
    h.loop.submit({ type: "userRequest", text: "two" }, "api");

    // The drummer can see what is waiting instead of guessing whether the message landed.
    expect(h.store.snapshot().queued.map((c) => c.summary)).toEqual(["two"]);
    expect(h.events.ofType("queue.changed").at(-1)?.queued.map((c) => c.summary)).toEqual(["two"]);

    brain.release();
    await h.loop.settle();
    expect(h.loop.machineState().ctx.deferred).toEqual([]);
    expect(h.store.snapshot().queued).toEqual([]);
    expect(h.events.ofType("queue.changed").at(-1)?.queued).toEqual([]);
  });

  test("followUp with 500ms delay fires at 500, not 499", async () => {
    const h = harness([
      { message: "first", actions: [], followUp: { cmd: { type: "userRequest", text: "check in" }, delayMs: 500 } },
      { message: "second", actions: [] },
    ]);
    h.loop.submit({ type: "userRequest", text: "start" }, "api");
    await h.loop.settle();
    expect(h.brain.calls).toHaveLength(1);

    h.clock.advance(499);
    await h.loop.settle();
    expect(h.brain.calls).toHaveLength(1);

    h.clock.advance(1);
    await h.loop.settle();
    expect(h.brain.calls).toHaveLength(2);
    expect(h.brain.calls[1]?.userText).toBe("check in");
  });

  test("brain failure retries after backoff then succeeds", async () => {
    const brain = new ScriptedBrain([{ message: "ok now", actions: [] }]);
    brain.rejectNext(new Error("boom"));
    const h = harness(brain);
    h.loop.submit({ type: "userRequest", text: "x" }, "api");
    await h.loop.settle();
    expect(h.loop.phase()).toBe("error");
    h.clock.advance(100);
    await h.loop.settle();
    expect(h.loop.phase()).toBe("idle");
    expect(h.store.snapshot().lastMessage).toBe("ok now");
  });

  test("timer ticks are re-armed and coalesced", async () => {
    const h = harness([], 1000);
    h.clock.advance(3000);
    await h.loop.settle();
    const ticks = h.store.recentCommands().filter((c) => c.type === "tick");
    expect(ticks).toHaveLength(3);
    // Ticks only observe: with no goal set they refresh the snapshot and never call the brain.
    expect(h.brain.calls).toHaveLength(0);
    expect(h.store.getSession()).not.toBeNull();
    expect(h.loop.phase()).toBe("idle");
  });

  test("stop clears the tick timer", async () => {
    const h = harness([], 1000);
    await h.loop.stop();
    expect(h.clock.pending()).toBe(0);
  });
});

describe("AgentLoop song digest", () => {
  test("a song saved while the loop runs reaches the next brain call, and never the command log", async () => {
    const h = harness([{ message: "ok", actions: [] }]);
    const song = await fixtureSong();
    h.store.setSong(song);

    h.loop.submit({ type: "userRequest", text: "make the b section sparser" }, "api");
    await h.loop.settle();

    expect(h.brain.calls[0]?.song?.id).toBe(song.id);
    expect(h.brain.calls[0]?.song?.tracks.map((t) => t.partId)).toEqual(["drums-kit", "bass-p", "guitar-strat"]);
    // A resolve saves once per slot: those must not each become a row in the log or an SSE event.
    expect(h.store.recentCommands().map((c) => c.type)).not.toContain("songChanged");
    expect(h.events.ofType("command.received").map((e) => e.command.type)).not.toContain("songChanged");
  });

  test("a song activated before start() is still the active one", async () => {
    const clock = new ManualClock(1_000);
    const events = new EventBus();
    const store = new StateStore(events);
    const song = await fixtureSong();
    store.setSong(song); // nobody is listening yet
    const brain = new ScriptedBrain([{ message: "ok", actions: [] }]);
    const loop = new AgentLoop({
      clock,
      mailbox: new Mailbox(),
      store,
      brain,
      ableton: new FakeAbleton(),
      splice: new FakeSplice(),
      log: silentLogger,
      options: { tickMs: 0 },
    });
    loop.start();

    loop.submit({ type: "userRequest", text: "what have we got" }, "api");
    await loop.settle();
    expect(brain.calls[0]?.song?.id).toBe(song.id);
  });

  test("clearing the active song takes it out of the input again", async () => {
    const h = harness([
      { message: "one", actions: [] },
      { message: "two", actions: [] },
    ]);
    h.store.setSong(await fixtureSong());
    h.loop.submit({ type: "userRequest", text: "first" }, "api");
    await h.loop.settle();

    h.store.setSong(null);
    h.loop.submit({ type: "userRequest", text: "second" }, "api");
    await h.loop.settle();

    expect(h.brain.calls[0]?.song).toBeDefined();
    expect(h.brain.calls[1]?.song).toBeUndefined();
  });

  test("stop() unsubscribes: a later save cannot wake the loop", async () => {
    const h = harness();
    await h.loop.stop();
    h.store.setSong(await fixtureSong());
    expect(h.mailbox.size()).toBe(0);
  });
});

describe("AgentLoop song actions", () => {
  /** A loop and a `SongService` over the same store and clock, the way `index.ts` wires them. */
  async function songHarness(script: Decision[]) {
    const sh = songServiceHarness({ briefer: denseBriefer() });
    await seedLibrary(sh);
    const brain = new ScriptedBrain(script);
    const loop = new AgentLoop({
      clock: sh.clock,
      mailbox: new Mailbox(),
      store: sh.store,
      brain,
      ableton: new FakeAbleton(),
      splice: new FakeSplice(),
      songs: sh.service,
      log: silentLogger,
      options: { tickMs: 0 },
    });
    loop.start();
    return { ...sh, brain, loop };
  }

  test("compose and an edit of it in one turn, and the digest that follows carries the edit", async () => {
    const h = await songHarness([
      {
        message: "Writing you something dusty.",
        actions: [
          { type: "composeSong", text: "something dusty and funky" },
          // Applied after the compose, against the song it just made: `requireActive()` is read
          // when the action runs, not when the brain decided on it.
          { type: "setPlacement", partId: "bass-p", occurrence: 1, plays: false },
        ],
      },
      { message: "Sparser now.", actions: [] },
    ]);

    h.loop.submit({ type: "userRequest", text: "something dusty and funky, bass out of the second bit" }, "api");
    await h.loop.settle();

    const song = h.store.getSong();
    expect(song).not.toBeNull();
    expect(h.loop.phase()).toBe("idle");
    const applied = h.events.ofType("action.applied");
    expect(applied.map((e) => e.ok)).toEqual([true, true]);
    expect(applied[0]?.detail).toMatch(/^“.+”: 3 parts, \d+\/\d+ slots with sounds$/);
    expect(applied[1]?.detail).toBe("bass-p rests in occurrence 1");

    // The compose queued no resolve of its own: the service already searched Splice.
    expect(song!.plan.slots.some((s) => s.candidates.length > 0)).toBe(true);

    // Second turn: the brain is told about the song, with the rest already in it.
    h.loop.submit({ type: "userRequest", text: "how does that look" }, "api");
    await h.loop.settle();
    const digest = h.brain.calls[1]?.song;
    expect(h.brain.calls[0]?.song).toBeUndefined();
    expect(digest?.id).toBe(song!.id);
    expect(digest?.tracks.find((t) => t.partId === "bass-p")?.plays).toBe("0, 2-3");
  });

  test("clearing the active song takes the plan away from the brain and puts compose back on the table", async () => {
    const h = await songHarness([
      { message: "Here you go.", actions: [{ type: "composeSong", text: "funky" }] },
      { message: "Gone.", actions: [{ type: "clearActiveSong" }] },
      { message: "What next?", actions: [] },
    ]);
    h.loop.submit({ type: "userRequest", text: "write me something" }, "api");
    await h.loop.settle();
    const name = h.store.getSong()?.name;

    h.loop.submit({ type: "userRequest", text: "scrap it" }, "api");
    await h.loop.settle();
    expect(h.store.getSong()).toBeNull();
    expect(h.events.ofType("action.applied").at(-1)?.detail).toBe(`put “${name}” away`);

    h.loop.submit({ type: "userRequest", text: "still there?" }, "api");
    await h.loop.settle();
    expect(h.brain.calls[2]?.song).toBeUndefined();
  });

  test("a compose the loop runs is one cancellable activity, gone by the end of the turn", async () => {
    const h = await songHarness([{ message: "Writing you something dusty.", actions: [{ type: "composeSong", text: "something dusty and funky" }] }]);
    const seen: (Activity | null)[] = [];
    h.events.subscribe((e) => {
      if (e.type === "activity.changed") seen.push(e.activity);
    });

    h.loop.submit({ type: "userRequest", text: "write me something dusty" }, "api");
    await h.loop.settle();

    const kinds = seen.map((a) => a?.kind ?? null);
    expect(kinds[0]).toBe("think");
    expect(kinds).toContain("compose");
    expect(kinds.at(-1)).toBeNull();
    const composing = seen.find((a) => a?.kind === "compose")!;
    // The loop owns it, so `cancel` really would stop it, and it carries the turn's request id —
    // which is also on every action.applied the app sees for this turn.
    expect(composing.cancellable).toBe(true);
    expect(composing.requestId).toBe(seen[0]!.requestId);
    expect(h.events.ofType("action.applied").at(-1)?.requestId).toBe(composing.requestId);
    expect(h.store.getActivity()).toBeNull();
    expect(h.store.snapshot().activity).toBeNull();
  });

  test("a song action with no library fails the set instead of silently doing nothing", async () => {
    const h = harness([{ message: "ok", actions: [{ type: "resolveSong" }] }]);
    h.store.setSong(await fixtureSong()); // a song to act on, but this loop was built without the service
    h.loop.submit({ type: "userRequest", text: "find sounds" }, "api");
    await h.loop.settle();
    expect(h.loop.phase()).toBe("error");
    expect(h.events.ofType("action.applied").at(-1)).toMatchObject({ ok: false, detail: expect.stringContaining("no song library") });
  });
});

describe("AgentLoop track ownership", () => {
  test("a new MIDI track is named with the [mate] suffix as soon as it exists", async () => {
    const h = harness([{ message: "Made you a click track.", actions: [{ type: "createMidiTrack", name: "Click" }, { type: "createMidiTrack" }] }]);
    h.loop.submit({ type: "userRequest", text: "click please" }, "api");
    await h.loop.settle();
    expect(h.ableton.callsOf("setTrackName").map((c) => c.args)).toEqual([
      [1, "Click [mate]"],
      [1, "MIDI [mate]"],
    ]);
    expect(h.events.ofType("action.applied").map((e) => e.detail)).toEqual(['track 1 "Click [mate]"', 'track 1 "MIDI [mate]"']);
  });
});
