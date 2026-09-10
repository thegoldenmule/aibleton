import { BandSchema, SongSchema, genreKey, keyName } from "@aibleton/protocol";
import type { Band, ComposeStage, Song, SongBrief, SongPlan, Template } from "@aibleton/protocol";
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
  /** Narrates each step as it starts or finishes; wired to an SSE event by the route. */
  onProgress?: (stage: ComposeStage, message: string) => void;
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
  const progress = opts.onProgress ?? (() => {});
  const template = pickTemplate(opts.templates, opts.text, opts.seed);
  let band = pickBand(opts.bands, opts.text, opts.seed);
  progress("picking", `picked the form “${template.name}” — ${template.form}`);
  progress("picking", `picked the band “${band.name}” — ${lineup(band)}`);
  progress("briefing", "asking the model what this song should be, and what to change about the form and the band…");
  let brief = await opts.briefer.brief({ text: opts.text, template, band }, opts.signal);
  for (const note of briefNotes(brief)) progress("briefing", note);

  if (!coversGenre(opts.bands, band, brief, opts.text)) {
    const genre = brief.genres[0]!;
    const known = opts.recipes.get(genre);
    progress("recipe", known ? `no saved band plays ${genre}; staffing one from its recipe` : `no saved band plays ${genre}; asking the model how to staff one…`);
    await opts.recipes.ensure(genre, opts.signal);
    const rolled: Band[] = [];
    for (let i = 1; i <= BANDS_PER_NEW_GENRE; i++) {
      const seed = opts.seed + i;
      const staffed = generateBand({ seed, genre }, opts.recipes);
      const at = opts.now();
      rolled.push(await opts.saveBand(BandSchema.parse({ id: newId("band"), name: `${staffed.metadata.genre} band ${seed}`, parts: staffed.parts, metadata: staffed.metadata, createdAt: at })));
      progress("bands", `rolled ${genre} band ${i} of ${BANDS_PER_NEW_GENRE}: ${staffed.parts.map((p) => p.name).join(", ")}`);
    }
    band = pickBand(rolled, opts.text, opts.seed);
    // The first brief's part feedback keyed on the old band; brief again so nothing is lost.
    progress("rebriefing", `briefing again with “${band.name}” — ${lineup(band)}…`);
    brief = await opts.briefer.brief({ text: opts.text, template, band }, opts.signal);
    for (const note of briefNotes(brief)) progress("rebriefing", note);
  }

  const revised = applyFeedback(template, band, brief);
  progress("feedback", editNote(template, band, revised.template, revised.band));
  const plan = layoutSong(revised.template, revised.band, brief);
  progress("layout", `laid out ${plan.tracks.length} tracks and ${plan.slots.length} sample slots over ${plan.timeline.length} sections`);
  progress("layout", playingNote(plan));

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

/** The band in one phrase: how many play and who they are. */
function lineup(band: Band): string {
  return `${band.parts.length} parts: ${band.parts.map((p) => p.name).join(", ")}`;
}

/**
 * What the model decided, in the drummer's terms: the summary it wrote, then
 * the numbers that drive every Splice search, then the words it chose. One
 * line each, so the conversation reads as a list of decisions.
 */
export function briefNotes(brief: SongBrief): string[] {
  const notes = [`brief: ${brief.summary}`];
  const swing = brief.swing === null ? "" : ` · swing ${Math.round(brief.swing * 100)}%`;
  const { min, max, target } = brief.bpm;
  notes.push(
    `key ${keyName(brief.key)} · ${target} bpm (${min}–${max}) · ${brief.timeSignature.numerator}/${brief.timeSignature.denominator}${swing}`,
  );
  const words = [...brief.genres, ...brief.descriptors];
  if (words.length > 0) notes.push(words.join(", "));
  return notes;
}

/** What the brief's notes actually changed about the picked form and band, or that they changed nothing. */
export function editNote(before: Template, band: Band, after: Template, revised: Band): string {
  const edits: string[] = [];
  if (after.form !== before.form) edits.push(`form → ${after.form}`);
  const reworded = Object.entries(after.sections).filter(([label, section]) => {
    const was = before.sections[label];
    return was !== undefined && (was.brief !== section.brief || was.intensity !== section.intensity);
  }).length;
  if (reworded > 0) edits.push(`reworked ${reworded} section${reworded === 1 ? "" : "s"}`);
  const had = new Set(band.parts.map((p) => p.id));
  const kept = new Set(revised.parts.map((p) => p.id));
  const dropped = band.parts.filter((p) => !kept.has(p.id)).map((p) => p.name);
  const added = revised.parts.filter((p) => !had.has(p.id)).map((p) => p.name);
  if (dropped.length > 0) edits.push(`dropped ${dropped.join(", ")}`);
  if (added.length > 0) edits.push(`added ${added.join(", ")}`);
  return edits.length > 0 ? `edited the form and the band: ${edits.join("; ")}` : "kept the form and the line-up as picked";
}

/** How the line-up lands on the timeline: the parts that sit out somewhere are the interesting ones. */
export function playingNote(plan: SongPlan): string {
  const playing = new Set(plan.placements.map((p) => `${p.partId}@${p.occurrence}`));
  const rests = plan.tracks
    .map((track) => ({ name: track.name, n: plan.timeline.filter((o) => !playing.has(`${track.partId}@${o.index}`)).length }))
    .filter((r) => r.n > 0);
  if (rests.length === 0) return `everyone plays all ${plan.timeline.length} sections`;
  // A full list gets unreadable with a big band; the thinnest parts are the ones worth naming.
  const named = [...rests].sort((a, b) => b.n - a.n).slice(0, 3);
  const rest = rests.length - named.length;
  return `sitting out: ${named.map((r) => `${r.name} ${r.n} of ${plan.timeline.length}`).join(" · ")}${rest > 0 ? ` · and ${rest} more` : ""}`;
}
