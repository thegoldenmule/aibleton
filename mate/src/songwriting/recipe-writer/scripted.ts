import type { RecipeDraft, RecipeRequest, RecipeWriter } from "./types.ts";

export type RecipeScript = (request: RecipeRequest, callIndex: number) => RecipeDraft | Promise<RecipeDraft>;

/**
 * Deterministic writer for tests and for running mate with no LLM: a generic
 * rhythm-section recipe with the genre's name worked into every name and
 * brief, three players per role. Records every request and can be told to fail.
 */
export class ScriptedRecipeWriter implements RecipeWriter {
  readonly kind = "scripted" as const;
  readonly calls: RecipeRequest[] = [];
  private failNext: Error | null = null;

  constructor(private readonly script: RecipeScript | null = null) {}

  /** The next write() call rejects with this error. */
  rejectNext(error: Error = new Error("scripted recipe writer failure")): void {
    this.failNext = error;
  }

  async write(request: RecipeRequest, signal: AbortSignal): Promise<RecipeDraft> {
    const index = this.calls.length;
    this.calls.push(request);
    if (signal.aborted) throw new Error("aborted");
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (this.script) return this.script(request, index);
    return genericRecipe(request.genre);
  }
}

/** The recipe the scripted writer falls back on. Exported for tests. */
export function genericRecipe(genre: string): RecipeDraft {
  const g = genre.toLowerCase();
  return {
    core: ["drums", "bass", "keys"],
    optional: [
      { role: "guitar", weight: 1 },
      { role: "percussion", weight: 0.7 },
      { role: "synth", weight: 0.6 },
      { role: "vocals", weight: 0.5 },
      { role: "horns", weight: 0.3 },
      { role: "strings", weight: 0.3 },
      { role: "fx", weight: 0.4 },
    ],
    names: {
      drums: [`${g} kit`, `${g} breaks`, `${g} electronic kit`],
      bass: [`${g} bass`, `${g} sub bass`, `${g} upright`],
      keys: [`${g} piano`, `${g} electric piano`, `${g} organ`],
      guitar: [`${g} rhythm guitar`, `${g} lead guitar`, `${g} acoustic guitar`],
      percussion: [`${g} shaker and tambourine`, `${g} hand drums`, `${g} claps`],
      synth: [`${g} pad`, `${g} lead synth`, `${g} arp`],
      vocals: [`${g} lead vocal`, `${g} backing vocals`, `${g} vocal chops`],
      horns: [`${g} horn section`, `${g} sax`, `${g} trumpet`],
      strings: [`${g} string section`, `${g} solo violin`, `${g} cello`],
      fx: [`${g} risers`, `${g} impacts`, `${g} textures`],
    },
    briefs: {
      drums: [`${g} drum kit groove, full kit, steady`, `${g} breakbeat, chopped and dry`, `${g} drum machine pattern, tight`],
      bass: [`${g} bass line, locked to the kick`, `${g} sub bass, long notes`, `${g} upright bass, walking`],
      keys: [`${g} piano comping, sustained chords`, `${g} electric piano, warm chords`, `${g} organ, held pads`],
      guitar: [`${g} rhythm guitar, chords on the beat`, `${g} lead guitar, melodic line`, `${g} acoustic guitar strum`],
      percussion: [`${g} shaker and tambourine on the offbeats`, `${g} hand drums, rolling`, `${g} claps on two and four`],
      synth: [`${g} synth pad, wide and slow`, `${g} lead synth melody`, `${g} arpeggiated synth, sixteenths`],
      vocals: [`${g} lead vocal phrase`, `${g} backing vocal harmonies`, `${g} vocal chops, rhythmic`],
      horns: [`${g} horn section stabs`, `${g} saxophone melody`, `${g} trumpet line`],
      strings: [`${g} string section swell`, `${g} solo violin melody`, `${g} cello line`],
      fx: [`${g} riser into the downbeat`, `${g} impact on the one`, `${g} atmospheric texture`],
    },
    anchors: {},
  };
}
