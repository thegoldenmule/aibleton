import { describe, expect, test } from "bun:test";
import { createSplicePort } from "../src/ports/splice/index.ts";
import { FixtureSpliceAdapter } from "../src/ports/splice/stub.ts";
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

  test("download returns a stub url", async () => {
    const splice = new FixtureSpliceAdapter();
    const r = await splice.downloadAsset("b56bbbbd-fa1a-4f0d-9dd2-f53be56bffc9");
    expect(r.fileName).toBe("SC_RS_110_drum_loop_slim_boy.wav");
    expect(r.url.startsWith("https://stub.splice.local/")).toBe(true);
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
});
