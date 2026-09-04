import Anthropic from "@anthropic-ai/sdk";
import type { BrainMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { AbletonPort } from "../../ports/ableton/types.ts";
import type { SplicePort } from "../../ports/splice/types.ts";
import { AnthropicBrain } from "./anthropic.ts";
import { ScriptedBrain } from "./scripted.ts";
import type { Brain, Decision } from "./types.ts";

export interface CreateBrainOptions {
  model: string;
  log: Logger;
  ableton: AbletonPort;
  splice: SplicePort;
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

  try {
    const client = new Anthropic();
    if (!client.apiKey && !client.authToken) {
      throw new Error("no Anthropic credentials found (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile)");
    }
    return { brain: new AnthropicBrain({ client, model: opts.model, log: opts.log, ableton: opts.ableton, splice: opts.splice }), live: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (mode === "anthropic") throw new Error(`MATE_BRAIN=anthropic but the client could not be created: ${reason}`);
    opts.log.warn(`brain: falling back to scripted (${reason})`);
    return { brain: new ScriptedBrain(demoScript()), live: false, fallbackReason: reason };
  }
}
