import type Anthropic from "@anthropic-ai/sdk";
import type { Song } from "@aibleton/protocol";
import type { BrainMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { AbletonPort } from "../../ports/ableton/types.ts";
import type { SplicePort } from "../../ports/splice/types.ts";
import { AnthropicBrain } from "./anthropic.ts";
import { ScriptedBrain } from "./scripted.ts";
import type { Brain, Decision } from "./types.ts";

export interface CreateBrainOptions {
  /** Shared client, or null when no credentials resolved (see core/anthropic.ts). */
  client: Anthropic | null;
  /** Why `client` is null, for the fallback log line. */
  clientError?: string;
  model: string;
  log: Logger;
  ableton: AbletonPort;
  splice: SplicePort;
  /** The active song, read fresh per call. Without it the brain is offered no song tools. */
  getSong?: () => Song | null;
}

export interface BrainResult {
  brain: Brain;
  live: boolean;
  fallbackReason?: string;
}

/** Demo script used when no LLM is available: greets, then answers every call without acting. */
export function demoScript(): Decision[] {
  return [
    {
      message:
        "Hey, I'm mate. I'm running without an LLM right now, so I'll just watch the session. Set MATE_BRAIN=anthropic with credentials to let me play along.",
      actions: [],
    },
  ];
}

export async function createBrain(mode: BrainMode, opts: CreateBrainOptions): Promise<BrainResult> {
  if (mode === "scripted") return { brain: new ScriptedBrain(demoScript()), live: false };

  const { client } = opts;
  if (client) {
    return {
      brain: new AnthropicBrain({
        client,
        model: opts.model,
        log: opts.log,
        ableton: opts.ableton,
        splice: opts.splice,
        ...(opts.getSong ? { getSong: opts.getSong } : {}),
      }),
      live: true,
    };
  }
  const reason = opts.clientError ?? "no Anthropic client";
  if (mode === "anthropic") throw new Error(`MATE_BRAIN=anthropic but the client could not be created: ${reason}`);
  opts.log.warn(`brain: falling back to scripted (${reason})`);
  return { brain: new ScriptedBrain(demoScript()), live: false, fallbackReason: reason };
}
