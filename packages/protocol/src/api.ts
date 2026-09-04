import { z } from "zod";
import { AdapterStatusSchema, PhaseSchema, SessionStateSchema, TranscriptEntrySchema } from "./state.ts";
import { CommandSummarySchema, ExternalCommandSchema } from "./commands.ts";
import { TemplateSchema } from "./templates.ts";
import { BandSchema, RecipeSummarySchema } from "./bands.ts";
import { SongSchema } from "./songs.ts";

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
  /** The active song: mate's own picture of the session, or null before one is composed. */
  song: SongSchema.nullable(),
  /** The conversation so far, oldest first. */
  transcript: z.array(TranscriptEntrySchema),
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
 * empty request still yields a coherent band. A genre with no recipe yet has
 * one written by the model first, which takes a while.
 */
export const GenerateBandRequestSchema = z.object({
  seed: z.number().int().optional(),
  genre: z.string().trim().min(1).optional(),
  /** Total parts. Clamped to what the genre's recipe can staff. */
  size: z.number().int().min(1).max(16).optional(),
  name: z.string().min(1).optional(),
});
export type GenerateBandRequest = z.infer<typeof GenerateBandRequestSchema>;

export const DeleteBandResponseSchema = z.object({ deleted: z.boolean() });
export type DeleteBandResponse = z.infer<typeof DeleteBandResponseSchema>;

/** Response of `GET /recipes`: every genre the generator can staff, built-in first. */
export const RecipeListResponseSchema = z.object({ recipes: z.array(RecipeSummarySchema) });
export type RecipeListResponse = z.infer<typeof RecipeListResponseSchema>;

/**
 * Body of `POST /songs/compose`. `seed` drives the deterministic template and
 * band picks and is chosen from the clock when omitted.
 */
export const ComposeSongRequestSchema = z.object({
  text: z.string().min(1),
  seed: z.number().int().optional(),
  name: z.string().min(1).optional(),
});
export type ComposeSongRequest = z.infer<typeof ComposeSongRequestSchema>;

export const SongListResponseSchema = z.object({ songs: z.array(SongSchema) });
export type SongListResponse = z.infer<typeof SongListResponseSchema>;

export const SongResponseSchema = z.object({ song: SongSchema });
export type SongResponse = z.infer<typeof SongResponseSchema>;

export const DeleteSongResponseSchema = z.object({ deleted: z.boolean() });
export type DeleteSongResponse = z.infer<typeof DeleteSongResponseSchema>;

/** Response of `DELETE /songs/active`: the song that was active, or null. */
export const ActiveSongResponseSchema = z.object({ song: SongSchema.nullable() });
export type ActiveSongResponse = z.infer<typeof ActiveSongResponseSchema>;

/** Body of `POST /songs/:id/pick`. `soundUuid` must be one of the slot's candidates. */
export const PickSlotRequestSchema = z.object({ slotId: z.string().min(1), soundUuid: z.string().min(1) });
export type PickSlotRequest = z.infer<typeof PickSlotRequestSchema>;

/** Response of `POST /songs/:id/resolve`. `failedSlotIds`: slots whose every search failed; their old candidates are kept. */
export const ResolveSongResponseSchema = z.object({ song: SongSchema, failedSlotIds: z.array(z.string()) });
export type ResolveSongResponse = z.infer<typeof ResolveSongResponseSchema>;

/** Response of `POST /songs/:id/download`. Partial failure is still a 200: read `failed`. */
export const DownloadSongResponseSchema = z.object({
  song: SongSchema,
  downloaded: z.array(z.object({ uuid: z.string(), fileName: z.string(), localPath: z.string(), slotIds: z.array(z.string()) })),
  failed: z.array(z.object({ uuid: z.string(), slotIds: z.array(z.string()), error: z.string() })),
});
export type DownloadSongResponse = z.infer<typeof DownloadSongResponseSchema>;

/**
 * Response of `POST /songs/:id/arrange`: the song (tracks now carry their Live
 * names), what was done, what failed, and what Live cannot do. The picture of
 * what is in Live comes from `dawStatus(song, state.session)`, not from here.
 */
export const ArrangeSongResponseSchema = z.object({
  song: SongSchema,
  applied: z.array(z.string()),
  failed: z.array(z.object({ step: z.string(), error: z.string() })),
  notes: z.array(z.string()),
});
export type ArrangeSongResponse = z.infer<typeof ArrangeSongResponseSchema>;
