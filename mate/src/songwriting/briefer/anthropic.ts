import type Anthropic from "@anthropic-ai/sdk";
import { SongBriefSchema } from "@aibleton/protocol";
import type { SongBrief } from "@aibleton/protocol";
import type { Logger } from "../../log.ts";
import { normalizeBrief } from "./normalize.ts";
import { BRIEF_SYSTEM_PROMPT, renderBriefPrompt } from "./prompt.ts";
import { SONG_BRIEF_JSON_SCHEMA } from "./schema.ts";
import { BriefRefusedError, type BriefInput, type Briefer } from "./types.ts";

export interface AnthropicBrieferOptions {
  client: Anthropic;
  model: string;
  log: Logger;
  maxTokens?: number;
}

/**
 * One structured-output call per brief. No tools, no loop: the model answers
 * with JSON matching SONG_BRIEF_JSON_SCHEMA, which is normalised and then
 * validated against the protocol schema.
 */
export class AnthropicBriefer implements Briefer {
  readonly kind = "anthropic" as const;

  constructor(private readonly opts: AnthropicBrieferOptions) {}

  async brief(input: BriefInput, signal: AbortSignal): Promise<SongBrief> {
    const { client, model, log } = this.opts;
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: this.opts.maxTokens ?? 8000,
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: "user", content: renderBriefPrompt(input) }],
        output_config: { format: { type: "json_schema", schema: SONG_BRIEF_JSON_SCHEMA } },
        // Server-side refusal fallbacks: route by refusal category without maintaining a model list.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );

    if (response.stop_reason === "refusal") {
      log.warn("briefer refused", response.stop_details);
      const details = response.stop_details;
      throw new BriefRefusedError(details?.category ?? null, details?.explanation ?? null);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("the brief was cut off by max_tokens; raise it and retry");
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("the model returned no text for the brief");

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`the brief was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const parsed = SongBriefSchema.safeParse(normalizeBrief(raw, input.template, input.band));
    if (!parsed.success) {
      log.warn("brief failed validation", parsed.error.issues);
      const first = parsed.error.issues[0];
      throw new Error(`the brief did not match the schema${first ? `: ${first.path.join(".")} ${first.message}` : ""}`);
    }
    log.info(`brief: ${parsed.data.summary}`, { usage: response.usage });
    return parsed.data;
  }
}
