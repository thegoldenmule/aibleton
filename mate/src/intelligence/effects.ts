import { mateTrackName } from "@aibleton/protocol";
import type { Clock } from "../core/clock.ts";
import { envelope, type CommandBody } from "../core/commands.ts";
import type { Mailbox } from "../core/mailbox.ts";
import type { StateStore } from "../core/state.ts";
import type { Logger } from "../log.ts";
import type { AbletonPort } from "../ports/ableton/types.ts";
import type { SplicePort } from "../ports/splice/types.ts";
import type { Action, ActionResult, Brain } from "./brain/types.ts";
import type { Effect } from "./machine.ts";

export interface EffectRunnerDeps {
  brain: Brain;
  ableton: AbletonPort;
  splice: SplicePort;
  mailbox: Mailbox;
  store: StateStore;
  clock: Clock;
  log: Logger;
}

/** The only impure part of the intelligence module. Executes effects and feeds completions back as commands. */
export class EffectRunner {
  private inflight = new Set<Promise<void>>();
  /**
   * Brain calls and action sets share a requestId but need separate maps. `post("brainDecided")`
   * drains the mailbox synchronously inside the `.then`, so `applyActions` registers its controller
   * *before* `callBrain`'s `.finally(delete)` runs — one map and that delete silently disarms cancel.
   */
  private brainControllers = new Map<string, AbortController>();
  private actionControllers = new Map<string, AbortController>();
  private timers = new Set<number>();

  constructor(private readonly deps: EffectRunnerDeps) {}

  run(effects: Effect[]): void {
    for (const effect of effects) this.runOne(effect);
  }

  inFlight(): number {
    return this.inflight.size;
  }

  /** Resolves when every in-flight effect has completed (including ones started meanwhile). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  abortAll(): void {
    for (const c of [...this.brainControllers.values(), ...this.actionControllers.values()]) c.abort();
    this.brainControllers.clear();
    this.actionControllers.clear();
    for (const t of this.timers) this.deps.clock.clearTimeout(t);
    this.timers.clear();
  }

  private runOne(effect: Effect): void {
    const { deps } = this;
    switch (effect.type) {
      case "refreshSnapshot":
        this.track(
          deps.ableton.getSnapshot().then(
            (snapshot) => {
              deps.store.setSession(snapshot);
              this.post({ type: "snapshotReady", snapshot });
            },
            (err) => this.post({ type: "snapshotFailed", error: message(err) }),
          ),
        );
        return;
      case "callBrain": {
        const controller = new AbortController();
        this.brainControllers.set(effect.requestId, controller);
        this.track(
          deps.brain
            .decide(effect.input, controller.signal)
            .then(
              (decision) => {
                if (controller.signal.aborted) return;
                this.post({ type: "brainDecided", requestId: effect.requestId, decision });
              },
              (err) => {
                if (controller.signal.aborted) return;
                this.post({ type: "brainFailed", requestId: effect.requestId, error: message(err) });
              },
            )
            .finally(() => this.brainControllers.delete(effect.requestId)),
        );
        return;
      }
      case "abortBrain":
        this.brainControllers.get(effect.requestId)?.abort();
        this.brainControllers.delete(effect.requestId);
        return;
      case "abortActions":
        this.actionControllers.get(effect.requestId)?.abort();
        this.actionControllers.delete(effect.requestId);
        return;
      case "applyActions":
        this.track(this.applyActions(effect.requestId, effect.actions, effect.userPrompt));
        return;
      case "emitEvent":
        if (effect.event.type === "message") deps.store.setLastMessage(effect.event.text, deps.clock.now(), effect.event.requestId);
        else deps.store.events.emit(effect.event);
        return;
      case "enqueue":
        deps.mailbox.enqueue(effect.cmd);
        return;
      case "scheduleCommand": {
        const handle = deps.clock.setTimeout(() => {
          this.timers.delete(handle);
          this.post(effect.cmd);
        }, effect.delayMs);
        this.timers.add(handle);
        return;
      }
      default: {
        // tsconfig has no noImplicitReturns, so without this a new Effect would silently do nothing.
        const never: never = effect;
        throw new Error(`runOne: unhandled effect ${JSON.stringify(never)}`);
      }
    }
  }

  private async applyActions(requestId: string, actions: Action[], userPrompt?: string): Promise<void> {
    const controller = new AbortController();
    this.actionControllers.set(requestId, controller);
    const results: ActionResult[] = [];
    try {
      for (let i = 0; i < actions.length; i++) {
        // Checked between actions, never mid-action: an Ableton call already sent has landed.
        if (controller.signal.aborted) {
          this.post({ type: "actionsDone", requestId, results, aborted: true });
          return;
        }
        const action = actions[i]!;
        try {
          const detail = await this.applyOne(action, controller.signal, userPrompt);
          results.push({ action, ok: true, detail });
          this.deps.store.events.emit({ type: "action.applied", action: action.type, ok: true, detail });
        } catch (err) {
          const detail = message(err);
          this.deps.log.warn(`action ${action.type} failed`, detail);
          this.deps.store.events.emit({ type: "action.applied", action: action.type, ok: false, detail });
          // The successful results go with it: they are already in the set and cannot be undone.
          this.post({ type: "actionFailed", requestId, index: i, error: detail, results });
          return;
        }
      }
      this.post({ type: "actionsDone", requestId, results });
    } finally {
      this.actionControllers.delete(requestId);
    }
  }

  /**
   * One action against the ports. `signal` is the set's: no port call takes one yet, so the check
   * that stops a cancelled set is the one between actions, but a case that makes several calls or
   * runs long should re-check it here.
   */
  private async applyOne(action: Action, signal: AbortSignal, userPrompt?: string): Promise<string | undefined> {
    const { ableton, splice } = this.deps;
    const ctx = userPrompt ? { userPrompt } : undefined;
    switch (action.type) {
      case "createMidiTrack": {
        // Named with the [mate] suffix straight away: that mark is what lets later actions touch it.
        const index = await ableton.createMidiTrack(undefined, ctx);
        const name = mateTrackName(action.name?.trim() || "MIDI");
        await ableton.setTrackName(index, name, ctx);
        return `track ${index} ${JSON.stringify(name)}`;
      }
      case "createClip":
        await ableton.createClip(action.track, action.slot, action.lengthBeats, ctx);
        return;
      case "addNotes":
        await ableton.addNotes(action.track, action.slot, action.notes, ctx);
        return `${action.notes.length} notes`;
      case "setTempo":
        await ableton.setTempo(action.bpm, ctx);
        return `${action.bpm} bpm`;
      case "fireClip":
        await ableton.fireClip(action.track, action.slot, ctx);
        return;
      case "startPlayback":
        await ableton.startPlayback(ctx);
        return;
      case "stopPlayback":
        await ableton.stopPlayback(ctx);
        return;
      case "loadDrumKit":
        await ableton.loadDrumKit(action.track, action.rackUri, action.kitPath, ctx);
        return action.kitPath;
      case "splicePromptToStack": {
        const stack = await splice.promptToStack(action.prompt, action.bpm);
        return `stack ${stack.name} (${stack.layers.length} layers)`;
      }
      default: {
        // `Promise<string | undefined>` would otherwise let a missing case resolve to a silent success.
        const never: never = action;
        throw new Error(`applyOne: unhandled action ${JSON.stringify(never)}`);
      }
    }
  }

  private post(body: CommandBody): void {
    this.deps.mailbox.enqueue(envelope(body, "loop", this.deps.clock.now()));
  }

  private track(p: Promise<void>): void {
    const wrapped = p.catch((err) => this.deps.log.error("effect failed", err)).finally(() => this.inflight.delete(wrapped));
    this.inflight.add(wrapped);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
