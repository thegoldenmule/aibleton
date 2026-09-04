import { BandSchema, SongSchema, genreKey } from "@aibleton/protocol";
import type { Band, Song, SongBrief, Template } from "@aibleton/protocol";
import { generateBand } from "../core/band-generator.ts";
import { newId } from "../core/commands.ts";
import type { RecipeBook } from "../core/recipes.ts";
import type { Briefer } from "./briefer/types.ts";
import { applyFeedback } from "./feedback.ts";
import { layoutSong } from "./layout.ts";
import { bandGenreKeys, genreKeysIn, matchesGenre, pickBand, pickTemplate, tokenize } from "./pick.ts";

/** How many bands the flow rolls for a genre it had none for. */
export const BANDS_PER_NEW_GENRE = 3;

export interface ComposeOptions {
  text: string;
  seed: number;
  name?: string;
  templates: readonly Template[];
  bands: readonly Band[];
  briefer: Briefer;
  /** Fills a genre gap: a recipe is written (once) and a few bands rolled from it. */
  recipes: RecipeBook;
  /** Persists a band the flow rolled, so the next request finds it in the library. */
  saveBand: (band: Band) => Promise<Band>;
  now: () => number;
  signal: AbortSignal;
}

/**
 * The song flow, end to end: deterministic picks, one brief from the model,
 * the deterministic feedback pass, then the layout. Everything but the brief
 * is pure, and the brief is stored verbatim so the rest can be re-run.
 *
 * When the request names a genre no saved band covers, the brief is the only
 * thing that can say so. On that miss the flow makes sure a recipe exists,
 * rolls a few bands from it, saves them, picks one and briefs again with it.
 * @throws EmptyLibraryError, ModelRefusedError, or whatever the briefer or writer throws.
 */
export async function composeSong(opts: ComposeOptions): Promise<Song> {
  const template = pickTemplate(opts.templates, opts.text, opts.seed);
  let band = pickBand(opts.bands, opts.text, opts.seed);
  let brief = await opts.briefer.brief({ text: opts.text, template, band }, opts.signal);

  if (!coversGenre(opts.bands, band, brief, opts.text)) {
    const genre = brief.genres[0]!;
    await opts.recipes.ensure(genre, opts.signal);
    const rolled: Band[] = [];
    for (let i = 1; i <= BANDS_PER_NEW_GENRE; i++) {
      const seed = opts.seed + i;
      const staffed = generateBand({ seed, genre }, opts.recipes);
      const at = opts.now();
      rolled.push(await opts.saveBand(BandSchema.parse({ id: newId("band"), name: `${staffed.metadata.genre} band ${seed}`, parts: staffed.parts, metadata: staffed.metadata, createdAt: at })));
    }
    band = pickBand(rolled, opts.text, opts.seed);
    // The first brief's part feedback keyed on the old band; brief again so nothing is lost.
    brief = await opts.briefer.brief({ text: opts.text, template, band }, opts.signal);
  }

  const revised = applyFeedback(template, band, brief);
  const plan = layoutSong(revised.template, revised.band, brief);

  return SongSchema.parse({
    id: newId("song"),
    name: opts.name ?? brief.summary,
    request: { text: opts.text, seed: opts.seed },
    templateId: template.id,
    bandId: band.id,
    template: revised.template,
    band: revised.band,
    brief,
    plan,
    createdAt: opts.now(),
  });
}

/**
 * True unless the brief names genres that no saved band is tagged with and
 * the pick had no genre signal to go on. A request that matched a band by
 * genre is trusted even if the model's genre words differ.
 */
export function coversGenre(bands: readonly Band[], picked: Band, brief: SongBrief, text: string): boolean {
  if (matchesGenre(picked, genreKeysIn(tokenize(text)))) return true;
  const wanted = new Set(brief.genres.map(genreKey));
  wanted.delete("");
  if (wanted.size === 0) return true;
  for (const band of bands) {
    for (const key of bandGenreKeys(band)) if (wanted.has(key)) return true;
  }
  return false;
}
