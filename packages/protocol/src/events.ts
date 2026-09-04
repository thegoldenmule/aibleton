import { z } from "zod";
import { AdapterStatusSchema, PhaseSchema, SessionStateSchema } from "./state.ts";
import { CommandSummarySchema } from "./commands.ts";
import { SongSchema } from "./songs.ts";

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
]);
export type MateEvent = z.infer<typeof MateEventSchema>;
