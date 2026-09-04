import type Anthropic from "@anthropic-ai/sdk";
import type { BrainMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { AnthropicBriefer } from "./anthropic.ts";
import { ScriptedBriefer } from "./scripted.ts";
import type { Briefer } from "./types.ts";

export type { BriefInput, Briefer } from "./types.ts";
export { BriefRefusedError } from "./types.ts";
export { ScriptedBriefer } from "./scripted.ts";
export { AnthropicBriefer } from "./anthropic.ts";

export interface CreateBrieferOptions {
  /** Shared client, or null when no credentials resolved (see core/anthropic.ts). */
  client: Anthropic | null;
  /** Why `client` is null, for the fallback log line. */
  clientError?: string;
  model: string;
  log: Logger;
}

export interface BrieferResult {
  briefer: Briefer;
  live: boolean;
  fallbackReason?: string;
}

/**
 * Mirrors `createBrain`: the same MATE_BRAIN mode and the same client, so the
 * brain and the briefer are live together or scripted together.
 */
export function createBriefer(mode: BrainMode, opts: CreateBrieferOptions): BrieferResult {
  if (mode === "scripted") return { briefer: new ScriptedBriefer(), live: false };
  if (opts.client) {
    return { briefer: new AnthropicBriefer({ client: opts.client, model: opts.model, log: opts.log }), live: true };
  }
  const reason = opts.clientError ?? "no Anthropic client";
  if (mode === "anthropic") throw new Error(`MATE_BRAIN=anthropic but the client could not be created: ${reason}`);
  opts.log.warn(`briefer: falling back to scripted (${reason})`);
  return { briefer: new ScriptedBriefer(), live: false, fallbackReason: reason };
}
