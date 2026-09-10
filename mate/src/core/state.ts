import type { Activity, AdapterStatus, CommandSummary, Phase, SessionState, Song, StateResponse, TranscriptEntry, TranscriptField } from "@aibleton/protocol";
import { EventBus } from "./events.ts";
import { newId, summarize, type Command } from "./commands.ts";

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
  private transcript: TranscriptEntry[] = [];
  private activity: Activity | null = null;
  private queued: CommandSummary[] = [];

  constructor(
    readonly events: EventBus,
    private readonly keepCommands = 50,
    private readonly keepTranscript = 200,
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
    // A run that crashed between setting an activity and clearing it would otherwise leave a
    // permanent spinner. Only the loop's own activities: `cancellable` marks those, and a
    // route-driven compose runs while the loop sits idle, so its phase says nothing about it.
    if ((phase === "idle" || phase === "paused" || phase === "error") && this.activity?.cancellable) this.setActivity(null);
  }

  /** The one slow thing mate is doing, or null. Server-owned: a reload mid-compose still sees it. */
  getActivity(): Activity | null {
    return this.activity;
  }
  setActivity(activity: Activity | null): void {
    this.activity = activity;
    this.events.emit({ type: "activity.changed", activity });
  }

  /** What arrived while mate was working and is waiting its turn, oldest first. */
  getQueued(): readonly CommandSummary[] {
    return this.queued;
  }
  setQueued(queued: CommandSummary[]): void {
    this.queued = queued;
    this.events.emit({ type: "queue.changed", queued });
  }

  getGoal(): string | null {
    return this.goal;
  }
  setGoal(goal: string | null): void {
    this.goal = goal;
    this.events.emit({ type: "goal.changed", goal });
  }

  /** A message from mate to the drummer, stamped `at`. Also lands in the transcript, with any facts behind it. */
  setLastMessage(text: string, at: number, requestId?: string, fields: TranscriptField[] = []): void {
    this.lastMessage = text;
    this.events.emit(requestId ? { type: "message", text, requestId } : { type: "message", text });
    this.appendTranscript({ role: "mate", kind: "reply", text, at, fields });
  }

  /** Append a line to the conversation; capped at `keepTranscript`, oldest dropped first. */
  appendTranscript(entry: Omit<TranscriptEntry, "id" | "fields"> & { fields?: TranscriptField[] }): TranscriptEntry {
    const full: TranscriptEntry = { id: newId("tx"), at: entry.at, role: entry.role, kind: entry.kind, text: entry.text, fields: entry.fields ?? [] };
    this.transcript.push(full);
    if (this.transcript.length > this.keepTranscript) this.transcript.shift();
    this.events.emit({ type: "transcript.appended", entry: full });
    return full;
  }
  getTranscript(): readonly TranscriptEntry[] {
    return this.transcript;
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
    // Only what the drummer typed is conversation; loop follow-ups and goals are not.
    if (cmd.type === "userRequest" && cmd.source === "api") {
      this.appendTranscript({ role: "user", kind: "request", text: cmd.text, at: cmd.at });
    }
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
      transcript: [...this.transcript],
      activity: this.activity,
      queued: [...this.queued],
    };
  }
}
