import type Anthropic from "@anthropic-ai/sdk";
import type { Action } from "../brain/types.ts";
import { ABLETON_ACTION_TOOLS, ABLETON_READ_TOOLS, abletonToolToAction } from "./ableton.tools.ts";
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

const READ_ONLY = new Set([...ABLETON_READ_TOOLS, ...SPLICE_READ_TOOLS].map((t) => t.name));

export function toolDefinitions(): Tool[] {
  return [...ABLETON_READ_TOOLS, ...SPLICE_READ_TOOLS, ...ABLETON_ACTION_TOOLS, ...SPLICE_ACTION_TOOLS, FOLLOW_UP_TOOL];
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY.has(name);
}

/** Map a mutating tool call onto a domain Action. Returns null for unknown or read-only tools. */
export function toolToAction(name: string, input: Record<string, unknown>): Action | null {
  return abletonToolToAction(name, input) ?? spliceToolToAction(name, input);
}
