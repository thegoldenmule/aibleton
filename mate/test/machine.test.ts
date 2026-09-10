import { describe, expect, test } from "bun:test";
import { envelope, type Command } from "../src/core/commands.ts";
import { actionTrack, guardDecision, initialState, step, type Effect, type MachineState, type StepOptions } from "../src/intelligence/machine.ts";
import type { Action } from "../src/intelligence/brain/types.ts";
import { makeSession } from "./helpers/fakes.ts";

const cmd = (body: Parameters<typeof envelope>[0], source: Command["source"] = "test"): Command => envelope(body, source, 0);
let seq = 0;
const opts: StepOptions = { maxBrainRetries: 3, retryBaseMs: 100, historyLimit: 10, maxDeferred: 3, newRequestId: () => `r${++seq}` };
const types = (effects: Effect[]) => effects.map((e) => e.type);

function toDeciding(trigger: Command = cmd({ type: "userRequest", text: "go" })) {
  const s1 = step(initialState(), trigger, opts);
  const s2 = step(s1.state, cmd({ type: "snapshotReady", snapshot: makeSession() }, "loop"), opts);
  return s2;
}

describe("machine", () => {
  test("idle + tick -> observing with refreshSnapshot", () => {
    const r = step(initialState(), cmd({ type: "tick" }, "timer"), opts);
    expect(r.state.kind).toBe("observing");
    expect(types(r.effects)).toEqual(["refreshSnapshot"]);
  });

  test("observing + snapshotReady -> deciding with fresh requestId and callBrain", () => {
    const r1 = toDeciding();
    const r2 = toDeciding();
    expect(r1.state.kind).toBe("deciding");
    const call = r1.effects.find((e) => e.type === "callBrain");
    expect(call).toBeDefined();
    if (call?.type === "callBrain" && r1.state.kind === "deciding" && r2.state.kind === "deciding") {
      expect(call.requestId).toBe(r1.state.requestId);
      expect(call.input.userText).toBe("go");
      expect(call.input.trigger).toBe("userRequest");
      expect(r2.state.requestId).not.toBe(r1.state.requestId);
    }
  });

  test("tick without a goal never calls the brain, even on a changed snapshot", () => {
    const r1 = step(initialState(), cmd({ type: "tick" }, "timer"), opts);
    const r2 = step(r1.state, cmd({ type: "snapshotReady", snapshot: makeSession({ tempo: 90 }, 1) }, "loop"), opts);
    expect(r2.state.kind).toBe("idle");
    expect(r2.effects).toEqual([]);
    expect(r2.state.ctx.snapshot?.transport.tempo).toBe(90); // the picture still updates
  });

  test("tick with a goal skips the brain when only the playhead moved", () => {
    const withGoal = step(initialState(), cmd({ type: "goalSet", text: "practice 16ths" }), opts);
    const seeded = step(withGoal.state, cmd({ type: "snapshotReady", snapshot: makeSession({ isPlaying: true, currentSongTime: 4 }, 1) }, "loop"), opts);
    // First look with a goal calls the brain; finish that cycle back to idle.
    expect(seeded.state.kind).toBe("deciding");
    const idle: MachineState = { kind: "idle", ctx: { ...seeded.state.ctx } };
    const r1 = step(idle, cmd({ type: "tick" }, "timer"), opts);
    const moved = makeSession({ isPlaying: true, currentSongTime: 12 }, 2);
    const r2 = step(r1.state, cmd({ type: "snapshotReady", snapshot: moved }, "loop"), opts);
    expect(r2.state.kind).toBe("idle");
    expect(r2.effects).toEqual([]);
  });

  test("tick with a goal calls the brain when the session really changed", () => {
    const withGoal = step(initialState(), cmd({ type: "goalSet", text: "practice 16ths" }), opts);
    const seeded = step(withGoal.state, cmd({ type: "snapshotReady", snapshot: makeSession({ tempo: 120 }, 1) }, "loop"), opts);
    const idle: MachineState = { kind: "idle", ctx: { ...seeded.state.ctx } };
    const r1 = step(idle, cmd({ type: "tick" }, "timer"), opts);
    const r2 = step(r1.state, cmd({ type: "snapshotReady", snapshot: makeSession({ tempo: 100 }, 2) }, "loop"), opts);
    expect(r2.state.kind).toBe("deciding");
    expect(types(r2.effects)).toEqual(["callBrain"]);
  });

  test("stale brainDecided is a no-op", () => {
    const d = toDeciding();
    const r = step(d.state, cmd({ type: "brainDecided", requestId: "stale", decision: { message: "x", actions: [] } }, "loop"), opts);
    expect(r.state).toBe(d.state);
    expect(r.effects).toEqual([]);
  });

  test("matching brainDecided with actions -> acting; without -> idle", () => {
    const d = toDeciding();
    if (d.state.kind !== "deciding") throw new Error("expected deciding");
    const withActions = step(
      d.state,
      cmd({ type: "brainDecided", requestId: d.state.requestId, decision: { message: "set", actions: [{ type: "setTempo", bpm: 100 }] } }, "loop"),
      opts,
    );
    expect(withActions.state.kind).toBe("acting");
    expect(types(withActions.effects)).toEqual(["emitEvent", "applyActions"]);
    const noActions = step(d.state, cmd({ type: "brainDecided", requestId: d.state.requestId, decision: { message: "ok", actions: [] } }, "loop"), opts);
    expect(noActions.state.kind).toBe("idle");
    expect(types(noActions.effects)).toEqual(["emitEvent"]);
  });

  test("deciding + cancel -> idle with abortBrain", () => {
    const d = toDeciding();
    const r = step(d.state, cmd({ type: "cancel" }), opts);
    expect(r.state.kind).toBe("idle");
    expect(types(r.effects)).toContain("abortBrain");
    expect(types(r.effects)).toContain("emitEvent");
  });

  test("brainFailed x3 schedules retry with backoff, then stays in error", () => {
    let state = toDeciding().state;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (state.kind !== "deciding") throw new Error(`expected deciding at attempt ${attempt}, got ${state.kind}`);
      const failed = step(state, cmd({ type: "brainFailed", requestId: state.requestId, error: "boom" }, "loop"), opts);
      expect(failed.state.kind).toBe("error");
      const sched = failed.effects.find((e) => e.type === "scheduleCommand");
      if (attempt <= 3) {
        expect(sched).toBeDefined();
        if (sched?.type === "scheduleCommand") delays.push(sched.delayMs);
        const retried = step(failed.state, cmd({ type: "retry" }, "loop"), opts);
        expect(retried.state.kind).toBe("observing");
        state = step(retried.state, cmd({ type: "snapshotReady", snapshot: makeSession() }, "loop"), opts).state;
      } else {
        expect(sched).toBeUndefined();
        state = failed.state;
      }
    }
    expect(delays).toEqual([100, 200, 400]);
    expect(state.kind).toBe("error");
    const resumed = step(state, cmd({ type: "resume" }), opts);
    expect(resumed.state.kind).toBe("idle");
    expect(resumed.state.ctx.retryCount).toBe(0);
  });

  test("pause during deciding aborts the brain; resume returns to idle", () => {
    const d = toDeciding();
    const p = step(d.state, cmd({ type: "pause" }), opts);
    expect(p.state.kind).toBe("paused");
    expect(types(p.effects)).toEqual(["abortBrain"]);
    const parked = step(p.state, cmd({ type: "userRequest", text: "later" }), opts);
    expect(parked.state.kind).toBe("paused");
    expect(parked.effects).toEqual([]);
    expect(parked.state.ctx.deferred.map((c) => c.type)).toEqual(["userRequest"]);
    const resumed = step(parked.state, cmd({ type: "resume" }), opts);
    expect(resumed.state.kind).toBe("idle");
    expect(types(resumed.effects)).toEqual(["enqueue"]);
  });

  test("acting + actionsDone -> idle and enqueues abletonChanged", () => {
    const d = toDeciding();
    if (d.state.kind !== "deciding") throw new Error("expected deciding");
    const acting = step(
      d.state,
      cmd({ type: "brainDecided", requestId: d.state.requestId, decision: { message: "set", actions: [{ type: "setTempo", bpm: 100 }] } }, "loop"),
      opts,
    ).state;
    const done = step(acting, cmd({ type: "actionsDone", results: [{ action: { type: "setTempo", bpm: 100 }, ok: true }] }, "loop"), opts);
    expect(done.state.kind).toBe("idle");
    const enq = done.effects.find((e) => e.type === "enqueue");
    expect(enq && enq.type === "enqueue" && enq.cmd.type).toBe("abletonChanged");
    expect(done.state.ctx.history.at(-1)?.results?.length).toBe(1);
  });

  test("loop-sourced abletonChanged refreshes the snapshot without calling the brain", () => {
    const idle = step(initialState(), cmd({ type: "abletonChanged", hint: "clips" }, "loop"), opts);
    expect(idle.state.kind).toBe("observing");
    const r = step(idle.state, cmd({ type: "snapshotReady", snapshot: makeSession({ tempo: 99 }) }, "loop"), opts);
    expect(r.state.kind).toBe("idle");
    expect(r.effects).toEqual([]);
    expect(r.state.ctx.snapshot?.transport.tempo).toBe(99);
    const external = step(initialState(), cmd({ type: "abletonChanged", hint: "clips" }, "ableton"), opts);
    expect(step(external.state, cmd({ type: "snapshotReady", snapshot: makeSession() }, "loop"), opts).state.kind).toBe("deciding");
  });

  test("goalSet from idle triggers observing and sets goal", () => {
    const r = step(initialState(), cmd({ type: "goalSet", text: "16ths at 90" }), opts);
    expect(r.state.kind).toBe("observing");
    expect(r.state.ctx.goal).toBe("16ths at 90");
  });
});

describe("deferred requests", () => {
  const late = (text: string) => cmd({ type: "userRequest", text });
  const deferredTexts = (state: MachineState) => state.ctx.deferred.map((c) => (c.type === "userRequest" ? c.text : c.type));

  function toActing(actions: Action[] = [{ type: "setTempo", bpm: 100 }]) {
    const d = toDeciding();
    if (d.state.kind !== "deciding") throw new Error("expected deciding");
    const r = step(d.state, cmd({ type: "brainDecided", requestId: d.state.requestId, decision: { message: "set", actions } }, "loop"), opts);
    if (r.state.kind !== "acting") throw new Error("expected acting");
    return r.state;
  }

  test("a request during deciding waits in the context and emits no effect", () => {
    const d = toDeciding();
    const cmd1 = late("later");
    const r = step(d.state, cmd1, opts);
    expect(r.state.kind).toBe("deciding");
    // The bug this replaces: an enqueue effect goes straight back through the synchronous drain.
    expect(r.effects).toEqual([]);
    expect(r.state.ctx.deferred).toEqual([cmd1]);
  });

  test("a request during acting waits in the context and emits no effect", () => {
    const r = step(toActing(), late("later"), opts);
    expect(r.state.kind).toBe("acting");
    expect(r.effects).toEqual([]);
    expect(deferredTexts(r.state)).toEqual(["later"]);
  });

  test("exactly one request is released per edge back to idle, oldest first", () => {
    let state: MachineState = toActing();
    state = step(state, late("a"), opts).state;
    state = step(state, late("b"), opts).state;

    const done = step(state, cmd({ type: "actionsDone", results: [] }, "loop"), opts);
    expect(done.state.kind).toBe("idle");
    const released = done.effects.filter((e) => e.type === "enqueue").map((e) => (e.type === "enqueue" ? e.cmd : null));
    // Two: the loop's own snapshot refresh, then one request. Never two requests — stepObserving
    // upgrades `pending` in place, so a second would be swallowed by the first.
    expect(released.map((c) => c?.type)).toEqual(["abletonChanged", "userRequest"]);
    expect(released[1] && released[1].type === "userRequest" ? released[1].text : "").toBe("a");
    expect(deferredTexts(done.state)).toEqual(["b"]);

    // "b" waits until the next time we come back to idle.
    const observing = step(done.state, late("a"), opts);
    const deciding = step(observing.state, cmd({ type: "snapshotReady", snapshot: makeSession({ tempo: 130 }, 9) }, "loop"), opts);
    if (deciding.state.kind !== "deciding") throw new Error("expected deciding");
    const idle = step(deciding.state, cmd({ type: "brainDecided", requestId: deciding.state.requestId, decision: { message: "ok", actions: [] } }, "loop"), opts);
    expect(idle.state.kind).toBe("idle");
    const next = idle.effects.find((e) => e.type === "enqueue");
    expect(next && next.type === "enqueue" && next.cmd.type === "userRequest" ? next.cmd.text : "").toBe("b");
    expect(idle.state.ctx.deferred).toEqual([]);
  });

  test("cancel stops what is in flight and releases one waiting request, from every phase", () => {
    const fromActing = step(step(toActing(), late("a"), opts).state, cmd({ type: "cancel" }), opts);
    expect(fromActing.state.kind).toBe("idle");
    expect(types(fromActing.effects)).toEqual(["emitEvent", "enqueue"]);

    const deciding = step(toDeciding().state, late("a"), opts).state;
    const fromDeciding = step(deciding, cmd({ type: "cancel" }), opts);
    expect(types(fromDeciding.effects)).toEqual(["abortBrain", "emitEvent", "enqueue"]);

    // Observing never defers of its own accord (it upgrades `pending`), but it can be entered
    // while a request from an earlier turn is still waiting.
    const observing: MachineState = { kind: "observing", ctx: { history: [], retryCount: 0, deferred: [late("a")] }, pending: cmd({ type: "tick" }, "timer") };
    expect(types(step(observing, cmd({ type: "cancel" }), opts).effects)).toEqual(["emitEvent", "enqueue"]);
  });

  test("a failed action set keeps the queue; resume releases one", () => {
    const acting = step(toActing(), late("later"), opts).state;
    const failed = step(acting, cmd({ type: "actionFailed", index: 0, error: "boom" }, "loop"), opts);
    expect(failed.state.kind).toBe("error");
    expect(deferredTexts(failed.state)).toEqual(["later"]);
    const resumed = step(failed.state, cmd({ type: "resume" }), opts);
    expect(resumed.state.kind).toBe("idle");
    const enq = resumed.effects.find((e) => e.type === "enqueue");
    expect(enq && enq.type === "enqueue" && enq.cmd.type === "userRequest" ? enq.cmd.text : "").toBe("later");
  });

  test("over the cap the oldest is dropped and mate says which one", () => {
    let state: MachineState = toActing();
    for (const text of ["a", "b", "c"]) state = step(state, late(text), opts).state;
    expect(deferredTexts(state)).toEqual(["a", "b", "c"]);

    const over = step(state, late("d"), opts);
    expect(deferredTexts(over.state)).toEqual(["b", "c", "d"]);
    const ev = over.effects[0];
    expect(ev?.type === "emitEvent" && ev.event.type === "message" ? ev.event.text : "").toBe(
      'I already have 3 messages waiting, so I let the oldest one go: "a". Say it again when I catch up.',
    );
  });
});

describe("actionTrack", () => {
  test("classifies every action variant: track-carrying ones by track, the rest undefined", () => {
    const cases: [Action, number | undefined][] = [
      [{ type: "createClip", track: 2, slot: 0, lengthBeats: 4 }, 2],
      [{ type: "addNotes", track: 3, slot: 0, notes: [] }, 3],
      [{ type: "fireClip", track: 4, slot: 0 }, 4],
      [{ type: "loadDrumKit", track: 5, rackUri: "u", kitPath: "p" }, 5],
      [{ type: "createMidiTrack" }, undefined],
      [{ type: "setTempo", bpm: 100 }, undefined],
      [{ type: "startPlayback" }, undefined],
      [{ type: "stopPlayback" }, undefined],
      [{ type: "splicePromptToStack", prompt: "p", bpm: 90 }, undefined],
    ];
    for (const [action, expected] of cases) expect(actionTrack(action)).toBe(expected);
  });
});

describe("ownership guard", () => {
  const owned = (): ReturnType<typeof makeSession> => {
    const s = makeSession();
    s.tracks = [
      { ...s.tracks[0]!, index: 0, name: "Drums" },
      { ...s.tracks[0]!, index: 1, name: "Bass [mate]" },
    ];
    return s;
  };

  test("actions on the drummer's tracks are dropped and named; track-less and owned ones pass", () => {
    const decision = {
      message: "Done.",
      actions: [
        { type: "setTempo" as const, bpm: 100 },
        { type: "createClip" as const, track: 0, slot: 0, lengthBeats: 4 },
        { type: "addNotes" as const, track: 1, slot: 0, notes: [] },
        { type: "fireClip" as const, track: 0, slot: 0 },
        { type: "createMidiTrack" as const },
      ],
    };
    const guarded = guardDecision(decision, owned());
    expect(guarded.actions.map((a) => a.type)).toEqual(["setTempo", "addNotes", "createMidiTrack"]);
    expect(guarded.message).toBe('Done. I left 2 things alone (createClip on track 0, fireClip on track 0): I only change the tracks I made, the ones ending in "[mate]".');
    expect(guardDecision(decision, undefined).actions.map((a) => a.type)).toEqual(["setTempo", "createMidiTrack"]);
    const clean = { message: "ok", actions: [{ type: "addNotes" as const, track: 1, slot: 0, notes: [] }] };
    expect(guardDecision(clean, owned())).toBe(clean);
  });

  test("brainDecided runs through the guard: a decision left with no actions goes idle with the note", () => {
    const s1 = step(initialState(), cmd({ type: "userRequest", text: "go" }), opts);
    const s2 = step(s1.state, cmd({ type: "snapshotReady", snapshot: owned() }, "loop"), opts);
    if (s2.state.kind !== "deciding") throw new Error("expected deciding");
    const r = step(s2.state, cmd({ type: "brainDecided", requestId: s2.state.requestId, decision: { message: "Adding a groove.", actions: [{ type: "createClip", track: 0, slot: 0, lengthBeats: 4 }] } }, "loop"), opts);
    expect(r.state.kind).toBe("idle");
    expect(types(r.effects)).toEqual(["emitEvent"]);
    const ev = r.effects[0];
    expect(ev?.type === "emitEvent" && ev.event.type === "message" ? ev.event.text : "").toMatch(/^Adding a groove\. I left one thing alone \(createClip on track 0\)/);
    expect(r.state.ctx.history.at(-1)?.decision?.actions).toEqual([]);
  });
});
