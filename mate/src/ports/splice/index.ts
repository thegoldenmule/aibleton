import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PortMode } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { FileOAuthProvider, callbackUrlFor } from "../mcp/oauth.ts";
import { McpSpliceAdapter } from "./mcp.ts";
import { FixtureSpliceAdapter } from "./stub.ts";
import type { SplicePortResult } from "./types.ts";

export type { SplicePort, SplicePortResult, Sound, Stack, StackLayer, DownloadResult, SearchOptions } from "./types.ts";
export { FixtureSpliceAdapter } from "./stub.ts";
export { McpSpliceAdapter } from "./mcp.ts";

export interface CreateSplicePortOptions {
  url: string;
  /** Plain bearer override (`SPLICE_MCP_TOKEN`). When set, the OAuth file is not consulted. */
  token?: string;
  /** OAuth login as written by `bun run splice:login`; without it (and without `token`) the server is not tried. */
  oauth?: { file: string; callbackPort: number };
  log: Logger;
  connectTimeoutMs?: number;
}

export const NOT_LOGGED_IN = "not logged in to Splice: run `bun run --cwd mate splice:login`";

/**
 * `stub`: fixtures. `mcp`: real server or throw. `auto`: try the real server (connect + listTools,
 * no credit-spending calls) and fall back to fixtures with a reason on any failure.
 *
 * Without a bearer token, the saved OAuth tokens are used and refreshed by the SDK. No saved
 * tokens, or a 401 the refresh could not fix, yields the "not logged in" reason instead of
 * starting a browser flow (which only the login command can finish).
 */
export async function createSplicePort(mode: PortMode, opts: CreateSplicePortOptions): Promise<SplicePortResult> {
  if (mode === "stub") return { port: new FixtureSpliceAdapter(), live: false };

  const fail = async (reason: string, adapter?: McpSpliceAdapter): Promise<SplicePortResult> => {
    await adapter?.close();
    if (mode === "mcp") throw new Error(`Splice MCP unavailable (MATE_SPLICE=mcp): ${reason}`);
    opts.log.warn(`splice mcp unavailable, falling back to fixtures: ${reason}`);
    return { port: new FixtureSpliceAdapter(), live: false, fallbackReason: reason };
  };

  let authProvider: FileOAuthProvider | undefined;
  if (!opts.token && opts.oauth) {
    authProvider = new FileOAuthProvider({ file: opts.oauth.file, redirectUrl: callbackUrlFor(opts.oauth.callbackPort) });
    if (!(await authProvider.hasTokens())) return fail(NOT_LOGGED_IN);
  }

  const adapter = new McpSpliceAdapter({ url: opts.url, token: opts.token, authProvider, log: opts.log });
  try {
    await adapter.connect(opts.connectTimeoutMs ?? 10_000);
    const tools = await adapter.connection.listTools();
    opts.log.info(`splice mcp ready with ${tools.length} tool(s)`);
    return { port: adapter, live: true };
  } catch (err) {
    const reason = isUnauthorized(err) ? NOT_LOGGED_IN : err instanceof Error ? err.message : String(err);
    return fail(reason, adapter);
  }
}

/** The SDK raises `UnauthorizedError` when a login is needed and a 401 `StreamableHTTPError` when one just failed. */
function isUnauthorized(err: unknown): boolean {
  return err instanceof UnauthorizedError || (err instanceof StreamableHTTPError && err.code === 401);
}

