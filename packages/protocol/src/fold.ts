import type { MateEvent } from "./events.ts";
import type { StateResponse } from "./api.ts";

/**
 * How much history the fold keeps. Both lists are bounded so a long session
 * cannot grow the state without limit; the oldest entries fall off first.
 */
export interface FoldOptions {
  /** Newest-first commands kept in `recentCommands`. */
  keepCommands?: number;
  /** Oldest-first lines kept in `transcript`. */
  keepTranscript?: number;
}

const KEEP_COMMANDS = 50;
const KEEP_TRANSCRIPT = 200;

/** The state before anything has happened: what mate looks like at boot. */
export function emptyState(): StateResponse {
  return {
    daw: null,
    phase: "idle",
    error: null,
    goal: null,
    adapters: { ableton: "stub", splice: "stub", brain: "scripted" },
    recentCommands: [],
    lastMessage: null,
    song: null,
    transcript: [],
    activity: null,
    queued: [],
  };
}

/**
 * The one fold of `MateEvent` into `StateResponse`. `StateStore` folds live in
 * mate, the app folds the SSE stream, and a replay folds a journal — all three
 * run this function, so the three pictures cannot drift.
 *
 * It never mutates `state`, and returns the **same reference** when an event
 * changes nothing. The app gets a free skipped re-render, and a replayed no-op
 * stays a no-op.
 */
export function applyMateEvent(state: StateResponse, event: MateEvent, opts: FoldOptions = {}): StateResponse {
  const keepCommands = opts.keepCommands ?? KEEP_COMMANDS;
  const keepTranscript = opts.keepTranscript ?? KEEP_TRANSCRIPT;

  switch (event.type) {
    case "state.changed":
      return { ...state, daw: event.daw };
    // A session switch: the whole picture is new, so there is nothing to merge.
    case "state.replaced":
      return event.state;
    case "phase.changed":
      return { ...state, phase: event.phase, error: event.error ?? null };
    case "command.received": {
      // Deduped by id, because `settleIdle` re-enqueues the *original* envelope
      // when it releases a deferred request (`machine.ts`). The fold is the
      // second line of that defence and is what makes a replay idempotent.
      if (state.recentCommands.some((c) => c.id === event.command.id)) return state;
      return { ...state, recentCommands: [event.command, ...state.recentCommands].slice(0, keepCommands) };
    }
    case "message":
      // Only `lastMessage`. The transcript line `setLastMessage` also produces
      // arrives as its own `transcript.appended`; synthesising it here would
      // double every reply on replay.
      return { ...state, lastMessage: event.text };
    case "adapters":
      return { ...state, adapters: event.status };
    case "goal.changed":
      return { ...state, goal: event.goal };
    case "song.changed":
      return { ...state, song: event.song };
    case "transcript.appended": {
      // Deduped by id, for the same reason as `command.received`. Entries are
      // identified before the event is emitted, so the fold only ever appends
      // something that already has an id.
      if (state.transcript.some((t) => t.id === event.entry.id)) return state;
      const transcript = [...state.transcript, event.entry];
      if (transcript.length > keepTranscript) transcript.splice(0, transcript.length - keepTranscript);
      return { ...state, transcript };
    }
    case "activity.changed":
      return { ...state, activity: event.activity };
    case "queue.changed":
      return { ...state, queued: event.queued };
    // Nothing in `StateResponse` describes these: a cancellation is a fact about
    // a request, an applied action is a trace of what reached Live, and download
    // progress is its own stream. Same reference, so replaying them is free.
    case "cancelled":
    case "action.applied":
    case "download.progress":
      return state;
    default: {
      const never: never = event;
      return never;
    }
  }
}
