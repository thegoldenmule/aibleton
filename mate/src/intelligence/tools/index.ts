import type Anthropic from "@anthropic-ai/sdk";
import type { Action } from "../brain/types.ts";
import { ABLETON_ACTION_TOOLS, ABLETON_READ_TOOLS, abletonToolToAction } from "./ableton.tools.ts";
import { LIBRARY_READ_TOOLS } from "./library.tools.ts";
import { SONG_ACTION_TOOLS, SONG_COMPOSE_TOOLS, SONG_READ_TOOLS, songToolToAction } from "./song.tools.ts";
import { SPLICE_ACTION_TOOLS, SPLICE_READ_TOOLS, spliceToolToAction } from "./splice.tools.ts";

export type Tool = Anthropic.Beta.BetaTool;

export const FOLLOW_UP_TOOL: Tool = {
  name: "schedule_follow_up",
  description:
    "Ask to be woken up again after a delay to check on the drummer (for example after a practice interval). reason is what you want to check.",
  input_schema: {
    type: "object",
    properties: { delay_ms: { type: "integer" }, reason: { type: "string" } },
    required: ["delay_ms", "reason"],
    additionalProperties: false,
  },
  strict: true,
};

const READ_ONLY = new Set(
  [...ABLETON_READ_TOOLS, ...SPLICE_READ_TOOLS, ...SONG_READ_TOOLS, ...LIBRARY_READ_TOOLS].map((t) => t.name),
);

/** What the brain is allowed to reach for this turn. Live tools are always on offer; the song plan is not. */
export interface ToolContext {
  /**
   * Whether the song plan is on the table at all. It is offered only for a request the drummer
   * typed: ticks, abletonChanged and MIDI may talk and use the Live tools, but a background idea
   * must never compose, re-cast or rebuild the song behind their back.
   */
  songTools: boolean;
  /** A song is active: the six editing tools, no compose. With none it is the other way round. */
  hasSong: boolean;
  /**
   * Whether the saved libraries may be read. Gated on the same thing the song plan is and for the
   * same reason — a tick or a stray MIDI note must not go rummaging through the drummer's bands —
   * but not on whether a song is active: reading a library clobbers nothing. False when the brain
   * was built without the libraries at all.
   */
  libraryTools?: boolean;
}

/**
 * The tool list for one call. Computed per call, never cached: it depends on this turn's trigger,
 * on whether a song is active, and on what the brain was built with. Downloading is in no list at
 * any time — it spends a credit, so it stays behind the drummer's own confirm.
 */
export function toolDefinitions(ctx: ToolContext = { songTools: false, hasSong: false }): Tool[] {
  const song = !ctx.songTools ? [] : ctx.hasSong ? [...SONG_READ_TOOLS, ...SONG_ACTION_TOOLS] : SONG_COMPOSE_TOOLS;
  const library = ctx.libraryTools ? LIBRARY_READ_TOOLS : [];
  return [...ABLETON_READ_TOOLS, ...SPLICE_READ_TOOLS, ...ABLETON_ACTION_TOOLS, ...SPLICE_ACTION_TOOLS, ...song, ...library, FOLLOW_UP_TOOL];
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY.has(name);
}

/** Map a mutating tool call onto a domain Action. Returns null for unknown or read-only tools. */
export function toolToAction(name: string, input: Record<string, unknown>): Action | null {
  return abletonToolToAction(name, input) ?? spliceToolToAction(name, input) ?? songToolToAction(name, input);
}
