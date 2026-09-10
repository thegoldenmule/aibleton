import { z } from "zod";
import { AdapterStatusSchema, PhaseSchema, SessionStateSchema, TranscriptEntrySchema } from "./state.ts";
import { CommandSummarySchema } from "./commands.ts";
import { SongSchema } from "./songs.ts";

/**
 * Where a song's download stands, sent before and after every asset so the
 * app can show "getting 2 of 10". `current` is null once the run is over.
 */
export const DownloadProgressSchema = z.object({
  songId: z.string(),
  total: z.number().int().min(0),
  done: z.number().int().min(0),
  failed: z.number().int().min(0),
  current: z.object({ uuid: z.string(), fileName: z.string() }).nullable(),
  /** Set when the last asset failed, so the app can show why while the run continues. */
  lastError: z.string().nullable(),
});
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>;

export const COMPOSE_STAGES = ["picking", "briefing", "recipe", "bands", "rebriefing", "feedback", "layout", "done", "failed"] as const;
export const ComposeStageSchema = z.enum(COMPOSE_STAGES);
export type ComposeStage = z.infer<typeof ComposeStageSchema>;

/**
 * One step of composing a song, in words: "asking the model for a brief",
 * "rolled band 2 of 3 for hip hop". Sent as the compose runs so the app can
 * narrate it; `fraction` is a coarse 0..1 for a bar. Every step but the last
 * also lands in the transcript as a `step` entry, so the conversation keeps
 * the trail of how a song was made.
 */
export const ComposeProgressSchema = z.object({
  /** The request text, so the app can match events to the compose it started. */
  request: z.string(),
  stage: ComposeStageSchema,
  message: z.string(),
  fraction: z.number().min(0).max(1),
  at: z.number(),
});
export type ComposeProgress = z.infer<typeof ComposeProgressSchema>;

/** Events mate pushes to the app over SSE. */
export const MateEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state.changed"), session: SessionStateSchema }),
  z.object({ type: z.literal("phase.changed"), phase: PhaseSchema, error: z.string().optional() }),
  z.object({ type: z.literal("command.received"), command: CommandSummarySchema }),
  z.object({ type: z.literal("message"), text: z.string(), requestId: z.string().optional() }),
  z.object({ type: z.literal("cancelled"), requestId: z.string().optional() }),
  z.object({
    type: z.literal("action.applied"),
    action: z.string(),
    ok: z.boolean(),
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal("adapters"), status: AdapterStatusSchema }),
  z.object({ type: z.literal("goal.changed"), goal: z.string().nullable() }),
  z.object({ type: z.literal("song.changed"), song: SongSchema.nullable() }),
  z.object({ type: z.literal("transcript.appended"), entry: TranscriptEntrySchema }),
  z.object({ type: z.literal("download.progress"), progress: DownloadProgressSchema }),
  z.object({ type: z.literal("compose.progress"), progress: ComposeProgressSchema }),
]);
export type MateEvent = z.infer<typeof MateEventSchema>;
