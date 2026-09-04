import { z } from "zod";
import { BandSchema } from "./bands.ts";
import { SectionLabelSchema, parseForm } from "./form.ts";
import type { Track } from "./state.ts";
import { TemplateSchema } from "./templates.ts";

/**
 * A song is a template (time) crossed with a band (space), briefed by the LLM
 * and laid out deterministically. Everything the model returns is a
 * `SongBrief`; everything mate derives from it is a `SongPlan`. Both are stored
 * verbatim on the `Song`, so a plan can be re-derived without another model call.
 */

export const KEY_ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const KeyRootSchema = z.enum(KEY_ROOTS);
export type KeyRoot = z.infer<typeof KeyRootSchema>;

export const KEY_MODES = ["major", "minor", "dorian", "mixolydian", "lydian", "phrygian"] as const;
export const KeyModeSchema = z.enum(KEY_MODES);
export type KeyMode = z.infer<typeof KeyModeSchema>;

export const MusicalKeySchema = z.object({ root: KeyRootSchema, mode: KeyModeSchema });
export type MusicalKey = z.infer<typeof MusicalKeySchema>;

/** Render a key the way sample libraries tag it: `"F minor"`. */
export function keyName(key: MusicalKey): string {
  return `${key.root} ${key.mode}`;
}

export const MIN_BPM = 40;
export const MAX_BPM = 220;

export const BpmRangeSchema = z
  .object({
    min: z.number().int().min(MIN_BPM).max(MAX_BPM),
    max: z.number().int().min(MIN_BPM).max(MAX_BPM),
    target: z.number().int().min(MIN_BPM).max(MAX_BPM),
  })
  .refine((r) => r.min <= r.target && r.target <= r.max, { message: "bpm must satisfy min <= target <= max" });
export type BpmRange = z.infer<typeof BpmRangeSchema>;

export const TimeSignatureSchema = z.object({
  numerator: z.number().int().min(1).max(32),
  denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
});
export type TimeSignature = z.infer<typeof TimeSignatureSchema>;

/** Loop lengths a sample slot may ask Splice for, in bars. */
export const LOOP_BARS = [1, 2, 4, 8, 16] as const;
export const LoopBarsSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]);
export type LoopBars = z.infer<typeof LoopBarsSchema>;

export const MAX_BRIEF_GENRES = 5;
export const MAX_BRIEF_HINTS = 5;
export const MAX_ADDED_PARTS = 2;

/** What the brief says about one band part, keyed by the part's id. */
export const BriefPartSchema = z.object({
  partId: z.string().min(1),
  /** False drops the part from the song. */
  keep: z.boolean(),
  /** Replaces the part's Splice brief when set. */
  brief: z.string().nullable(),
  /** Extra Splice search words for this part. */
  soundHints: z.array(z.string()).max(MAX_BRIEF_HINTS),
  /** Preferred loop length; the layout fits it to each section's bars. */
  loopBars: LoopBarsSchema,
});
export type BriefPart = z.infer<typeof BriefPartSchema>;

/** What the brief says about one template section, keyed by label. */
export const BriefSectionSchema = z.object({
  label: SectionLabelSchema,
  /** Replaces the section's brief when set. */
  brief: z.string().nullable(),
  descriptors: z.array(z.string()).max(MAX_BRIEF_HINTS),
  intensity: z.number().min(0).max(1).nullable(),
});
export type BriefSection = z.infer<typeof BriefSectionSchema>;

export const AddedPartSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1),
  brief: z.string().min(1),
});
export type AddedPart = z.infer<typeof AddedPartSchema>;

/**
 * The model's structured answer to "what should this song be?". Validated
 * after a deterministic normalisation pass, so ranges here are hard limits
 * rather than something the model has to hit exactly.
 */
export const SongBriefSchema = z.object({
  /** One line, shown in the UI and spoken to the drummer. */
  summary: z.string().min(1),
  /** Splice-searchable genre words. */
  genres: z.array(z.string().min(1)).min(1).max(MAX_BRIEF_GENRES),
  /** Mood and texture words: "upbeat", "syncopated", "dry". */
  descriptors: z.array(z.string().min(1)).max(MAX_BRIEF_HINTS),
  key: MusicalKeySchema,
  bpm: BpmRangeSchema,
  timeSignature: TimeSignatureSchema,
  swing: z.number().min(0).max(1).nullable(),
  parts: z.array(BriefPartSchema),
  sections: z.array(BriefSectionSchema),
  templateFeedback: z.object({
    /** A revised form string using only the template's labels, or null to keep it. */
    form: z.string().nullable(),
    notes: z.string(),
  }),
  bandFeedback: z.object({
    addParts: z.array(AddedPartSchema).max(MAX_ADDED_PARTS),
    notes: z.string(),
  }),
});
export type SongBrief = z.infer<typeof SongBriefSchema>;

/** One Ableton track the song needs; one per surviving band part, in band order. */
export const SongTrackSchema = z.object({
  index: z.number().int().min(0),
  partId: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  kind: z.literal("audio"),
});
export type SongTrack = z.infer<typeof SongTrackSchema>;

/** One occurrence of a section in the form, placed on the timeline. */
export const SongOccurrenceSchema = z.object({
  index: z.number().int().min(0),
  label: SectionLabelSchema,
  bars: z.number().int().positive(),
  startBar: z.number().int().min(0),
  startBeat: z.number().min(0),
  lengthBeats: z.number().positive(),
});
export type SongOccurrence = z.infer<typeof SongOccurrenceSchema>;

/** A sample once Splice has been asked for it. Null until then. */
export const ResolvedSampleSchema = z.object({
  soundUuid: z.string().min(1),
  fileName: z.string(),
  /** Absolute path once downloaded. */
  localPath: z.string().nullable(),
});
export type ResolvedSample = z.infer<typeof ResolvedSampleSchema>;

/** Id of the slot for a part in a section: `"<partId>:<label>"`. */
export function sampleSlotId(partId: string, label: string): string {
  return `${partId}:${label}`;
}

/**
 * The sample one part plays in one section. Every occurrence of that section
 * reuses the same slot, so `material[part.id][section.label]` is one lookup.
 */
export const SampleSlotSchema = z.object({
  id: z.string().min(1),
  partId: z.string().min(1),
  label: SectionLabelSchema,
  /** Query text for Splice, composed deterministically from the briefs. */
  query: z.string().min(1),
  bpm: BpmRangeSchema,
  key: MusicalKeySchema,
  tags: z.array(z.string()),
  loopBars: LoopBarsSchema,
  resolved: ResolvedSampleSchema.nullable(),
});
export type SampleSlot = z.infer<typeof SampleSlotSchema>;

/** One slot played for one occurrence: the sample looped `repeats` times. */
export const PlacementSchema = z.object({
  partId: z.string().min(1),
  label: SectionLabelSchema,
  occurrence: z.number().int().min(0),
  slotId: z.string().min(1),
  startBar: z.number().int().min(0),
  bars: z.number().int().positive(),
  loopBars: LoopBarsSchema,
  repeats: z.number().int().positive(),
  startBeat: z.number().min(0),
  lengthBeats: z.number().positive(),
});
export type Placement = z.infer<typeof PlacementSchema>;

const SongPlanShape = z.object({
  bpm: z.number().int().min(MIN_BPM).max(MAX_BPM),
  key: MusicalKeySchema,
  timeSignature: TimeSignatureSchema,
  tracks: z.array(SongTrackSchema).min(1),
  timeline: z.array(SongOccurrenceSchema).min(1),
  slots: z.array(SampleSlotSchema),
  placements: z.array(PlacementSchema),
});

/** The DAW-shaped result: what tracks, what samples, and when. */
export const SongPlanSchema = SongPlanShape.superRefine((plan, ctx) => {
  const tracks = new Set(plan.tracks.map((t) => t.partId));
  const slots = new Set(plan.slots.map((s) => s.id));
  plan.placements.forEach((p, i) => {
    if (!tracks.has(p.partId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["placements", i, "partId"], message: `no track for part ${JSON.stringify(p.partId)}` });
    }
    if (!slots.has(p.slotId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["placements", i, "slotId"], message: `no slot ${JSON.stringify(p.slotId)}` });
    }
    if (p.repeats * p.loopBars !== p.bars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["placements", i, "repeats"],
        message: `${p.repeats} x ${p.loopBars} bars does not fill ${p.bars} bars`,
      });
    }
  });
});
export type SongPlan = z.infer<typeof SongPlanSchema>;

export const SongRequestSchema = z.object({
  /** What the drummer typed. */
  text: z.string().min(1),
  /** Seed for the deterministic picks, so the same request reproduces. */
  seed: z.number().int(),
});
export type SongRequest = z.infer<typeof SongRequestSchema>;

/**
 * A composed song. Carries revised copies of the template and band rather than
 * references, so later edits or deletes in the libraries cannot break it.
 */
export const SongSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  request: SongRequestSchema,
  templateId: z.string().min(1),
  bandId: z.string().min(1),
  template: TemplateSchema,
  band: BandSchema,
  brief: SongBriefSchema,
  plan: SongPlanSchema,
  createdAt: z.number(),
});
export type Song = z.infer<typeof SongSchema>;

/** Beats in one bar for a time signature, in quarter-note beats as Ableton counts them. */
export function beatsPerBar(sig: TimeSignature): number {
  return (sig.numerator * 4) / sig.denominator;
}

/**
 * Project a plan onto the DAW picture the app already renders: one clip slot
 * per section label in form order (a scene per section), and one arrangement
 * clip per placement. Repeats live on placements only, so the same slot may
 * loop twice under `b8` and once under `b4`.
 */
export function songTracks(song: Pick<Song, "plan" | "template">): Track[] {
  const { plan } = song;
  const labels: string[] = [];
  for (const entry of parseForm(song.template.form)) {
    if (!labels.includes(entry.label)) labels.push(entry.label);
  }
  const bpb = beatsPerBar(plan.timeSignature);
  const slotById = new Map(plan.slots.map((s) => [s.id, s]));

  return plan.tracks.map((track) => ({
    index: track.index,
    name: track.name,
    kind: track.kind,
    mute: false,
    solo: false,
    arm: false,
    volume: 0.85,
    clipSlots: labels.map((label, i) => {
      const slot = slotById.get(sampleSlotId(track.partId, label));
      return {
        index: i,
        clip: slot ? { name: `${label} · ${slot.loopBars} bar${slot.loopBars === 1 ? "" : "s"}`, length: slot.loopBars * bpb } : null,
      };
    }),
    arrangementClips: plan.placements
      .filter((p) => p.partId === track.partId)
      .map((p) => ({
        name: `${p.label} · ${p.loopBars}×${p.repeats}`,
        startTime: p.startBeat,
        endTime: p.startBeat + p.lengthBeats,
        length: p.lengthBeats,
        type: "audio",
      })),
  }));
}
