import type Anthropic from "@anthropic-ai/sdk";
import { bandGenre, formTotalBars, parseForm } from "@aibleton/protocol";
import type { Band, RecipeSummary, Template } from "@aibleton/protocol";
import { DEFAULT_LIMIT, searchBands, searchTemplates, type Match } from "../../songwriting/search.ts";
import type { Action } from "../brain/types.ts";

type Tool = Anthropic.Beta.BetaTool;

const int = { type: "integer" as const };
const num = { type: "number" as const };
const str = { type: "string" as const };

/**
 * The saved libraries, as tools: who mate can call on, what roadmaps it has,
 * which genres it can staff a band from — and the two ways it adds to them.
 *
 * The reads run inline in `AnthropicBrain`'s tool loop and never become
 * `Action`s. The two generates do: they write, so they queue like every other
 * mutation and land through `EffectRunner.applyOne`.
 *
 * **Deleting is never a tool.** A delete is irreversible — the record file is
 * unlinked, there is no trash and no undo — and the app already gates it behind
 * a two-click confirm. A brain tool would route around that confirm, so the
 * invariant is: mate adds, the drummer removes. A test pins it.
 *
 * **Everything is bounded.** A thirty-band library handed over whole is most of
 * the turn's context spent before the answer starts, so `find_*` returns a
 * summary per hit — the same projection style as `compactSession` and the song
 * digest — and `get_*` is where a brief lives. `total` rides along with every
 * find so the model can tell a whole library from a slice of one.
 */

/** The most a `find_*` will return however large a `limit` is asked for. */
export const MAX_LIMIT = 25;

export const LIBRARY_READ_TOOLS: Tool[] = [
  {
    name: "find_bands",
    description:
      "Who is in the band library: a summary per band — id, name, genre and who plays what, never the part briefs. With a query it returns the best matches with a line saying what each one matched on, so judge the hits rather than trusting the order; with no query at all it returns the newest bands, which is how you browse. total is the whole library and shown is how many came back, so you can tell a slice from all of it. Read one in full with get_band once you have narrowed down.",
    input_schema: {
      type: "object",
      properties: {
        query: { ...str, description: "What you are after — a genre, an instrument, words from a name or a brief. Omit to browse the newest." },
        limit: { ...int, description: `How many to return. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.` },
      },
    },
  },
  {
    name: "get_band",
    description:
      "One band in full, by id: every part with its role, its stage name and the brief that is handed to Splice when it is bound to material. This is the detail find_bands leaves out, so narrow there first and fetch here second.",
    input_schema: { type: "object", properties: { band_id: str }, required: ["band_id"], additionalProperties: false },
    strict: true,
  },
  {
    name: "find_templates",
    description:
      "The song roadmaps on the shelf: a summary per template — id, name, form string, how many bars that adds up to and its bpm if it has one, never the section briefs. Same rules as find_bands: ranked with a query, newest with none, and total says how much of the library you are seeing.",
    input_schema: {
      type: "object",
      properties: {
        query: { ...str, description: "What you are after — a tempo, a length, words from a name, a form or a section brief. Omit to browse the newest." },
        limit: { ...int, description: `How many to return. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.` },
      },
    },
  },
  {
    name: "get_template",
    description:
      "One template in full, by id: the form and every section with the brief that describes it. This is the detail find_templates leaves out, so narrow there first and fetch here second.",
    input_schema: { type: "object", properties: { template_id: str }, required: ["template_id"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_genres",
    description:
      "Which genres a band can be staffed from, and which of them ship with mate versus having been written by a model already. A genre not in this list is not a refusal — composing one simply writes its recipe first — but this is how you tell the drummer what is already on hand.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

/**
 * The two ways mate adds to a library. Both save — unlike the generate routes,
 * which hand the app a draft to confirm, the brain has no draft UI to confirm
 * from, so a generate the model asked for is a record the drummer then owns.
 *
 * Neither takes a seed. A seed is a reproducibility handle for the app's
 * "roll again" button; a model choosing one adds nothing and invites it to
 * reuse one, so it defaults from the clock.
 */
export const LIBRARY_ACTION_TOOLS: Tool[] = [
  {
    name: "generate_band",
    description:
      "Staff a new band from a genre and save it to the library: a roster of parts, each with a role, a stage name and the brief Splice is searched with. Everything is optional — with no genre one is picked for you. Check get_genres first: a genre already on that list is immediate, and any other genre has its recipe written by a model before the band is rolled, which takes a while. Adds to the library for a future song; it does not change the song on the go.",
    input_schema: {
      type: "object",
      properties: {
        genre: { ...str, description: "The genre to staff from, e.g. \"funk\". Omit to let the roll choose one." },
        size: { ...int, description: "How many parts in total, 1-16. Clamped to what the genre's recipe can staff." },
        name: { ...str, description: "Optional name; one is made up from the genre otherwise." },
      },
    },
  },
  {
    name: "generate_template",
    description:
      "Lay out a new song form and save it to the library: a form string like \"a8 b8 a8 c8\" plus a starting brief for every letter in it. Everything is optional and it is immediate — no model is in the loop. Adds to the library for a future song; it does not change the song on the go.",
    input_schema: {
      type: "object",
      properties: {
        name: { ...str, description: "Optional name; one is made up otherwise." },
        alphabet: { ...int, description: "How many distinct sections the form may use, 2-6." },
        count: { ...int, description: "How many sections long the form runs, 1-64." },
        home: { ...str, description: "The section it keeps returning to, a single lowercase letter such as \"a\"." },
        max_run: { ...int, description: "The most times one section may repeat back to back." },
        bars: { ...int, description: "Bars per section." },
        bpm: { ...num, description: "Tempo for the template. Omit to leave it open." },
      },
    },
  },
];

const NAMES = new Set(LIBRARY_READ_TOOLS.map((t) => t.name));

/** True when `name` is one of the library **reads** — the ones that run inline. A generate is an action. */
export function isLibraryTool(name: string): boolean {
  return NAMES.has(name);
}

/**
 * Map a mutating library tool call onto a domain Action. An option the model
 * did not supply stays absent rather than becoming a zero or an empty string:
 * absent means "you choose", which is not the same as `size: 0`.
 */
export function libraryToolToAction(name: string, input: Record<string, unknown>): Action | null {
  switch (name) {
    case "generate_band":
      return {
        type: "generateBand",
        ...opt("genre", optText(input.genre)),
        ...opt("size", optInt(input.size)),
        ...opt("name", optText(input.name)),
      };
    case "generate_template":
      return {
        type: "generateTemplate",
        ...opt("name", optText(input.name)),
        ...opt("alphabet", optInt(input.alphabet)),
        ...opt("count", optInt(input.count)),
        ...opt("home", optText(input.home)),
        ...opt("maxRun", optInt(input.max_run)),
        ...opt("bars", optInt(input.bars)),
        ...opt("bpm", optNum(input.bpm)),
      };
    default:
      return null;
  }
}

/** `{ key: value }` when there is a value, nothing at all when there is not. */
function opt<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Text the model actually supplied. Blank is not an answer — it means it left the choice to us. */
function optText(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s || undefined;
}

/** A number the model actually supplied. `null`, `""` and `undefined` all mean it did not. */
function optNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The same, floored: the generator's own bounds check rejects anything out of range. */
function optInt(v: unknown): number | undefined {
  const n = optNum(v);
  return n === undefined ? undefined : Math.floor(n);
}

/**
 * What the handlers read. Deliberately narrower than `LibraryStore`: the two
 * methods a read needs, so a test can hand over an array without a disk.
 */
export interface LibraryReader<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
}

/** Everything the library tools reach. Absent from the brain means none of them are offered. */
export interface LibraryToolDeps {
  bands: LibraryReader<Band>;
  templates: LibraryReader<Template>;
  /** `RecipeBook`, for `get_genres`. Only the listing is read; nothing here writes one. */
  recipes: { list(): Promise<RecipeSummary[]> };
}

/** A band without its briefs: enough to choose between two, a tenth of the bytes. */
export function bandSummary(band: Band) {
  return {
    id: band.id,
    name: band.name,
    genre: bandGenre(band),
    parts: band.parts.map((p) => ({ role: p.role, name: p.name })),
  };
}

/** A template without its section briefs. `totalBars` because a form string does not read as a length. */
export function templateSummary(template: Template) {
  return {
    id: template.id,
    name: template.name,
    form: template.form,
    totalBars: formTotalBars(parseForm(template.form)),
    ...(template.bpm !== undefined ? { bpm: template.bpm } : {}),
  };
}

/** What a `find_*` answers with: the slice, and the size of the thing it was cut from. */
function found<T, S>(total: number, matches: Match<T>[], summarise: (doc: T) => S) {
  return {
    total,
    shown: matches.length,
    // An empty `why` is dropped rather than printed: eight `"why":[]` on a browse is noise.
    matches: matches.map((m) => ({ ...summarise(m.document), ...(m.why.length ? { why: m.why } : {}) })),
  };
}

/** A limit the model asked for, clamped. Anything unreadable means it did not ask. */
function limitOf(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Run one library read and return what the model sees.
 *
 * A miss on `get_band`/`get_template` is an ordinary answer, not an error
 * result: a bad id is usually a guess the model made instead of searching, and
 * a plain sentence pointing back at `find_*` gets it there in one turn, where
 * `is_error` reads as a fault and tends to draw an apology to the drummer.
 * An id the store refuses outright is the same miss — it cannot name a band.
 */
export async function runLibraryTool(name: string, args: Record<string, unknown>, deps: LibraryToolDeps): Promise<string> {
  switch (name) {
    case "find_bands": {
      const bands = await deps.bands.list();
      const limit = limitOf(args.limit);
      return JSON.stringify(found(bands.length, searchBands(bands, String(args.query ?? ""), limit), bandSummary));
    }
    case "find_templates": {
      const templates = await deps.templates.list();
      const limit = limitOf(args.limit);
      return JSON.stringify(found(templates.length, searchTemplates(templates, String(args.query ?? ""), limit), templateSummary));
    }
    case "get_band": {
      const id = String(args.band_id ?? "");
      const band = await read(deps.bands, id);
      return band ? JSON.stringify(band) : `no band ${JSON.stringify(id)} — find one with find_bands.`;
    }
    case "get_template": {
      const id = String(args.template_id ?? "");
      const template = await read(deps.templates, id);
      return template ? JSON.stringify(template) : `no template ${JSON.stringify(id)} — find one with find_templates.`;
    }
    case "get_genres":
      return JSON.stringify(await deps.recipes.list());
    default:
      throw new Error(`not a library tool: ${name}`);
  }
}

/** A read that treats an id the store will not even look up as a miss. */
async function read<T>(reader: LibraryReader<T>, id: string): Promise<T | null> {
  try {
    return await reader.get(id);
  } catch {
    return null;
  }
}
