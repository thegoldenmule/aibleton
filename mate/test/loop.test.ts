import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { StateStore } from "../src/core/state.ts";
import { silentLogger } from "../src/log.ts";
import { ScriptedBrain } from "../src/intelligence/brain/scripted.ts";
import type { Decision } from "../src/intelligence/brain/types.ts";
import { createIntelligence } from "../src/intelligence/index.ts";
import { FakeAbleton, FakeSplice } from "./helpers/fakes.ts";

function harness(script: Decision[] | ScriptedBrain = [], tickMs = 0) {
  const clock = new ManualClock(1_000);
  const events = new EventBus();
  const store = new StateStore(events);
  const mailbox = new Mailbox();
  const ableton = new FakeAbleton();
  const splice = new FakeSplice();
  const brain = script instanceof ScriptedBrain ? script : new ScriptedBrain(script);
  const loop = createIntelligence({ clock, mailbox, store, brain, ableton, splice, log: silentLogger, options: { tickMs, retryBaseMs: 100 } });
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
    expect(h.events.ofType("action.applied")).toEqual([{ type: "action.applied", action: "setTempo", ok: true, detail: "120 bpm" }]);
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
