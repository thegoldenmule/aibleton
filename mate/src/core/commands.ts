import type { CommandSource, CommandSummary, Envelope, ExternalCommand, SessionState } from "@aibleton/protocol";
import type { ActionResult, Decision } from "../intelligence/brain/types.ts";
import type { SongDigest } from "../songwriting/digest.ts";

export type { CommandSource, Envelope };

/** Commands produced inside mate (timer, loop completions, lifecycle). */
export type InternalCommand =
  | { type: "tick" }
  | { type: "shutdown" }
  | { type: "retry" }
  | { type: "snapshotReady"; snapshot: SessionState }
  | { type: "snapshotFailed"; error: string }
  /**
   * The active song plan changed (composed, resolved, picked, edited, arranged) — or went away.
   * A picture, not an event: it updates the machine's context and is never a trigger.
   */
  | { type: "songChanged"; digest: SongDigest | null }
  | { type: "brainDecided"; requestId: string; decision: Decision }
  | { type: "brainFailed"; requestId: string; error: string }
  /** `aborted` when the set stopped early: cancel, pause or shutdown. */
  | { type: "actionsDone"; requestId: string; results: ActionResult[]; aborted?: boolean }
  /** `results` are the actions that landed before this one; Live has no delete, so they stand. */
  | { type: "actionFailed"; requestId: string; index: number; error: string; results: ActionResult[] };

export type CommandBody = ExternalCommand | InternalCommand;
export type CommandType = CommandBody["type"];

/** A command with its envelope; this is what flows through the mailbox. */
export type Command = Envelope & CommandBody;

/** Commands that jump the mailbox queue. */
export const PRIORITY_COMMANDS: ReadonlySet<CommandType> = new Set(["cancel", "pause", "resume", "shutdown"]);

let counter = 0;
export function newId(prefix = "cmd"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function envelope(body: CommandBody, source: CommandSource, at: number): Command {
  return { id: newId(), at, source, ...body };
}

/** One-line description for logs, the API, and the UI. */
export function summarize(cmd: Command): CommandSummary {
  let summary: string;
  switch (cmd.type) {
    case "userRequest":
    case "goalSet":
      summary = cmd.text;
      break;
    case "abletonChanged":
      summary = cmd.hint ? `hint=${cmd.hint}` : "";
      break;
    case "midiNote":
      summary = `note=${cmd.note} vel=${cmd.velocity} ch=${cmd.channel}`;
      break;
    case "brainDecided":
      summary = `${cmd.decision.actions.length} action(s): ${cmd.decision.message.slice(0, 80)}`;
      break;
    case "brainFailed":
    case "snapshotFailed":
    case "actionFailed":
      summary = cmd.error;
      break;
    case "songChanged":
      summary = cmd.digest ? `${cmd.digest.name}: ${cmd.digest.counts.tracks} parts, ${cmd.digest.counts.slots} slots` : "no song";
      break;
    case "actionsDone":
      summary = cmd.aborted ? `${cmd.results.length} result(s), stopped early` : `${cmd.results.length} result(s)`;
      break;
    default:
      summary = "";
  }
  return { id: cmd.id, at: cmd.at, source: cmd.source, type: cmd.type, summary };
}
