import type Anthropic from "@anthropic-ai/sdk";
import { SongBriefSchema } from "@aibleton/protocol";
import type { SongBrief } from "@aibleton/protocol";
import { structuredCall } from "../../core/anthropic.ts";
import type { Logger } from "../../log.ts";
import { normalizeBrief } from "./normalize.ts";
import { BRIEF_SYSTEM_PROMPT, renderBriefPrompt } from "./prompt.ts";
import { SONG_BRIEF_JSON_SCHEMA } from "./schema.ts";
import type { BriefInput, Briefer } from "./types.ts";

export interface AnthropicBrieferOptions {
  client: Anthropic;
  model: string;
  log: Logger;
  maxTokens?: number;
}

/**
 * One structured-output call per brief. The model answers with JSON matching
 * SONG_BRIEF_JSON_SCHEMA, which is normalised and then validated against the
 * protocol schema.
 */
export class AnthropicBriefer implements Briefer {
  readonly kind = "anthropic" as const;

  constructor(private readonly opts: AnthropicBrieferOptions) {}

  async brief(input: BriefInput, signal: AbortSignal): Promise<SongBrief> {
    const { log } = this.opts;
    const { raw, usage } = await structuredCall({
      client: this.opts.client,
      model: this.opts.model,
      log,
      system: BRIEF_SYSTEM_PROMPT,
      user: renderBriefPrompt(input),
      schema: SONG_BRIEF_JSON_SCHEMA,
      what: "brief this song",
      signal,
      ...(this.opts.maxTokens !== undefined ? { maxTokens: this.opts.maxTokens } : {}),
    });

    const parsed = SongBriefSchema.safeParse(normalizeBrief(raw, input.template, input.band));
    if (!parsed.success) {
      log.warn("brief failed validation", parsed.error.issues);
      const first = parsed.error.issues[0];
      throw new Error(`the brief did not match the schema${first ? `: ${first.path.join(".")} ${first.message}` : ""}`);
    }
    log.info(`brief: ${parsed.data.summary}`, { usage });
    return parsed.data;
  }
}
