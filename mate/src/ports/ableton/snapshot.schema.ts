import { z } from "zod";
import type { Clip, ClipSlot, MidiNote, SessionState, Track } from "@aibleton/protocol";

/** Zod schema for the `ableton_mcp_snapshot_v2` payload. Lenient: only what mate needs is required. */
const RawNoteSchema = z
  .object({
    pitch: z.number(),
    start_time: z.number(),
    duration: z.number(),
    velocity: z.number(),
    mute: z.boolean().optional(),
  })
  .passthrough();

const RawClipSchema = z
  .object({
    name: z.string().default(""),
    length: z.number().default(0),
    is_playing: z.boolean().optional(),
    is_audio_clip: z.boolean().optional(),
    file_path: z.string().optional(),
    notes: z.array(RawNoteSchema).optional(),
  })
  .passthrough();

const RawClipSlotSchema = z
  .object({
    index: z.number().int(),
    has_clip: z.boolean().default(false),
    clip: RawClipSchema.nullable().optional(),
  })
  .passthrough();

const RawArrangementClipSchema = z
  .object({
    name: z.string().default(""),
    start_time: z.number().default(0),
    end_time: z.number().default(0),
    length: z.number().default(0),
    type: z.string().default("unknown"),
    is_audio_clip: z.boolean().optional(),
    file_path: z.string().optional(),
  })
  .passthrough();

const RawTrackSchema = z
  .object({
    index: z.number().int(),
    name: z.string().default(""),
    is_audio_track: z.boolean().optional(),
    is_midi_track: z.boolean().optional(),
    mute: z.boolean().default(false),
    solo: z.boolean().default(false),
    arm: z.boolean().default(false),
    volume: z.number().default(0),
    clip_slots: z.array(RawClipSlotSchema).default([]),
    arrangement_clips: z.array(RawArrangementClipSchema).default([]),
  })
  .passthrough();

const RawSessionSchema = z
  .object({
    tempo: z.number(),
    signature_numerator: z.number().int().default(4),
    signature_denominator: z.number().int().default(4),
    is_playing: z.boolean().default(false),
    current_song_time: z.number().default(0),
    song_length: z.number().default(0),
  })
  .passthrough();

export const SnapshotV2Schema = z
  .object({
    schema: z.string().optional(),
    session: RawSessionSchema,
    tracks: z.array(RawTrackSchema),
    scenes: z.array(z.object({ index: z.number().int(), name: z.string().default("") }).passthrough()).optional(),
    return_tracks: z.array(z.object({ index: z.number().int(), name: z.string().default("") }).passthrough()).optional(),
    cue_points: z.array(z.object({ name: z.string().default(""), time: z.number().default(0) }).passthrough()).optional(),
  })
  .passthrough();

export type SnapshotV2 = z.infer<typeof SnapshotV2Schema>;

export function parseSnapshotV2(raw: unknown): SnapshotV2 {
  return SnapshotV2Schema.parse(raw);
}

function toNote(n: z.infer<typeof RawNoteSchema>): MidiNote {
  return { pitch: n.pitch, startTime: n.start_time, duration: n.duration, velocity: n.velocity, mute: n.mute ?? false };
}

function toClip(c: z.infer<typeof RawClipSchema>): Clip {
  const clip: Clip = { name: c.name, length: c.length };
  if (c.is_playing !== undefined) clip.isPlaying = c.is_playing;
  if (c.is_audio_clip !== undefined) clip.isAudio = c.is_audio_clip;
  if (c.file_path) clip.filePath = c.file_path;
  if (c.notes) clip.notes = c.notes.map(toNote);
  return clip;
}

function toClipSlot(s: z.infer<typeof RawClipSlotSchema>): ClipSlot {
  return { index: s.index, clip: s.has_clip && s.clip ? toClip(s.clip) : null };
}

function toTrack(t: z.infer<typeof RawTrackSchema>): Track {
  return {
    index: t.index,
    name: t.name,
    kind: t.is_midi_track ? "midi" : "audio",
    mute: t.mute,
    solo: t.solo,
    arm: t.arm,
    volume: t.volume,
    clipSlots: t.clip_slots.map(toClipSlot),
    arrangementClips: t.arrangement_clips.map((c) => ({
      name: c.name,
      startTime: c.start_time,
      endTime: c.end_time,
      length: c.length,
      type: c.is_audio_clip === undefined ? c.type : c.is_audio_clip ? "audio" : "midi",
      ...(c.file_path ? { filePath: c.file_path } : {}),
    })),
  };
}

/** Map a validated v2 snapshot onto the protocol SessionState the UI renders. */
export function toSessionState(raw: SnapshotV2, capturedAt: number): SessionState {
  return {
    transport: {
      tempo: raw.session.tempo,
      signatureNumerator: raw.session.signature_numerator,
      signatureDenominator: raw.session.signature_denominator,
      isPlaying: raw.session.is_playing,
      currentSongTime: raw.session.current_song_time,
      songLength: raw.session.song_length,
    },
    tracks: raw.tracks.map(toTrack),
    ...(raw.cue_points ? { locators: raw.cue_points.map((c) => ({ name: c.name, time: c.time })) } : {}),
    capturedAt,
  };
}

/**
 * Ableton MCP tool results arrive as a text block holding JSON `{"result": "<string>"}`.
 * The inner string is itself JSON, sometimes followed by non-JSON text (a consent banner
 * separated by `\n---\n` was observed). Returns the first balanced JSON value found.
 */
export function parseToolJson(text: string): unknown {
  let inner = text.trim();
  const outer = tryParse(inner);
  if (outer && typeof outer === "object" && "result" in outer) {
    const r = (outer as { result: unknown }).result;
    if (typeof r !== "string") return r;
    inner = r;
  }
  const direct = tryParse(inner);
  if (direct !== undefined) return direct;
  const sliced = firstBalancedJson(inner);
  if (sliced === null) throw new Error(`Ableton MCP result is not JSON: ${inner.slice(0, 120)}`);
  return JSON.parse(sliced);
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function firstBalancedJson(s: string): string | null {
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === close) return s.slice(start, i + 1);
    }
  }
  return null;
}
