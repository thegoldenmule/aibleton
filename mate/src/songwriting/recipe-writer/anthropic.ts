import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall } from "../../core/anthropic.ts";
import type { Logger } from "../../log.ts";
import { normalizeRecipe } from "./normalize.ts";
import { RECIPE_SYSTEM_PROMPT, renderRecipePrompt } from "./prompt.ts";
import { RECIPE_JSON_SCHEMA } from "./schema.ts";
import type { RecipeDraft, RecipeRequest, RecipeWriter } from "./types.ts";

export interface AnthropicRecipeWriterOptions {
  client: Anthropic;
  model: string;
  log: Logger;
  maxTokens?: number;
}

/** One structured-output call per genre; the book saves what comes back. */
export class AnthropicRecipeWriter implements RecipeWriter {
  readonly kind = "anthropic" as const;

  constructor(private readonly opts: AnthropicRecipeWriterOptions) {}

  async write(request: RecipeRequest, signal: AbortSignal): Promise<RecipeDraft> {
    const { raw, usage } = await structuredCall({
      client: this.opts.client,
      model: this.opts.model,
      log: this.opts.log,
      system: RECIPE_SYSTEM_PROMPT,
      user: renderRecipePrompt(request),
      schema: RECIPE_JSON_SCHEMA,
      what: `write a ${request.genre} recipe`,
      signal,
      ...(this.opts.maxTokens !== undefined ? { maxTokens: this.opts.maxTokens } : {}),
    });
    const draft = normalizeRecipe(raw);
    this.opts.log.info(`recipe for ${request.genre}: core ${draft.core.join(", ")}; ${Object.keys(draft.names).length} roles`, { usage });
    return draft;
  }
}
