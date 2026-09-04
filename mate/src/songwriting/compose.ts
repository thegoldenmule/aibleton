import { SongSchema } from "@aibleton/protocol";
import type { Band, Song, Template } from "@aibleton/protocol";
import { newId } from "../core/commands.ts";
import type { Briefer } from "./briefer/types.ts";
import { applyFeedback } from "./feedback.ts";
import { layoutSong } from "./layout.ts";
import { pickBand, pickTemplate } from "./pick.ts";

export interface ComposeOptions {
  text: string;
  seed: number;
  name?: string;
  templates: readonly Template[];
  bands: readonly Band[];
  briefer: Briefer;
  now: () => number;
  signal: AbortSignal;
}

/**
 * The song flow, end to end: deterministic picks, one brief from the model,
 * the deterministic feedback pass, then the layout. Everything but the brief
 * is pure, and the brief is stored verbatim so the rest can be re-run.
 * @throws EmptyLibraryError, BriefRefusedError, or whatever the briefer throws.
 */
export async function composeSong(opts: ComposeOptions): Promise<Song> {
  const picked = { template: pickTemplate(opts.templates, opts.text, opts.seed), band: pickBand(opts.bands, opts.text, opts.seed) };
  const brief = await opts.briefer.brief({ text: opts.text, template: picked.template, band: picked.band }, opts.signal);
  const revised = applyFeedback(picked.template, picked.band, brief);
  const plan = layoutSong(revised.template, revised.band, brief);

  return SongSchema.parse({
    id: newId("song"),
    name: opts.name ?? brief.summary,
    request: { text: opts.text, seed: opts.seed },
    templateId: picked.template.id,
    bandId: picked.band.id,
    template: revised.template,
    band: revised.band,
    brief,
    plan,
    createdAt: opts.now(),
  });
}
