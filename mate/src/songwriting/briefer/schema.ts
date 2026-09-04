import { KEY_MODES, KEY_ROOTS, LOOP_BARS } from "@aibleton/protocol";

/**
 * The JSON schema sent as `output_config.format` for the brief. Hand-written
 * in the structured-output subset: every object has `additionalProperties:
 * false` and lists every property in `required`; optionality is `anyOf` with
 * null; no numeric or string constraints (those live in `normalizeBrief` and
 * `SongBriefSchema`); enums for closed sets; arrays of keyed objects instead
 * of records. Mirrors `SongBriefSchema` in protocol/songs.ts.
 */

type JsonSchema = Record<string, unknown>;

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const str = (description?: string): JsonSchema => (description ? { type: "string", description } : { type: "string" });
const strings = (description: string): JsonSchema => ({ type: "array", description, items: { type: "string" } });
const object = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const SONG_BRIEF_JSON_SCHEMA: JsonSchema = object({
  summary: str("One short line for the drummer."),
  genres: strings("Genre words as a sample library tags them, at most 5."),
  descriptors: strings("Mood or texture words, at most 5."),
  key: object({
    root: { type: "string", enum: [...KEY_ROOTS] },
    mode: { type: "string", enum: [...KEY_MODES] },
  }),
  bpm: object(
    {
      min: { type: "integer" },
      max: { type: "integer" },
      target: { type: "integer" },
    },
    "Search window and target tempo, 40..220, min <= target <= max.",
  ),
  timeSignature: object({
    numerator: { type: "integer" },
    denominator: { type: "integer", enum: [2, 4, 8, 16] },
  }),
  swing: nullable({ type: "number", description: "0 straight to 1 heavily swung." }),
  parts: {
    type: "array",
    description: "One entry per band part, using the given part id.",
    items: object({
      partId: str(),
      keep: { type: "boolean" },
      brief: nullable(str("Replacement Splice brief, or null to keep the part's own.")),
      soundHints: strings("Extra search words for this part only, at most 5."),
      loopBars: { type: "integer", enum: [...LOOP_BARS] },
    }),
  },
  sections: {
    type: "array",
    description: "One entry per section letter.",
    items: object({
      label: str("The section letter."),
      brief: nullable(str("Replacement section brief, or null to keep it.")),
      descriptors: strings("Search words for every part in this section, at most 5."),
      intensity: nullable({ type: "number", description: "0 sparsest to 1 fullest." }),
    }),
  },
  templateFeedback: object({
    form: nullable(str("Revised form string using only existing letters, or null to keep the form.")),
    notes: str(),
  }),
  bandFeedback: object({
    addParts: {
      type: "array",
      description: "Parts to add, at most 2.",
      items: object({ role: str(), name: str(), brief: str() }),
    },
    notes: str(),
  }),
});
