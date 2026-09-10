import { z } from "zod";
import { ActivitySchema, AdapterStatusSchema, PhaseSchema, SessionStateSchema, TranscriptEntrySchema } from "./state.ts";
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

/**
 * Where a compose has got to. Not an event of its own: the trail lands in the
 * transcript as `step` entries and the stage drives the `Activity` bar.
 */
export const COMPOSE_STAGES = ["picking", "briefing", "recipe", "bands", "rebriefing", "feedback", "layout", "done", "failed"] as const;
export const ComposeStageSchema = z.enum(COMPOSE_STAGES);
export type ComposeStage = z.infer<typeof ComposeStageSchema>;

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
    /** The machine request the action set belongs to; absent for anything not run by the loop. */
    requestId: z.string().optional(),
  }),
  z.object({ type: z.literal("adapters"), status: AdapterStatusSchema }),
  z.object({ type: z.literal("goal.changed"), goal: z.string().nullable() }),
  z.object({ type: z.literal("song.changed"), song: SongSchema.nullable() }),
  z.object({ type: z.literal("transcript.appended"), entry: TranscriptEntrySchema }),
  z.object({ type: z.literal("download.progress"), progress: DownloadProgressSchema }),
  /** The one slow thing mate is doing, or null when it is at rest. */
  z.object({ type: z.literal("activity.changed"), activity: ActivitySchema.nullable() }),
  /** Requests that arrived while mate was working and are waiting their turn, oldest first. */
  z.object({ type: z.literal("queue.changed"), queued: z.array(CommandSummarySchema) }),
]);
export type MateEvent = z.infer<typeof MateEventSchema>;
