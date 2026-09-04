/**
 * `bun run splice:login`: one-time OAuth login for the Splice MCP server.
 *
 * Connects with the file-backed provider; when the server answers 401 the SDK registers a client,
 * hands us the authorization URL and throws `UnauthorizedError`. We open that URL, wait for the
 * redirect on a temporary localhost server, exchange the code, reconnect to prove the tokens work
 * and list the tools (nothing that spends credits). From then on mate starts with Splice live.
 */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig } from "../config.ts";
import { createLogger } from "../log.ts";
import { McpConnection } from "../ports/mcp/client.ts";
import { FileOAuthProvider, callbackUrlFor, parseCallback } from "../ports/mcp/oauth.ts";

const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("splice-login");
  if (config.spliceMcpToken) {
    console.log("note: SPLICE_MCP_TOKEN is set; mate will use it as a bearer token instead of this login until it is unset.");
  }

  const redirectUrl = callbackUrlFor(config.spliceOauthCallbackPort);
  const provider = new FileOAuthProvider({ file: config.spliceOauthFile, redirectUrl });
  const callback = listenForCallback(config.spliceOauthCallbackPort, provider);

  try {
    const connection = new McpConnection({ kind: "http", url: config.spliceMcpUrl, authProvider: provider }, log, "aibleton-mate-splice");
    let firstTry: unknown = null;
    try {
      await connection.connect(CONNECT_TIMEOUT_MS);
    } catch (err) {
      firstTry = err;
    }

    if (firstTry !== null) {
      if (!(firstTry instanceof UnauthorizedError)) throw firstTry;
      const url = provider.lastAuthorizationUrl;
      if (!url) throw new Error("the server asked for authorization but no authorization URL was produced");

      console.log(`\nOpen this URL in your browser to authorize aibleton mate with Splice:\n\n  ${url.href}\n`);
      console.log(`Waiting for the redirect on ${redirectUrl} ...`);
      await openInBrowser(url.href);

      const code = await callback.code;
      await connection.finishAuth(code);
      await connection.connect(CONNECT_TIMEOUT_MS);
    }

    const tools = await connection.listTools();
    await connection.close();
    console.log(`logged in, ${tools.length} tools (saved to ${config.spliceOauthFile})`);
  } finally {
    callback.stop();
  }
}

interface CallbackListener {
  /** Resolves with the authorization code, rejects on a bad callback or a timeout. */
  code: Promise<string>;
  stop(): void;
}

function listenForCallback(port: number, provider: FileOAuthProvider): CallbackListener {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: "localhost",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
        const parsed = parseCallback(url, await provider.pendingState());
        if (!parsed.ok) {
          reject(new Error(`authorization failed: ${parsed.error}`));
          return html(`<h1>Login failed</h1><p>${escape(parsed.error)}</p>`, 400);
        }
        resolve(parsed.code);
        return html("<h1>Logged in to Splice</h1><p>You can close this tab and go back to the terminal.</p>");
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot listen on localhost:${port} for the OAuth redirect (${detail}); set SPLICE_OAUTH_CALLBACK_PORT to a free port`);
  }

  const timer = setTimeout(() => reject(new Error(`no authorization callback within ${CALLBACK_TIMEOUT_MS / 60_000} minutes`)), CALLBACK_TIMEOUT_MS);
  return {
    code,
    stop() {
      clearTimeout(timer);
      server.stop(true);
    },
  };
}

async function openInBrowser(url: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const proc = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // Printing the URL above is the fallback.
  }
}

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>aibleton mate</title><body style="font-family:system-ui;padding:2rem">${body}</body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`splice login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
