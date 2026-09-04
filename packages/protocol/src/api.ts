import { z } from "zod";
import { AdapterStatusSchema, PhaseSchema, SessionStateSchema } from "./state.ts";
import { CommandSummarySchema, ExternalCommandSchema } from "./commands.ts";
import { TemplateSchema } from "./templates.ts";

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

export const TemplateListResponseSchema = z.object({ templates: z.array(TemplateSchema) });
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;

export const TemplateResponseSchema = z.object({ template: TemplateSchema });
export type TemplateResponse = z.infer<typeof TemplateResponseSchema>;

/** Body of `POST /templates`. The client supplies a whole template; the store upserts it. */
export const PutTemplateRequestSchema = z.object({ template: TemplateSchema });
export type PutTemplateRequest = z.infer<typeof PutTemplateRequestSchema>;

/**
 * Body of `POST /templates/generate`. Every field is optional; `seed` is chosen
 * for you when omitted and always reported back on the generated template's id.
 */
export const GenerateTemplateRequestSchema = z.object({
  seed: z.number().int().optional(),
  alphabet: z.number().int().min(2).max(6).optional(),
  count: z.number().int().min(1).max(64).optional(),
  home: z.string().regex(/^[a-z]$/).optional(),
  maxRun: z.number().int().min(1).optional(),
  bars: z.number().int().min(1).optional(),
  name: z.string().min(1).optional(),
  bpm: z.number().positive().optional(),
});
export type GenerateTemplateRequest = z.infer<typeof GenerateTemplateRequestSchema>;

export const DeleteTemplateResponseSchema = z.object({ deleted: z.boolean() });
export type DeleteTemplateResponse = z.infer<typeof DeleteTemplateResponseSchema>;
