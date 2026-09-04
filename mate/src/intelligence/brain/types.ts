import type { MidiNote, SessionState } from "@aibleton/protocol";
import type { Command, CommandBody, CommandType } from "../../core/commands.ts";

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
  | { type: "splicePromptToStack"; prompt: string; bpm: number };

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
  snapshot: SessionState;
  goal?: string;
  /** Text of the userRequest that triggered this decision, if any. */
  userText?: string;
  history: HistoryEntry[];
  trigger: CommandType;
}

export interface Brain {
  readonly kind: "anthropic" | "scripted";
  decide(input: BrainInput, signal: AbortSignal): Promise<Decision>;
}
