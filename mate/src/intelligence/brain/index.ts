import type Anthropic from "@anthropic-ai/sdk";
import type { Song } from "@aibleton/protocol";
import type { BrainMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { AbletonPort } from "../../ports/ableton/types.ts";
import type { SplicePort } from "../../ports/splice/types.ts";
import type { LibraryToolDeps } from "../tools/library.tools.ts";
import { AnthropicBrain } from "./anthropic.ts";
import { ScriptedBrain } from "./scripted.ts";
import type { Brain, BrainInput, Decision } from "./types.ts";

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
  /**
   * The saved bands, templates and genres. Optional for the same reason `getSong` is: a brain
   * built without them — a test, the scripted path — simply offers no library tools.
   */
  library?: LibraryToolDeps;
}

export interface BrainResult {
  brain: Brain;
  live: boolean;
  fallbackReason?: string;
}

/**
 * Demo brain used when no LLM is available. It does the one thing the drummer
 * always means when they type with nothing laid out — compose — so the all-stub
 * stack still gets you a song end to end; everything else it just watches.
 */
export function demoScript(): (input: BrainInput) => Decision {
  return (input) => {
    if (input.trigger !== "userRequest" || !input.userText) {
      return { message: "Running without an LLM, so I'm just watching the session. Set MATE_BRAIN=anthropic with credentials to let me play along.", actions: [] };
    }
    if (!input.song) {
      return {
        message: `Laying out “${input.userText}”. I'm running without an LLM, so the brief is the scripted one — set MATE_BRAIN=anthropic to have the model write it.`,
        actions: [{ type: "composeSong", text: input.userText }],
      };
    }
    return {
      message: `“${input.song.name}” is up: ${input.song.counts.tracks} tracks, ${input.song.counts.downloaded}/${input.song.counts.slots} sounds downloaded. Without an LLM I can't act on that — set MATE_BRAIN=anthropic and ask again.`,
      actions: [],
    };
  };
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
        ...(opts.library ? { library: opts.library } : {}),
      }),
      live: true,
    };
  }
  const reason = opts.clientError ?? "no Anthropic client";
  if (mode === "anthropic") throw new Error(`MATE_BRAIN=anthropic but the client could not be created: ${reason}`);
  opts.log.warn(`brain: falling back to scripted (${reason})`);
  return { brain: new ScriptedBrain(demoScript()), live: false, fallbackReason: reason };
}
