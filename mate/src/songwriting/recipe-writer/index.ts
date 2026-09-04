import type Anthropic from "@anthropic-ai/sdk";
import type { BrainMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { AnthropicRecipeWriter } from "./anthropic.ts";
import { ScriptedRecipeWriter } from "./scripted.ts";
import type { RecipeWriter } from "./types.ts";

export type { RecipeDraft, RecipeRequest, RecipeWriter } from "./types.ts";
export { ScriptedRecipeWriter } from "./scripted.ts";
export { AnthropicRecipeWriter } from "./anthropic.ts";

export interface CreateRecipeWriterOptions {
  /** Shared client, or null when no credentials resolved (see core/anthropic.ts). */
  client: Anthropic | null;
  /** Why `client` is null, for the fallback log line. */
  clientError?: string;
  model: string;
  log: Logger;
}

export interface RecipeWriterResult {
  writer: RecipeWriter;
  live: boolean;
  fallbackReason?: string;
}

/** Mirrors `createBrain` and `createBriefer`: same MATE_BRAIN mode, same client. */
export function createRecipeWriter(mode: BrainMode, opts: CreateRecipeWriterOptions): RecipeWriterResult {
  if (mode === "scripted") return { writer: new ScriptedRecipeWriter(), live: false };
  if (opts.client) {
    return { writer: new AnthropicRecipeWriter({ client: opts.client, model: opts.model, log: opts.log }), live: true };
  }
  const reason = opts.clientError ?? "no Anthropic client";
  if (mode === "anthropic") throw new Error(`MATE_BRAIN=anthropic but the client could not be created: ${reason}`);
  opts.log.warn(`recipe writer: falling back to scripted (${reason})`);
  return { writer: new ScriptedRecipeWriter(), live: false, fallbackReason: reason };
}
