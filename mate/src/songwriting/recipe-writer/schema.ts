/**
 * The JSON schema sent as `output_config.format` for a recipe. Structured-output
 * subset: closed objects, every property required, arrays of keyed objects
 * instead of records, no numeric or length constraints (see `normalizeRecipe`).
 */

type JsonSchema = Record<string, unknown>;

const str = (description?: string): JsonSchema => (description ? { type: "string", description } : { type: "string" });
const object = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const RECIPE_JSON_SCHEMA: JsonSchema = object({
  core: { type: "array", description: "Roles always present, in track order.", items: str() },
  optional: {
    type: "array",
    description: "Roles drawn by weight to fill the band out.",
    items: object({ role: str(), weight: { type: "number", description: "Above 0; 1 is common, 0.3 is rare." } }),
  },
  roles: {
    type: "array",
    description: "Players per role, for every role in core or optional. Archetype first.",
    items: object({
      role: str(),
      players: {
        type: "array",
        items: object({
          name: str("Short stage name, e.g. \"Rhodes\" or \"slap bass\"."),
          brief: str("One sentence of searchable sound for Splice."),
        }),
      },
    }),
  },
  anchors: {
    type: "array",
    description: "For core roles: how many leading players are equally foundational.",
    items: object({ role: str(), count: { type: "integer" } }),
  },
});
