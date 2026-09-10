import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { StateStore } from "../src/core/state.ts";
import { silentLogger } from "../src/log.ts";
import { ScriptedBrain } from "../src/intelligence/brain/scripted.ts";
import type { Action, BrainInput } from "../src/intelligence/brain/types.ts";
import { EffectRunner } from "../src/intelligence/effects.ts";
import type { CallContext } from "../src/ports/ableton/types.ts";
import { FakeAbleton, FakeSplice, makeSession } from "./helpers/fakes.ts";

/** FakeAbleton with a gate on setTempo, so a set can be caught with one action still in flight. */
class GatedAbleton extends FakeAbleton {
  private gate = Promise.withResolvers<void>();
  open(): void {
    this.gate.resolve();
  }
  override async setTempo(bpm: number, ctx?: CallContext): Promise<void> {
    await this.gate.promise;
    await super.setTempo(bpm, ctx);
  }
}

function harness(ableton: FakeAbleton = new FakeAbleton()) {
  const clock = new ManualClock(1_000);
  const events = new EventBus();
  const store = new StateStore(events);
  const mailbox = new Mailbox();
  const splice = new FakeSplice();
  const brain = new ScriptedBrain();
  const runner = new EffectRunner({ brain, ableton, splice, mailbox, store, clock, log: silentLogger });
  return { clock, events, store, mailbox, ableton, splice, brain, runner };
}

const input = (): BrainInput => ({ snapshot: makeSession(), history: [], trigger: "userRequest" });
const tick = () => new Promise((r) => setTimeout(r, 0));
const two: Action[] = [
  { type: "setTempo", bpm: 100 },
  { type: "startPlayback" },
];

describe("EffectRunner.applyActions", () => {
  test("runs the actions in order and ends the set with actionsDone carrying every result", async () => {
    const h = harness();
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: two, userPrompt: "faster" }]);
    await h.runner.settle();

    expect(h.ableton.calls.map((c) => c.method)).toEqual(["setTempo", "startPlayback"]);
    expect(h.ableton.calls[0]?.ctx).toEqual({ userPrompt: "faster" });
    const posted = h.mailbox.peekAll();
    expect(posted.map((c) => c.type)).toEqual(["actionsDone"]);
    const done = posted[0];
    expect(done?.type === "actionsDone" ? done.requestId : "").toBe("r1");
    expect(done?.type === "actionsDone" ? done.results.map((r) => r.ok) : []).toEqual([true, true]);
    expect(done?.type === "actionsDone" ? done.aborted : true).toBeUndefined();
  });

  test("a failed action carries the results that already landed: Live has no undo", async () => {
    const h = harness();
    h.ableton.failOn.add("startPlayback");
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: two }]);
    await h.runner.settle();

    const failed = h.mailbox.peekAll()[0];
    expect(failed?.type).toBe("actionFailed");
    if (failed?.type !== "actionFailed") throw new Error("expected actionFailed");
    expect(failed.requestId).toBe("r1");
    expect(failed.index).toBe(1);
    expect(failed.results.map((r) => r.action.type)).toEqual(["setTempo"]);
    expect(h.events.ofType("action.applied").map((e) => e.ok)).toEqual([true, false]);
  });

  test("abortActions stops the set before the next port call", async () => {
    const h = harness();
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: two }]);
    // Synchronous, so the controller is registered but the first action is still in flight.
    h.runner.run([{ type: "abortActions", requestId: "r1" }]);
    await h.runner.settle();

    expect(h.ableton.calls.map((c) => c.method)).toEqual(["setTempo"]);
    const done = h.mailbox.peekAll()[0];
    expect(done?.type === "actionsDone" ? done.aborted : false).toBe(true);
    expect(done?.type === "actionsDone" ? done.results.length : 0).toBe(1);
  });

  test("the brain's cleanup does not disarm the action set sharing its requestId", async () => {
    const ableton = new GatedAbleton();
    const h = harness(ableton);
    h.brain.push({ message: "ok", actions: two });
    // The real loop drains synchronously inside post(), so applyActions registers its controller
    // before callBrain's .finally(delete) runs. With one map that delete lost the action set.
    h.mailbox.setListener((cmd) => {
      if (cmd.type === "brainDecided") h.runner.run([{ type: "applyActions", requestId: "r1", actions: cmd.decision.actions }]);
    });
    h.runner.run([{ type: "callBrain", requestId: "r1", input: input() }]);
    await tick(); // the brain resolves, the set starts, and callBrain's cleanup runs

    h.runner.run([{ type: "abortActions", requestId: "r1" }]);
    ableton.open();
    await h.runner.settle();

    expect(ableton.callsOf("startPlayback")).toEqual([]);
  });

  test("abortAll stops a hung brain call and an in-flight set, so stop() never waits out an arrange", async () => {
    const ableton = new GatedAbleton();
    const h = harness(ableton);
    h.brain.hold();
    h.runner.run([{ type: "callBrain", requestId: "r1", input: input() }]);
    h.runner.run([{ type: "applyActions", requestId: "r2", actions: two }]);
    await tick();

    h.runner.abortAll();
    ableton.open();
    h.brain.release();
    await h.runner.settle();

    expect(ableton.callsOf("startPlayback")).toEqual([]);
    expect(h.mailbox.peekAll().map((c) => c.type)).toEqual(["actionsDone"]);
    expect(h.runner.inFlight()).toBe(0);
  });
});
