import { z } from "zod";

/**
 * Genres are free text everywhere: a band's genre lives in `metadata.genre`,
 * a recipe is filed under `genreKey(genre)`. "Hip-Hop", "hip hop" and
 * "hiphop" are the same key.
 */
export function genreKey(genre: string): string {
  return genre.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Suggested role vocabulary. Roles are free text; this is for pickers and generator recipes. */
export const ROLES = [
  "drums",
  "percussion",
  "bass",
  "guitar",
  "keys",
  "synth",
  "horns",
  "strings",
  "vocals",
  "fx",
] as const;
export type Role = (typeof ROLES)[number];

/** Part ids are stable keys, so they are restricted to a slug shape. */
export const PartIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "part id must be a lowercase slug, e.g. \"keys-rhodes\"");

/**
 * One player in a band. `id` is stable for the life of the band because a
 * composition keys its material on it (`material[part.id][section.label]`),
 * and each part becomes one Ableton track.
 */
export const BandPartSchema = z.object({
  id: PartIdSchema,
  /** Free text, but usually one of ROLES. */
  role: z.string().min(1),
  /** What this player is called on the stage plot, e.g. "Rhodes" or "rhythm guitar". */
  name: z.string().min(1),
  /** Prompt text handed to Splice when this part is bound to material. */
  brief: z.string().min(1),
  /** Reserved for a later mix-prominence input. Nothing reads it yet. */
  emphasis: z.number().min(0).max(1).optional(),
});
export type BandPart = z.infer<typeof BandPartSchema>;

const BandShape = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Ordered: this is the track order in Ableton. */
  parts: z.array(BandPartSchema).min(1),
  /** Free-form tags. `genre` is a conventional key; nothing here is required. */
  metadata: z.record(z.string(), z.string()).default({}),
  createdAt: z.number(),
});

/**
 * Who plays in a song. Bands are the space axis; templates are the time axis.
 * A composition is a template crossed with a band: parts become tracks,
 * sections become scenes.
 */
export const BandSchema = BandShape.superRefine((band, ctx) => {
  const seen = new Set<string>();
  band.parts.forEach((part, i) => {
    if (seen.has(part.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parts", i, "id"],
        message: `duplicate part id ${JSON.stringify(part.id)}`,
      });
    }
    seen.add(part.id);
  });
});
export type Band = z.infer<typeof BandSchema>;
/** Input shape: `metadata` may be omitted and defaults to `{}`. */
export type BandDraft = z.input<typeof BandSchema>;

/** Distinct roles in a band, in part order. */
export function bandRoles(band: Pick<Band, "parts">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of band.parts) {
    if (seen.has(part.role)) continue;
    seen.add(part.role);
    out.push(part.role);
  }
  return out;
}

/** The band's genre tag, or null when it was never tagged. */
export function bandGenre(band: Pick<Band, "metadata">): string | null {
  return band.metadata.genre ?? null;
}

/** Recipe ids are genre keys: lowercase alphanumerics, so they double as filenames. */
export const GenreKeySchema = z.string().regex(/^[a-z0-9]{1,64}$/, "genre key must be lowercase alphanumerics");

/**
 * How one genre staffs a band. Mate ships none: the library starts empty and a
 * genre's recipe is written by the model the first time a band is staffed for
 * it, then saved to the recipe log like any other document.
 *
 * `names` and `briefs` are parallel per role: the brief at index `i` describes
 * the instrument named at index `i`. Where the arrays differ in length the
 * brief index wraps.
 */
export const BandRecipeSchema = z
  .object({
    /** `genreKey(genre)`; the document id. */
    id: GenreKeySchema,
    /** The genre as written, e.g. "Hip-Hop". */
    genre: z.string().min(1),
    /** Always staffed, in this order — this is the track order in Ableton. A role may repeat. */
    core: z.array(z.string().min(1)).min(1),
    /** Drawn by weight, without replacement, until the size is met. A role may repeat a core role. */
    optional: z.array(z.object({ role: z.string().min(1), weight: z.number().positive() })),
    /** Display names per role, drawn without replacement so duplicate roles read differently. */
    names: z.record(z.string(), z.array(z.string().min(1)).min(1)),
    /** Splice prompt text per role, paired by index with `names`. */
    briefs: z.record(z.string(), z.array(z.string().min(1)).min(1)),
    /** How many leading `names` entries a core slot may be drawn from, per role. */
    anchors: z.record(z.string(), z.number().int().positive()).default({}),
    createdAt: z.number(),
  })
  .superRefine((recipe, ctx) => {
    const roles = new Set([...recipe.core, ...recipe.optional.map((o) => o.role)]);
    for (const role of roles) {
      if (!recipe.names[role]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["names", role], message: `role ${JSON.stringify(role)} has no names` });
      }
      if (!recipe.briefs[role]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["briefs", role], message: `role ${JSON.stringify(role)} has no briefs` });
      }
    }
  });
export type BandRecipe = z.infer<typeof BandRecipeSchema>;
/** Input shape: `anchors` may be omitted. */
export type BandRecipeDraft = z.input<typeof BandRecipeSchema>;

/** What `GET /recipes` lists per recipe: enough for a genre picker. */
export const RecipeSummarySchema = z.object({
  id: GenreKeySchema,
  genre: z.string().min(1),
  roles: z.array(z.string()),
});
export type RecipeSummary = z.infer<typeof RecipeSummarySchema>;
