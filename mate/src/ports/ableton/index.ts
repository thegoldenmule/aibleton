import type { PortMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { McpAbletonAdapter } from "./mcp.ts";
import { InMemoryAbletonAdapter } from "./stub.ts";
import type { AbletonPortResult } from "./types.ts";

export type { AbletonPort, AbletonPortResult, CallContext } from "./types.ts";
export { InMemoryAbletonAdapter, defaultStubSession } from "./stub.ts";
export { McpAbletonAdapter } from "./mcp.ts";

export interface CreateAbletonPortOptions {
  command: string;
  args: string[];
  log: Logger;
  connectTimeoutMs?: number;
  now?: () => number;
}

/**
 * `stub`: in-memory. `mcp`: real server or throw. `auto`: try the real server (connect + one
 * snapshot) and fall back to the stub with a logged reason.
 */
export async function createAbletonPort(mode: PortMode, opts: CreateAbletonPortOptions): Promise<AbletonPortResult> {
  if (mode === "stub") {
    return { port: new InMemoryAbletonAdapter({ now: opts.now }), live: false };
  }
  const mcp = new McpAbletonAdapter(opts);
  try {
    await mcp.connect();
    await mcp.getSnapshot();
    return { port: mcp, live: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await mcp.close();
    if (mode === "mcp") throw new Error(`Ableton MCP unavailable: ${reason}`);
    opts.log.warn(`Ableton MCP unavailable, using stub: ${reason}`);
    return { port: new InMemoryAbletonAdapter({ now: opts.now }), live: false, fallbackReason: reason };
  }
}
