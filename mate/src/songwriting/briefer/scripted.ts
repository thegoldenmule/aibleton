import { KEY_ROOTS, SongBriefSchema, bandGenre, genreKey } from "@aibleton/protocol";
import type { BpmRange, KeyMode, LoopBars, SongBrief } from "@aibleton/protocol";
import { mulberry32 } from "../../core/rng.ts";
import { bpmHint, genreKeysIn, tokenize } from "../pick.ts";
import type { BriefInput, Briefer } from "./types.ts";

export type BriefScript = (input: BriefInput, callIndex: number) => SongBrief | Promise<SongBrief>;

/** Tempo and mode that read as the genre when the request says nothing. */
const GENRE_DEFAULTS: Record<string, { bpm: BpmRange; mode: KeyMode; genres: string[] }> = {
  funk: { bpm: { min: 96, max: 116, target: 106 }, mode: "dorian", genres: ["funk", "soul"] },
  jazz: { bpm: { min: 110, max: 170, target: 140 }, mode: "major", genres: ["jazz", "swing"] },
  rock: { bpm: { min: 110, max: 140, target: 124 }, mode: "minor", genres: ["rock", "indie"] },
  metal: { bpm: { min: 130, max: 190, target: 160 }, mode: "phrygian", genres: ["metal"] },
  house: { bpm: { min: 120, max: 128, target: 124 }, mode: "minor", genres: ["house", "electronic"] },
  hiphop: { bpm: { min: 84, max: 96, target: 90 }, mode: "minor", genres: ["hip hop", "boom bap"] },
  ambient: { bpm: { min: 60, max: 90, target: 72 }, mode: "lydian", genres: ["ambient", "cinematic"] },
  reggae: { bpm: { min: 70, max: 90, target: 78 }, mode: "major", genres: ["reggae", "dub"] },
};
const FALLBACK = { bpm: { min: 100, max: 120, target: 110 } as BpmRange, mode: "minor" as KeyMode, genres: ["groove"] };

/** Loop length that suits each role: rhythm parts turn over faster than pads and lines. */
const ROLE_LOOP_BARS: Record<string, LoopBars> = {
  drums: 4,
  percussion: 4,
  guitar: 4,
  bass: 8,
  keys: 8,
  synth: 8,
  strings: 8,
  vocals: 2,
  horns: 2,
  fx: 2,
};

/** Descriptor words worth echoing from the request. */
const MOOD_WORDS = ["upbeat", "dark", "bright", "mellow", "heavy", "tight", "loose", "dry", "wet", "lush", "sparse", "busy", "dirty", "clean"];

/**
 * Deterministic brief for tests and for running mate with no LLM: reads the
 * band's genre and the request's tempo and mood words, keeps every part and
 * changes nothing about the form. Records every input and can be told to fail.
 */
export class ScriptedBriefer implements Briefer {
  readonly kind = "scripted" as const;
  readonly calls: BriefInput[] = [];
  private failNext: Error | null = null;

  constructor(private readonly script: BriefScript | null = null) {}

  /** The next brief() call rejects with this error. */
  rejectNext(error: Error = new Error("scripted briefer failure")): void {
    this.failNext = error;
  }

  async brief(input: BriefInput, signal: AbortSignal): Promise<SongBrief> {
    const index = this.calls.length;
    this.calls.push(input);
    if (signal.aborted) throw new Error("aborted");
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (this.script) return this.script(input, index);
    return defaultBrief(input);
  }
}

/** The brief a scripted briefer writes when it has no script. Exported for tests. */
export function defaultBrief(input: BriefInput): SongBrief {
  const tokens = tokenize(input.text);
  const genre = bandGenre(input.band) ?? [...genreKeysIn(tokens)].find((key) => key in GENRE_DEFAULTS) ?? null;
  const defaults = (genre && GENRE_DEFAULTS[genreKey(genre)]) || FALLBACK;
  const hinted = bpmHint(tokens);
  const bpm: BpmRange = hinted !== null ? { min: Math.max(40, hinted - 8), max: Math.min(220, hinted + 8), target: hinted } : defaults.bpm;
  const rng = mulberry32(hash(`${input.template.id}|${input.band.id}|${input.text}`));
  const root = KEY_ROOTS[Math.floor(rng() * KEY_ROOTS.length)]!;
  const descriptors = MOOD_WORDS.filter((w) => tokens.includes(w));

  return SongBriefSchema.parse({
    summary: `${descriptors[0] ?? defaults.genres[0]} ${genre ?? "groove"} in ${root} ${defaults.mode} around ${bpm.target} bpm`,
    genres: defaults.genres,
    descriptors,
    key: { root, mode: defaults.mode },
    bpm,
    timeSignature: { numerator: 4, denominator: 4 },
    swing: null,
    parts: input.band.parts.map((part) => ({
      partId: part.id,
      keep: true,
      brief: null,
      soundHints: [],
      loopBars: ROLE_LOOP_BARS[part.role] ?? 4,
    })),
    sections: Object.values(input.template.sections).map((section) => ({
      label: section.label,
      brief: null,
      descriptors: [],
      intensity: null,
    })),
    templateFeedback: { form: null, notes: "scripted briefer: template kept as saved" },
    bandFeedback: { addParts: [], notes: "scripted briefer: band kept as saved" },
  });
}

/** Small string hash so the scripted key depends on the inputs, not the clock. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
