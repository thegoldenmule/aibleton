import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "../../log.ts";

export type McpTransportSpec =
  | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | {
      kind: "http";
      url: string;
      /** Plain bearer override; wins over `authProvider` when both are set. */
      bearerToken?: string;
      /** OAuth provider handed to the SDK transport; it refreshes tokens and raises `UnauthorizedError` when a login is needed. */
      authProvider?: OAuthClientProvider;
    };

export interface McpToolInfo {
  name: string;
  description?: string;
}

/**
 * Thin wrapper over the MCP SDK client. Ports call `callTool` and get the concatenated
 * text content back; parsing (JSON for Ableton, markdown for Splice) is the port's job.
 */
export class McpConnection {
  private client: Client | null = null;
  private transport: Transport | null = null;

  constructor(
    private readonly spec: McpTransportSpec,
    private readonly log: Logger,
    private readonly clientName = "aibleton-mate",
  ) {}

  async connect(timeoutMs = 15_000): Promise<void> {
    if (this.client) return;
    const transport = createTransport(this.spec);
    // Kept even when connect fails: an OAuth login needs `finishAuth` on the transport that
    // received the 401 (it remembers the resource metadata URL and scope from the challenge).
    this.transport = transport;
    const client = new Client({ name: this.clientName, version: "0.0.1" });
    await withTimeout(client.connect(transport), timeoutMs, `MCP connect (${describe(this.spec)})`);
    this.client = client;
    this.log.info(`connected to ${describe(this.spec)}`);
  }

  /**
   * Exchanges an OAuth authorization code for tokens after a `connect` failed with
   * `UnauthorizedError`. The SDK transport cannot be restarted afterwards, so call `connect`
   * again: it builds a fresh transport that picks up the saved tokens from the provider.
   */
  async finishAuth(code: string): Promise<void> {
    const transport = this.transport;
    if (!(transport instanceof StreamableHTTPClientTransport)) {
      throw new Error(`finishAuth needs an http transport with an auth provider (${describe(this.spec)})`);
    }
    await transport.finishAuth(code);
    this.transport = null;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.require().listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description }));
  }

  /** Calls a tool and returns its text content joined with newlines. Throws on `isError`. */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<string> {
    const res = await this.require().callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    if (res.isError) throw new Error(`MCP tool ${name} failed: ${text || "(no detail)"}`);
    return text;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) {
      try {
        await client.close();
      } catch (err) {
        this.log.warn("error closing MCP client", err);
      }
    }
  }

  private require(): Client {
    if (!this.client) throw new Error(`MCP not connected (${describe(this.spec)})`);
    return this.client;
  }
}

function createTransport(spec: McpTransportSpec): Transport {
  if (spec.kind === "stdio") {
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
      stderr: "ignore",
    });
  }
  if (spec.bearerToken) {
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: { Authorization: `Bearer ${spec.bearerToken}` } },
    });
  }
  return new StreamableHTTPClientTransport(new URL(spec.url), spec.authProvider ? { authProvider: spec.authProvider } : undefined);
}

function describe(spec: McpTransportSpec): string {
  return spec.kind === "stdio" ? `${spec.command} ${(spec.args ?? []).join(" ")}`.trim() : spec.url;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
