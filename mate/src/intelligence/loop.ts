import { envelope, summarize, type Command, type CommandBody, type CommandSource } from "../core/commands.ts";
import type { Phase, Song, StateResponse } from "@aibleton/protocol";
import { songDigest } from "../songwriting/digest.ts";
import { EffectRunner } from "./effects.ts";
import { DEFAULT_STEP_OPTIONS, errorOf, initialState, phaseOf, step, type MachineState, type StepOptions } from "./machine.ts";
import type { Intelligence, IntelligenceDeps } from "./types.ts";

/**
 * The machine's working memory as the store already holds it: what a resumed session, or a song
 * activated before the loop started, has to hand the reducer. Pure — `songDigest` is pure, so no
 * I/O leaks into the seed.
 */
export function contextFromState(state: StateResponse): Extract<CommandBody, { type: "contextRestored" }> {
  // The most recent thing the drummer typed, so the brain's first turn after a resume knows what
  // the conversation was about.
  const lastRequest = [...state.transcript].reverse().find((t) => t.role === "user" && t.kind === "request");
  return {
    type: "contextRestored",
    goal: state.goal,
    userText: lastRequest?.text ?? null,
    song: state.song ? songDigest(state.song) : null,
  };
}

/**
 * A drain is one synchronous pass: nothing awaits inside it, so a command that keeps re-enqueueing
 * itself would spin here on one stack with no timeout ever firing. Cap it, say so, and let go.
 */
const MAX_DRAIN_STEPS = 1000;

/**
 * Drives the machine: mailbox -> step -> effects, and keeps the periodic tick armed.
 * Ticks are re-armed with setTimeout after each fire (never setInterval) so a manual clock
 * cannot double-fire within one advance.
 */
export class AgentLoop implements Intelligence {
  private state: MachineState = initialState();
  private readonly runner: EffectRunner;
  private readonly stepOptions: StepOptions;
  private readonly tickMs: number;
  private tickHandle: number | null = null;
  private running = false;
  private draining = false;
  private seen = new Set<string>();
  private lastGoal: string | undefined;
  private lastQueued = "";
  private unsubscribeSong: (() => void) | null = null;

  constructor(private readonly deps: IntelligenceDeps) {
    this.runner = new EffectRunner({
      brain: deps.brain,
      ableton: deps.ableton,
      splice: deps.splice,
      ...(deps.songs ? { songs: deps.songs } : {}),
      ...(deps.library ? { library: deps.library } : {}),
      mailbox: deps.mailbox,
      store: deps.store,
      clock: deps.clock,
      log: deps.log,
    });
    this.stepOptions = {
      ...DEFAULT_STEP_OPTIONS,
      maxBrainRetries: deps.options?.maxBrainRetries ?? DEFAULT_STEP_OPTIONS.maxBrainRetries,
      retryBaseMs: deps.options?.retryBaseMs ?? DEFAULT_STEP_OPTIONS.retryBaseMs,
      historyLimit: deps.options?.historyLimit ?? DEFAULT_STEP_OPTIONS.historyLimit,
      maxDeferred: deps.options?.maxDeferred ?? DEFAULT_STEP_OPTIONS.maxDeferred,
    };
    this.tickMs = deps.options?.tickMs ?? 5000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.mailbox.setListener(() => this.drain());
    // Everything that changes the song — the drummer's buttons and the loop's own actions alike —
    // goes through the store, so this is the one place that keeps the brain's picture current.
    this.unsubscribeSong = this.deps.store.events.subscribe((event) => {
      if (event.type === "song.changed") this.postSongDigest(event.song);
    });
    // Whatever the store already holds is still true: a song activated before the loop started, and
    // a goal and a request restored from a saved session. Without this the brain would think there
    // is no song and offer to compose over it, and would have forgotten what it was working toward.
    const ctx = contextFromState(this.deps.store.snapshot());
    // Seeded here too, or `sync()` would see the restored goal as a change on the next command and
    // emit a `goal.changed` the journal would then record: one more line per restart, forever.
    this.lastGoal = ctx.goal ?? undefined;
    this.deps.mailbox.enqueue(envelope(ctx, "loop", this.deps.clock.now()));
    this.armTick();
    this.drain();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.deps.mailbox.setListener(null);
    this.unsubscribeSong?.();
    this.unsubscribeSong = null;
    if (this.tickHandle !== null) {
      this.deps.clock.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    this.runner.abortAll();
    await this.runner.settle();
  }

  submit(body: CommandBody, source: CommandSource): string {
    const cmd = envelope(body, source, this.deps.clock.now());
    this.deps.mailbox.enqueue(cmd);
    return cmd.id;
  }

  post(cmd: Command): void {
    this.deps.mailbox.enqueue(cmd);
  }

  phase(): Phase {
    return phaseOf(this.state);
  }

  /** Exposed for tests and diagnostics. */
  machineState(): MachineState {
    return this.state;
  }

  async settle(): Promise<void> {
    do {
      this.drain();
      await this.runner.settle();
    } while (this.deps.mailbox.size() > 0 || this.runner.inFlight() > 0);
  }

  private armTick(): void {
    if (!this.running || this.tickMs <= 0) return;
    this.tickHandle = this.deps.clock.setTimeout(() => {
      this.tickHandle = null;
      if (!this.running) return;
      this.deps.mailbox.enqueue(envelope({ type: "tick" }, "timer", this.deps.clock.now()));
      this.armTick();
    }, this.tickMs);
  }

  private drain(): void {
    if (!this.running || this.draining) return;
    this.draining = true;
    try {
      for (let steps = 0; ; steps++) {
        if (steps >= MAX_DRAIN_STEPS) {
          this.deps.log.error(`drain stopped after ${MAX_DRAIN_STEPS} commands in one pass; ${this.deps.mailbox.size()} left in the mailbox`);
          break;
        }
        const cmd = this.deps.mailbox.next();
        if (!cmd) break;
        this.record(cmd);
        if (cmd.type === "shutdown") {
          void this.stop();
          break;
        }
        const { state, effects } = step(this.state, cmd, this.stepOptions);
        this.state = state;
        this.sync();
        this.runner.run(effects);
      }
    } finally {
      this.draining = false;
    }
  }

  /** `songDigest` is pure — no I/O leaks into the loop, only the shape of the plan. */
  private postSongDigest(song: Song | null): void {
    this.deps.mailbox.enqueue(envelope({ type: "songChanged", digest: song ? songDigest(song) : null }, "loop", this.deps.clock.now()));
  }

  private record(cmd: Command): void {
    // A digest is a picture, not an event: one resolve saves every slot in turn, and each save
    // would otherwise become a recentCommands row and a command.received on the wire. The same for
    // a restored context, and there it matters twice over: a `command.received` *is* journaled, so
    // recording it would append one more command row to the session on every single restart.
    if (cmd.type === "songChanged" || cmd.type === "contextRestored") return;
    if (this.seen.has(cmd.id)) return; // re-enqueued command, already recorded
    this.seen.add(cmd.id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);
    this.deps.store.recordCommand(cmd);
  }

  private sync(): void {
    this.deps.store.setPhase(phaseOf(this.state), errorOf(this.state));
    const goal = this.state.ctx.goal;
    if (goal !== this.lastGoal) {
      this.lastGoal = goal;
      this.deps.store.setGoal(goal ?? null);
    }
    // What arrived mid-turn and is waiting. Change-detected the way the goal is: `sync` runs on
    // every command, and the queue only moves when one is parked or released.
    const deferred = this.state.ctx.deferred;
    const fingerprint = deferred.map((c) => c.id).join(",");
    if (fingerprint !== this.lastQueued) {
      this.lastQueued = fingerprint;
      this.deps.store.setQueued(deferred.map(summarize));
    }
  }
}
