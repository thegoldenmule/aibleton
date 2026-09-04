import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOAuthProvider, callbackUrlFor, parseCallback, readOAuthFile } from "../src/ports/mcp/oauth.ts";

describe("FileOAuthProvider", () => {
  let dir: string;
  let file: string;
  const redirectUrl = callbackUrlFor(4546);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mate-splice-oauth-"));
    file = join(dir, "nested", "splice-oauth.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("starts empty and advertises a public authorization-code client", async () => {
    const p = new FileOAuthProvider({ file, redirectUrl });
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeUndefined();
    expect(await p.hasTokens()).toBe(false);
    expect(p.redirectUrl).toBe("http://localhost:4546/callback");
    expect(p.clientMetadata.redirect_uris).toEqual([redirectUrl]);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
    expect(p.clientMetadata.grant_types).toContain("refresh_token");
  });

  test("round-trips client info, tokens and the code verifier through the file", async () => {
    const p = new FileOAuthProvider({ file, redirectUrl });
    await p.saveClientInformation({ client_id: "abc", redirect_uris: [redirectUrl], client_id_issued_at: 1 });
    const state = p.state();
    await p.saveCodeVerifier("verifier-1");
    expect(await p.codeVerifier()).toBe("verifier-1");
    expect(await p.pendingState()).toBe(state);

    await p.saveTokens({ access_token: "at", token_type: "bearer", refresh_token: "rt", expires_in: 3600 });

    // A fresh instance sees only what hit the disk.
    const q = new FileOAuthProvider({ file, redirectUrl });
    expect(await q.clientInformation()).toEqual({ client_id: "abc", redirect_uris: [redirectUrl], client_id_issued_at: 1 });
    expect(await q.tokens()).toEqual({ access_token: "at", token_type: "bearer", refresh_token: "rt", expires_in: 3600 });
    expect(await q.hasTokens()).toBe(true);
    // Saving tokens closes the pending authorization.
    expect(await q.pendingState()).toBeUndefined();
    await expect(q.codeVerifier()).rejects.toThrow(/no pending/);

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });

  test("refreshed tokens replace the old ones on disk", async () => {
    const p = new FileOAuthProvider({ file, redirectUrl });
    await p.saveTokens({ access_token: "old", token_type: "bearer", refresh_token: "rt" });
    await p.saveTokens({ access_token: "new", token_type: "bearer", refresh_token: "rt2" });
    expect((await readOAuthFile(file)).tokens?.access_token).toBe("new");
    expect((await readOAuthFile(file)).tokens?.refresh_token).toBe("rt2");
  });

  test("a corrupt file is ignored and overwritten by the next save", async () => {
    await writeFile(join(dir, "corrupt.json"), "{not json", "utf8");
    const p = new FileOAuthProvider({ file: join(dir, "corrupt.json"), redirectUrl });
    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens({ access_token: "at", token_type: "bearer" });
    expect((await readOAuthFile(join(dir, "corrupt.json"))).tokens?.access_token).toBe("at");

    await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ version: 1, tokens: { token_type: "bearer" } }), "utf8");
    const q = new FileOAuthProvider({ file: join(dir, "wrong-shape.json"), redirectUrl });
    expect(await q.tokens()).toBeUndefined();
  });

  test("a registration made for another callback port is treated as missing", async () => {
    const other = "http://localhost:9999/callback";
    // Registered while listening on 9999; the server's echo of the URI is not what we compare.
    await new FileOAuthProvider({ file, redirectUrl: other }).saveClientInformation({ client_id: "abc", redirect_uris: ["http://localhost:9999/callback/"] });
    expect(await new FileOAuthProvider({ file, redirectUrl: other }).clientInformation()).toEqual({
      client_id: "abc",
      redirect_uris: ["http://localhost:9999/callback/"],
    });
    expect(await new FileOAuthProvider({ file, redirectUrl }).clientInformation()).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8")).clientRedirectUrl).toBe(other);
  });

  test("invalidateCredentials drops the requested scope only", async () => {
    const p = new FileOAuthProvider({ file, redirectUrl });
    await p.saveClientInformation({ client_id: "abc" });
    await p.saveTokens({ access_token: "at", token_type: "bearer" });
    await p.invalidateCredentials("tokens");
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toEqual({ client_id: "abc" });
    await p.invalidateCredentials("all");
    expect(await p.clientInformation()).toBeUndefined();
  });

  test("redirectToAuthorization records the URL without blocking", async () => {
    const p = new FileOAuthProvider({ file, redirectUrl });
    expect(p.lastAuthorizationUrl).toBeNull();
    const url = new URL("https://auth.splice.com/authorize?client_id=abc&state=s");
    p.redirectToAuthorization(url);
    expect(p.lastAuthorizationUrl).toBe(url);
  });
});

describe("parseCallback", () => {
  const base = "http://localhost:4546";

  test("accepts a code with the expected state", () => {
    expect(parseCallback(new URL(`${base}/callback?code=c1&state=s1`), "s1")).toEqual({ ok: true, code: "c1" });
  });

  test("accepts a code when no state was issued", () => {
    expect(parseCallback(new URL(`${base}/callback?code=c1`), undefined)).toEqual({ ok: true, code: "c1" });
  });

  test("rejects a state mismatch, a missing code, a server error and a wrong path", () => {
    expect(parseCallback(new URL(`${base}/callback?code=c1&state=other`), "s1")).toEqual({
      ok: false,
      error: expect.stringMatching(/state/),
    });
    expect(parseCallback(new URL(`${base}/callback?code=c1`), "s1")).toEqual({ ok: false, error: expect.stringMatching(/state/) });
    expect(parseCallback(new URL(`${base}/callback?state=s1`), "s1")).toEqual({ ok: false, error: expect.stringMatching(/no authorization code/) });
    expect(parseCallback(new URL(`${base}/callback?error=access_denied&error_description=User%20said%20no`), "s1")).toEqual({
      ok: false,
      error: "access_denied: User said no",
    });
    expect(parseCallback(new URL(`${base}/favicon.ico`), "s1")).toEqual({ ok: false, error: expect.stringMatching(/path/) });
  });
});
