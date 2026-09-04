import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../log.ts";

/**
 * One Anthropic client for everything in mate that talks to the model. The SDK
 * resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
 * `ant auth login` profile; nothing is passed explicitly.
 * @throws when no credential source is available.
 */
export function createAnthropicClient(): Anthropic {
  const client = new Anthropic();
  if (!client.apiKey && !client.authToken) {
    throw new Error("no Anthropic credentials found (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile)");
  }
  return client;
}

/** The model declined the request outright. Routes map this to a 422. */
export class ModelRefusedError extends Error {
  constructor(
    readonly what: string,
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(`the model declined to ${what}${explanation ? `: ${explanation}` : ""}`);
    this.name = "ModelRefusedError";
  }
}

export interface StructuredCallOptions {
  client: Anthropic;
  model: string;
  log: Logger;
  /** Frozen system prompt; sits first in the request so caching can pick it up. */
  system: string;
  /** The single user turn. */
  user: string;
  /** A JSON schema in the structured-output subset (closed objects, every property required). */
  schema: Record<string, unknown>;
  /** Verb for the refusal error: "brief this song", "write a recipe". */
  what: string;
  signal: AbortSignal;
  maxTokens?: number;
}

/**
 * One structured-output call, no tools, no loop: the model answers with JSON
 * matching `schema`, which is parsed and returned untyped for the caller to
 * normalise and validate. Refusals are checked before any content is read.
 */
export async function structuredCall(opts: StructuredCallOptions): Promise<{ raw: unknown; usage: Anthropic.Beta.BetaUsage }> {
  const response = await opts.client.beta.messages.create(
    {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 8000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      output_config: { format: { type: "json_schema", schema: opts.schema } },
      // Server-side refusal fallbacks: route by refusal category without maintaining a model list.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal: opts.signal },
  );

  if (response.stop_reason === "refusal") {
    opts.log.warn(`model refused to ${opts.what}`, response.stop_details);
    const details = response.stop_details;
    throw new ModelRefusedError(opts.what, details?.category ?? null, details?.explanation ?? null);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`the answer was cut off by max_tokens while trying to ${opts.what}; raise it and retry`);
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error(`the model returned no text while trying to ${opts.what}`);

  try {
    return { raw: JSON.parse(text), usage: response.usage };
  } catch (err) {
    throw new Error(`the answer was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
