import type { Logger } from "../../log.ts";
import { McpConnection } from "../mcp/client.ts";
import { parseDownload, parseSearchResults, parseStack } from "./markdown.ts";
import type { DownloadResult, SearchOptions, Sound, SplicePort, Stack } from "./types.ts";

export interface McpSpliceOptions {
  url: string;
  token?: string;
  log: Logger;
}

/**
 * Splice port over the remote Splice MCP server (streamable HTTP).
 * Auth is an open question: Claude Code holds an OAuth session for mcp.splice.com, mate does not.
 * An optional bearer token is forwarded; a proper OAuth provider hook can replace it later.
 */
export class McpSpliceAdapter implements SplicePort {
  readonly kind = "mcp" as const;
  readonly connection: McpConnection;

  constructor(private readonly opts: McpSpliceOptions) {
    this.connection = new McpConnection({ kind: "http", url: opts.url, bearerToken: opts.token }, opts.log, "aibleton-mate-splice");
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

  /** Spends one Splice credit the first time an asset is downloaded. */
  async downloadAsset(uuid: string): Promise<DownloadResult> {
    this.opts.log.warn(`downloading Splice asset ${uuid} (may spend a credit)`);
    const text = await this.connection.callTool("download_asset", { asset_uuid: uuid });
    return parseDownload(text, uuid);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
