import { z } from "zod";

/**
 * Genres the band generator knows how to staff. Only an input to generation —
 * a saved band's genre lives in `metadata.genre`, which is free text.
 */
export const GENRES = ["funk", "jazz", "rock", "metal", "house", "hiphop", "ambient", "reggae"] as const;
export const GenreSchema = z.enum(GENRES);
export type Genre = z.infer<typeof GenreSchema>;

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
