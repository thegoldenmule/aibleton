import { describe, expect, test } from "bun:test";
import { applyMateEvent, emptyState, type CommandSummary, type MateEvent, type TranscriptEntry } from "@aibleton/protocol";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { StateStore } from "../src/core/state.ts";
import { silentLogger } from "../src/log.ts";
import { ScriptedBrain } from "../src/intelligence/brain/scripted.ts";
import { AgentLoop } from "../src/intelligence/loop.ts";
import { FakeAbleton, FakeSplice } from "./helpers/fakes.ts";

function command(id: string, at = id.length): CommandSummary {
  return { id, at, source: "api", type: "userRequest", summary: id };
}
function entry(id: string, at = 0): TranscriptEntry {
  return { id, at, role: "user", kind: "request", text: id, fields: [] };
}
function fold(events: readonly MateEvent[]) {
  return events.reduce((s, e) => applyMateEvent(s, e), emptyState());
}

describe("the shared fold", () => {
  /**
   * The property the whole thing rests on: what mate holds and what a client
   * derives from the stream are the same picture. If `StateStore` ever grows a
   * private field the fold does not know about, this fails.
   */
  test("folding a whole run's events equals the store the run built", async () => {
    const clock = new ManualClock(1_000);
    const events = new EventBus<MateEvent>();
    const store = new StateStore(events);
    const brain = new ScriptedBrain([{ message: "Setting 120.", actions: [{ type: "setTempo", bpm: 120 }] }]);
    const loop = new AgentLoop({
      clock,
      mailbox: new Mailbox(),
      store,
      brain,
      ableton: new FakeAbleton(),
      splice: new FakeSplice(),
      log: silentLogger,
      options: { tickMs: 0, retryBaseMs: 100 },
    });
    loop.start();
    loop.submit({ type: "userRequest", text: "120 bpm" }, "api");
    await loop.settle();

    expect(store.snapshot().lastMessage).toBe("Setting 120.");
    expect(fold(events.recent())).toEqual(store.snapshot());
  });

  test("recentCommands keeps the newest 50, newest first", () => {
    let state = emptyState();
    for (let i = 0; i < 60; i++) state = applyMateEvent(state, { type: "command.received", command: command(`c${i}`, i) });
    expect(state.recentCommands).toHaveLength(50);
    expect(state.recentCommands[0]!.id).toBe("c59");
    expect(state.recentCommands.at(-1)!.id).toBe("c10");
  });

  test("the same command twice folds once, and changes nothing the second time", () => {
    const event: MateEvent = { type: "command.received", command: command("c1") };
    const once = applyMateEvent(emptyState(), event);
    expect(applyMateEvent(once, event)).toBe(once);
  });

  test("the transcript keeps the newest 200, oldest first out", () => {
    let state = emptyState();
    for (let i = 0; i < 250; i++) state = applyMateEvent(state, { type: "transcript.appended", entry: entry(`t${i}`, i) });
    expect(state.transcript).toHaveLength(200);
    expect(state.transcript[0]!.id).toBe("t50");
    expect(state.transcript.at(-1)!.id).toBe("t249");
  });

  test("the same transcript entry twice folds once", () => {
    const event: MateEvent = { type: "transcript.appended", entry: entry("t1") };
    const once = applyMateEvent(emptyState(), event);
    expect(once.transcript).toHaveLength(1);
    expect(applyMateEvent(once, event)).toBe(once);
  });

  test("caps are configurable", () => {
    let state = emptyState();
    for (let i = 0; i < 5; i++) state = applyMateEvent(state, { type: "transcript.appended", entry: entry(`t${i}`, i) }, { keepTranscript: 3 });
    expect(state.transcript.map((t) => t.id)).toEqual(["t2", "t3", "t4"]);
  });

  test("a message sets only lastMessage; its transcript line is its own event", () => {
    const state = applyMateEvent(emptyState(), { type: "message", text: "hello", requestId: "r1" });
    expect(state.lastMessage).toBe("hello");
    expect(state.transcript).toEqual([]);
  });

  /** A skipped re-render in the app, and a replayed no-op that stays a no-op. */
  test("events that describe nothing in the state return the same reference", () => {
    const state = emptyState();
    expect(applyMateEvent(state, { type: "cancelled", requestId: "r1" })).toBe(state);
    expect(applyMateEvent(state, { type: "action.applied", action: "setTempo", ok: true })).toBe(state);
    expect(
      applyMateEvent(state, {
        type: "download.progress",
        progress: { songId: "s1", total: 2, done: 1, failed: 0, current: null, lastError: null },
      }),
    ).toBe(state);
  });
});
