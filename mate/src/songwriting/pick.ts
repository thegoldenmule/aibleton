import { ROLES, bandGenre, bandRoles, formTotalBars, genreKey, parseForm } from "@aibleton/protocol";
import type { Band, Template } from "@aibleton/protocol";
import { mulberry32 } from "../core/rng.ts";

/**
 * Deterministic picks from the saved libraries. No generation happens here:
 * the request text scores each candidate, and ties (including "no signal at
 * all") break with the seed, so the same text and seed always pick the same
 * template and band.
 */

/** Thrown when a library has nothing to pick from. The route maps it to a 409. */
export class EmptyLibraryError extends Error {
  constructor(readonly library: "templates" | "bands") {
    super(`no saved ${library}: save at least one before composing a song`);
    this.name = "EmptyLibraryError";
  }
}

/**
 * Request words that mean a genre without naming it. Genres themselves are
 * free text: a band tagged "gospel" matches the word "gospel" with no entry
 * here. Values are genre keys (see `genreKey`).
 */
export const GENRE_SYNONYMS: Record<string, readonly string[]> = {
  funky: ["funk"],
  groove: ["funk"],
  groovy: ["funk"],
  jazzy: ["jazz"],
  swing: ["jazz"],
  swung: ["jazz"],
  bebop: ["jazz"],
  riff: ["rock"],
  riffs: ["rock"],
  indie: ["rock"],
  punk: ["rock"],
  heavy: ["metal"],
  djent: ["metal"],
  thrash: ["metal"],
  doom: ["metal"],
  dance: ["house"],
  club: ["house"],
  techno: ["house"],
  disco: ["house", "funk"],
  electronic: ["house"],
  edm: ["house"],
  rap: ["hiphop"],
  trap: ["hiphop"],
  boom: ["hiphop"],
  bap: ["hiphop"],
  chill: ["ambient"],
  atmospheric: ["ambient"],
  drone: ["ambient"],
  mellow: ["ambient"],
  dub: ["reggae"],
  ska: ["reggae"],
  skank: ["reggae"],
  roots: ["reggae"],
};

/** Tempo words and what they imply, in bpm. Explicit numbers win over words. */
const TEMPO_WORDS: readonly { words: readonly string[]; bpm: number }[] = [
  { words: ["slow", "ballad", "laid", "lazy", "downtempo", "sludgy"], bpm: 80 },
  { words: ["mid", "midtempo", "steady", "walking"], bpm: 105 },
  { words: ["upbeat", "fast", "uptempo", "quick", "driving", "energetic", "bright"], bpm: 130 },
  { words: ["frantic", "blazing", "breakneck"], bpm: 170 },
];

/** Length words and what they imply, in total bars. */
const LENGTH_WORDS: readonly { words: readonly string[]; bars: number }[] = [
  { words: ["short", "quick", "brief", "little"], bars: 32 },
  { words: ["long", "epic", "extended", "full"], bars: 96 },
];

/** A named genre is the strong signal; a named role is a nudge on top of it. */
export const GENRE_SCORE = 10;
export const ROLE_SCORE = 3;

/** Lowercase word tokens, with hyphens split so "hip-hop" reads as two hits. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Genre keys the request points at: every token and every adjacent token pair
 * ("hip hop" -> "hiphop") as a key, plus the synonyms. Whether a key is a real
 * genre is the caller's business; it is matched against band tags and recipes.
 */
export function genreKeysIn(tokens: readonly string[]): Set<string> {
  const keys = new Set<string>();
  tokens.forEach((token, i) => {
    keys.add(genreKey(token));
    const next = tokens[i + 1];
    if (next) keys.add(genreKey(token + next));
    for (const genre of GENRE_SYNONYMS[token] ?? []) keys.add(genre);
  });
  keys.delete("");
  return keys;
}

/** The keys a band's genre tag answers to: the whole tag and each of its words. */
export function bandGenreKeys(band: Pick<Band, "metadata">): Set<string> {
  const genre = bandGenre(band);
  if (!genre) return new Set();
  const keys = new Set([genreKey(genre)]);
  for (const word of tokenize(genre)) keys.add(genreKey(word));
  keys.delete("");
  return keys;
}

/** True when the request names the band's genre. */
export function matchesGenre(band: Pick<Band, "metadata">, requestKeys: ReadonlySet<string>): boolean {
  for (const key of bandGenreKeys(band)) if (requestKeys.has(key)) return true;
  return false;
}

/** Roles the request names ("with horns", "no keys" still counts as a mention). */
export function rolesIn(tokens: readonly string[]): string[] {
  const set = new Set(tokens);
  return ROLES.filter((role) => set.has(role) || set.has(`${role}s`));
}

/** A bpm the request implies: an explicit number in range wins, else the first tempo word, else null. */
export function bpmHint(tokens: readonly string[]): number | null {
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) continue;
    const n = Number(token);
    if (n >= 40 && n <= 220) return n;
  }
  const set = new Set(tokens);
  for (const entry of TEMPO_WORDS) {
    if (entry.words.some((w) => set.has(w))) return entry.bpm;
  }
  return null;
}

/** Total bars the request implies, from a length word. */
export function barsHint(tokens: readonly string[]): number | null {
  const set = new Set(tokens);
  for (const entry of LENGTH_WORDS) {
    if (entry.words.some((w) => set.has(w))) return entry.bars;
  }
  return null;
}

/** Highest score wins; equal scores are settled by one seeded draw. */
function best<T>(items: readonly T[], score: (item: T) => number, seed: number): T {
  let top = -Infinity;
  let winners: T[] = [];
  for (const item of items) {
    const s = score(item);
    if (s > top) {
      top = s;
      winners = [item];
    } else if (s === top) {
      winners.push(item);
    }
  }
  const rng = mulberry32(seed);
  return winners[Math.floor(rng() * winners.length)]!;
}

/**
 * How well a band fits a request, on the request's own tokens: the genre tag
 * scores once, then every named role the band actually fields. Free of the
 * picker so the library search can rank on the same relevance compose picks
 * with — a `find_bands` that disagreed with `compose_song` would be worse
 * than no search at all.
 */
export function scoreBand(band: Band, tokens: readonly string[]): number {
  const keys = genreKeysIn(tokens);
  let score = matchesGenre(band, keys) ? GENRE_SCORE : 0;
  const has = new Set(bandRoles(band));
  for (const role of rolesIn(tokens)) if (has.has(role)) score += ROLE_SCORE;
  return score;
}

/**
 * How well a template fits a request: proximity to the tempo the words imply,
 * then to the length they imply. A template with no bpm scores nothing on
 * tempo rather than being pushed below one that is merely far off.
 */
export function scoreTemplate(template: Template, tokens: readonly string[]): number {
  const bpm = bpmHint(tokens);
  const bars = barsHint(tokens);
  let score = 0;
  if (bpm !== null && template.bpm !== undefined) {
    // 10 points at an exact match, fading to 0 forty bpm away.
    score += Math.max(0, GENRE_SCORE - Math.abs(template.bpm - bpm) / 4);
  }
  if (bars !== null) {
    const total = formTotalBars(parseForm(template.form));
    score += Math.max(0, ROLE_SCORE - Math.abs(total - bars) / 16);
  }
  return score;
}

/**
 * Pick the band that best fits the request: genre words score the band's
 * `metadata.genre`, role words score bands that field that role.
 * @throws EmptyLibraryError when `bands` is empty.
 */
export function pickBand(bands: readonly Band[], text: string, seed: number): Band {
  if (bands.length === 0) throw new EmptyLibraryError("bands");
  const tokens = tokenize(text);
  return best(bands, (band) => scoreBand(band, tokens), seed);
}

/**
 * Pick the template that best fits the request: tempo words and numbers score
 * proximity to `template.bpm`, length words score proximity to the total bars.
 * Templates without a bpm are neutral on tempo rather than penalised.
 * @throws EmptyLibraryError when `templates` is empty.
 */
export function pickTemplate(templates: readonly Template[], text: string, seed: number): Template {
  if (templates.length === 0) throw new EmptyLibraryError("templates");
  const tokens = tokenize(text);
  return best(templates, (template) => scoreTemplate(template, tokens), seed);
}
