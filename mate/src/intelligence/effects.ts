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
  private controllers = new Map<string, AbortController>();
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
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
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
        this.controllers.set(effect.requestId, controller);
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
            .finally(() => this.controllers.delete(effect.requestId)),
        );
        return;
      }
      case "abortBrain":
        this.controllers.get(effect.requestId)?.abort();
        this.controllers.delete(effect.requestId);
        return;
      case "applyActions":
        this.track(this.applyActions(effect.actions, effect.userPrompt));
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
    }
  }

  private async applyActions(actions: Action[], userPrompt?: string): Promise<void> {
    const results: ActionResult[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      try {
        const detail = await this.applyOne(action, userPrompt);
        results.push({ action, ok: true, detail });
        this.deps.store.events.emit({ type: "action.applied", action: action.type, ok: true, detail });
      } catch (err) {
        const detail = message(err);
        this.deps.log.warn(`action ${action.type} failed`, detail);
        this.deps.store.events.emit({ type: "action.applied", action: action.type, ok: false, detail });
        this.post({ type: "actionFailed", index: i, error: detail });
        return;
      }
    }
    this.post({ type: "actionsDone", results });
  }

  private async applyOne(action: Action, userPrompt?: string): Promise<string | undefined> {
    const { ableton, splice } = this.deps;
    const ctx = userPrompt ? { userPrompt } : undefined;
    switch (action.type) {
      case "createMidiTrack": {
        const index = await ableton.createMidiTrack(undefined, ctx);
        return `track ${index}`;
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
