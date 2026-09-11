import { bandGenre, bandRoles, formTotalBars, parseForm } from "@aibleton/protocol";
import type { Band, Template } from "@aibleton/protocol";
import { GENRE_SCORE, barsHint, bpmHint, genreKeysIn, matchesGenre, rolesIn, scoreBand, scoreTemplate, tokenize } from "./pick.ts";

/**
 * Ranked find over the saved libraries, for brain tools that must not hand the
 * model a whole library: a thirty-band `get_bands` would eat the context that
 * the answer needs.
 *
 * Relevance is the composer's own `scoreBand`/`scoreTemplate` — what the model
 * finds and what `compose_song` picks have to agree — plus a thin layer of text
 * matching over the fields the composer never reads: names, part briefs, the
 * form, section briefs. "Something jazzy with horns" already worked; "the one
 * called Tuesday" did not, and that is the whole of what is added here. Text
 * matching lives on top and never inside the scorers, because inside would
 * change which band a compose picks.
 */

/** One hit: the document, what it scored, and which signals earned it. */
export interface Match<T> {
  document: T;
  score: number;
  /** Short, human phrases — the model judges a hit on these instead of trusting the rank. */
  why: string[];
}

/**
 * How many hits a `find_*` returns by default. Eight is about a kilobyte of
 * summarised JSON: enough for the model to choose between real alternatives,
 * few enough that a default-shaped call never floods the turn.
 */
export const DEFAULT_LIMIT = 8;

/** Whole word beats a prefix, so "horn" reaches "horns" without outranking it. */
const WHOLE_HIT = 1;
const PREFIX_HIT = 0.5;
/** Below this a prefix is noise: "a" prefixes half the library. */
const MIN_PREFIX = 3;

/** Per-field text weights, all under GENRE_SCORE so a real genre match still wins. */
const NAME_WEIGHT = 4;
const PART_WEIGHT = 2;
const BRIEF_WEIGHT = 1.5;
const FORM_WEIGHT = 1;

/**
 * The most text can contribute, total. One point under a genre tag, so a band
 * that plays the genre asked for outranks one that merely mentions the words
 * in its briefs, however many of them land.
 */
const TEXT_CAP = GENRE_SCORE - 1;

/**
 * Words a drummer wraps a question in. They carry no signal but do collide with
 * names and briefs ("the one called Tuesday" should not match every band whose
 * brief says "one"), so they are dropped from text matching only — the scorers
 * still see the raw tokens, exactly as `pickBand` hands them over.
 */
const NOISE = new Set([
  "a", "an", "and", "any", "are", "for", "from", "have", "is", "it", "like", "me", "my", "of", "on", "one", "or",
  "please", "something", "that", "the", "then", "this", "to", "want", "with", "you",
  "band", "bands", "template", "templates", "song", "songs", "called", "named", "find", "get", "play", "playing",
]);

/** A searchable field: `kind` is what the `why` calls it, `weight` what a hit is worth. */
interface Field {
  kind: string;
  weight: number;
  text: string;
}

function bandFields(band: Band): Field[] {
  const fields: Field[] = [{ kind: "name", weight: NAME_WEIGHT, text: band.name }];
  for (const part of band.parts) {
    fields.push({ kind: "part", weight: PART_WEIGHT, text: part.name });
    fields.push({ kind: "brief", weight: BRIEF_WEIGHT, text: part.brief });
  }
  return fields;
}

function templateFields(template: Template): Field[] {
  const fields: Field[] = [
    { kind: "name", weight: NAME_WEIGHT, text: template.name },
    { kind: "form", weight: FORM_WEIGHT, text: template.form },
  ];
  for (const section of Object.values(template.sections)) {
    fields.push({ kind: "brief", weight: BRIEF_WEIGHT, text: section.brief });
  }
  return fields;
}

/** Whole-word hit, prefix hit either way round, or nothing. */
function hit(query: string, word: string): number {
  if (query === word) return WHOLE_HIT;
  const short = query.length <= word.length ? query : word;
  const long = short === query ? word : query;
  if (short.length >= MIN_PREFIX && long.startsWith(short)) return PREFIX_HIT;
  return 0;
}

interface TextResult {
  score: number;
  why: string[];
}

/**
 * Token overlap, nothing cleverer: each query word scores once, against the
 * field that answers it best, so a word repeated across five part briefs is
 * still one hit. No fuzzy distance — a library this size does not need it and
 * a near-miss the model cannot explain is worse than a miss.
 */
function textMatch(tokens: readonly string[], fields: readonly Field[]): TextResult {
  const matched = new Map<string, string[]>();
  let score = 0;
  for (const token of tokens) {
    let bestScore = 0;
    let bestKind = "";
    for (const field of fields) {
      for (const word of tokenize(field.text)) {
        const value = hit(token, word) * field.weight;
        if (value > bestScore) {
          bestScore = value;
          bestKind = field.kind;
        }
      }
    }
    if (bestScore <= 0) continue;
    score += bestScore;
    const words = matched.get(bestKind) ?? [];
    if (!words.includes(token)) words.push(token);
    matched.set(bestKind, words);
  }
  const why = [...matched].map(([kind, words]) => `${kind}: ${words.join(", ")}`);
  return { score: Math.min(score, TEXT_CAP), why };
}

/** Why a band's structural score is what it is, in the composer's own terms. */
function bandWhy(band: Band, tokens: readonly string[]): string[] {
  const why: string[] = [];
  if (matchesGenre(band, genreKeysIn(tokens))) why.push(`genre ${bandGenre(band) ?? ""}`.trim());
  const has = new Set(bandRoles(band));
  for (const role of rolesIn(tokens)) if (has.has(role)) why.push(`plays ${role}`);
  return why;
}

function templateWhy(template: Template, tokens: readonly string[]): string[] {
  const why: string[] = [];
  const bpm = bpmHint(tokens);
  if (bpm !== null && template.bpm !== undefined) why.push(`${template.bpm} bpm, asked around ${bpm}`);
  const bars = barsHint(tokens);
  if (bars !== null) why.push(`${formTotalBars(parseForm(template.form))} bars, asked around ${bars}`);
  return why;
}

/** What a ranked list needs to break ties without a seed. */
interface Document {
  id: string;
  createdAt: number;
}

/**
 * Score first, then newest, then id. Unlike `pickBand`, which settles a tie
 * with a seeded draw, a search has to reproduce: the model may call it twice in
 * one turn and must not see the library shuffle underneath it.
 */
function rank<T extends Document>(matches: Match<T>[], limit: number): Match<T>[] {
  return matches
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.document.createdAt - a.document.createdAt ||
        (a.document.id < b.document.id ? -1 : a.document.id > b.document.id ? 1 : 0),
    )
    .slice(0, limit);
}

/** The newest documents, scored zero: what an unspecific query gets back. */
function newest<T extends Document>(documents: readonly T[], limit: number): Match<T>[] {
  return rank(
    documents.map((document) => ({ document, score: 0, why: [] })),
    limit,
  );
}

/** Query words worth matching against free text. */
function textTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !NOISE.has(token));
}

/**
 * Bands the query points at, best first. An empty or whitespace query is not an
 * error and not nothing: it returns the newest `limit` bands, so `find_bands`
 * stays a safe opening move for a model with nothing specific to ask. A query
 * that matches nothing returns nothing — a list of zeroes would read as a
 * ranking and be worse than an honest miss.
 */
export function searchBands(bands: readonly Band[], query: string, limit: number = DEFAULT_LIMIT): Match<Band>[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return newest(bands, limit);
  const words = textTokens(tokens);
  const matches: Match<Band>[] = [];
  for (const band of bands) {
    const structural = scoreBand(band, tokens);
    const text = textMatch(words, bandFields(band));
    const score = structural + text.score;
    if (score <= 0) continue;
    matches.push({ document: band, score, why: [...bandWhy(band, tokens), ...text.why] });
  }
  return rank(matches, limit);
}

/** Templates the query points at, best first. Same rules as `searchBands`. */
export function searchTemplates(templates: readonly Template[], query: string, limit: number = DEFAULT_LIMIT): Match<Template>[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return newest(templates, limit);
  const words = textTokens(tokens);
  const matches: Match<Template>[] = [];
  for (const template of templates) {
    const structural = scoreTemplate(template, tokens);
    const text = textMatch(words, templateFields(template));
    const score = structural + text.score;
    if (score <= 0) continue;
    matches.push({ document: template, score, why: [...templateWhy(template, tokens), ...text.why] });
  }
  return rank(matches, limit);
}
