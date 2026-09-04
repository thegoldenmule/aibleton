import { AgentLoop } from "./loop.ts";
import type { Intelligence, IntelligenceDeps } from "./types.ts";

export function createIntelligence(deps: IntelligenceDeps): Intelligence {
  return new AgentLoop(deps);
}

export { AgentLoop } from "./loop.ts";
export * from "./machine.ts";
export * from "./types.ts";
export * from "./brain/types.ts";
export { ScriptedBrain } from "./brain/scripted.ts";
export { AnthropicBrain } from "./brain/anthropic.ts";
export { createBrain } from "./brain/index.ts";
