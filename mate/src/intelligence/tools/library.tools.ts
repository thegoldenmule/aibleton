import type Anthropic from "@anthropic-ai/sdk";
import { bandGenre, formTotalBars, parseForm } from "@aibleton/protocol";
import type { Band, RecipeSummary, Template } from "@aibleton/protocol";
import { DEFAULT_LIMIT, searchBands, searchTemplates, type Match } from "../../songwriting/search.ts";

type Tool = Anthropic.Beta.BetaTool;

const int = { type: "integer" as const };
const str = { type: "string" as const };

/**
 * The saved libraries, as read-only tools: who mate can call on, what roadmaps
 * it has, and which genres it can staff a band from.
 *
 * They run inline in `AnthropicBrain`'s tool loop and never become `Action`s —
 * nothing here writes. Generating a band or a template is the next wave;
 * deleting one is deliberately never a tool.
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

const NAMES = new Set(LIBRARY_READ_TOOLS.map((t) => t.name));

/** True when `name` is one of the library reads. */
export function isLibraryTool(name: string): boolean {
  return NAMES.has(name);
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
