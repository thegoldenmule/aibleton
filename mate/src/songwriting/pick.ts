import { ROLES, bandGenre, bandRoles, formTotalBars, parseForm } from "@aibleton/protocol";
import type { Band, Genre, Template } from "@aibleton/protocol";
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

/** Words in the request that point at a genre. Matched against whole tokens. */
export const GENRE_KEYWORDS: Record<Genre, readonly string[]> = {
  funk: ["funk", "funky", "groove", "groovy", "syncopated"],
  jazz: ["jazz", "jazzy", "swing", "swung", "bebop", "bop"],
  rock: ["rock", "rocky", "riff", "riffs", "indie", "punk"],
  metal: ["metal", "heavy", "djent", "thrash", "doom", "brutal"],
  house: ["house", "dance", "club", "techno", "disco", "electronic", "edm"],
  hiphop: ["hiphop", "hip", "hop", "rap", "boom", "bap", "trap", "beats"],
  ambient: ["ambient", "chill", "atmospheric", "drone", "spacey", "calm", "mellow"],
  reggae: ["reggae", "dub", "ska", "skank", "roots"],
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

const GENRE_SCORE = 10;
const ROLE_SCORE = 3;

/** Lowercase word tokens, with hyphens split so "hip-hop" reads as two hits. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Genres the request names, in GENRES order. */
export function genresIn(tokens: readonly string[]): Genre[] {
  const set = new Set(tokens);
  return (Object.keys(GENRE_KEYWORDS) as Genre[]).filter((genre) => GENRE_KEYWORDS[genre].some((w) => set.has(w)));
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

function barsHint(tokens: readonly string[]): number | null {
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
 * Pick the band that best fits the request: genre words score the band's
 * `metadata.genre`, role words score bands that field that role.
 * @throws EmptyLibraryError when `bands` is empty.
 */
export function pickBand(bands: readonly Band[], text: string, seed: number): Band {
  if (bands.length === 0) throw new EmptyLibraryError("bands");
  const tokens = tokenize(text);
  const genres = new Set<string>(genresIn(tokens));
  const roles = rolesIn(tokens);
  return best(
    bands,
    (band) => {
      const genre = bandGenre(band);
      let score = genre && genres.has(genre) ? GENRE_SCORE : 0;
      const has = new Set(bandRoles(band));
      for (const role of roles) if (has.has(role)) score += ROLE_SCORE;
      return score;
    },
    seed,
  );
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
  const bpm = bpmHint(tokens);
  const bars = barsHint(tokens);
  return best(
    templates,
    (template) => {
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
    },
    seed,
  );
}
