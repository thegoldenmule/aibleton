import type Anthropic from "@anthropic-ai/sdk";
import type { Action } from "../brain/types.ts";

type Tool = Anthropic.Beta.BetaTool;

export const SPLICE_READ_TOOLS: Tool[] = [
  {
    name: "splice_search",
    description: "Search the Splice catalog for loops or one-shots matching a description. Returns name, BPM, tags and asset UUID for each result.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bpm_min: { type: "integer" },
        bpm_max: { type: "integer" },
        type: { type: "string", enum: ["loop", "oneshot"] },
      },
      required: ["query"],
    },
  },
];

export const SPLICE_ACTION_TOOLS: Tool[] = [
  {
    name: "splice_prompt_to_stack",
    description:
      "Ask Splice to assemble a multi-layer stack of compatible samples from a text description. Always state the target BPM in the prompt and pass it as bpm.",
    input_schema: {
      type: "object",
      properties: { prompt: { type: "string" }, bpm: { type: "integer" } },
      required: ["prompt", "bpm"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export function spliceToolToAction(name: string, input: Record<string, unknown>): Action | null {
  if (name === "splice_prompt_to_stack") {
    return { type: "splicePromptToStack", prompt: String(input.prompt), bpm: Number(input.bpm) };
  }
  return null;
}
