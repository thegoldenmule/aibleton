import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";

/**
 * On-disk shape. Kept in one JSON file so a login is a single file to copy or delete.
 * `client` is the dynamic registration the auth server issued us, `tokens` the current
 * access/refresh pair, `pending` the PKCE verifier and state of an authorization in flight.
 */
const ClientSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().optional() }).passthrough();
const TokensSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    id_token: z.string().optional(),
    expires_in: z.coerce.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
  })
  .passthrough();
const PendingSchema = z.object({ codeVerifier: z.string().min(1), state: z.string().optional() });
const FileSchema = z.object({
  version: z.literal(1),
  client: ClientSchema.optional(),
  tokens: TokensSchema.optional(),
  pending: PendingSchema.optional(),
});
type OAuthFile = z.infer<typeof FileSchema>;

export interface FileOAuthProviderOptions {
  /** Path of the JSON file holding registration, tokens and the pending verifier. */
  file: string;
  /** Where the authorization server sends the browser back; must be served by the login command. */
  redirectUrl: string;
  clientName?: string;
}

/**
 * File-backed `OAuthClientProvider` for the MCP SDK's streamable HTTP transport.
 *
 * - The file is read lazily once and written through on every save (the SDK calls `tokens()` on
 *   every request, so the in-memory copy is the source of truth after the first read).
 * - A missing or corrupt file behaves like "never logged in": nothing is thrown, the next save
 *   replaces it.
 * - `redirectToAuthorization` never blocks or opens anything; it records the URL on
 *   `lastAuthorizationUrl` for the caller (the login command) to print and open.
 * - Token refresh is the SDK's job: on a 401 it exchanges the saved refresh token and calls
 *   `saveTokens`, which lands back in the file.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  lastAuthorizationUrl: URL | null = null;
  private data: OAuthFile | null = null;
  /** State issued for the authorization in flight; written to the file together with the verifier. */
  private issuedState: string | undefined;

  constructor(private readonly opts: FileOAuthProviderOptions) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? "aibleton mate",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** Random per-authorization state; the SDK asks for it just before `saveCodeVerifier`. */
  state(): string {
    this.issuedState = crypto.randomUUID();
    return this.issuedState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const client = (await this.load()).client;
    if (!client) return undefined;
    // A registration made for another callback port cannot be reused: the auth server would
    // reject the redirect_uri. Pretend it is gone so the SDK registers again.
    const uris = (client as { redirect_uris?: unknown }).redirect_uris;
    if (Array.isArray(uris) && !uris.includes(this.opts.redirectUrl)) return undefined;
    return client as OAuthClientInformationMixed;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const data = await this.load();
    data.client = info as OAuthFile["client"];
    await this.save(data);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const data = await this.load();
    data.tokens = tokens as OAuthFile["tokens"];
    delete data.pending;
    await this.save(data);
  }

  /** True when a login has been completed at some point (the tokens may still be expired). */
  async hasTokens(): Promise<boolean> {
    return (await this.tokens()) !== undefined;
  }

  redirectToAuthorization(url: URL): void {
    this.lastAuthorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const data = await this.load();
    data.pending = { codeVerifier, ...(this.issuedState ? { state: this.issuedState } : {}) };
    await this.save(data);
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).pending?.codeVerifier;
    if (!verifier) throw new Error(`no pending Splice authorization in ${this.opts.file}; start the login again`);
    return verifier;
  }

  /** The state the current authorization was started with, if any. */
  async pendingState(): Promise<string | undefined> {
    return (await this.load()).pending?.state;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const data = await this.load();
    if (scope === "all" || scope === "client") delete data.client;
    if (scope === "all" || scope === "tokens") delete data.tokens;
    if (scope === "all" || scope === "verifier") delete data.pending;
    await this.save(data);
  }

  private async load(): Promise<OAuthFile> {
    if (this.data) return this.data;
    this.data = await readOAuthFile(this.opts.file);
    return this.data;
  }

  private async save(data: OAuthFile): Promise<void> {
    this.data = data;
    await writePrivateFile(this.opts.file, JSON.stringify(data, null, 2) + "\n");
  }
}

/** Reads and validates the file; a missing or malformed file yields an empty record. */
export async function readOAuthFile(path: string): Promise<OAuthFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { version: 1 };
  }
  try {
    const parsed = FileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

/** Writes via a temp file in the same directory and renames it into place, owner read/write only. */
async function writePrivateFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export function callbackUrlFor(port: number): string {
  return `http://localhost:${port}/callback`;
}

export type CallbackParse = { ok: true; code: string } | { ok: false; error: string };

/**
 * Interprets the redirect the authorization server sent the browser to. Pure so it can be tested
 * without a browser: checks the path, an `error` from the server, the presence of `code`, and
 * that `state` matches the one the authorization was started with (when one was).
 */
export function parseCallback(url: URL, expectedState: string | undefined): CallbackParse {
  if (url.pathname !== "/callback") return { ok: false, error: `unexpected path ${url.pathname}` };
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    return { ok: false, error: description ? `${error}: ${description}` : error };
  }
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, error: "callback carried no authorization code" };
  if (expectedState !== undefined && url.searchParams.get("state") !== expectedState) {
    return { ok: false, error: "callback state did not match the pending authorization" };
  }
  return { ok: true, code };
}
