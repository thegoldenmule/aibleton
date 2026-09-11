import type { DawState, MidiNote, RequestContext } from "@aibleton/protocol";
import type { Command, CommandBody, CommandType } from "../../core/commands.ts";
import type { SongDigest } from "../../songwriting/digest.ts";

/** Something the brain wants done. The machine (never the brain) applies these to the ports. */
export type Action =
  | { type: "createMidiTrack"; name?: string }
  | { type: "createClip"; track: number; slot: number; lengthBeats: number }
  | { type: "addNotes"; track: number; slot: number; notes: MidiNote[] }
  | { type: "setTempo"; bpm: number }
  | { type: "fireClip"; track: number; slot: number }
  | { type: "startPlayback" }
  | { type: "stopPlayback" }
  | { type: "loadDrumKit"; track: number; rackUri: string; kitPath: string }
  | { type: "splicePromptToStack"; prompt: string; bpm: number }
  /**
   * The song plan, applied through `SongService`. None of these carries a song id: the loop always
   * means the active song, and which one that is is read when the action is applied, not when the
   * brain decided on it — that is what lets a compose and an edit of it queue in the same turn.
   */
  | { type: "composeSong"; text: string; name?: string }
  | { type: "clearActiveSong" }
  | { type: "resolveSong" }
  | { type: "pickSlot"; slotId: string; soundUuid: string }
  | { type: "setPlacement"; partId: string; occurrence: number; plays: boolean }
  | { type: "removeTrack"; partId: string }
  | { type: "arrangeSong" };

export type ActionType = Action["type"];

export interface ActionResult {
  action: Action;
  ok: boolean;
  detail?: string;
}

export interface Decision {
  /** What the bandmate says back to the drummer. */
  message: string;
  actions: Action[];
  /** A command the loop should enqueue after acting, optionally delayed. */
  followUp?: { cmd: CommandBody; delayMs?: number };
}

export interface HistoryEntry {
  at: number;
  command: Command;
  decision?: Decision;
  results?: ActionResult[];
}

export interface BrainInput {
  snapshot: DawState;
  goal?: string;
  /** Text of the userRequest that triggered this decision, if any. */
  userText?: string;
  /** The view that request was typed in, when the client sent one. A hint, never a fact about the set. */
  context?: RequestContext;
  history: HistoryEntry[];
  trigger: CommandType;
  /** The active song plan, kept current by `songChanged`. Absent means no song is active. */
  song?: SongDigest;
}

export interface Brain {
  readonly kind: "anthropic" | "scripted";
  decide(input: BrainInput, signal: AbortSignal): Promise<Decision>;
}
