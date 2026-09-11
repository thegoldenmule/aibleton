import { applyMateEvent, emptyState, type Activity, type AdapterStatus, type CommandSummary, type FoldOptions, type MateEvent, type Phase, type DawState, type Song, type StateResponse, type TranscriptEntry, type TranscriptField } from "@aibleton/protocol";
import { EventBus } from "./events.ts";
import { newId, summarize, type Command } from "./commands.ts";

/**
 * Observable snapshot of everything the API exposes. Emits events on change.
 *
 * The state itself is `applyMateEvent`'s fold of those events — the same
 * function the app runs over the SSE stream — so what a browser derives and
 * what mate holds cannot drift. What lives here is the impure half: minting
 * ids, and the policy about which events an operation produces at all.
 */
export class StateStore {
  private state: StateResponse = emptyState();
  private readonly fold: FoldOptions;

  constructor(
    readonly events: EventBus<MateEvent>,
    keepCommands = 50,
    keepTranscript = 200,
  ) {
    this.fold = { keepCommands, keepTranscript };
  }

  /**
   * Apply then emit, in that order: a subscriber that reads the store from
   * inside `emit()` must see the state the event describes.
   */
  private apply(event: MateEvent): void {
    this.state = applyMateEvent(this.state, event, this.fold);
    this.events.emit(event);
  }

  /**
   * Replay durable events through the same fold, emitting **nothing**. Once, at
   * boot or on a session switch, before anything subscribes.
   *
   * It bypasses the setters on purpose, for two reasons. The journal is an
   * `EventBus` subscriber attached *after* the replay, so emitting here would
   * write the whole session down a second time — that ordering is what makes a
   * `restoring` flag unnecessary. And `appendTranscript` mints a fresh id, so
   * replaying a reply through `setLastMessage` would give every restored line a
   * new one and duplicate it.
   */
  restore(events: readonly MateEvent[]): void {
    for (const event of events) this.state = applyMateEvent(this.state, event, this.fold);
  }

  /** Back to boot, emitting nothing: what a session switch does before its replay. */
  reset(): void {
    this.state = emptyState();
  }

  getDaw(): DawState | null {
    return this.state.daw;
  }
  setDaw(daw: DawState): void {
    this.apply({ type: "state.changed", daw });
  }

  getPhase(): Phase {
    return this.state.phase;
  }
  setPhase(phase: Phase, error?: string): void {
    if (phase === this.state.phase && (error ?? null) === this.state.error) return;
    this.apply(error ? { type: "phase.changed", phase, error } : { type: "phase.changed", phase });
    // A run that crashed between setting an activity and clearing it would otherwise leave a
    // permanent spinner. Only the loop's own activities: `cancellable` marks those, and a
    // route-driven compose runs while the loop sits idle, so its phase says nothing about it.
    if ((phase === "idle" || phase === "paused" || phase === "error") && this.state.activity?.cancellable) this.setActivity(null);
  }

  /** The one slow thing mate is doing, or null. Server-owned: a reload mid-compose still sees it. */
  getActivity(): Activity | null {
    return this.state.activity;
  }
  setActivity(activity: Activity | null): void {
    this.apply({ type: "activity.changed", activity });
  }

  /** What arrived while mate was working and is waiting its turn, oldest first. */
  getQueued(): readonly CommandSummary[] {
    return this.state.queued;
  }
  setQueued(queued: CommandSummary[]): void {
    this.apply({ type: "queue.changed", queued });
  }

  getGoal(): string | null {
    return this.state.goal;
  }
  setGoal(goal: string | null): void {
    this.apply({ type: "goal.changed", goal });
  }

  /** A message from mate to the drummer, stamped `at`. Also lands in the transcript, with any facts behind it. */
  setLastMessage(text: string, at: number, requestId?: string, fields: TranscriptField[] = []): void {
    this.apply(requestId ? { type: "message", text, requestId } : { type: "message", text });
    this.appendTranscript({ role: "mate", kind: "reply", text, at, fields });
  }

  /**
   * Append a line to the conversation; capped at `keepTranscript`, oldest dropped first.
   *
   * The purity seam: the id is minted here, so the event carries a finished
   * entry and the fold only ever appends something already identified.
   */
  appendTranscript(entry: Omit<TranscriptEntry, "id" | "fields"> & { fields?: TranscriptField[] }): TranscriptEntry {
    const full: TranscriptEntry = { id: newId("tx"), at: entry.at, role: entry.role, kind: entry.kind, text: entry.text, fields: entry.fields ?? [] };
    this.apply({ type: "transcript.appended", entry: full });
    return full;
  }
  getTranscript(): readonly TranscriptEntry[] {
    return this.state.transcript;
  }

  getAdapters(): AdapterStatus {
    return this.state.adapters;
  }
  setAdapters(status: AdapterStatus): void {
    this.apply({ type: "adapters", status });
  }

  /** The active song: mate's own picture of the session, rendered by the app. */
  getSong(): Song | null {
    return this.state.song;
  }
  setSong(song: Song | null): void {
    this.apply({ type: "song.changed", song });
  }

  recordCommand(cmd: Command): void {
    this.apply({ type: "command.received", command: summarize(cmd) });
    // Only what the drummer typed is conversation; loop follow-ups and goals are not.
    if (cmd.type === "userRequest" && cmd.source === "api") {
      this.appendTranscript({ role: "user", kind: "request", text: cmd.text, at: cmd.at });
    }
  }
  /** Oldest first, unlike `snapshot().recentCommands`, which the app reads newest first. */
  recentCommands(): readonly CommandSummary[] {
    return [...this.state.recentCommands].reverse();
  }

  snapshot(): StateResponse {
    return this.state;
  }
}
