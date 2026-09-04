import Anthropic from "@anthropic-ai/sdk";

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
