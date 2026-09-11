import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MateEvent } from "@aibleton/protocol";
import { ModelRefusedError } from "../src/core/anthropic.ts";
import { ManualClock } from "../src/core/clock.ts";
import { EventBus } from "../src/core/events.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { StateStore } from "../src/core/state.ts";
import { silentLogger } from "../src/log.ts";
import { ScriptedBrain } from "../src/intelligence/brain/scripted.ts";
import type { Action, BrainInput } from "../src/intelligence/brain/types.ts";
import { EffectRunner } from "../src/intelligence/effects.ts";
import { RecipeBook, RecipeStore } from "../src/core/recipes.ts";
import { ScriptedRecipeWriter } from "../src/songwriting/recipe-writer/index.ts";
import type { CallContext } from "../src/ports/ableton/types.ts";
import { FakeAbleton, FakeSplice, makeSession } from "./helpers/fakes.ts";
import { bandLibrary, templateLibrary } from "./helpers/library.ts";

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
  const events = new EventBus<MateEvent>();
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


/** The same runner with the two libraries and a recipe book wired in, on temp directories. */
function libraryHarness() {
  const base = harness();
  const dir = mkdtempSync(join(tmpdir(), "mate-effects-library-"));
  const now = () => base.clock.now();
  const bands = bandLibrary(join(dir, "bands"), { now, log: silentLogger });
  const templates = templateLibrary(join(dir, "templates"), { now, log: silentLogger });
  const writer = new ScriptedRecipeWriter();
  const recipes = new RecipeBook({ store: new RecipeStore({ dir: join(dir, "recipes") }), writer, now });
  const runner = new EffectRunner({
    brain: base.brain,
    ableton: base.ableton,
    splice: base.splice,
    mailbox: base.mailbox,
    store: base.store,
    clock: base.clock,
    log: silentLogger,
    library: { bands, templates, recipes },
  });
  return { ...base, runner, bands, templates, recipes, writer };
}

const applied = (h: { events: EventBus<MateEvent> }) => h.events.ofType("action.applied");

describe("EffectRunner: the library generates", () => {
  test("staffs the band, saves it, and names the roster in the trail", async () => {
    const h = libraryHarness();
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: [{ type: "generateBand", genre: "funk" }] }]);
    await h.runner.settle();

    // The routes hand back a draft for the drummer to confirm; the brain has no draft UI, so this saves.
    const saved = await h.bands.list();
    expect(saved).toHaveLength(1);
    const band = saved[0]!;
    expect(band.metadata.genre).toBe("funk");
    expect(applied(h).map((e) => [e.action, e.ok])).toEqual([["generateBand", true]]);
    // “funk band 1000”: breakbeat kit (drums), P-bass (bass), ...
    expect(applied(h)[0]?.detail).toBe(`“${band.name}”: ${band.parts.map((p) => `${p.name} (${p.role})`).join(", ")}`);
    expect(applied(h)[0]?.detail).toMatch(/^“funk band \d+”: [^(]+ \([a-z]+\)/);
  });

  test("a name the model chose is the one the library holds", async () => {
    const h = libraryHarness();
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: [{ type: "generateBand", genre: "jazz", size: 3, name: "The Tuesday Trio" }] }]);
    await h.runner.settle();

    const band = (await h.bands.list())[0]!;
    expect(band.name).toBe("The Tuesday Trio");
    expect(band.parts).toHaveLength(3);
    expect(applied(h)[0]?.detail).toStartWith("“The Tuesday Trio”: ");
  });

  test("lays the form out, saves it, and says how long it runs", async () => {
    const h = libraryHarness();
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: [{ type: "generateTemplate", alphabet: 3, count: 5, bars: 8 }] }]);
    await h.runner.settle();

    const template = (await h.templates.list())[0]!;
    // Sections counted along the form, not distinct letters: five to play, forty bars of them.
    expect(applied(h)[0]?.detail).toBe(`“${template.name}”: ${template.form} (5 sections, 40 bars)`);
    expect(applied(h)[0]?.detail).toMatch(/^“Form \d+”: (?:[a-z]\d+ ?){5}\(5 sections, 40 bars\)$/);
  });

  test("a refusal from the recipe writer fails the action; it does not crash the runner", async () => {
    const h = libraryHarness();
    // An unknown genre goes to the writer, and the writer is allowed to say no.
    h.writer.rejectNext(new ModelRefusedError("write a recipe for \"sea shanty\"", "policy", null));
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: [{ type: "generateBand", genre: "sea shanty" }] }]);
    await h.runner.settle();

    const failed = h.mailbox.peekAll()[0];
    expect(failed?.type).toBe("actionFailed");
    if (failed?.type !== "actionFailed") throw new Error("expected actionFailed");
    expect(failed.error).toContain("the model declined to write a recipe");
    expect(applied(h).map((e) => e.ok)).toEqual([false]);
    expect(await h.bands.list()).toEqual([]);
  });

  test("a loop built without the libraries fails the action by name rather than doing nothing", async () => {
    const h = harness();
    h.runner.run([{ type: "applyActions", requestId: "r1", actions: [{ type: "generateTemplate" }] }]);
    await h.runner.settle();

    const failed = h.mailbox.peekAll()[0];
    expect(failed?.type === "actionFailed" ? failed.error : "").toContain("no band or template library is wired up");
  });
});
