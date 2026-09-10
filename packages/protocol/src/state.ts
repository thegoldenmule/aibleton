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
  /** Absolute path of the sample behind an audio clip, as Live reports it. */
  filePath: z.string().optional(),
  isAudio: z.boolean().optional(),
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
  /** Absolute path of the sample behind an audio clip, as Live reports it. */
  filePath: z.string().optional(),
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

/** A named cue point on the arrangement timeline, in beats. */
export const LocatorSchema = z.object({ name: z.string(), time: z.number() });
export type Locator = z.infer<typeof LocatorSchema>;

/** The DAW-level picture mate holds and the app renders. Not realtime. */
export const SessionStateSchema = z.object({
  transport: TransportSchema,
  tracks: z.array(TrackSchema),
  /** Arrangement cue points; absent when the source does not report them. */
  locators: z.array(LocatorSchema).optional(),
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
/** One labelled fact under a transcript line: "key" / "F# minor". */
export const TranscriptFieldSchema = z.object({
  label: z.string().min(1),
  value: z.string(),
});
export type TranscriptField = z.infer<typeof TranscriptFieldSchema>;

export const TranscriptEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  role: z.enum(["user", "mate"]),
  text: z.string(),
  /**
   * What produced it: a request to compose a song, a request to the bandmate,
   * a bandmate reply, or one step of a compose narrating itself as it runs.
   */
  kind: z.enum(["compose", "request", "reply", "step"]),
  /**
   * The structured half of the line, rendered as a list under `text`. What
   * mate picked, decided or changed is data, not prose, so it stays data all
   * the way to the pane. Empty for anything the drummer typed.
   */
  fields: z.array(TranscriptFieldSchema).default([]),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const ACTIVITY_KINDS = ["think", "compose", "resolve", "arrange", "download", "edit"] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/**
 * The one slow thing mate is doing right now, or null. Server-owned on
 * purpose: a browser that reloads mid-compose, or a second tab, sees the same
 * work in flight, which a per-request flag in the page could never do. `phase`
 * cannot stand in for it — `acting` covers both a 200 ms setTempo and a
 * three-minute compose.
 */
export const ActivitySchema = z.object({
  /**
   * The machine request this belongs to, when the loop started it; a private
   * id when a route did. Also the key the app matches `action.applied` and
   * `cancelled` events on — the request *text* cannot be, now that the brain
   * writes it.
   */
  requestId: z.string(),
  kind: ActivityKindSchema,
  /** What was asked for, in the drummer's words where there are any. */
  request: z.string(),
  /** The headline for the step it is on; the detail is in `fields`. */
  message: z.string(),
  fields: z.array(TranscriptFieldSchema).default([]),
  /** Coarse 0..1 for a bar, or null when the work has no known length. */
  fraction: z.number().min(0).max(1).nullable(),
  startedAt: z.number(),
  at: z.number(),
  /** True when `cancel` would actually stop it: the loop owns it, so the machine can abort it. */
  cancellable: z.boolean(),
});
export type Activity = z.infer<typeof ActivitySchema>;
