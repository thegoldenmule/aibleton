import type { AdapterStatus, CommandSummary, Phase, SessionState, Song, StateResponse } from "@aibleton/protocol";
import { EventBus } from "./events.ts";
import { summarize, type Command } from "./commands.ts";

/** Observable snapshot of everything the API exposes. Emits events on change. */
export class StateStore {
  private session: SessionState | null = null;
  private phase: Phase = "idle";
  private error: string | null = null;
  private goal: string | null = null;
  private lastMessage: string | null = null;
  private recent: CommandSummary[] = [];
  private adapters: AdapterStatus = { ableton: "stub", splice: "stub", brain: "scripted" };
  private song: Song | null = null;

  constructor(
    readonly events: EventBus,
    private readonly keepCommands = 50,
  ) {}

  getSession(): SessionState | null {
    return this.session;
  }
  setSession(session: SessionState): void {
    this.session = session;
    this.events.emit({ type: "state.changed", session });
  }

  getPhase(): Phase {
    return this.phase;
  }
  setPhase(phase: Phase, error?: string): void {
    if (phase === this.phase && (error ?? null) === this.error) return;
    this.phase = phase;
    this.error = error ?? null;
    this.events.emit(error ? { type: "phase.changed", phase, error } : { type: "phase.changed", phase });
  }

  getGoal(): string | null {
    return this.goal;
  }
  setGoal(goal: string | null): void {
    this.goal = goal;
    this.events.emit({ type: "goal.changed", goal });
  }

  setLastMessage(text: string, requestId?: string): void {
    this.lastMessage = text;
    this.events.emit(requestId ? { type: "message", text, requestId } : { type: "message", text });
  }

  getAdapters(): AdapterStatus {
    return this.adapters;
  }
  setAdapters(status: AdapterStatus): void {
    this.adapters = status;
    this.events.emit({ type: "adapters", status });
  }

  /** The active song: mate's own picture of the session, rendered by the app. */
  getSong(): Song | null {
    return this.song;
  }
  setSong(song: Song | null): void {
    this.song = song;
    this.events.emit({ type: "song.changed", song });
  }

  recordCommand(cmd: Command): void {
    const summary = summarize(cmd);
    this.recent.push(summary);
    if (this.recent.length > this.keepCommands) this.recent.shift();
    this.events.emit({ type: "command.received", command: summary });
  }
  recentCommands(): readonly CommandSummary[] {
    return this.recent;
  }

  snapshot(): StateResponse {
    return {
      session: this.session,
      phase: this.phase,
      error: this.error,
      goal: this.goal,
      adapters: this.adapters,
      recentCommands: [...this.recent].reverse(),
      lastMessage: this.lastMessage,
      song: this.song,
    };
  }
}
