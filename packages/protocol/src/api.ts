import { z } from "zod";
import { AdapterStatusSchema, PhaseSchema, SessionStateSchema } from "./state.ts";
import { CommandSummarySchema, ExternalCommandSchema } from "./commands.ts";

export const HealthResponseSchema = z.object({ ok: z.literal(true), uptimeMs: z.number() });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const StateResponseSchema = z.object({
  session: SessionStateSchema.nullable(),
  phase: PhaseSchema,
  error: z.string().nullable(),
  goal: z.string().nullable(),
  adapters: AdapterStatusSchema,
  recentCommands: z.array(CommandSummarySchema),
  lastMessage: z.string().nullable(),
});
export type StateResponse = z.infer<typeof StateResponseSchema>;

export const PostCommandRequestSchema = z.object({ command: ExternalCommandSchema });
export type PostCommandRequest = z.infer<typeof PostCommandRequestSchema>;

export const PostCommandResponseSchema = z.object({ id: z.string(), queued: z.number() });
export type PostCommandResponse = z.infer<typeof PostCommandResponseSchema>;

export const AdaptersResponseSchema = AdapterStatusSchema;
export type AdaptersResponse = z.infer<typeof AdaptersResponseSchema>;

export const RecentCommandsResponseSchema = z.object({ commands: z.array(CommandSummarySchema) });
export type RecentCommandsResponse = z.infer<typeof RecentCommandsResponseSchema>;
