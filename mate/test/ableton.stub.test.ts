import { describe, expect, test } from "bun:test";
import { InMemoryAbletonAdapter } from "../src/ports/ableton/stub.ts";
import { parseToolJson } from "../src/ports/ableton/snapshot.schema.ts";
import { createAbletonPort } from "../src/ports/ableton/index.ts";
import { silentLogger } from "../src/log.ts";

describe("InMemoryAbletonAdapter", () => {
  test("starts like the live set", async () => {
    const a = new InMemoryAbletonAdapter({ now: () => 1 });
    const s = await a.getSnapshot();
    expect(s.tracks).toHaveLength(4);
    expect(s.transport.tempo).toBe(120);
    expect(s.tracks[0]!.clipSlots).toHaveLength(8);
  });

  test("mutations are reflected in the snapshot and recorded", async () => {
    let t = 10;
    const a = new InMemoryAbletonAdapter({ now: () => t++ });
    await a.setTempo(96, { userPrompt: "slower please" });
    await a.createClip(0, 2, 8);
    await a.addNotes(0, 2, [{ pitch: 38, startTime: 1, duration: 0.5, velocity: 90, mute: false }]);
    await a.fireClip(0, 2);
    const idx = await a.createMidiTrack();
    const s = await a.getSnapshot();
    expect(s.transport.tempo).toBe(96);
    expect(s.transport.isPlaying).toBe(true);
    expect(s.tracks[0]!.clipSlots[2]!.clip?.length).toBe(8);
    expect(s.tracks[0]!.clipSlots[2]!.clip?.notes).toHaveLength(1);
    expect(s.tracks[0]!.clipSlots[2]!.clip?.isPlaying).toBe(true);
    expect(idx).toBe(4);
    expect(s.tracks).toHaveLength(5);
    expect(s.tracks[4]!.kind).toBe("midi");
    expect(s.capturedAt).toBeGreaterThan(10);
    expect(a.calls[0]).toEqual({ method: "setTempo", args: [96], ctx: { userPrompt: "slower please" } });
    await a.stopPlayback();
    expect((await a.getSnapshot()).transport.isPlaying).toBe(false);
  });

  test("rejects invalid targets", async () => {
    const a = new InMemoryAbletonAdapter();
    await expect(a.createClip(9, 0, 4)).rejects.toThrow(/no track/);
    await expect(a.createClip(0, 99, 4)).rejects.toThrow(/no clip slot/);
    await expect(a.createClip(2, 0, 4)).rejects.toThrow(/not a MIDI/);
    await expect(a.addNotes(0, 0, [])).rejects.toThrow(/has no clip/);
  });

  test("createAbletonPort('stub') returns the stub", async () => {
    const r = await createAbletonPort("stub", { command: "uvx", args: [], log: silentLogger });
    expect(r.port.kind).toBe("stub");
    expect(r.live).toBe(false);
  });

  test("createAbletonPort('auto') falls back when the server is missing", async () => {
    const r = await createAbletonPort("auto", {
      command: "definitely-not-a-real-command-xyz",
      args: [],
      log: silentLogger,
      connectTimeoutMs: 2000,
    });
    expect(r.port.kind).toBe("stub");
    expect(r.live).toBe(false);
    expect(r.fallbackReason).toBeTruthy();
  });
});

describe("parseToolJson", () => {
  test("unwraps the result envelope", () => {
    expect(parseToolJson(JSON.stringify({ result: JSON.stringify({ tempo: 120 }) }))).toEqual({ tempo: 120 });
  });

  test("tolerates a trailing consent banner after the inner JSON", () => {
    const inner = JSON.stringify({ schema: "ableton_mcp_snapshot_v2", tracks: [{ name: "a}b" }] });
    const banner = "\n\n---\n[Ask the user this now, before continuing.]\n\n**Keep contributing?**\n---";
    const text = JSON.stringify({ result: inner + banner });
    expect(parseToolJson(text)).toEqual({ schema: "ableton_mcp_snapshot_v2", tracks: [{ name: "a}b" }] });
  });

  test("accepts bare JSON and non-string results", () => {
    expect(parseToolJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolJson(JSON.stringify({ result: { b: 2 } }))).toEqual({ b: 2 });
  });

  test("throws on non-JSON", () => {
    expect(() => parseToolJson(JSON.stringify({ result: "Tempo set to 120" }))).toThrow(/not JSON/);
  });
});
