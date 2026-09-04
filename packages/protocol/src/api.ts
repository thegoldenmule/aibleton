import { z } from "zod";
import { AdapterStatusSchema, PhaseSchema, SessionStateSchema } from "./state.ts";
import { CommandSummarySchema, ExternalCommandSchema } from "./commands.ts";
import { TemplateSchema } from "./templates.ts";
import { BandSchema, GenreSchema } from "./bands.ts";

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
 * from the clock when omitted and surfaces in the default template name.
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

export const BandListResponseSchema = z.object({ bands: z.array(BandSchema) });
export type BandListResponse = z.infer<typeof BandListResponseSchema>;

export const BandResponseSchema = z.object({ band: BandSchema });
export type BandResponse = z.infer<typeof BandResponseSchema>;

/** Body of `POST /bands`. The client supplies a whole band; the store upserts it. */
export const PutBandRequestSchema = z.object({ band: BandSchema });
export type PutBandRequest = z.infer<typeof PutBandRequestSchema>;

/**
 * Body of `POST /bands/generate`. Every field is optional; `seed` is chosen from
 * the clock when omitted, and an omitted `genre` is picked from the seed so an
 * empty request still yields a coherent band.
 */
export const GenerateBandRequestSchema = z.object({
  seed: z.number().int().optional(),
  genre: GenreSchema.optional(),
  /** Total parts. Clamped to what the genre's recipe can staff. */
  size: z.number().int().min(1).max(16).optional(),
  name: z.string().min(1).optional(),
});
export type GenerateBandRequest = z.infer<typeof GenerateBandRequestSchema>;

export const DeleteBandResponseSchema = z.object({ deleted: z.boolean() });
export type DeleteBandResponse = z.infer<typeof DeleteBandResponseSchema>;
