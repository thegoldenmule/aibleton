import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("splice oauth defaults", () => {
    const c = loadConfig({});
    expect(c.spliceOauthFile).toBe(".mate/splice-oauth.json");
    expect(c.spliceOauthCallbackPort).toBe(4546);
    expect(c.spliceMcpToken).toBeUndefined();
  });

  test("splice oauth env overrides", () => {
    const c = loadConfig({ SPLICE_OAUTH_FILE: "/tmp/x.json", SPLICE_OAUTH_CALLBACK_PORT: "5000", SPLICE_MCP_TOKEN: "t" });
    expect(c.spliceOauthFile).toBe("/tmp/x.json");
    expect(c.spliceOauthCallbackPort).toBe(5000);
    expect(c.spliceMcpToken).toBe("t");
  });

  test("rejects a non-numeric callback port", () => {
    expect(() => loadConfig({ SPLICE_OAUTH_CALLBACK_PORT: "nope" })).toThrow();
  });
});
