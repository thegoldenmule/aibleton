import { mkdir } from "node:fs/promises";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Logger } from "../../log.ts";
import { McpConnection } from "../mcp/client.ts";
import { localPathFor } from "./files.ts";
import { parseDownload, parseSearchResults, parseStack } from "./markdown.ts";
import type { DownloadResult, SearchOptions, Sound, SplicePort, Stack } from "./types.ts";

export interface McpSpliceOptions {
  url: string;
  /** Plain bearer override (`SPLICE_MCP_TOKEN`); wins over `authProvider`. */
  token?: string;
  /** OAuth provider holding the login made by `bun run splice:login`. */
  authProvider?: OAuthClientProvider;
  log: Logger;
  /** Fetches the presigned download URL; injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Splice port over the remote Splice MCP server (streamable HTTP).
 * Auth is OAuth through `authProvider` (tokens saved by the login command, refreshed by the SDK on
 * 401) or a plain bearer token when one is configured.
 */
export class McpSpliceAdapter implements SplicePort {
  readonly kind = "mcp" as const;
  readonly connection: McpConnection;

  constructor(private readonly opts: McpSpliceOptions) {
    this.connection = new McpConnection(
      { kind: "http", url: opts.url, bearerToken: opts.token, authProvider: opts.authProvider },
      opts.log,
      "aibleton-mate-splice",
    );
  }

  async connect(timeoutMs?: number): Promise<void> {
    await this.connection.connect(timeoutMs);
  }

  async searchSounds(query: string, opts: SearchOptions = {}): Promise<Sound[]> {
    const args: Record<string, unknown> = { query };
    if (opts.bpmMin !== undefined) args.bpm_min = Math.round(opts.bpmMin);
    if (opts.bpmMax !== undefined) args.bpm_max = Math.round(opts.bpmMax);
    if (opts.type) args.type = opts.type;
    const text = await this.connection.callTool("describe_a_sound", args);
    return parseSearchResults(text);
  }

  async promptToStack(prompt: string, bpm: number): Promise<Stack> {
    const target = Math.round(bpm);
    const text = await this.connection.callTool("prompt_to_stack", {
      prompt: /\bbpm\b/i.test(prompt) ? prompt : `${prompt} at ${target} bpm`,
      bpm_min: Math.max(40, target - 10),
      bpm_max: Math.min(300, target + 10),
    });
    return parseStack(text, { name: prompt.slice(0, 64), bpm: target });
  }

  async createStack(seedUuid: string, bpm?: number): Promise<Stack> {
    const args: Record<string, unknown> = { asset_uuid: seedUuid };
    if (bpm !== undefined) args.bpm = Math.round(bpm);
    const text = await this.connection.callTool("create_stack", args);
    return parseStack(text, { name: `Stack from ${seedUuid.slice(0, 8)}`, bpm: bpm ?? 0 });
  }

  /** Spends one Splice credit the first time an asset is downloaded, then writes the file under `dir`. */
  async downloadAsset(uuid: string, dir: string): Promise<DownloadResult> {
    this.opts.log.warn(`downloading Splice asset ${uuid} (may spend a credit)`);
    const text = await this.connection.callTool("download_asset", { asset_uuid: uuid });
    const { fileName, url } = parseDownload(text, uuid);
    if (!url) throw new Error(`download_asset returned no URL for ${uuid}: ${text.slice(0, 200)}`);
    const localPath = localPathFor(dir, uuid, fileName);
    await mkdir(dir, { recursive: true });
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`fetching asset ${uuid} failed: HTTP ${res.status}`);
    await Bun.write(localPath, res);
    return { uuid, fileName, url, localPath };
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
