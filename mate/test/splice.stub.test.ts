import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import fixtures from "../src/ports/splice/fixtures/sounds.json";
import { NOT_LOGGED_IN, createSplicePort } from "../src/ports/splice/index.ts";
import { parseSearchResults } from "../src/ports/splice/markdown.ts";
import { FixtureSpliceAdapter } from "../src/ports/splice/stub.ts";
import { FileOAuthProvider } from "../src/ports/mcp/oauth.ts";
import { silentLogger } from "../src/log.ts";

describe("FixtureSpliceAdapter", () => {
  test("search filters by bpm and ranks by query words", async () => {
    const splice = new FixtureSpliceAdapter();
    const sounds = await splice.searchSounds("funk drums", { bpmMin: 100, bpmMax: 112 });
    expect(sounds.length).toBeGreaterThanOrEqual(3);
    for (const s of sounds) expect(s.bpm).toBeGreaterThanOrEqual(100);
    for (const s of sounds) expect(s.bpm).toBeLessThanOrEqual(112);
    expect(sounds[0]?.tags).toContain("funk");
    expect(splice.calls[0]?.method).toBe("searchSounds");
  });

  test("the catalog carries the captured keyed bass loops verbatim", async () => {
    const keyed = parseSearchResults(await Bun.file(new URL("../src/ports/splice/fixtures/search_response_keys.md", import.meta.url)).text());
    expect(keyed.length).toBe(10);
    expect(fixtures).toEqual(expect.arrayContaining(keyed));
    expect(new Set(fixtures.map((s) => s.uuid)).size).toBe(fixtures.length);
  });

  test("search finds pitched material by instrument word", async () => {
    const splice = new FixtureSpliceAdapter();
    const sounds = await splice.searchSounds("bass loop, indie rock", { bpmMin: 105, bpmMax: 125 });
    expect(sounds.length).toBeGreaterThanOrEqual(3);
    expect(sounds[0]?.key).not.toBeNull();
    expect(sounds[0]?.tags.some((t) => t.includes("bass"))).toBe(true);
  });

  test("search always returns something", async () => {
    const splice = new FixtureSpliceAdapter();
    expect((await splice.searchSounds("zzzz qqqq")).length).toBeGreaterThan(0);
    expect((await splice.searchSounds("anything", { bpmMin: 200, bpmMax: 210 })).length).toBeGreaterThan(0);
  });

  test("stacks are deterministic and honour bpm", async () => {
    const splice = new FixtureSpliceAdapter();
    const a = await splice.promptToStack("rock groove for practice", 118);
    const b = await splice.promptToStack("rock groove for practice", 118);
    expect(a).toEqual(b);
    expect(a.bpm).toBe(118);
    expect(a.layers.length).toBeGreaterThanOrEqual(3);
    expect(a.uuid).toMatch(/^[0-9a-f-]{36}$/);
    const seeded = await splice.createStack("d7975d7f-66d6-4b8c-914a-8e94557050cc");
    expect(seeded.layers[0]?.sound.uuid).toBe("d7975d7f-66d6-4b8c-914a-8e94557050cc");
    expect(seeded.bpm).toBe(90);
  });

  describe("downloadAsset", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "mate-splice-stub-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("writes a placeholder wav under the dir", async () => {
      const splice = new FixtureSpliceAdapter();
      const r = await splice.downloadAsset("b56bbbbd-fa1a-4f0d-9dd2-f53be56bffc9", dir);
      expect(r.fileName).toBe("SC_RS_110_drum_loop_slim_boy.wav");
      expect(r.url.startsWith("https://stub.splice.local/")).toBe(true);
      expect(isAbsolute(r.localPath)).toBe(true);
      expect(r.localPath).toBe(join(dir, "SC_RS_110_drum_loop_slim_boy.wav"));
      const bytes = await readFile(r.localPath);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(splice.calls.at(-1)).toEqual({ method: "downloadAsset", args: ["b56bbbbd-fa1a-4f0d-9dd2-f53be56bffc9", dir] });
    });

    test("file names never escape the dir", async () => {
      const traversal = "11111111-2222-3333-4444-555555555555";
      const noExtension = "22222222-2222-3333-4444-555555555555";
      const splice = new FixtureSpliceAdapter([
        { uuid: traversal, fileName: "../../escape.wav", bpm: 100, key: null, durationSec: 4, type: "loop", pack: "", tags: [], url: "" },
        { uuid: noExtension, fileName: "weird|name", bpm: 100, key: null, durationSec: 4, type: "loop", pack: "", tags: [], url: "" },
      ]);
      const a = await splice.downloadAsset(traversal, dir);
      expect(a.localPath).toBe(join(dir, "escape.wav"));
      const b = await splice.downloadAsset(noExtension, dir);
      expect(b.localPath).toBe(join(dir, `${noExtension}.wav`));
      expect((await readFile(b.localPath)).length).toBeGreaterThan(44);
    });
  });
});

describe("createSplicePort", () => {
  test("stub mode returns fixtures", async () => {
    const r = await createSplicePort("stub", { url: "http://127.0.0.1:1/mcp", log: silentLogger });
    expect(r.live).toBe(false);
    expect(r.port.kind).toBe("stub");
  });

  test("auto mode falls back when the server is unreachable", async () => {
    const r = await createSplicePort("auto", { url: "http://127.0.0.1:1/mcp", log: silentLogger, connectTimeoutMs: 2000 });
    expect(r.live).toBe(false);
    expect(r.port.kind).toBe("stub");
    expect(r.fallbackReason).toBeTruthy();
  });

  test("mcp mode throws when the server is unreachable", async () => {
    await expect(
      createSplicePort("mcp", { url: "http://127.0.0.1:1/mcp", log: silentLogger, connectTimeoutMs: 2000 }),
    ).rejects.toThrow(/Splice MCP unavailable/);
  });

  describe("with an OAuth file", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "mate-splice-oauth-port-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test("auto mode without a login says how to log in and never touches the server", async () => {
      const r = await createSplicePort("auto", {
        url: "http://127.0.0.1:1/mcp",
        oauth: { file: join(dir, "splice-oauth.json"), callbackPort: 4546 },
        log: silentLogger,
        connectTimeoutMs: 2000,
      });
      expect(r.live).toBe(false);
      expect(r.port.kind).toBe("stub");
      expect(r.fallbackReason).toBe(NOT_LOGGED_IN);
      expect(r.fallbackReason).toContain("bun run --cwd mate splice:login");
    });

    test("mcp mode without a login throws with the login command", async () => {
      await expect(
        createSplicePort("mcp", {
          url: "http://127.0.0.1:1/mcp",
          oauth: { file: join(dir, "splice-oauth.json"), callbackPort: 4546 },
          log: silentLogger,
        }),
      ).rejects.toThrow(/splice:login/);
    });

    test("a bearer token skips the OAuth file and tries the server", async () => {
      const r = await createSplicePort("auto", {
        url: "http://127.0.0.1:1/mcp",
        token: "t",
        oauth: { file: join(dir, "splice-oauth.json"), callbackPort: 4546 },
        log: silentLogger,
        connectTimeoutMs: 2000,
      });
      expect(r.live).toBe(false);
      expect(r.fallbackReason).not.toBe(NOT_LOGGED_IN);
    });

    test("saved tokens are tried against the server and an unreachable one still falls back", async () => {
      const file = join(dir, "splice-oauth.json");
      await new FileOAuthProvider({ file, redirectUrl: "http://localhost:4546/callback" }).saveTokens({
        access_token: "at",
        token_type: "bearer",
      });
      const r = await createSplicePort("auto", {
        url: "http://127.0.0.1:1/mcp",
        oauth: { file, callbackPort: 4546 },
        log: silentLogger,
        connectTimeoutMs: 2000,
      });
      expect(r.live).toBe(false);
      expect(r.fallbackReason).toBeTruthy();
      expect(r.fallbackReason).not.toBe(NOT_LOGGED_IN);
    });
  });
});
