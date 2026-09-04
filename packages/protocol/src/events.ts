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
]);
export type MateEvent = z.infer<typeof MateEventSchema>;
