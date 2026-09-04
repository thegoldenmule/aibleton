import type { PortMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { McpSpliceAdapter } from "./mcp.ts";
import { FixtureSpliceAdapter } from "./stub.ts";
import type { SplicePortResult } from "./types.ts";

export type { SplicePort, SplicePortResult, Sound, Stack, StackLayer, DownloadResult, SearchOptions } from "./types.ts";
export { FixtureSpliceAdapter } from "./stub.ts";
export { McpSpliceAdapter } from "./mcp.ts";

export interface CreateSplicePortOptions {
  url: string;
  token?: string;
  log: Logger;
  connectTimeoutMs?: number;
}

/**
 * `stub`: fixtures. `mcp`: real server or throw. `auto`: try the real server (connect + listTools,
 * no credit-spending calls) and fall back to fixtures with a reason on any failure.
 */
export async function createSplicePort(mode: PortMode, opts: CreateSplicePortOptions): Promise<SplicePortResult> {
  if (mode === "stub") return { port: new FixtureSpliceAdapter(), live: false };

  const adapter = new McpSpliceAdapter({ url: opts.url, token: opts.token, log: opts.log });
  try {
    await adapter.connect(opts.connectTimeoutMs ?? 10_000);
    const tools = await adapter.connection.listTools();
    opts.log.info(`splice mcp ready with ${tools.length} tool(s)`);
    return { port: adapter, live: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await adapter.close();
    if (mode === "mcp") throw new Error(`Splice MCP unavailable (MATE_SPLICE=mcp): ${reason}`);
    opts.log.warn(`splice mcp unavailable, falling back to fixtures: ${reason}`);
    return { port: new FixtureSpliceAdapter(), live: false, fallbackReason: reason };
  }
}
