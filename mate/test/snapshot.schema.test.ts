import { describe, expect, test } from "bun:test";
import fixture from "../src/ports/ableton/fixtures/snapshot_v2.json";
import { parseSnapshotV2, toSessionState } from "../src/ports/ableton/snapshot.schema.ts";

describe("ableton snapshot v2", () => {
  test("parses the captured live snapshot", () => {
    const raw = parseSnapshotV2(fixture);
    expect(raw.schema).toBe("ableton_mcp_snapshot_v2");
    expect(raw.tracks).toHaveLength(4);
    expect(raw.return_tracks).toHaveLength(2);
  });

  test("maps to DawState", () => {
    const state = toSessionState(parseSnapshotV2(fixture), 1234);
    expect(state.capturedAt).toBe(1234);
    expect(state.transport.tempo).toBe(120);
    expect(state.transport.signatureNumerator).toBe(4);
    expect(state.transport.isPlaying).toBe(false);
    expect(state.tracks.map((t) => t.kind)).toEqual(["midi", "midi", "audio", "audio"]);
    expect(state.tracks.map((t) => t.name)).toEqual(["1-MIDI", "2-MIDI", "3-Audio", "4-Audio"]);
    for (const t of state.tracks) {
      expect(t.clipSlots).toHaveLength(8);
      expect(t.clipSlots.every((s) => s.clip === null)).toBe(true);
      expect(t.arrangementClips).toEqual([]);
    }
  });

  test("maps clips and notes when present", () => {
    const raw = structuredClone(fixture) as typeof fixture;
    raw.tracks[0]!.clip_slots[1] = {
      index: 1,
      has_clip: true,
      clip: {
        name: "Groove",
        length: 4,
        is_playing: true,
        notes: [{ pitch: 36, start_time: 0, duration: 0.25, velocity: 100, mute: false }],
      },
    } as never;
    const state = toSessionState(parseSnapshotV2(raw), 0);
    const clip = state.tracks[0]!.clipSlots[1]!.clip;
    expect(clip).toEqual({
      name: "Groove",
      length: 4,
      isPlaying: true,
      notes: [{ pitch: 36, startTime: 0, duration: 0.25, velocity: 100, mute: false }],
    });
  });
});

describe("ableton snapshot v2 audio clips and cue points", () => {
  test("keeps the sample path on session and arrangement clips, and the cue points", () => {
    const raw = structuredClone(fixture) as typeof fixture;
    raw.tracks[2]!.clip_slots[0] = {
      index: 0,
      has_clip: true,
      clip: { name: "a · loop", length: 16, is_playing: false, is_audio_clip: true, file_path: "/dl/loop.wav", warping: true, looping: true },
    } as never;
    (raw.tracks[2] as { arrangement_clips: unknown[] }).arrangement_clips = [
      { name: "a · loop", start_time: 0, end_time: 16, length: 16, is_audio_clip: true, file_path: "/dl/loop.wav" },
      { name: "midi thing", start_time: 16, end_time: 20, length: 4, is_midi_clip: true },
    ];
    (raw as { cue_points: unknown[] }).cue_points = [{ name: "a1", time: 0 }, { name: "b1", time: 32 }];
    const state = toSessionState(parseSnapshotV2(raw), 0);
    expect(state.tracks[2]!.clipSlots[0]!.clip).toEqual({ name: "a · loop", length: 16, isPlaying: false, isAudio: true, filePath: "/dl/loop.wav" });
    expect(state.tracks[2]!.arrangementClips).toEqual([
      { name: "a · loop", startTime: 0, endTime: 16, length: 16, type: "audio", filePath: "/dl/loop.wav" },
      { name: "midi thing", startTime: 16, endTime: 20, length: 4, type: "unknown" },
    ]);
    expect(state.locators).toEqual([
      { name: "a1", time: 0 },
      { name: "b1", time: 32 },
    ]);
  });
});
