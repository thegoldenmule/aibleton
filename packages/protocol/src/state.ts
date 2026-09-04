import { z } from "zod";

export const MidiNoteSchema = z.object({
  pitch: z.number().int().min(0).max(127),
  startTime: z.number().min(0),
  duration: z.number().positive(),
  velocity: z.number().min(0).max(127),
  mute: z.boolean().default(false),
});
export type MidiNote = z.infer<typeof MidiNoteSchema>;

export const ClipSchema = z.object({
  name: z.string(),
  length: z.number(),
  isPlaying: z.boolean().optional(),
  notes: z.array(MidiNoteSchema).optional(),
});
export type Clip = z.infer<typeof ClipSchema>;

export const ClipSlotSchema = z.object({
  index: z.number().int(),
  clip: ClipSchema.nullable(),
});
export type ClipSlot = z.infer<typeof ClipSlotSchema>;

export const ArrangementClipSchema = z.object({
  name: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  length: z.number(),
  type: z.string(),
});
export type ArrangementClip = z.infer<typeof ArrangementClipSchema>;

export const TrackKindSchema = z.enum(["midi", "audio"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TrackSchema = z.object({
  index: z.number().int(),
  name: z.string(),
  kind: TrackKindSchema,
  mute: z.boolean(),
  solo: z.boolean(),
  arm: z.boolean(),
  volume: z.number(),
  clipSlots: z.array(ClipSlotSchema),
  arrangementClips: z.array(ArrangementClipSchema),
});
export type Track = z.infer<typeof TrackSchema>;

export const TransportSchema = z.object({
  tempo: z.number(),
  signatureNumerator: z.number().int(),
  signatureDenominator: z.number().int(),
  isPlaying: z.boolean(),
  currentSongTime: z.number(),
  songLength: z.number(),
});
export type Transport = z.infer<typeof TransportSchema>;

/** The DAW-level picture mate holds and the app renders. Not realtime. */
export const SessionStateSchema = z.object({
  transport: TransportSchema,
  tracks: z.array(TrackSchema),
  capturedAt: z.number(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const PhaseSchema = z.enum(["idle", "observing", "deciding", "acting", "paused", "error"]);
export type Phase = z.infer<typeof PhaseSchema>;

export const AdapterStatusSchema = z.object({
  ableton: z.enum(["mcp", "stub"]),
  splice: z.enum(["mcp", "stub"]),
  brain: z.enum(["anthropic", "scripted"]),
});
export type AdapterStatus = z.infer<typeof AdapterStatusSchema>;

/** One line of the conversation between the drummer and mate, as the app shows it. */
export const TranscriptEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  role: z.enum(["user", "mate"]),
  text: z.string(),
  /** What produced it: a request to compose a song, a request to the bandmate, or a bandmate reply. */
  kind: z.enum(["compose", "request", "reply"]),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;
