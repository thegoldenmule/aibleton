import { describe, expect, test } from "bun:test";
import { InMemoryAbletonAdapter } from "../src/ports/ableton/stub.ts";
import { assertNotError } from "../src/ports/ableton/mcp.ts";
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

describe("InMemoryAbletonAdapter audio and arrangement", () => {
  test("creates a named audio track, imports a clip, copies it to the arrangement and cuts overlaps", async () => {
    const a = new InMemoryAbletonAdapter({ now: () => 1, clipBeats: (p) => (p.endsWith("long.wav") ? 32 : 16) });
    const idx = await a.createAudioTrack("Bass [mate]");
    expect(idx).toBe(4);
    let s = await a.getSnapshot();
    expect(s.tracks[4]).toMatchObject({ index: 4, name: "Bass [mate]", kind: "audio" });

    const { lengthBeats } = await a.createAudioClip(4, 0, "/x/a.wav");
    expect(lengthBeats).toBe(16);
    await a.setClipName(4, 0, "a · thing");
    await a.createAudioClip(4, 1, "/x/long.wav");
    s = await a.getSnapshot();
    expect(s.tracks[4]!.clipSlots[0]!.clip).toMatchObject({ name: "a · thing", length: 16, filePath: "/x/a.wav", isAudio: true });

    await a.duplicateToArrangement(4, 0, 0);
    await a.duplicateToArrangement(4, 0, 16);
    await a.duplicateToArrangement(4, 1, 8); // lands across both copies: first is cut short, second loses its head
    s = await a.getSnapshot();
    expect(s.tracks[4]!.arrangementClips.map((c) => [c.name, c.startTime, c.endTime])).toEqual([
      ["a · thing", 0, 8],
      ["long", 8, 40],
    ]);
    expect(s.tracks[4]!.arrangementClips[1]!.filePath).toBe("/x/long.wav");

    await a.createLocator("a1", 0);
    await a.createLocator("intro", 0);
    await a.createLocator("b1", 32);
    expect((await a.getSnapshot()).locators).toEqual([
      { name: "intro", time: 0 },
      { name: "b1", time: 32 },
    ]);

    await a.deleteClip(4, 0);
    expect((await a.getSnapshot()).tracks[4]!.clipSlots[0]!.clip).toBeNull();
  });

  test("refuses audio clips on MIDI tracks, relative paths and occupied slots", async () => {
    const a = new InMemoryAbletonAdapter();
    await expect(a.createAudioClip(0, 0, "/x/a.wav")).rejects.toThrow(/not an audio/);
    await expect(a.createAudioClip(2, 0, "a.wav")).rejects.toThrow(/absolute/);
    await a.createAudioClip(2, 0, "/x/a.wav");
    await expect(a.createAudioClip(2, 0, "/x/b.wav")).rejects.toThrow(/already has/);
  });
});

describe("assertNotError", () => {
  test("throws on the server's prose errors, wrapped or bare, and passes everything else through", () => {
    expect(() => assertNotError(JSON.stringify({ result: "Error creating audio clip: Track 1 is not an audio track" }), "create_audio_clip")).toThrow(
      /create_audio_clip: Error creating audio clip: Track 1/,
    );
    expect(() => assertNotError("Error getting session info: not connected", "get_session_info")).toThrow(/not connected/);
    expect(assertNotError(JSON.stringify({ result: "Created audio clip 'x' at track 4, slot 0 (length 16.0 beats)" }), "t")).toContain("length 16.0");
    expect(assertNotError('{"result":"{\\"tempo\\":120}"}', "t")).toBe('{"tempo":120}');
  });
});
