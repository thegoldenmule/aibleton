import { mateTrackName } from "@aibleton/protocol";
import type { Activity } from "@aibleton/protocol";
import type { Clock } from "../core/clock.ts";
import { envelope, type CommandBody } from "../core/commands.ts";
import type { Mailbox } from "../core/mailbox.ts";
import type { StateStore } from "../core/state.ts";
import type { Logger } from "../log.ts";
import type { AbletonPort } from "../ports/ableton/types.ts";
import type { SplicePort } from "../ports/splice/types.ts";
import type { SongService } from "../songwriting/service.ts";
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
  /**
   * The one implementation of every song operation, shared with the REST routes. Optional: a loop
   * built without it simply cannot run song actions, which is what most tests want.
   */
  songs?: SongService;
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
        // The brain can take half a minute. Without this the app has nothing to show between the
        // drummer pressing send and the first action landing.
        const thinking = this.startThinking(effect.requestId, effect.input.userText ?? effect.input.goal ?? "");
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
            .finally(() => {
              this.brainControllers.delete(effect.requestId);
              // By identity: posting `brainDecided` drains synchronously, so by the time this runs
              // the actions it decided on may already have an activity of their own in the store.
              if (deps.store.getActivity() === thinking) deps.store.setActivity(null);
            }),
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
          const detail = await this.applyOne(action, controller.signal, requestId, userPrompt);
          results.push({ action, ok: true, detail });
          this.deps.store.events.emit({ type: "action.applied", action: action.type, ok: true, detail, requestId });
        } catch (err) {
          const detail = message(err);
          this.deps.log.warn(`action ${action.type} failed`, detail);
          this.deps.store.events.emit({ type: "action.applied", action: action.type, ok: false, detail, requestId });
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
  private async applyOne(action: Action, signal: AbortSignal, requestId: string, userPrompt?: string): Promise<string | undefined> {
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
      // The song plan. Each of these goes through the service the drummer's buttons call, and each
      // reads the active song when it runs, so a compose and an edit of it can queue in one turn.
      case "composeSong": {
        const out = await this.songs().compose({ text: action.text, ...(action.name ? { name: action.name } : {}), signal, requestId });
        const { plan } = out.song;
        const found = plan.slots.filter((s) => s.candidates.length > 0).length;
        return `“${out.song.name}”: ${plan.tracks.length} parts, ${found}/${plan.slots.length} slots with sounds${out.resolveError ? `; the Splice search failed (${out.resolveError})` : ""}`;
      }
      case "clearActiveSong": {
        const was = this.songs().clearActive();
        return was ? `put “${was.name}” away` : "no song was active";
      }
      case "resolveSong": {
        const songs = this.songs();
        const out = await songs.resolve(songs.requireActive(), signal, requestId);
        const found = out.song.plan.slots.filter((s) => s.candidates.length > 0).length;
        return `${found}/${out.song.plan.slots.length} slots have sounds${out.failedSlotIds.length ? `, ${out.failedSlotIds.length} found nothing` : ""}`;
      }
      case "pickSlot": {
        const songs = this.songs();
        const song = await songs.pick(songs.requireActive(), action.slotId, action.soundUuid, requestId);
        const slot = song.plan.slots.find((s) => s.id === action.slotId);
        const name = slot?.candidates.find((c) => c.uuid === action.soundUuid)?.fileName ?? action.soundUuid;
        return `${action.slotId}: ${name}`;
      }
      case "setPlacement": {
        const songs = this.songs();
        await songs.setPlacement(songs.requireActive(), action.partId, action.occurrence, action.plays, requestId);
        return `${action.partId} ${action.plays ? "plays" : "rests"} in occurrence ${action.occurrence}`;
      }
      case "removeTrack": {
        const songs = this.songs();
        const song = await songs.removeTrack(songs.requireActive(), action.partId, requestId);
        return `dropped ${action.partId}, ${song.plan.tracks.length} parts left`;
      }
      case "arrangeSong": {
        const songs = this.songs();
        const out = await songs.arrange(songs.requireActive(), signal, requestId);
        // `arrange` already says the sentence to the drummer; this is the trail line, not a repeat.
        return `${out.applied.length} applied${out.failed.length ? `, ${out.failed.length} failed` : ""}`;
      }
      default: {
        // `Promise<string | undefined>` would otherwise let a missing case resolve to a silent success.
        const never: never = action;
        throw new Error(`applyOne: unhandled action ${JSON.stringify(never)}`);
      }
    }
  }

  /** Publishes "the bandmate is thinking" and hands back the record, so only that one is cleared later. */
  private startThinking(requestId: string, request: string): Activity {
    const at = this.deps.clock.now();
    const activity: Activity = {
      requestId,
      kind: "think",
      request,
      message: "thinking it over",
      fields: [],
      fraction: null,
      startedAt: at,
      at,
      cancellable: true,
    };
    this.deps.store.setActivity(activity);
    return activity;
  }

  /** The song library, or a failure that names the reason. Wired in `index.ts`; absent in most tests. */
  private songs(): SongService {
    const { songs } = this.deps;
    if (!songs) throw new Error("no song library is wired up, so song actions cannot run");
    return songs;
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
