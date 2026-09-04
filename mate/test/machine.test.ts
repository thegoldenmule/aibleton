import { describe, expect, test } from "bun:test";
import { envelope, type Command } from "../src/core/commands.ts";
import { initialState, step, type Effect, type MachineState, type StepOptions } from "../src/intelligence/machine.ts";
import { makeSession } from "./helpers/fakes.ts";

const cmd = (body: Parameters<typeof envelope>[0], source: Command["source"] = "test"): Command => envelope(body, source, 0);
let seq = 0;
const opts: StepOptions = { maxBrainRetries: 3, retryBaseMs: 100, historyLimit: 10, newRequestId: () => `r${++seq}` };
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

  test("tick with unchanged snapshot and no goal returns to idle without brain call", () => {
    const first = toDeciding(cmd({ type: "tick" }, "timer")); // first ever snapshot: brain is called
    expect(first.state.kind).toBe("deciding");
    const idle: MachineState = { kind: "idle", ctx: { ...first.state.ctx } };
    const r1 = step(idle, cmd({ type: "tick" }, "timer"), opts);
    const r2 = step(r1.state, cmd({ type: "snapshotReady", snapshot: makeSession({}, 999) }, "loop"), opts);
    expect(r2.state.kind).toBe("idle");
    expect(r2.effects).toEqual([]);
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

  test("userRequest during deciding is re-enqueued, not lost", () => {
    const d = toDeciding();
    const late = cmd({ type: "userRequest", text: "later" });
    const r = step(d.state, late, opts);
    expect(r.state).toBe(d.state);
    expect(r.effects).toEqual([{ type: "enqueue", cmd: late }]);
  });

  test("pause during deciding aborts the brain; resume returns to idle", () => {
    const d = toDeciding();
    const p = step(d.state, cmd({ type: "pause" }), opts);
    expect(p.state.kind).toBe("paused");
    expect(types(p.effects)).toEqual(["abortBrain"]);
    const dropped = step(p.state, cmd({ type: "userRequest", text: "ignored" }), opts);
    expect(dropped.state.kind).toBe("paused");
    expect(dropped.effects).toEqual([]);
    expect(step(p.state, cmd({ type: "resume" }), opts).state.kind).toBe("idle");
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
